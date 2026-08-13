// The SSO login Backend-For-Frontend: server-side OIDC Authorization Code + PKCE against SecSSO
// (Authentik), fronted by four HTTP routes and an httpOnly session cookie. No OIDC token (id_token,
// access_token, or anything else from the IdP) is EVER written to a response body or a
// non-httpOnly cookie — the browser's only credential is `secchat_session`, which it can't read
// (httpOnly) and which carries nothing beyond what auth/session.ts's Principal shape needs.
//
// Two cookies, two purposes:
//   - secchat_oidc_flow — the in-flight login's {state, codeVerifier, nonce, next}, alive only
//     between GET /auth/login and GET /auth/callback (~seconds, capped at 10 minutes). Itself a
//     signed (HS256, same session secret) JWT, so it's tamper-evident without a server-side flow
//     store — anyone holding it can't forge or alter its claims, only replay it verbatim, and
//     replaying it doesn't help without also winning the `state` won by the real IdP round-trip.
//   - secchat_session — the actual login, minted only after a full, verified OIDC round-trip
//     (auth/session.ts).
// Both are httpOnly + SameSite=Lax + Path=/, and `Secure` whenever `publicUrl` is https — see
// cookieOpts below.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { jwtVerify, SignJWT } from "jose";
import type { Config } from "../config.ts";
import type { AuthGateway, Principal } from "../types.ts";
import { buildAuthorizeUrl, challengeS256, discover, exchangeCode, newVerifier, verifyIdToken } from "./oidc.ts";
import { mintSession, parseCookies, serializeCookie, verifySession, type CookieOptions } from "./session.ts";

/** Everything makeAuthGateway needs from Config — a Pick, not the whole thing (mirrors
 * auth/jwks.ts's makeVerifyToken), so callers (index.ts, tests) don't have to fabricate unrelated
 * fields like `host`/`port`/`secrouterUrl` just to build a gateway. `stepUp` (the token minter) is
 * needed only by the interactive step-up re-auth flow. */
export type AuthGatewayConfig = Pick<
  Config,
  "ssoEnabled" | "oidcIssuer" | "oidcClientId" | "oidcClientSecret" | "publicUrl" | "sessionSecret" | "sessionTtl" | "stepUp"
>;

const SESSION_COOKIE = "secchat_session";
const FLOW_COOKIE = "secchat_oidc_flow";
const FLOW_TTL_SECONDS = 600; // 10 minutes — long enough for a human to complete the IdP hop, no longer
const SCOPE = "openid profile email groups";

// Step-up: the httpOnly cookie carrying the fresh-re-auth proof, and how recent the IdP's
// `auth_time` must be for the callback to accept it as a genuine re-authentication (proof that
// `prompt=login` forced a real login, not a silent SSO session reuse).
const STEPUP_COOKIE = "secchat_stepup";
const STEPUP_MAX_AUTH_AGE_SECONDS = 300;
const STEPUP_COOKIE_TTL_SECONDS = 900;

// The flow cookie's own iss/aud — deliberately DIFFERENT from session.ts's "secchat"/"secchat" so
// a captured flow cookie can never be replayed as a session cookie (or vice versa) even though
// both are HS256-signed with the same secret: jwtVerify's issuer/audience pins make the two
// token kinds mutually unacceptable to each other's verifier.
const FLOW_ISSUER = "secchat-oidc-flow";

interface FlowState {
  state: string;
  codeVerifier: string;
  nonce: string;
  next: string;
  /** True when this flow is a step-up re-auth (prompt=login) rather than a fresh login — the
   * callback then mints a step-up proof cookie instead of a session cookie. */
  stepUp: boolean;
  /** Native (desktop) login loopback: when set, the callback hands the freshly minted session
   * token back to a local `http://127.0.0.1:<nativePort>/` listener (the desktop app started one
   * per RFC 8252) instead of setting an httpOnly cookie a native app could never read. The
   * browser still runs the whole OIDC dance (this flow cookie round-trips in the browser); only
   * the final step differs. `nativeState` is echoed to the loopback so the app confirms the
   * response belongs to the login it initiated (a local-process CSRF guard). */
  nativePort?: number;
  nativeState?: string;
}

function flowKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

async function signFlowCookie(flow: FlowState, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    state: flow.state, codeVerifier: flow.codeVerifier, nonce: flow.nonce, next: flow.next,
    stepUp: flow.stepUp, nativePort: flow.nativePort, nativeState: flow.nativeState,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(FLOW_ISSUER)
    .setAudience(FLOW_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + FLOW_TTL_SECONDS)
    .sign(flowKey(secret));
}

/** Verifies+parses the flow cookie. Pins alg HS256 + this module's own iss/aud (see FLOW_ISSUER
 * above) — same fail-closed shape as session.ts's verifySession. */
async function verifyFlowCookie(token: string, secret: string): Promise<FlowState> {
  const { payload } = await jwtVerify(token, flowKey(secret), {
    algorithms: ["HS256"],
    issuer: FLOW_ISSUER,
    audience: FLOW_ISSUER,
  });
  const { state, codeVerifier, nonce, next, stepUp, nativePort, nativeState } = payload;
  if (typeof state !== "string" || typeof codeVerifier !== "string" || typeof nonce !== "string" || typeof next !== "string") {
    throw new Error("malformed OIDC flow cookie");
  }
  return {
    state, codeVerifier, nonce, next, stepUp: stepUp === true,
    nativePort: typeof nativePort === "number" ? nativePort : undefined,
    nativeState: typeof nativeState === "string" ? nativeState : undefined,
  };
}

function randomToken(): string {
  return randomBytes(16).toString("base64url");
}

/** True if `s` contains any ASCII control character or plain space — checked by char code (not a
 * regex escape class) on purpose, to keep this a plain, unambiguous character-by-character scan.
 * Used only by safeNext below, to keep a CR/LF (or any other control byte) smuggled in via a
 * percent-encoded `next` query value from ever reaching a response header. */
function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 32 || code === 127) return true; // 0..31 = C0 controls, 32 = space, 127 = DEL
  }
  return false;
}

/** Open-redirect guard for `next` (see the sprint contract's Backend routes section): only a
 * same-origin relative path is ever honored. Must start with a single "/" (rejects "//host/..."
 * and "https://...", both of which browsers/some parsers can treat as an absolute redirect
 * target), and must contain no whitespace/control characters (rejects CR/LF header-injection
 * attempts smuggled in via a percent-encoded query value — `next` ends up in a Location header).
 * Anything that doesn't qualify silently falls back to "/" rather than erroring the request. */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (hasControlOrSpace(raw)) return "/";
  return raw;
}

/** Parse a native-login loopback port, accepting ONLY an unprivileged port a local app could bind
 * (1024–65535). Returns undefined for anything else, so the callback's loopback host stays a
 * hardcoded 127.0.0.1:<validated-port> — never an attacker-influenced target (no open redirect). */
function parseLoopbackPort(raw: string | null): number | undefined {
  if (!raw || !/^\d{4,5}$/.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1024 && port <= 65535 ? port : undefined;
}

function cookieOpts(cfg: AuthGatewayConfig): CookieOptions {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: (cfg.publicUrl ?? "").toLowerCase().startsWith("https"),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

/** Appends (rather than clobbers) a Set-Cookie header — a single response may need to set more
 * than one cookie (e.g. the callback both mints the session cookie AND clears the flow cookie),
 * and Node's ServerResponse only sends multiple Set-Cookie headers correctly if they're passed to
 * setHeader as an array. */
function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (Array.isArray(existing)) res.setHeader("Set-Cookie", [...existing, cookie]);
  else if (typeof existing === "string") res.setHeader("Set-Cookie", [existing, cookie]);
  else res.setHeader("Set-Cookie", cookie);
}

/** Fields only meaningful once `cfg.ssoEnabled` is true — narrows away the `?`/`boolean` noise
 * for the three handlers below so they can read `ready.oidcClientSecret` etc. as plain strings.
 * Re-checks ssoEnabled itself (rather than trusting the caller) as defense in depth: this throws
 * (caught by each handler's try/catch, below) if it's ever called when SSO isn't fully
 * configured, so a future refactor that skips the route-level 503 gate fails closed instead of
 * dereferencing an absent secret. */
interface ReadyConfig {
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  publicUrl: string;
  sessionSecret: string;
  sessionTtl: number;
}

function requireReady(cfg: AuthGatewayConfig): ReadyConfig {
  if (!cfg.ssoEnabled || !cfg.oidcClientSecret || !cfg.publicUrl || !cfg.sessionSecret) {
    throw new Error("SSO login is not configured");
  }
  return {
    oidcIssuer: cfg.oidcIssuer,
    oidcClientId: cfg.oidcClientId,
    oidcClientSecret: cfg.oidcClientSecret,
    publicUrl: cfg.publicUrl,
    sessionSecret: cfg.sessionSecret,
    sessionTtl: cfg.sessionTtl,
  };
}

/** Starts an Authorization Code + PKCE flow. `stepUp` distinguishes a fresh LOGIN (silent SSO
 * allowed) from a step-up RE-AUTH — the latter adds `prompt=login` + `max_age=0` to FORCE a fresh
 * authentication at the IdP (and to make it return an `auth_time` the callback verifies). */
async function startFlow(req: IncomingMessage, res: ServerResponse, cfg: AuthGatewayConfig, stepUp: boolean): Promise<void> {
  try {
    const ready = requireReady(cfg);
    const url = new URL(req.url ?? "/", "http://internal");
    const next = safeNext(url.searchParams.get("next"));
    // Native (desktop) loopback login (RFC 8252): the app passes the local port it's listening on
    // plus a state token. Only accept a sane loopback port; ignore anything malformed so a
    // browser login is unaffected.
    const nativePort = parseLoopbackPort(url.searchParams.get("native_port"));
    const nativeState = nativePort ? (url.searchParams.get("native_state") ?? "").slice(0, 128) : undefined;

    const endpoints = await discover(ready.oidcIssuer);
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = newVerifier();
    const codeChallenge = challengeS256(codeVerifier);
    const redirectUri = `${ready.publicUrl}/auth/callback`;

    const authorizeUrl = buildAuthorizeUrl({
      endpoints,
      clientId: ready.oidcClientId,
      redirectUri,
      scope: SCOPE,
      state,
      nonce,
      codeChallenge,
      ...(stepUp ? { prompt: "login", maxAge: 0 } : {}),
    });

    const flowCookie = await signFlowCookie({ state, codeVerifier, nonce, next, stepUp, nativePort, nativeState }, ready.sessionSecret);
    appendSetCookie(res, serializeCookie(FLOW_COOKIE, flowCookie, { ...cookieOpts(cfg), maxAge: FLOW_TTL_SECONDS }));
    redirect(res, authorizeUrl);
  } catch (err) {
    console.error("[bff login error]", err instanceof Error ? err.stack : err);
    // Never leak internals (discovery failures, network errors, ...) — same generic error
    // redirect the callback uses below.
    redirect(res, "/?auth_error=login_failed");
  }
}

async function handleCallback(req: IncomingMessage, res: ServerResponse, cfg: AuthGatewayConfig): Promise<void> {
  try {
    const ready = requireReady(cfg);
    const url = new URL(req.url ?? "/", "http://internal");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) throw new Error("callback missing code/state");

    const flowToken = parseCookies(req.headers.cookie)[FLOW_COOKIE];
    if (!flowToken) throw new Error("missing OIDC flow cookie");
    const flow = await verifyFlowCookie(flowToken, ready.sessionSecret);
    if (flow.state !== state) throw new Error("state mismatch");

    const endpoints = await discover(ready.oidcIssuer);
    const redirectUri = `${ready.publicUrl}/auth/callback`;
    const tokenResponse = await exchangeCode({
      tokenEndpoint: endpoints.token_endpoint,
      clientId: ready.oidcClientId,
      clientSecret: ready.oidcClientSecret,
      redirectUri,
      code,
      codeVerifier: flow.codeVerifier,
    });

    const principal = await verifyIdToken(tokenResponse.id_token, {
      jwksUri: endpoints.jwks_uri,
      issuer: ready.oidcIssuer,
      clientId: ready.oidcClientId,
      nonce: flow.nonce,
      // A step-up flow demands a FRESH authentication — reject a silently-reused SSO session.
      ...(flow.stepUp ? { maxAuthAgeSeconds: STEPUP_MAX_AUTH_AGE_SECONDS } : {}),
    });

    if (flow.stepUp) {
      // Fresh re-auth proven → mint a step-up proof cookie (NOT a session). If no minter is wired,
      // the step-up flow was never really available — bounce to the generic error.
      if (!cfg.stepUp) throw new Error("step-up minter not configured");
      const stepUpToken = await cfg.stepUp.mint(principal.sub);
      appendSetCookie(res, serializeCookie(STEPUP_COOKIE, stepUpToken, { ...cookieOpts(cfg), maxAge: STEPUP_COOKIE_TTL_SECONDS }));
      appendSetCookie(res, serializeCookie(FLOW_COOKIE, "", { ...cookieOpts(cfg), maxAge: 0 })); // clear
      redirect(res, flow.next);
      return;
    }

    const sessionToken = await mintSession(principal, ready.sessionSecret, ready.sessionTtl);
    appendSetCookie(res, serializeCookie(FLOW_COOKIE, "", { ...cookieOpts(cfg), maxAge: 0 })); // clear

    if (flow.nativePort) {
      // Native (desktop) login: hand the session token to the app's loopback listener instead of
      // setting an httpOnly cookie a native app can't read. Host is a hardcoded 127.0.0.1 with a
      // validated unprivileged port (see parseLoopbackPort) — not an open redirect. The app sends
      // this token back as a `Cookie: secchat_session=…` header it sets itself. `state` lets the
      // app confirm the response belongs to the login IT started.
      const params = new URLSearchParams({ session: sessionToken });
      if (flow.nativeState) params.set("state", flow.nativeState);
      redirect(res, `http://127.0.0.1:${flow.nativePort}/?${params.toString()}`);
      return;
    }

    appendSetCookie(res, serializeCookie(SESSION_COOKIE, sessionToken, { ...cookieOpts(cfg), maxAge: ready.sessionTtl }));
    redirect(res, flow.next);
  } catch (err) {
    console.error("[bff callback error]", err instanceof Error ? err.stack : err);
    redirect(res, "/?auth_error=login_failed");
  }
}

async function handleLogout(req: IncomingMessage, res: ServerResponse, cfg: AuthGatewayConfig): Promise<void> {
  // Always clear SecChat's own httpOnly session cookie first.
  appendSetCookie(res, serializeCookie(SESSION_COOKIE, "", { ...cookieOpts(cfg), maxAge: 0 }));
  const isGet = (req.method ?? "GET").toUpperCase() === "GET";
  // RP-initiated logout (OIDC end_session): clearing our cookie alone leaves the IdP (Authentik)
  // SSO session alive, so the very next /auth/login silently re-authenticates — an incomplete
  // logout on a shared workstation (CMMC AC-12 "terminate the session"). If the IdP publishes an
  // end_session_endpoint, send the browser there to terminate the IdP session too. No
  // `id_token_hint`: this BFF deliberately stores no OIDC tokens (see the module header), and
  // `client_id` + `post_logout_redirect_uri` are enough for Authentik to end the browser's own
  // session (it carries Authentik's cookie) and redirect back. A GET (top-level browser
  // navigation) 302-redirects there; a POST (the XHR client) gets the URL as JSON and navigates.
  try {
    const ready = requireReady(cfg);
    const endpoints = await discover(ready.oidcIssuer);
    const endSession = endpoints.end_session_endpoint;
    if (typeof endSession === "string" && endSession) {
      const url = new URL(endSession);
      url.searchParams.set("client_id", ready.oidcClientId);
      url.searchParams.set("post_logout_redirect_uri", ready.publicUrl);
      const logoutUrl = url.toString();
      if (isGet) redirect(res, logoutUrl);
      else sendJson(res, 200, { logoutUrl });
      return;
    }
  } catch (err) {
    // SSO not configured, IdP unreachable, or no end_session_endpoint published — fall back to the
    // legacy local-only logout (our cookie is already cleared above, so sign-out still succeeds).
    console.error("[bff logout] RP-initiated logout unavailable:", err instanceof Error ? err.message : err);
  }
  if (isGet) {
    redirect(res, "/");
  } else {
    res.writeHead(204);
    res.end();
  }
}

/** Builds the SSO login gateway from config. Always returns a fully-formed AuthGateway — when
 * `cfg.ssoEnabled` is false, `handleAuthRoutes` still answers `/auth/status` truthfully and 503s
 * the other three routes (so the client can detect "SSO isn't configured" and fall back to the
 * dev/bearer login path), and `resolveSession` always returns null. Callers (index.ts) wire this
 * in unconditionally; there's no separate "stub" implementation to switch between. */
export function makeAuthGateway(cfg: AuthGatewayConfig): AuthGateway {
  async function handleAuthRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://internal").pathname;

    if (method === "GET" && pathname === "/auth/status") {
      sendJson(res, 200, { sso: cfg.ssoEnabled });
      return true;
    }

    const isAuthRoute =
      (method === "GET" && (pathname === "/auth/login" || pathname === "/auth/callback" || pathname === "/auth/stepup/start" || pathname === "/auth/logout")) ||
      (method === "POST" && pathname === "/auth/logout");
    if (!isAuthRoute) return false;

    if (!cfg.ssoEnabled) {
      sendJson(res, 503, { error: "sso_not_configured" });
      return true;
    }

    if (pathname === "/auth/login") await startFlow(req, res, cfg, false);
    else if (pathname === "/auth/stepup/start") await startFlow(req, res, cfg, true);
    else if (pathname === "/auth/callback") await handleCallback(req, res, cfg);
    else await handleLogout(req, res, cfg);
    return true;
  }

  async function resolveSession(req: IncomingMessage): Promise<Principal | null> {
    if (!cfg.ssoEnabled || !cfg.sessionSecret) return null;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    try {
      return await verifySession(token, cfg.sessionSecret);
    } catch {
      return null;
    }
  }

  return { handleAuthRoutes, resolveSession };
}

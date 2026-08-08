// Sprint 11 EXIT TEST — SSO login end-to-end, driven against a FAKE in-process OIDC provider
// standing in for SecSSO (Authentik). This is the definition of done for the login BFF
// (src/auth/bff.ts + src/auth/oidc.ts + src/auth/session.ts): the backend runs the whole
// Authorization Code + PKCE dance itself and issues an httpOnly session cookie — no OIDC token of
// any kind ever reaches (or is asserted against) anything acting as "the browser" here.
//
// Every fetch below passes `redirect: "manual"` and drives a hand-rolled CookieJar rather than
// letting fetch auto-follow redirects or manage cookies — the whole point of this test is to
// inspect the Location + Set-Cookie headers at each hop ourselves, exactly the way the sprint
// contract's EXIT TEST section specifies.

import { createServer, request } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHttpServer } from "../src/http/server.ts";
import { attachWsHub } from "../src/ws/hub.ts";
import type { Hub } from "../src/ws/hub.ts";
import { makeAuthGateway } from "../src/auth/bff.ts";
import type { AuthGatewayConfig } from "../src/auth/bff.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Principal, VerifyToken } from "../src/types.ts";

// The wire-contract cookie names (see the sprint contract's "Cookies" section) — hardcoded here
// rather than imported from bff.ts (which doesn't export them): this test is asserting the
// PUBLIC contract those literal names are part of, same as it hardcodes route paths like
// "/auth/login" rather than importing them from anywhere.
const SESSION_COOKIE_NAME = "secchat_session";
const FLOW_COOKIE_NAME = "secchat_oidc_flow";

const CLIENT_ID = "secchatng";
const CLIENT_SECRET = "test-client-secret";
const SESSION_SECRET = "test-session-secret-do-not-use-in-prod";

// ── A minimal manual cookie jar ─────────────────────────────────────────────────────────────────
// Applies Set-Cookie response headers into a name->value map and renders it back as a request
// Cookie header. A cookie whose Set-Cookie carries "Max-Age=0" (or an empty value) is treated as
// cleared and dropped from the jar — mirrors how a real browser reacts to an expiring Set-Cookie.

class CookieJar {
  private readonly jar = new Map<string, string>();

  applySetCookies(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const firstPart = line.split(";")[0] ?? "";
      const eq = firstPart.indexOf("=");
      if (eq === -1) continue;
      const name = firstPart.slice(0, eq).trim();
      const value = firstPart.slice(eq + 1).trim();
      const cleared = value === "" || line.toLowerCase().includes("max-age=0");
      if (cleared) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }
}

// ── The fake IdP (stands in for SecSSO / Authentik) ────────────────────────────────────────────
// A real Authorization Code + PKCE dance, entirely in-memory, on loopback only: discovery, JWKS,
// /authorize (mints a one-time code, remembers what PKCE challenge + nonce it was issued with),
// and /token (redeems the code — genuinely verifying the S256 PKCE code_verifier against the
// stored challenge, not just checking a param was present — then mints a real RS256 id_token).

interface AuthorizeRecord {
  nonce: string;
  redirectUri: string;
  codeChallenge: string;
}

interface FakeIdpClaims {
  sub: string;
  email: string;
  name: string;
  groups: string[];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startFakeIdp(claims: FakeIdpClaims): Promise<{ server: Server; baseUrl: string }> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "fake-idp-1", alg: "RS256", use: "sig" };

  const codes = new Map<string, AuthorizeRecord>();
  let baseUrl = ""; // filled in once listen() resolves, below — the handler only runs after that

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://internal");

      if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        sendJson(res, 200, {
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          jwks_uri: `${baseUrl}/jwks`,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/jwks") {
        sendJson(res, 200, { keys: [jwk] });
        return;
      }

      if (req.method === "GET" && url.pathname === "/authorize") {
        const state = url.searchParams.get("state") ?? "";
        const nonce = url.searchParams.get("nonce") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const codeChallenge = url.searchParams.get("code_challenge") ?? "";
        const method = url.searchParams.get("code_challenge_method");
        if (method !== "S256" || !codeChallenge || !redirectUri) {
          sendJson(res, 400, { error: "invalid_request" });
          return;
        }
        const code = randomUUID();
        codes.set(code, { nonce, redirectUri, codeChallenge });
        const location = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
        res.writeHead(302, { Location: location });
        res.end();
        return;
      }

      if (req.method === "POST" && url.pathname === "/token") {
        const form = new URLSearchParams(await readBody(req));
        const code = form.get("code") ?? "";
        const codeVerifier = form.get("code_verifier") ?? "";
        const clientId = form.get("client_id");
        const clientSecret = form.get("client_secret");
        const record = codes.get(code);

        if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET || !record) {
          sendJson(res, 400, { error: "invalid_grant" });
          return;
        }
        codes.delete(code); // single-use

        // Genuine PKCE verification — proves the client actually possesses (and sent) the
        // verifier matching the challenge it presented at /authorize, not just that it sent SOME
        // code_verifier param.
        const expectedChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
        if (expectedChallenge !== record.codeChallenge) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }

        const now = Math.floor(Date.now() / 1000);
        const idToken = await new SignJWT({
          email: claims.email,
          name: claims.name,
          groups: claims.groups,
          nonce: record.nonce,
        })
          .setProtectedHeader({ alg: "RS256", kid: "fake-idp-1" })
          .setSubject(claims.sub)
          .setIssuer(baseUrl)
          .setAudience(CLIENT_ID)
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey);

        sendJson(res, 200, { id_token: idToken, access_token: "fake-access-token", token_type: "Bearer" });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      sendJson(res, 500, { error: "fake_idp_internal", detail: String(err) });
    }
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  return { server, baseUrl };
}

// ── The real SecChat server under test ─────────────────────────────────────────────────────────

const verifyToken: VerifyToken = async () => {
  throw new Error("bearer path not exercised by this exit test — see test/http.test.ts for that");
};

async function startSecChat(cfg: AuthGatewayConfig, withHub: boolean): Promise<{ server: Server; baseUrl: string; hub?: Hub }> {
  const auth = makeAuthGateway(cfg);
  const server = createHttpServer({ verifyToken, store: new MemoryStore(), auth });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address() as AddressInfo;
  // Only known now — but that's fine: makeAuthGateway's handlers read cfg.publicUrl fresh on
  // EVERY request (never hoisted at construction time), and no request reaches this server before
  // the line below runs, so mutating the SAME config object `auth` already closed over is safe.
  cfg.publicUrl = `http://127.0.0.1:${port}`;
  const hub = withHub ? attachWsHub(server, { verifyToken, auth }) : undefined;
  return { server, baseUrl: cfg.publicUrl, hub };
}

let idp: { server: Server; baseUrl: string };
let enabled: { server: Server; baseUrl: string; hub?: Hub };
let disabled: { server: Server; baseUrl: string };

before(async () => {
  idp = await startFakeIdp({ sub: "user-42", email: "grace@example.com", name: "Grace Hopper", groups: ["eng", "secchat-admins"] });

  const enabledCfg: AuthGatewayConfig = {
    ssoEnabled: true,
    oidcIssuer: idp.baseUrl,
    oidcClientId: CLIENT_ID,
    oidcClientSecret: CLIENT_SECRET,
    publicUrl: "",
    sessionSecret: SESSION_SECRET,
    sessionTtl: 28800,
  };
  enabled = await startSecChat(enabledCfg, true);

  const disabledCfg: AuthGatewayConfig = {
    ssoEnabled: false, // no client secret configured — the realistic trigger for ssoEnabled=false
    oidcIssuer: "http://unused.example.invalid",
    oidcClientId: CLIENT_ID,
    oidcClientSecret: undefined,
    publicUrl: undefined,
    sessionSecret: undefined,
    sessionTtl: 28800,
  };
  disabled = await startSecChat(disabledCfg, false);
});

after(async () => {
  enabled.hub?.close();
  await new Promise<void>((r) => enabled.server.close(() => r()));
  await new Promise<void>((r) => disabled.server.close(() => r()));
  await new Promise<void>((r) => idp.server.close(() => r()));
});

// ── Flow helpers shared by the tests below ─────────────────────────────────────────────────────

/** Drives GET /auth/login through the fake IdP's real /authorize, WITHOUT touching /auth/callback
 * — returns everything a test needs to inspect the login leg and then finish the flow itself. */
async function driveLogin(nextQuery?: string): Promise<{ jar: CookieJar; authorizeUrl: URL; callbackUrl: URL }> {
  const jar = new CookieJar();
  const loginPath = nextQuery ? `/auth/login?next=${encodeURIComponent(nextQuery)}` : "/auth/login";
  const loginRes = await fetch(`${enabled.baseUrl}${loginPath}`, { redirect: "manual" });
  assert.equal(loginRes.status, 302, "GET /auth/login should 302 to the IdP");
  jar.applySetCookies(loginRes.headers);
  const authorizeUrl = new URL(loginRes.headers.get("location") ?? "");

  const idpRes = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(idpRes.status, 302, "the fake IdP's /authorize should 302 back to /auth/callback");
  const callbackUrl = new URL(idpRes.headers.get("location") ?? "");

  return { jar, authorizeUrl, callbackUrl };
}

/** Completes a full login and returns a jar holding a live `secchat_session` cookie. */
async function loginAndGetSessionJar(): Promise<CookieJar> {
  const { jar, callbackUrl } = await driveLogin();
  const callbackRes = await fetch(callbackUrl, { redirect: "manual", headers: { cookie: jar.header() } });
  assert.equal(callbackRes.status, 302, "GET /auth/callback should 302 on success");
  jar.applySetCookies(callbackRes.headers);
  return jar;
}

// ── exit 1 ──────────────────────────────────────────────────────────────────────────────────────

test("exit 1 — GET /auth/status reports sso:true when SSO is configured", async () => {
  const res = await fetch(`${enabled.baseUrl}/auth/status`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sso: true });
});

// ── exit 2-5 — the full happy-path flow ────────────────────────────────────────────────────────

test("exit 2-5 — full OIDC BFF login flow: /auth/login -> fake IdP -> /auth/callback -> session cookie -> /me", async () => {
  const { jar, authorizeUrl, callbackUrl } = await driveLogin();

  // exit 2: the authorize URL GET /auth/login redirected to, and the flow cookie it set.
  assert.equal(authorizeUrl.origin, idp.baseUrl);
  assert.equal(authorizeUrl.pathname, "/authorize");
  assert.equal(authorizeUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizeUrl.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), `${enabled.baseUrl}/auth/callback`);
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizeUrl.searchParams.get("scope"), "openid profile email groups");
  const codeChallenge = authorizeUrl.searchParams.get("code_challenge");
  assert.ok(codeChallenge, "has a PKCE code_challenge");
  assert.ok(codeChallenge.length > 0);
  const state = authorizeUrl.searchParams.get("state");
  assert.ok(state, "has a state");
  const nonce = authorizeUrl.searchParams.get("nonce");
  assert.ok(nonce, "has a nonce");
  assert.ok(jar.has(FLOW_COOKIE_NAME), "GET /auth/login set the flow cookie");

  // exit 3: the fake IdP's /authorize (hit inside driveLogin) sent us back to /auth/callback with
  // the SAME state, plus a fresh code.
  assert.equal(callbackUrl.pathname, "/auth/callback");
  assert.equal(callbackUrl.searchParams.get("state"), state);
  assert.ok(callbackUrl.searchParams.get("code"));

  // exit 4: GET /auth/callback WITH the flow cookie.
  const callbackRes = await fetch(callbackUrl, { redirect: "manual", headers: { cookie: jar.header() } });
  assert.equal(callbackRes.status, 302);
  assert.equal(callbackRes.headers.get("location"), "/"); // no `next` was given — defaults to "/"
  const sessionSetCookie = callbackRes.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  assert.ok(sessionSetCookie, "sets the session cookie");
  assert.ok(sessionSetCookie.toLowerCase().includes("httponly"), "session cookie is httpOnly");
  jar.applySetCookies(callbackRes.headers);
  assert.ok(jar.has(SESSION_COOKIE_NAME));
  assert.ok(!jar.has(FLOW_COOKIE_NAME), "the flow cookie is cleared after a successful callback");

  // exit 5: GET /me WITH the session cookie — no Authorization header anywhere in this test.
  const meRes = await fetch(`${enabled.baseUrl}/me`, { headers: { cookie: jar.header() } });
  assert.equal(meRes.status, 200);
  const principal = (await meRes.json()) as Principal;
  assert.equal(principal.sub, "user-42");
  assert.equal(principal.email, "grace@example.com");
  assert.equal(principal.displayName, "Grace Hopper");
  assert.deepEqual(principal.groups, ["eng", "secchat-admins"]);
});

// ── the `next` open-redirect guard ─────────────────────────────────────────────────────────────

test("the `next` open-redirect guard: a safe relative next is honored; absolute/protocol-relative ones fall back to /", async () => {
  const safe = await driveLogin("/channels/general");
  const safeCallbackRes = await fetch(safe.callbackUrl, { redirect: "manual", headers: { cookie: safe.jar.header() } });
  assert.equal(safeCallbackRes.status, 302);
  assert.equal(safeCallbackRes.headers.get("location"), "/channels/general");

  const absolute = await driveLogin("https://evil.example/steal");
  const absoluteRes = await fetch(absolute.callbackUrl, { redirect: "manual", headers: { cookie: absolute.jar.header() } });
  assert.equal(absoluteRes.headers.get("location"), "/");

  const protocolRelative = await driveLogin("//evil.example/steal");
  const prRes = await fetch(protocolRelative.callbackUrl, { redirect: "manual", headers: { cookie: protocolRelative.jar.header() } });
  assert.equal(prRes.headers.get("location"), "/");
});

// ── exit 6 ──────────────────────────────────────────────────────────────────────────────────────

test("exit 6a — a mismatched state on /auth/callback is rejected: no session cookie, generic error redirect", async () => {
  const { jar, callbackUrl } = await driveLogin();
  const tampered = new URL(callbackUrl);
  tampered.searchParams.set("state", "not-the-real-state");

  const res = await fetch(tampered, { redirect: "manual", headers: { cookie: jar.header() } });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location") ?? "", enabled.baseUrl);
  assert.equal(location.pathname, "/");
  assert.ok(location.searchParams.get("auth_error"), "carries a generic auth_error reason");

  const liveSession = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && !c.toLowerCase().includes("max-age=0"));
  assert.equal(liveSession, undefined, "no session cookie is set on a rejected callback");
});

test("exit 6b — with SSO not configured: /auth/login|callback|logout 503, but /auth/status still reports sso:false", async () => {
  const statusRes = await fetch(`${disabled.baseUrl}/auth/status`);
  assert.equal(statusRes.status, 200);
  assert.deepEqual(await statusRes.json(), { sso: false });

  const loginRes = await fetch(`${disabled.baseUrl}/auth/login`, { redirect: "manual" });
  assert.equal(loginRes.status, 503);
  assert.deepEqual(await loginRes.json(), { error: "sso_not_configured" });

  const callbackRes = await fetch(`${disabled.baseUrl}/auth/callback?code=x&state=y`, { redirect: "manual" });
  assert.equal(callbackRes.status, 503);
  assert.deepEqual(await callbackRes.json(), { error: "sso_not_configured" });

  const logoutRes = await fetch(`${disabled.baseUrl}/auth/logout`, { method: "POST" });
  assert.equal(logoutRes.status, 503);
  assert.deepEqual(await logoutRes.json(), { error: "sso_not_configured" });
});

// ── exit 7 ──────────────────────────────────────────────────────────────────────────────────────

test("exit 7 — POST /auth/logout clears the session cookie", async () => {
  const jar = await loginAndGetSessionJar();
  assert.ok(jar.has(SESSION_COOKIE_NAME));

  const logoutRes = await fetch(`${enabled.baseUrl}/auth/logout`, { method: "POST", headers: { cookie: jar.header() } });
  assert.equal(logoutRes.status, 204);
  const cleared = logoutRes.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  assert.ok(cleared, "logout sets a Set-Cookie for the session");
  assert.ok(cleared.toLowerCase().includes("max-age=0"), "the Set-Cookie expires it immediately");
  jar.applySetCookies(logoutRes.headers);
  assert.ok(!jar.has(SESSION_COOKIE_NAME));

  const meRes = await fetch(`${enabled.baseUrl}/me`, { headers: { cookie: jar.header() } });
  assert.equal(meRes.status, 401, "the session no longer authenticates after logout");
});

// ── WS integration: the browser's natural credential on the upgrade request too ───────────────

test("WS upgrade authenticates via the session cookie when no ?token= is given", async () => {
  const jar = await loginAndGetSessionJar();
  const target = new URL(enabled.baseUrl);

  const outcome = await new Promise<number | string>((resolvePromise) => {
    const upgradeReq = request({
      host: target.hostname,
      port: target.port,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        Cookie: jar.header(),
      },
    });
    upgradeReq.on("upgrade", (res, socket) => {
      socket.destroy(); // don't leave the connection open — it would hang server.close() in `after`
      resolvePromise(res.statusCode ?? -1);
    });
    upgradeReq.on("response", (res) => {
      res.resume();
      resolvePromise(res.statusCode ?? -1);
    });
    upgradeReq.on("error", (err) => resolvePromise(`error: ${err.message}`));
    upgradeReq.end();
  });

  assert.equal(outcome, 101, "the upgrade should succeed (101) using the session cookie alone");
});

test("WS upgrade with neither a token nor a session cookie is rejected", async () => {
  const target = new URL(enabled.baseUrl);

  const outcome = await new Promise<number | string>((resolvePromise) => {
    const upgradeReq = request({
      host: target.hostname,
      port: target.port,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });
    upgradeReq.on("upgrade", (res, socket) => {
      socket.destroy();
      resolvePromise(res.statusCode ?? -1);
    });
    upgradeReq.on("response", (res) => {
      res.resume();
      resolvePromise(res.statusCode ?? -1);
    });
    upgradeReq.on("error", (err) => resolvePromise(`error: ${err.message}`));
    upgradeReq.end();
  });

  assert.equal(outcome, 401);
});

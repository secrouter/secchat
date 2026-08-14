// OIDC client-credentials service-token provider for the SecRouter egress path.
//
// When SecRouter runs with `security.enabled`, every request must carry a valid OIDC access token
// (audience "secrouter") — there is no static-token path. SecChat authenticates as a MACHINE client
// via the client-credentials grant (RFC 6749 §4.4) against SecSSO, exactly like secagent's service
// identity. Access tokens are short-lived, so this fetches on demand, caches, and refreshes shortly
// before expiry (one in-flight fetch is shared to avoid a stampede under concurrent calls).
//
// Opt-in: when no service client is configured (`makeServiceTokenProvider` not built), the SecRouter
// client falls back to the static `SECROUTER_TOKEN` (or no header at all against an open dev
// gateway) — so behavior is unchanged until a deployment wires the service client.

export interface ServiceTokenConfig {
  /** SecSSO's OAuth2 token endpoint (…/application/o/token/). */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Requested scope — the audience-bearing scope SecRouter validates (default "secrouter"). */
  scope?: string;
}

export interface TokenProvider {
  /** A currently-valid access token, fetching or refreshing as needed. Rejects if the grant fails. */
  get(): Promise<string>;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number; // seconds
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface TokenProviderOptions {
  fetchImpl?: FetchLike; // default: global fetch
  now?: () => number; // ms epoch; default Date.now
  /** Refresh this many ms BEFORE the token's stated expiry, to avoid using one that dies in flight. */
  skewMs?: number; // default 60_000
}

/** Build a caching client-credentials token provider. Pure aside from the injected fetch/clock, so
 * it's fully testable offline. */
export function makeServiceTokenProvider(cfg: ServiceTokenConfig, opts: TokenProviderOptions = {}): TokenProvider {
  const fetchImpl: FetchLike =
    opts.fetchImpl ??
    ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
  const now = opts.now ?? (() => Date.now());
  const skewMs = opts.skewMs ?? 60_000;
  const scope = cfg.scope ?? "secrouter";

  let cached: { token: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope,
    }).toString();
    const res = await fetchImpl(cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`SecRouter service-token grant failed with status ${res.status}`);
    }
    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) {
      throw new Error("SecRouter service-token grant returned no access_token");
    }
    // Default a missing expires_in to a conservative 5 minutes so we still refresh regularly.
    const ttlMs = (json.expires_in ?? 300) * 1000;
    cached = { token: json.access_token, expiresAt: now() + ttlMs };
    return json.access_token;
  }

  return {
    async get(): Promise<string> {
      if (cached && cached.expiresAt - skewMs > now()) return cached.token;
      // Coalesce concurrent refreshes onto one grant.
      if (!inFlight) {
        inFlight = fetchToken().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}

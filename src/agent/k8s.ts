// A minimal Kubernetes client for the agent pool — just enough of the API to create and delete a
// Pod. Talks to the API server over the in-cluster ServiceAccount token + CA (the same shape
// SecRouter uses to reach Bedrock: raw HTTPS + a mounted credential, NO client library) so it adds
// NO npm dependency, matching this repo's jose+pg-only discipline.
//
// The REST logic (path building, status handling) is separated from the I/O TRANSPORT (`K8sRequestFn`)
// so the client is fully testable offline with a fake transport — see test/pool-runner.test.ts. The
// production transport (`inClusterRequest`) reads the projected SA token PER REQUEST (it rotates) and
// the cluster CA once, and uses node:https (custom `ca`) — a global `fetch` can't easily carry a
// per-call CA without undici internals, and https is a stable built-in.

import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

/** One API call: returns the HTTP status + raw response body. Throws only on a transport failure
 * (network/TLS) — an HTTP error status is returned, not thrown, so the client decides what a 404
 * (say) means. */
export type K8sRequestFn = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: string }>;

export interface K8sClient {
  /** POST a Pod manifest into the client's namespace. `ok` is a 2xx. */
  createPod(manifest: Record<string, unknown>): Promise<{ ok: boolean; status: number; name?: string; error?: string }>;
  /** DELETE a Pod by name. A 404 (already gone) counts as `ok` — deletion is idempotent. */
  deletePod(name: string): Promise<{ ok: boolean; status: number }>;
}

/** The standard in-cluster mount paths for a Pod's ServiceAccount credential. */
export const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
export const SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
export const SA_NAMESPACE_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

export function makeK8sClient(deps: { namespace: string; request: K8sRequestFn }): K8sClient {
  const base = `/api/v1/namespaces/${encodeURIComponent(deps.namespace)}/pods`;
  return {
    async createPod(manifest) {
      const { status, body } = await deps.request("POST", base, manifest);
      const ok = status >= 200 && status < 300;
      const name = ((manifest.metadata as { name?: string } | undefined)?.name) ?? undefined;
      // Surface the API server's reason on failure (metadata only — a K8s Status message, not content).
      return ok ? { ok, status, name } : { ok, status, error: extractStatusMessage(body) };
    },
    async deletePod(name) {
      const { status } = await deps.request("DELETE", `${base}/${encodeURIComponent(name)}`);
      return { ok: (status >= 200 && status < 300) || status === 404, status };
    },
  };
}

/** Pull the human `message` out of a K8s `Status` error body, best-effort (for logs only). */
function extractStatusMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON — fall through
  }
  return body.slice(0, 200);
}

/** The production transport: HTTPS to `apiServer`, presenting the in-cluster SA bearer token and
 * trusting the cluster CA. The token is re-read per request (projected tokens rotate); the CA is read
 * once. `readFile`/`caFile`/`tokenFile` are injectable for tests, but the real code needs none of
 * them. */
export function inClusterRequest(
  apiServer: string,
  opts: { tokenPath?: string; caPath?: string; readFile?: (p: string) => string } = {},
): K8sRequestFn {
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const tokenPath = opts.tokenPath ?? SA_TOKEN_PATH;
  const caPath = opts.caPath ?? SA_CA_PATH;
  let ca: string | undefined;
  const loadCa = (): string | undefined => {
    if (ca === undefined) {
      try {
        ca = readFile(caPath);
      } catch {
        ca = ""; // no CA available — https falls back to the system trust store
      }
    }
    return ca || undefined;
  };

  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const url = new URL(path, apiServer);
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
      let token = "";
      try {
        token = readFile(tokenPath).trim();
      } catch {
        // no token — the request will 401; let the API server say so rather than throwing here
      }
      const req = httpsRequest(
        {
          method,
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          ca: loadCa(),
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            "content-type": "application/json",
            accept: "application/json",
            ...(payload ? { "content-length": String(payload.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
}

/** Read the namespace this SecChat pod is running in (for a default when SECCHAT_POOL_NAMESPACE is
 * unset), or null when not in a cluster. */
export function inClusterNamespace(readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): string | null {
  try {
    return readFile(SA_NAMESPACE_PATH).trim() || null;
  } catch {
    return null;
  }
}

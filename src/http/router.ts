// A tiny dependency-free HTTP router. Registers method + pattern routes (patterns may contain
// `:param` segments, e.g. "/channels/:id/messages") and resolves a method/path pair to the
// matching handler plus the extracted param values. No regex engine, no external deps — routes
// are compared segment-by-segment. Generic over the handler type so this module stays
// HTTP-framework-agnostic; src/http/server.ts supplies the concrete handler signature.

export type Params = Record<string, string>;

export interface RouteMatch<H> {
  handler: H;
  params: Params;
}

interface Route<H> {
  method: string;
  segments: string[];
  handler: H;
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export class Router<H> {
  private routes: Route<H>[] = [];

  /** Register `handler` for `method` + `pattern` (e.g. "GET", "/channels/:id/messages"). */
  add(method: string, pattern: string, handler: H): void {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(pattern), handler });
  }

  /** Resolve a request method + path to its handler and `:param` values, or null if nothing
   * registered matches (exact segment-count match; first-registered wins on overlap). */
  match(method: string, path: string): RouteMatch<H> | null {
    const reqMethod = method.toUpperCase();
    const reqSegments = splitPath(path);

    for (const route of this.routes) {
      if (route.method !== reqMethod || route.segments.length !== reqSegments.length) continue;

      const params: Params = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const routeSeg = route.segments[i]!;
        const reqSeg = reqSegments[i]!;
        if (routeSeg.startsWith(":")) {
          params[routeSeg.slice(1)] = decodeURIComponent(reqSeg);
        } else if (routeSeg !== reqSeg) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

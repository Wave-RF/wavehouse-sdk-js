const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** Whether a (port-less, lower-cased) host is the local machine: plain HTTP is the right default there. */
function isLoopback(host: string): boolean {
  const h = host.replace(/\.$/, "");
  return (
    h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || /^127(\.\d{1,3}){3}$/.test(h)
  );
}

/**
 * Give a scheme-less `baseURL` a scheme: `http://` for a loopback host
 * (`localhost`, `127.0.0.0/8`, `::1`, `*.localhost`), `https://` for anything
 * else. An explicit scheme is kept as typed, apart from its case, so an
 * `http://` is never upgraded. Works on the string, not through `URL#href`,
 * which would add a trailing slash and change how a path prefix joins. The
 * `wavehouse-sdk-go` client applies the same rule.
 *
 * `new URL("localhost:8080")` parses, as scheme `localhost:`, so a scheme is
 * detected by `scheme://`, never by a failed parse.
 *
 * @internal
 */
export function normalizeBaseURL(input: string): string {
  const base = input.trim();
  const explicit = SCHEME.exec(base);
  if (explicit) return explicit[0].toLowerCase() + base.slice(explicit[0].length);

  const rest = base.replace(/^\/\/+/, "");
  if (rest === "") return rest;
  // The host: the authority without its credentials and port.
  const authority = rest.split(/[/?#]/, 1)[0].replace(/^.*@/, "");
  if (authority === "::1") return `http://[::1]${rest.slice(authority.length)}`;
  const host = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : authority.replace(/:\d*$/, "");
  return `${isLoopback(host.toLowerCase()) ? "http" : "https"}://${rest}`;
}

/**
 * Resolve an SDK request path against the configured `baseURL`.
 *
 * The single URL-construction rule for every transport (REST in `http.ts`, SSE
 * in `stream/sse.ts`, the codegen CLI). Request paths are joined **onto** the
 * base rather than resolved as absolute ones, so a base carrying a path prefix
 * — `https://app.example.com/api/warehouse`, a WaveHouse behind a BFF,
 * app-server route, or path-routed ingress — keeps that prefix. Resolving
 * `/v1/query` against such a base would silently discard it (#428).
 *
 * @internal
 */
export function resolveURL(base: string, path: string, params?: Record<string, string>): URL {
  let root: URL;
  try {
    root = new URL(normalizeBaseURL(base));
  } catch {
    throw new TypeError(
      `baseURL ${JSON.stringify(base)} is not a usable URL: give a host, with an optional scheme, port and path prefix, such as "https://example.com/api"`,
    );
  }
  // Normalize the base to a directory: a bare last segment (or a query/fragment
  // shadowing one) makes relative resolution *replace* the prefix, not extend it.
  root.search = "";
  root.hash = "";
  if (!root.pathname.endsWith("/")) root.pathname += "/";

  const url = new URL(path.replace(/^\/+/, ""), root);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return url;
}

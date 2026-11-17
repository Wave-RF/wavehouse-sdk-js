// ============================================================================
// @wavehouse/sdk — Public Type Definitions
// ============================================================================

// --- Database type helper ---

/** User-provided database schema mapping table names to row types. */
export type Database = Record<string, Record<string, unknown>>;

// --- Result types ---

/**
 * Discriminated union for the async SDK calls that return one. Never throws for
 * anything the server returns. A `baseURL` that names no host (a bare path such
 * as `/api/warehouse`) or carries a query or fragment throws from `createClient`;
 * a `baseURL` that is otherwise unusable (`https://[`) and a rejecting `auth`
 * callback throw from the call, while a runtime with no `fetch` at all surfaces
 * instead as a retried `NETWORK_ERROR` result.
 *
 * `.stream()` and `.liveQuery()` return no `Result` and report the last three
 * differently: an unusable `baseURL` reaches the subscriber's `error` callback
 * as a terminal `SSE_CONNECT_ERROR`, a rejecting `auth` as a retryable
 * `SSE_AUTH_ERROR`, and only a missing `fetch` throws from the call itself.
 *
 * Discriminated on `ok`: `if (result.ok)` narrows to the success arm (and tells
 * the compiler `data` is present), while `error` is always available for
 * debugging on failure. `data`/`error` remain populated as before.
 */
export type Result<T> =
  | { ok: true; data: T; error: null; hasMore?: boolean; next?: () => Promise<Result<T>> }
  | { ok: false; data: null; error: WaveHouseError; hasMore?: false; next?: undefined };

/** Structured error returned by all SDK operations. */
export interface WaveHouseError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  /**
   * On an API answer, the server's own verdict that it is transient, which
   * `wh.sql()` and pipe calls may carry without the SDK resending them. On a
   * transport error it is whether this call may be sent again: cleared for a
   * `wh.sql()` or pipe call whose request may have reached the server.
   */
  retryable: boolean;
}

// --- Filter operators ---

/**
 * SDK filter operators (translated to backend equivalents): the set the
 * server's structured-query endpoint accepts. There is no negated `like`.
 */
export type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "like";

// --- Streaming types ---

export type StreamStatus = "connecting" | "live" | "reconnecting" | "closed";

export interface StreamEvent<T = Record<string, unknown>> {
  table: string;
  timestamp: string;
  data: T;
}

export interface StreamSubscriber<T = Record<string, unknown>> {
  /** Called once with historical backfill data. */
  initial?: (result: Result<T[]>) => void;
  /** Called for each live event. */
  next: (event: StreamEvent<T>) => void;
  /** Called when stream connection status changes. */
  status?: (state: StreamStatus) => void;
  /** Called on stream errors. */
  error?: (err: WaveHouseError) => void;
}

// --- Client config ---

export interface ClientConfig<_DB extends Database = Database> {
  /**
   * Base URL of the WaveHouse server (e.g. "http://localhost:8080"). May include
   * a path prefix ("https://app.example.com/api/warehouse") for a WaveHouse
   * behind a backend-for-frontend (BFF), app-server route, or path-routed
   * ingress; request paths are appended to it. The proxy in front must strip
   * the prefix before forwarding.
   *
   * Must name a **host**; the scheme may be left off (`http://` for a loopback
   * host, `https://` otherwise). A bare path such as "/api/warehouse" has no
   * host, so `createClient` throws a `TypeError` for it, as it does for a query
   * string or fragment. Build an absolute one:
   * `` `${location.origin}/api/warehouse` ``. A base that is otherwise unusable
   * is reported per call: a REST call rejects with a `TypeError`, and a stream
   * reports `SSE_CONNECT_ERROR` to the subscriber's `error` callback.
   */
  baseURL: string;
  /**
   * Auth token provider. Omit for public/unauthenticated access.
   *
   * The contract: the SDK calls it **before every attempt** — each retry of a
   * REST call and each (re)connect of a stream runs it again, so a token that
   * changed in between is the one sent. It must therefore be cheap: caching,
   * refreshing and de-duplicating concurrent refreshes are the implementer's
   * job, not the SDK's. Return an empty string to send no `Authorization`
   * header. A rejection throws out of a REST call (it is never retried) and is
   * a retryable `SSE_AUTH_ERROR` on a stream.
   */
  auth?: () => Promise<string> | string;
  /** Additional client options. */
  options?: ClientOptions;
}

/**
 * A `fetch`-compatible function.
 *
 * Spelled out rather than written `typeof fetch`, which resolves differently
 * depending on whether the consumer's TypeScript `lib` includes DOM — the same
 * signature either way, but stable across configurations.
 *
 * The parameter is `string` rather than `typeof fetch`'s wider union because a
 * string URL is all the SDK ever passes. Since parameters are contravariant,
 * narrowing it *widens* what can be assigned: the global `fetch` still fits, and
 * so does hand-written `(url: string, init?: RequestInit) => Promise<Response>`
 * middleware, which the wider spelling rejects at compile time.
 *
 * On REST the SDK reads `.ok` and `.headers` always, `.text()` on success, and
 * `.status`, `.statusText` plus `.json()` when the response is not `ok`. A
 * rejection becomes a `NETWORK_ERROR` result and is retried with backoff on
 * reads and ingest, but not on raw SQL (`wh.sql()`) or pipe calls, which are
 * resent only when the connection was certainly never made — unless the
 * `AbortSignal` you passed has been aborted, in which case the result is
 * `ABORTED` and nothing is retried. That is decided from the signal
 * rather than the rejection's type, so an implementation that throws something
 * other than a `DOMException` named `AbortError` — `AbortSignal.timeout()`,
 * `node-fetch` — is reported the same way.
 *
 * **Honor `init.signal`.** The SDK aborts it to cancel a call or close a stream,
 * and relies on the rejection or errored body that follows. An implementation
 * that ignores the signal keeps a request (and, for a stream, a socket) running
 * after the caller has let go of it.
 *
 * **Streaming needs more.** `.stream()` and `.liveQuery()` read the response as
 * it arrives, via `.body.getReader()`, so an implementation used with them must
 * return a response carrying a live `ReadableStream` — something the type cannot
 * enforce, since `Response.body` is legitimately nullable. A response handed
 * back with an absent or already-consumed body fails fast with
 * `SSE_NO_STREAM_BODY`. What the SDK *cannot* rescue is an implementation that
 * awaits the body before returning — `await res.text()`, or the
 * `res.clone().text()` a logging wrapper reaches for — because on a stream that
 * never ends, that never resolves and your function never returns. Both satisfy
 * every REST call, which is what makes the trap easy to walk into.
 *
 * Implementations shipping their own request/response declarations (undici,
 * `node-fetch`) need casts on the init and the return value, since those types
 * are separate from the ones behind your global `fetch`; the narrow runtime
 * contract above is what makes them safe.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A function form of `options.headers`: called before every attempt and every
 * stream connect, for credentials that rotate. It follows the contract of
 * `auth`: it must be cheap, and caching is the implementer's job.
 */
export type HeadersProvider = () => Record<string, string> | Promise<Record<string, string>>;

export interface ClientOptions {
  /** Maximum retry attempts for failed requests: a non-negative integer, else the client throws. Default: 2. */
  maxRetries?: number;
  /**
   * A deadline for each attempt on its own, in milliseconds, so a stalled
   * attempt is retried instead of holding the whole call. Default: off. A
   * per-call `attemptTimeoutMs` overrides it, and `0` turns it off for that
   * call.
   *
   * It runs from sending the request to the end of the response body, linked to
   * the caller's `signal`: the caller's own abort still ends the call at once
   * with `ABORTED` and is never retried. An attempt that hits it is retried
   * after a backoff while `maxRetries` allows, with the same safety rules as any
   * network error — `wh.sql()` and pipe calls are not resent once the request
   * may have been sent, which a timeout always counts as. The call that gives
   * up returns `ATTEMPT_TIMEOUT`, naming the number of attempts.
   *
   * For `.stream()` and `.liveQuery()` it bounds each connect, up to the
   * response headers, and never an established stream, which is long-lived.
   */
  attemptTimeoutMs?: number;
  /**
   * Longest `Retry-After` wait, in milliseconds, a REST call will sit through
   * before resending. It applies to any retryable answer (5xx, 408, 429) the
   * call may resend; when the server asks for more, the wait is clamped to this
   * and the call retries while attempts remain. `Retry-After` may be seconds or
   * an HTTP-date. Default: 30000, the backoff ceiling.
   */
  maxRetryAfterMs?: number;
  /**
   * HTTP implementation used for every request, REST and streaming alike.
   * Defaults to the global `fetch`.
   *
   * Provide one to route through a proxy, attach client certificates, add
   * middleware (logging, tracing, circuit breaking), or bypass a transport bug
   * in the runtime's bundled HTTP stack by routing through an implementation
   * you install yourself — e.g. an undici new enough to be free of
   * {@link https://github.com/nodejs/undici/issues/5600 | undici #5600}:
   *
   * ```ts
   * import { Agent, fetch as undiciFetch } from "undici"; // npm install undici — 8.10.0+
   * // Pass the dispatcher explicitly: undici's pool lives on a shared
   * // globalThis symbol claimed by whichever copy loaded first, so an implied
   * // dispatcher can still be the runtime's affected one.
   * const dispatcher = new Agent();
   * createClient({
   *   baseURL,
   *   options: {
   *     fetch: (url, init) =>
   *       undiciFetch(url, { ...init, dispatcher } as never) as unknown as Promise<Response>,
   *   },
   * });
   * ```
   *
   * `.stream()` and `.liveQuery()` go through it too, which imposes the extra
   * streaming requirement described on {@link FetchLike} — read that before
   * supplying a wrapper that touches the response body.
   */
  fetch?: FetchLike;
  /**
   * Headers added to every request, REST and streaming alike — for a
   * header-gated proxy in front of WaveHouse, such as a Cloudflare Access
   * service token.
   *
   * Matched case-insensitively, as HTTP headers are. Applied underneath the
   * SDK's own headers: `auth` still owns `Authorization`, and the
   * `Content-Type` and `Accept` a given request needs are not overridable
   * here — a global `Content-Type` that outranked the request's own is a
   * documented way to break uploads. Precedence, lowest to highest: these
   * headers, a per-call `headers`, `auth`'s `Authorization`, then the SDK's own;
   * a later layer replaces a header of the same name and never joins with it.
   *
   * May be a function, for credentials that rotate: it is called before every
   * attempt and every stream connect, under the same contract as `auth` — it
   * must be cheap, and caching is yours to do. A rejection throws out of a REST
   * call, and is a retryable `SSE_AUTH_ERROR` on a stream.
   *
   * In a browser these are subject to CORS: a header outside the safelist adds
   * it to the preflight, which the origin must allow. WaveHouse's own CORS
   * advertises a fixed set, so custom headers reach it cross-origin only when
   * a proxy in front terminates the preflight — which is the deployment they
   * exist for. Server-side callers never preflight.
   */
  headers?: Record<string, string> | HeadersProvider;
  /**
   * Extra `RequestInit` fields merged into every request — `credentials` for a
   * cookie-authenticated origin, `mode`, `cache`, `keepalive`, or a
   * runtime-specific extension such as Next.js's `next: { tags }`.
   *
   * A per-call `fetchOptions` is merged over this, field by field (shallowly).
   * Fields the SDK controls (`method`, `headers`, `body`, `signal`) always
   * win, so this cannot corrupt the request itself. Non-standard fields may
   * need a cast, since `RequestInit` only declares the standard ones.
   *
   * The streaming transport additionally owns `cache` and `redirect`, where the
   * values are load-bearing rather than preference: a `Cache-Control` header
   * would fail cross-origin preflight, and following a redirect would strip the
   * `Authorization` header on a cross-origin hop and silently downgrade the
   * stream to the default role instead of failing. So a request carrying an
   * `auth` token, configured `headers` that may hold a proxy secret, or (in a
   * browser) `credentials: "include"` refuses redirects (`SSE_REDIRECT`);
   * without any of them it follows them, so CDN canonicalization and an
   * http→https upgrade still work. Cookies relied on through the implicit
   * `same-origin` default are **invisible to that test**, since that default
   * cannot be told from a deployment with no cookies. A cookie is re-derived
   * from the cookie store at each hop rather than carried, so under the default
   * `same-origin` credentials mode a redirect keeps the stream authenticated
   * only while the hop stays inside both the request's origin and the cookie's
   * `Path`; a hop outside either arrives with no cookie and gets a
   * `default_role` view rather than an error.
   * With `credentials: "include"` the origin half is replaced rather than
   * lifted: ordinary cookie scoping decides, so the cookie crosses a
   * CORS-allowed cross-origin hop only if its own `Domain` covers the target —
   * a host-only cookie, the default, still stops at its host. Spelled out
   * under "Supplying your own `fetch`" in the SDK guide; see #478.
   * `credentials` itself is honored in browsers and dropped elsewhere, since
   * some runtimes throw if it is set.
   */
  fetchOptions?: RequestInit;
}

// --- Structured query AST (matches backend wire format) ---

export interface StructuredQuery {
  /**
   * Explicit columns to project. A literal "*" is a column named "*", not a
   * wildcard. Omitting columns (with no aggregations and no select_all) selects
   * nothing — use select_all for a full-row read. Mutually exclusive with
   * select_all.
   */
  columns?: string[];
  /**
   * Request every column the caller's role may read (the all-columns wildcard,
   * expanded server-side to the allowed/denied set). Mutually exclusive with a
   * non-empty columns list.
   */
  select_all?: boolean;
  aggregations?: Aggregation[];
  filters?: QueryFilter[];
  group_by?: string[];
  order_by?: OrderClause[];
  limit?: number;
  time_range?: TimeRange;
}

export interface Aggregation {
  fn: string;
  column: string;
  /** Omitted from the wire when empty; the server then names the column. */
  alias?: string;
}

export interface QueryFilter {
  column: string;
  op: string;
  value: unknown;
}

export interface OrderClause {
  column: string;
  dir: "asc" | "desc";
}

/**
 * A relative span for `last()`: a number and a unit, such as `"90s"`, `"1h"`,
 * `"7d"` or `"2w"`. The units are ms, s, m, h, d and w.
 */
export type Duration = `${number}${"ms" | "s" | "m" | "h" | "d" | "w"}`;

export interface TimeRange {
  column: string;
  since: string;
  until?: string;
}

// --- Schema types ---

export interface Column {
  name: string;
  type: string;
  is_nullable: boolean;
  /** Whether the column declares any default at all — see `default_kind`. */
  has_default: boolean;
  /**
   * How the default is declared, when there is one: `DEFAULT`, `MATERIALIZED`,
   * `ALIAS` or `EPHEMERAL`. Omitted when the column declares none.
   *
   * `MATERIALIZED` and `ALIAS` columns are computed by ClickHouse and cannot be
   * inserted — a record naming one is rejected — so they never appear in an
   * ingest envelope or an SSE `schema` frame, though they are still reported
   * here and are still queryable.
   */
  default_kind?: string;
  /** 1-based ordinal in the table's declaration order — the order `columns` itself is in. Always present. */
  position: number;
  /** The column's DEFAULT expression, absent when it declares none. */
  default_expression?: string;
}

export interface TableSchema {
  name: string;
  columns: Column[];
}

export type Schemas = Record<string, TableSchema>;

// --- Insert result ---

/**
 * A per-record outcome from a batch (array / NDJSON / CSV / TSV) insert. Mirrors the
 * single-object response shape plus the record's position. Exactly one of
 * `ok` / `duplicate` / `error` is set.
 */
export interface InsertRecordResult {
  /** 1-based index of the record within the submitted batch. */
  index: number;
  /** Set when the record was validated and published. */
  ok?: boolean;
  /** Set when dedup skipped the record. */
  duplicate?: boolean;
  /**
   * Set (with `ok`/`duplicate` absent) when the record was rejected by the
   * gateway: a failed policy check, a missing dedupe id or a `422` decline. A
   * record ClickHouse's parser refuses refuses the whole request instead, as a
   * `400` whose `error.code` is `"clickhouse.rejected"` and whose
   * `error.details.exception_code` carries ClickHouse's code (117 also covers a
   * column the caller's role may not write).
   */
  error?: string;
}

export interface InsertResult {
  /** True for a fully successful insert: a single row, or a batch with no rejected records (`failed === 0`). */
  ok: boolean;
  /** Single insert only: set when dedup skipped the row. */
  duplicate?: boolean;
  /** Batch insert (array / NDJSON): number of records submitted. */
  total?: number;
  /** Batch insert: records validated and published. */
  succeeded?: number;
  /** Batch insert: records rejected — see `results`. */
  failed?: number;
  /** Batch insert: records skipped by dedup. */
  duplicates?: number;
  /** Batch insert: per-record outcomes, each `{index, ok|duplicate|error}` (may be truncated for very large batches; the counts stay authoritative). */
  results?: InsertRecordResult[];
}

// --- DLQ types ---

export interface DLQStats {
  tables: Record<string, number>;
  total: number;
}

// --- Pipe types ---

export interface Pipe {
  name: string;
  sql: string;
  parameters?: ParamDef[];
  description?: string;
  allowed_roles?: string[];
}

export interface ParamDef {
  name: string;
  type: string;
  required?: boolean;
  default?: unknown;
}

// --- Policy types ---

export interface Policy {
  default_role?: string;
  admin_role?: string;
  tables: Record<string, TablePolicy>;
}

/**
 * Access control for one table, keyed by role name. A role appears once per
 * table and states what it may do; omit `select` to deny reads, omit `insert`
 * to deny writes.
 */
export type TablePolicy = Record<string, RolePermissions>;

export interface RolePermissions {
  select?: SelectPermissions;
  insert?: InsertPermissions;
}

/** A role's read grant on a table. */
export interface SelectPermissions {
  allow_columns?: string[];
  deny_columns?: string[];
  filter?: Record<string, PolicyFilter>;
  allowed_aggregations?: string[];
  denied_aggregations?: string[];
  /** Caps the query result LIMIT. 0 = no limit. */
  max_rows?: number;
  /**
   * Max query execution time, enforced server-side by ClickHouse. Set it as a
   * duration string ("5s", "500ms") or a number of milliseconds; reads always
   * return the number of milliseconds.
   */
  max_execution_time?: number | string;
  /** Max rows scanned from storage, enforced server-side by ClickHouse. 0 = no limit. */
  max_rows_to_read?: number;
  /**
   * Max peak query memory, enforced server-side by ClickHouse. Set it as a size
   * string ("4GiB", "512MiB") or a number of bytes; reads always return the
   * number of bytes.
   */
  max_memory_usage?: number | string;
}

/** A role's write grant on a table. */
export interface InsertPermissions {
  allow_columns?: string[];
  deny_columns?: string[];
  check?: Record<string, PolicyFilter>;
}

export interface PolicyFilter {
  _eq?: string;
  _neq?: string;
  _gt?: string;
  _lt?: string;
  _in?: string;
}

// --- Settings types ---

/** One validation finding from the server's settings directory. */
export interface SettingsFinding {
  severity: "error" | "warning";
  /**
   * Settings file the finding is about; absent for directory-level findings.
   */
  file?: string;
  /** Dotted JSON path within the file; absent for whole-file findings. */
  path?: string;
  message: string;
}

/** Body of POST /v1/ops/settings/reload. */
export interface SettingsReloadResult {
  /**
   * Whether everything the reload covered was adopted; false leaves the
   * previous settings in effect.
   */
  adopted: boolean;
  /** Every finding from the validation pass (warnings included on success). */
  findings: SettingsFinding[];
}

// --- Per-call request options ---

/**
 * What every REST call takes: a signal, and per-call overrides of the client's
 * `options`.
 */
export interface CallOptions {
  signal?: AbortSignal;
  /**
   * This call's own per-attempt deadline in milliseconds, over the client's
   * `options.attemptTimeoutMs`; `0` switches it off for this call.
   */
  attemptTimeoutMs?: number;
  /**
   * Headers for this call, over the client's `options.headers` and under
   * `auth`'s `Authorization` and the SDK's own `Content-Type` and `Accept`.
   * Matched case-insensitively; a header here replaces the client's of the same
   * name and is never joined with it.
   */
  headers?: Record<string, string>;
  /**
   * `RequestInit` fields for this call, merged over the client's
   * `options.fetchOptions` — Next.js's `next: { tags }` on one query, say.
   * The fields the SDK controls (`method`, `headers`, `body`, `signal`) still
   * win.
   */
  fetchOptions?: RequestInit;
  /**
   * An implementation of `fetch` for this call alone, over `options.fetch` —
   * a framework's request-scoped `fetch`, such as SvelteKit's `load()` one. The
   * contract on {@link FetchLike} applies.
   */
  fetch?: FetchLike;
}

/**
 * Options for a single call, passed to `.fetch()`.
 *
 * Note that `await`ing a builder directly (`await wh.from("t").select("*")`)
 * takes no options — use the explicit `.fetch({ … })` form for those.
 */
export interface RequestOptions extends CallOptions {
  limit?: number;
}

/**
 * Options for a single `PipeRef.fetch()` call.
 *
 * `limit` is declared `never` rather than simply left out. Omitting it would
 * still admit a `RequestOptions` value that carries one — excess-property
 * checking only rejects fresh object literals, so a variable would pass and the
 * limit would be silently dropped, which is the whole defect this prevents.
 *
 * A pipe's row cap belongs in its SQL as a `{{limit}}` parameter, supplied via
 * `wh.pipe(name, { limit })`.
 */
export interface PipeRequestOptions extends CallOptions {
  /** Not supported on pipes — pass `limit` as a pipe parameter instead. */
  limit?: never;
}

/**
 * Options for a call to one of the admin routes: `wh.pipes.list()`,
 * `wh.pipes.get()`, `wh.settings.reload()`, `wh.schema.list()`,
 * `wh.schema.refresh()`, `wh.from(t).schema()`, `wh.dlq.list()`,
 * `wh.dlq.table()` and `wh.sql()`.
 */
export type OpsRequestOptions = CallOptions;

/** The server's build, from `GET /version`. */
export interface VersionInfo {
  /** The release without its leading "v", or a pseudo-version. */
  version: string;
  git_commit: string;
  build_time: string;
  /** The server's Go runtime. */
  go_version: string;
}

// --- Stream options ---

export interface StreamOptions {
  since?: string;
  signal?: AbortSignal;
  /**
   * Headers for this subscription's connections, over the client's
   * `options.headers` and under the SDK's own, with the precedence of
   * {@link CallOptions.headers}.
   */
  headers?: Record<string, string>;
  /**
   * This subscription's per-attempt deadline for each connect, in milliseconds,
   * over the client's `options.attemptTimeoutMs`; `0` switches it off.
   */
  attemptTimeoutMs?: number;
}

// --- Internal HTTP context ---

/** @internal */
export interface HttpContext {
  baseURL: string;
  auth?: () => Promise<string> | string;
  // `fetch` stays optional rather than defaulted here, to keep the global late-bound.
  options: {
    maxRetries: number;
    maxRetryAfterMs?: number;
    attemptTimeoutMs?: number;
    fetch?: FetchLike;
    headers?: Record<string, string> | HeadersProvider;
    fetchOptions?: RequestInit;
  };
}

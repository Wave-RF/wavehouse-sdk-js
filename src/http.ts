import { networkError, parseErrorResponse } from "./errors.js";
import type { CallOptions, HttpContext, OpsRequestOptions, WaveHouseError } from "./types.js";
import { resolveURL } from "./url.js";

interface RequestSpec {
  method: string;
  path: string;
  body?: unknown;
  /**
   * Pre-serialized request body, sent verbatim (no `JSON.stringify`) — e.g.
   * NDJSON text. Takes precedence over `body`. Must be re-sendable so retries
   * work, hence a string rather than a stream.
   */
  rawBody?: string;
  /** Override the request Content-Type (default `application/json`). */
  contentType?: string;
  params?: Record<string, string>;
  signal?: AbortSignal;
  /** Per-call override of the client's `attemptTimeoutMs`; see {@link CallOptions}. */
  attemptTimeoutMs?: number;
  /**
   * How safely a call can be sent twice. `read` (the default, and ingest, which
   * dedupes) retries as before. `sql` and `pipe` may run a write, so they are
   * resent only when the first attempt certainly did nothing — see `mayResend`.
   */
  kind?: CallKind;
}

/** @internal */
export type CallKind = "read" | "pipe" | "sql";

/** @internal */
export interface HttpResult<T> {
  data: T | null;
  error: WaveHouseError | null;
  headers: Headers;
}

/**
 * Merge configured headers underneath the SDK's own, matching names
 * case-insensitively so a caller's `authorization` can't sit alongside our
 * `Authorization` and let the server pick. Canonical casing wins, and values
 * replace rather than append — a header joined instead of replaced is a known
 * way to produce `Content-Type: application/json, image/png`.
 *
 * Shared with the SSE transport so both paths resolve `headers` the same way,
 * rather than growing a second precedence story.
 *
 * @internal
 */
export function mergeHeaders(
  base: Record<string, string>,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  if (!extra) return base;
  const sdkNames = new Set(Object.keys(base).map((k) => k.toLowerCase()));
  const merged = { ...base };
  // Spelling each configured name was last stored under, so two entries
  // differing only in case replace each other here rather than surviving as
  // separate keys for `Headers` to comma-join at fetch time.
  const configured = new Map<string, string>();
  for (const [name, value] of Object.entries(extra)) {
    const lower = name.toLowerCase();
    // Skip rather than overwrite: `base` is the SDK's own, which outranks.
    if (sdkNames.has(lower)) continue;
    const prior = configured.get(lower);
    if (prior !== undefined) delete merged[prior];
    merged[name] = value;
    configured.set(lower, name);
  }
  return merged;
}

/**
 * The per-call fields of an options object, for spreading into a `RequestSpec`.
 * Picks fields by name so an options value carrying anything else (`limit`,
 * `tenant`) never leaks into the spec.
 *
 * @internal
 */
export function callOpts(opts?: CallOptions): Pick<RequestSpec, "signal" | "attemptTimeoutMs"> {
  return { signal: opts?.signal, attemptTimeoutMs: opts?.attemptTimeoutMs };
}

/** A usable per-attempt timeout: a positive finite number of milliseconds. */
export function attemptTimeout(ms: number | undefined): number | undefined {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * One attempt's own deadline, linked to the caller's signal. Firing the timer
 * aborts `signal` (what `fetch` gets) and rejects `race`, which covers a `fetch`
 * that ignores its signal; the caller's abort propagates too, so either ends the
 * attempt, and `timedOut` says which. Without a timeout it is the caller's
 * signal and a no-op.
 *
 * @internal
 */
export function attemptGuard(caller: AbortSignal | undefined, ms: number | undefined) {
  if (ms === undefined) {
    return {
      signal: caller,
      timedOut: false,
      race: <T>(p: Promise<T>) => p,
      dispose: () => {},
    };
  }
  const ac = new AbortController();
  const guard = {
    signal: ac.signal as AbortSignal | undefined,
    timedOut: false,
    race: <T>(p: Promise<T>): Promise<T> => Promise.race([p, rejected]),
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCaller);
    },
  };
  const rejected = new Promise<never>((_, reject) => {
    ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true });
  });
  // Unhandled otherwise: it only rejects when nothing is racing it any more.
  rejected.catch(() => {});
  const onCaller = () => ac.abort(caller?.reason);
  if (caller?.aborted) ac.abort(caller.reason);
  else caller?.addEventListener("abort", onCaller, { once: true });
  const timer = setTimeout(() => {
    guard.timedOut = true;
    ac.abort(new DOMException(`Attempt timed out after ${ms} ms`, "TimeoutError"));
  }, ms);
  return guard;
}

/**
 * The `?tenant=` query an admin call sends for `opts.tenant`. An empty string
 * is sent, not dropped: the server refuses it, where dropping it would turn a
 * caller's bug into a call that addresses the default tenant — or, on a
 * reload, every tenant.
 *
 * @internal
 */
export function tenantParam(opts?: OpsRequestOptions): Record<string, string> | undefined {
  return opts?.tenant === undefined ? undefined : { tenant: opts.tenant };
}

/** The documented shape for a cancelled request: a Result, never a throw. */
function abortedResult<T>(): HttpResult<T> {
  return {
    data: null,
    error: { status: 0, code: "ABORTED", message: "Request aborted", retryable: false },
    headers: new Headers(),
  };
}

// Errors from a connection that was never made, so no byte of the request left.
const NEVER_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * True only when `fetch` failed before connecting. Node/undici put the system
 * error on `cause` (an AggregateError of them when several addresses were
 * tried); a browser's bare TypeError says nothing, so it reads as "may have
 * been sent".
 */
function neverSent(e: unknown): boolean {
  const seen = new Set<unknown>();
  const check = (err: unknown): boolean => {
    if (typeof err !== "object" || err === null || seen.has(err)) return false;
    seen.add(err);
    const { code, cause, errors } = err as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof code === "string" && NEVER_SENT_CODES.has(code)) return true;
    if (Array.isArray(errors) && errors.length > 0 && errors.every(check)) return true;
    return check(cause);
  };
  return check(e);
}

/**
 * Whether an error answer may be sent again. A raw SQL statement or a write
 * pipe may already have run, and a gateway can answer 5xx after it did, so
 * those resend only on the server's own word that it is safe.
 */
function mayResendResponse(kind: CallKind, error: WaveHouseError, res: Response): boolean {
  if (kind === "read") return true;
  if (kind === "sql") return false;
  const body = error.details as { retryable?: unknown } | undefined;
  const serverSaid = typeof body?.retryable === "boolean";
  if (serverSaid) return body?.retryable === true;
  return res.status === 429 || (res.status === 503 && res.headers.has("Retry-After"));
}

/**
 * Internal fetch wrapper with auth injection, retry, backoff, and Retry-After.
 * @internal
 */
export async function request<T>(ctx: HttpContext, opts: RequestSpec): Promise<HttpResult<T>> {
  const url = resolveURL(ctx.baseURL, opts.path, opts.params).toString();
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  // Serialize once so every retry attempt re-sends an identical body.
  const requestBody: string | undefined =
    opts.rawBody !== undefined
      ? opts.rawBody
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;

  // Only a request with a body describes one. On a bodyless GET the header
  // would also make a cross-origin browser read preflight, since
  // application/json is not a CORS-safelisted Content-Type.
  if (requestBody !== undefined) {
    headers["Content-Type"] = opts.contentType ?? "application/json";
  }

  const kind = opts.kind ?? "read";
  let lastError: WaveHouseError | null = null;
  const maxAttempts = ctx.options.maxRetries + 1;

  const timeoutMs = attemptTimeout(opts.attemptTimeoutMs ?? ctx.options.attemptTimeoutMs);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Resolved before every attempt, not once per call: a token that changed
    // during a backoff is the one a retry sends. Outside the `try` below, so a
    // rejection throws out of `request` as it always has instead of being
    // retried as a network error. `auth` is called synchronously on the first
    // attempt: a liveQuery depends on which of the stream and the backfill
    // reaches it first.
    const sdkHeaders = { ...headers };
    if (ctx.auth) {
      const token = await ctx.auth();
      if (token) {
        sdkHeaders.Authorization = `Bearer ${token}`;
      }
    }
    // After auth, so `auth` keeps ownership of Authorization, and after the
    // Content-Type/Accept this request needs.
    const finalHeaders = mergeHeaders(sdkHeaders, ctx.options.headers);

    const guard = attemptGuard(opts.signal, timeoutMs);
    try {
      // Configured RequestInit first, so the fields the SDK controls overwrite
      // it — a supplied `method` or `body` would otherwise corrupt the request.
      const init: RequestInit = {
        ...ctx.options.fetchOptions,
        method: opts.method,
        headers: finalHeaders,
        body: requestBody,
        signal: guard.signal,
      };
      // Call the global directly when no override is configured, rather than
      // capturing it — a detached `fetch` reference is not universally safe to
      // invoke, and late binding is what lets tests swap `globalThis.fetch`.
      const doFetch = ctx.options.fetch;
      const res = await guard.race(doFetch ? doFetch(url, init) : fetch(url, init));

      if (res.ok) {
        const text = await guard.race(res.text());
        const data = text ? (JSON.parse(text) as T) : (undefined as T);
        return { data, error: null, headers: res.headers };
      }

      const error = await guard.race(parseErrorResponse(res));

      if (!mayResendResponse(kind, error, res)) {
        return { data: null, error, headers: res.headers };
      }

      // The server's own wait, from Retry-After, for the answers that carry one:
      // a 429 the server has not marked `retryable: false`, and any 503. A raw
      // SQL statement never gets here (see `mayResendResponse`).
      const mayWait = (res.status === 429 && error.retryable) || res.status === 503;
      const retryAfter = res.headers.get("Retry-After");
      if (mayWait && (res.status === 429 || retryAfter) && attempt < maxAttempts - 1) {
        const wait = parseRetryAfter(retryAfter, Date.now());
        const cap = ctx.options.maxRetryAfterMs ?? MAX_BACKOFF_MS;
        // Sleeping an hour inside a call the caller thinks is short is worse
        // than handing back the server's answer.
        if (wait !== undefined && wait > cap) {
          return { data: null, error, headers: res.headers };
        }
        guard.dispose();
        await sleep(wait === undefined ? backoff(attempt) : jitter(wait), opts.signal);
        lastError = error;
        continue;
      }

      // Retryable server errors (5xx)
      if (error.retryable && attempt < maxAttempts - 1) {
        guard.dispose();
        await sleep(backoff(attempt), opts.signal);
        lastError = error;
        continue;
      }

      return { data: null, error, headers: res.headers };
    } catch (e) {
      // Classified on the *signal*, never the rejection's type. Keying off the
      // error made the outcome depend on `maxRetries` — an implementation that
      // throws something other than a `DOMException` named `AbortError`
      // (`AbortSignal.timeout()` raises a `TimeoutError`, `node-fetch` its own
      // class) fell through to NETWORK_ERROR here and was reclassified only if
      // a retry remained for the backoff to notice the signal.
      //
      // Matching on the error would also misread middleware: an `options.fetch`
      // enforcing its own per-attempt deadline aborts an internal controller
      // and rejects with a real `AbortError` while the caller's signal is
      // untouched. Nobody asked to cancel, so that is a transient failure to
      // retry, not a terminal `ABORTED`.
      if (opts.signal?.aborted) {
        return abortedResult<T>();
      }

      lastError = guard.timedOut
        ? attemptTimeoutError(timeoutMs ?? 0, attempt + 1)
        : networkError(e);
      // The request may have reached the server; resending could run it twice.
      // Reported as not retryable too: `retryable` tells the caller a resend is safe.
      if (kind !== "read" && !neverSent(e)) {
        lastError = { ...lastError, retryable: false };
        break;
      }
      if (attempt < maxAttempts - 1) {
        // This sleep is the one that runs inside the catch, so unlike the two
        // in the try above, an abort raised *by* the backoff would escape
        // `request()` as a raw DOMException instead of the documented ABORTED
        // result — and no caller wraps this, so it would reach the consumer as
        // an unhandled rejection.
        guard.dispose();
        try {
          await sleep(backoff(attempt), opts.signal);
        } catch (abort) {
          // Same rule as above, so the two classifications can't drift apart.
          // `sleep` only rejects when the signal fires, so this always holds.
          if (opts.signal?.aborted) {
            return abortedResult<T>();
          }
          throw abort;
        }
      }
    } finally {
      guard.dispose();
    }
  }

  return { data: null, error: lastError!, headers: new Headers() };
}

/**
 * What a call ends with when its last attempt hit `attemptTimeoutMs`. Not a
 * caller abort (that is `ABORTED`), and it says how many attempts were made.
 * Retryable here; the catch below clears that for a call that may have written.
 */
function attemptTimeoutError(ms: number, attempts: number): WaveHouseError {
  return {
    status: 0,
    code: "ATTEMPT_TIMEOUT",
    message: `Attempt timeout: no complete response within ${ms} ms, after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
    retryable: true,
  };
}

const MAX_BACKOFF_MS = 30_000;

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

/** Spread clients that were told the same wait; never earlier than asked. */
function jitter(ms: number): number {
  return ms + Math.random() * (0.2 * ms + 100);
}

/**
 * A `Retry-After` value in milliseconds: delta-seconds or an HTTP-date (a date
 * already past is 0, "retry now"). Undefined when absent or unparseable, which
 * the caller reads as "no usable hint, back off normally".
 *
 * @internal
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // Date.parse reads "1.5" or "-3" as some year; an HTTP-date names a month.
  if (!/[A-Za-z]/.test(v)) return undefined;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    // `{ once: true }` only removes the listener after it fires; when the timer
    // wins it must come off by hand, or a long-lived signal collects one per wait.
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

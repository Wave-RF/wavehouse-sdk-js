import { createParser } from "eventsource-parser";
import { parseErrorResponse } from "../errors.js";
import { attemptTimeout, mergeHeaders } from "../http.js";
import type { FetchLike, StreamEvent, StreamStatus, WaveHouseError } from "../types.js";
import { resolveURL } from "../url.js";
import type { StreamTransport } from "./controller.js";

export interface SSEOptions {
  baseURL: string;
  table: string;
  since?: string;
  auth?: () => Promise<string> | string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
  /** Per-connect deadline up to the response headers; never an established stream. */
  attemptTimeoutMs?: number;
  fetchOptions?: RequestInit;
}

/** Module-level active SSE connection counter. */
let activeSSEConnections = 0;
const SSE_WARN_THRESHOLD = 5;

/**
 * Cap on characters the frame parser will buffer before giving up, guarding
 * against unbounded growth from a malformed or hostile stream. The parser
 * defaults to unbounded, so this has to be set explicitly. 16 MiB is generous
 * headroom over the ~1 MiB NATS payload ceiling a single event can carry.
 *
 * @internal Exported only so the overflow test can hit the cap exactly; not
 * re-exported from `index.ts`, so it stays off the public surface.
 */
export const MAX_BUFFER_CHARS = 16 * 1024 * 1024;

/** Ceiling for reconnect backoff. */
const MAX_BACKOFF_MS = 30_000;

/**
 * How long a connection must stay live before it counts as healthy enough to
 * reset the backoff. Roughly the fixed delay native `EventSource` used, so a
 * server that accepts and instantly closes can't be hammered faster than the
 * transport this replaces.
 */
const STABLE_CONNECTION_MS = 3_000;

/**
 * Delay before reconnect attempt `attempt` (0-based), jittered.
 *
 * Unlike the REST backoff in `http.ts`, this one is randomized: REST retries
 * are spread across independent calls, but every subscriber to a stream that
 * drops reconnects at the same instant, so a fixed schedule synchronizes the
 * whole fleet into a thundering herd against a server that is probably already
 * unwell. Each attempt waits between 50% and 100% of its nominal delay.
 */
function backoff(attempt: number, retryFloorMs: number): number {
  const nominal = Math.max(retryFloorMs, Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS));
  // Jitter spans [max(floor, nominal/2), nominal), so a server-requested
  // `retry:` is honored as the lower bound the SSE spec makes it — jittering
  // over the whole nominal range could re-dial at half what the server asked.
  // With no `retry:` (the default) the floor is 0 and this is the full spread.
  const low = Math.max(retryFloorMs, nominal / 2);
  return low + Math.random() * (nominal - low);
}

/**
 * Hand a response body back to the connection pool on a path that won't read
 * it. Skipped when locked — `cancel()` throws on a locked stream, and a locked
 * body was never ours to release anyway.
 */
function releaseBody(res: Response): void {
  // `.catch` is load-bearing, not defensive: cancelling an *errored* stream
  // returns a rejected promise, and an unhandled rejection takes the host
  // process down under Node's default `--unhandled-rejections=throw`. A
  // connection reset between the headers arriving and this call is enough.
  if (res.body && !res.body.locked) res.body.cancel().catch(() => {});
}

/**
 * Milliseconds a `Retry-After` header asks for, clamped to `MAX_BACKOFF_MS` so a
 * hostile or fat-fingered value can't strand a stream. Both header forms are
 * read (delta-seconds and an HTTP-date); anything else, or a date already
 * past, is no request at all.
 */
function parseRetryAfter(value: string | null): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, MAX_BACKOFF_MS);
}

/** Rejects with the signal's reason once `ac` aborts. */
function rejectOnAbort(ac: AbortController): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    if (ac.signal.aborted) reject(ac.signal.reason);
    else ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true });
  });
  // Only meaningful while raced; settled later it must not be unhandled.
  p.catch(() => {});
  return p;
}

/** Outcome of one connection attempt, driving the reconnect decision. */
interface AttemptResult {
  /** Milliseconds the connection stayed readable; 0 if it never opened. */
  liveMs: number;
  /** Stop for good: a bad token or missing table can't be fixed by retrying. */
  terminal: boolean;
  /** Floor for the wait before the next attempt, from the response's `Retry-After`. */
  retryAfterMs?: number;
}

/**
 * SSE transport over `fetch`.
 *
 * Replaces `EventSource`, which cannot set request headers — the reason the JWT
 * used to ride in `?token=`, where it crossed every intermediary in the request
 * URI. In exchange for the `Authorization` header this owns what `EventSource`
 * used to provide: framing, reconnect, and resumption from the last event id.
 */
export class SSETransport<T = Record<string, unknown>> implements StreamTransport<T> {
  private _opts: SSEOptions;
  private _abort: AbortController | null = null;
  /**
   * Set by `disconnect()` before it calls `abort()` — both synchronously — so
   * a rejection caused by our own abort always observes this as `true`. That
   * makes it a complete and precise test for "did we cause this?", which is
   * why the catch blocks read it directly instead of matching on the error
   * type: an `AbortError` we *didn't* raise (a custom `fetch` enforcing a
   * per-attempt deadline, an `auth()` call cancelled by its own controller) is
   * a transient failure to re-dial, exactly as on the REST path. Treating one
   * as a teardown killed the stream permanently, and silently.
   */
  private _closed = false;
  private _started = false;
  private _counted = false;
  /**
   * Most recent non-empty event id, sent as `Last-Event-ID` on reconnect.
   *
   * Deliberately ignores empty ids. The server emits a blank `id:` line for
   * passthrough payloads, and per the SSE spec an empty `id` field *clears* the
   * last-event-id — so tracking it faithfully would silently discard the
   * resumption point mid-stream and re-open from the beginning.
   */
  private _lastEventId: string | null = null;
  /**
   * Where a reconnect resumes when there is neither `opts.since` nor an event
   * id yet: the start of the first live connection, so rows ingested during
   * the backoff are replayed rather than skipped at the live head.
   */
  private _resumeSince: string | null = null;
  /** Reconnect floor most recently requested by the server via `retry:`. */
  private _retryFloorMs = 0;
  /** Cuts a reconnect gap short when set — see `_sleep`. */
  private _wake: (() => void) | null = null;
  /**
   * Column names for the rows currently arriving, from the most recent
   * `event: schema` frame. Rows travel positionally, so this is what turns one
   * back into an object; `null` means none has been announced yet, and a data
   * frame arriving in that state is a protocol error (see `_dispatch`).
   *
   * Reset at the start of every connection attempt: a reconnect re-announces,
   * and zipping a new connection's rows under the previous one's list would
   * silently mislabel every value.
   */
  private _columns: string[] | null = null;
  /**
   * Per-cause warning budget for the current connection. Every PER-FRAME warn
   * site is bounded, keyed by CAUSE so a malformed schema frame and unparseable
   * JSON stay individually visible: collapsing them behind one flag would hide
   * the distinct failures the warning exists to surface, and an unbounded
   * `console.warn` per frame floods the console for the whole connection. Reset
   * per attempt. (The per-connect() notices are not per-frame and are not
   * bounded here.)
   */
  private _warnBudget = new Map<string, number>();

  onEvent: ((event: StreamEvent<T>) => void) | null = null;
  onStatus: ((status: StreamStatus) => void) | null = null;
  onError: ((error: WaveHouseError) => void) | null = null;

  constructor(opts: SSEOptions) {
    this._opts = opts;
  }

  connect(): void {
    // Idempotent: a second call would leave two reconnect loops racing over one
    // transport, each re-dialing the other's dropped connection.
    if (this._closed || this._started) return;
    this._started = true;

    if (!this._opts.fetch && typeof fetch === "undefined") {
      throw new Error(
        "[wavehouse] global fetch is not available in this environment. " +
          "Upgrade to Node 22+ or supply one via `options.fetch`.",
      );
    }

    activeSSEConnections++;
    this._counted = true;
    if (activeSSEConnections > SSE_WARN_THRESHOLD) {
      console.warn(
        `[wavehouse] ${activeSSEConnections} SSE connections open. ` +
          `Browsers limit HTTP/1.1 to 6 connections per domain.`,
      );
    }

    // `_run` resolves rather than rejects on stream failure; this catch is for
    // a programming error inside the loop itself.
    this._run().catch((err) => {
      this._emitError({
        status: 0,
        code: "SSE_CONNECT_ERROR",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      });
      this.disconnect();
    });
  }

  disconnect(): void {
    if (!this._closed) {
      this._closed = true;
      this._abort?.abort();
      this._abort = null;
      this._wake?.();
      if (this._counted) {
        activeSSEConnections = Math.max(0, activeSSEConnections - 1);
        this._counted = false;
      }
      // Same isolation as `_emitStatus`, which this deliberately bypasses:
      // `_emitStatus` returns early once `_closed` is set, so the terminal
      // status would never get out. Inside the guard, so a redundant
      // `disconnect()` is a no-op rather than a second `closed`.
      try {
        this.onStatus?.("closed");
      } catch (e) {
        console.error("[wavehouse] SSE status handler threw:", e);
      }
    }
  }

  /** Connect/read/reconnect until the stream is closed or hits a terminal error. */
  private async _run(): Promise<void> {
    // Yield before the first attempt so a failure that is detectable
    // synchronously — an unresolvable `baseURL` — still reaches a subscriber.
    // `connect()` runs inside the StreamController constructor, so anything
    // emitted before this point fires before `.stream()` has returned and
    // nobody is listening yet.
    await Promise.resolve();

    let attempt = 0;

    while (!this._closed) {
      const { liveMs, terminal, retryAfterMs } = await this._attempt();

      if (this._closed) return;
      if (terminal) {
        this.disconnect();
        return;
      }

      // Only a connection that *held* resets the schedule. Resetting on any
      // connection that merely opened lets a server accepting and immediately
      // closing (slow-consumer eviction, a half-broken upstream) pin the client
      // at sub-second retries forever — more aggressive than the ~3s fixed
      // delay EventSource used, against a server already in trouble.
      if (liveMs >= STABLE_CONNECTION_MS) attempt = 0;

      this._emitStatus("reconnecting");
      // A `Retry-After` is a floor for this wait only; a `retry:` field persists.
      await this._sleep(backoff(attempt, Math.max(this._retryFloorMs, retryAfterMs ?? 0)));
      attempt++;
    }
  }

  /**
   * Warn at most `LIMIT` times per cause per connection, then once more to say
   * how many were suppressed. Returns nothing — callers warn and bail as before.
   */
  private _warnBounded(cause: string, message: string, data: unknown): void {
    const LIMIT = 3;
    const seen = (this._warnBudget.get(cause) ?? 0) + 1;
    this._warnBudget.set(cause, seen);
    if (seen <= LIMIT) {
      console.warn(message, data);
    } else if (seen === LIMIT + 1) {
      console.warn(`${message} — further occurrences suppressed for this connection`);
    }
  }

  /** One connection attempt: request, validate, then pump frames until it ends. */
  private async _attempt(): Promise<AttemptResult> {
    const ac = new AbortController();
    this._abort = ac;
    this._columns = null;
    this._warnBudget.clear();

    // A URL that won't build is deterministic — every retry produces the same
    // failure — so it ends the stream rather than looping.
    let target: string;
    try {
      target = this._url();
    } catch (e) {
      this._emitError({
        status: 0,
        code: "SSE_CONNECT_ERROR",
        message: e instanceof Error ? e.message : String(e),
        retryable: false,
      });
      return { liveMs: 0, terminal: true };
    }

    // A token provider that throws is treated as transient, unlike the URL
    // above: `auth` now runs on every attempt, so a refresh endpoint having a
    // bad minute would otherwise tear down a healthy long-lived stream.
    let init: RequestInit;
    try {
      init = await this._init(ac.signal);
    } catch (e) {
      if (this._closed) return { liveMs: 0, terminal: true };
      this._emitError({
        status: 0,
        code: "SSE_AUTH_ERROR",
        message: e instanceof Error ? e.message : String(e),
        retryable: true,
      });
      return { liveMs: 0, terminal: false };
    }

    // The per-attempt deadline bounds the connect, up to the response headers:
    // an established stream is long-lived and has no deadline of its own. It
    // aborts the same controller `disconnect()` does, which is safe because
    // `_closed` tells the two apart.
    const timeoutMs = attemptTimeout(this._opts.attemptTimeoutMs);
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            ac.abort();
          }, timeoutMs);
    const timeoutError = (): WaveHouseError => ({
      status: 0,
      code: "SSE_ATTEMPT_TIMEOUT",
      message: `The stream connection got no response within ${timeoutMs} ms`,
      retryable: true,
    });

    let res: Response;
    try {
      const doFetch = this._opts.fetch;
      const pending = doFetch ? doFetch(target, init) : fetch(target, init);
      // Raced against the abort so a `fetch` that ignores its signal still
      // lets the deadline end the attempt.
      res = await (timer === undefined ? pending : Promise.race([pending, rejectOnAbort(ac)]));
    } catch (e) {
      clearTimeout(timer);
      if (this._closed) return { liveMs: 0, terminal: true };
      this._emitError(
        timedOut
          ? timeoutError()
          : {
              status: 0,
              code: "SSE_NETWORK_ERROR",
              message: e instanceof Error ? e.message : String(e),
              retryable: true,
            },
      );
      return { liveMs: 0, terminal: false };
    }
    clearTimeout(timer);
    if (timedOut && !this._closed) {
      // The headers arrived as the deadline fired, so the body is aborted too.
      releaseBody(res);
      this._emitError(timeoutError());
      return { liveMs: 0, terminal: false };
    }

    // A fetch that ignores `init.signal` can resolve after `disconnect()`;
    // don't open a connection nobody wants.
    if (this._closed) {
      releaseBody(res);
      return { liveMs: 0, terminal: true };
    }

    // Redirects are refused, not followed — see `_init`. Surfaced explicitly
    // because both shapes are otherwise misleading: a browser reports an
    // opaque status-0 response, and Node hands back the raw 3xx.
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      this._emitError({
        status: res.status,
        code: "SSE_REDIRECT",
        message:
          "The stream endpoint redirected and the SDK did not follow it. Redirects are " +
          "refused when the request carries a credential — an `auth` token or configured " +
          "`headers` — because a cross-origin hop strips the Authorization header, and this " +
          "endpoint answers an unauthenticated caller with a reduced view instead of an " +
          "error, while forwarding any configured headers to wherever the redirect points. " +
          "If this request carries neither, `fetch` was left to follow the redirect itself, " +
          "so arriving here means a response it will not follow (a 304, or a 3xx with no " +
          "Location header) or an `options.fetch` that returned the redirect verbatim. " +
          "Either way, set `baseURL` to the final URL; most often this is an http→https " +
          "upgrade or a canonical-host redirect at a proxy. To follow a credentialed " +
          "redirect anyway, supply an `options.fetch` that overrides `redirect`.",
        retryable: false,
      });
      releaseBody(res);
      return { liveMs: 0, terminal: true };
    }

    if (!res.ok) {
      const error = await parseErrorResponse(res);
      // 429 is a retry-later status from a fronting rate limiter, so a stream
      // that took one must re-dial rather than stay dead until a reload — unless
      // the body says otherwise. Every other 4xx stays terminal.
      if (
        res.status === 429 &&
        (error.details as { retryable?: unknown } | undefined)?.retryable !== false
      ) {
        error.retryable = true;
      }
      this._emitError(error);
      // 4xx is terminal: whatever rejected this usually won't be talked round
      // by repeating the request, and native EventSource likewise stops on
      // non-200. Note WaveHouse doesn't reject here *for authentication* — the
      // endpoint is ungated and answers a bad token with a reduced view, which
      // is why `auth` is re-read per attempt (#239 tracks enforcing expiry). The
      // 4xx it raises itself are
      // a 400 for a missing or empty `table` (internal/api/stream.go) or a
      // malformed `X-Tenant-ID`, and a 404 `unknown tenant` for a tenant it does
      // not serve (internal/api/tenant.go) — never held, or removed, which is
      // what a stream the server ended with its tenant reconnects into; a
      // rejected tenant's 503 is retried like any 5xx. Any other 404/405 means
      // the request missed the route entirely (router.go's chi handlers), and
      // anything else comes from something in front — a gateway, or a proxy.
      const retry = error.retryable;
      return {
        liveMs: 0,
        terminal: !retry,
        retryAfterMs: retry ? parseRetryAfter(res.headers.get("Retry-After")) : undefined,
      };
    }

    // A 200 that isn't an event stream is an intermediary answering for the
    // server — an auth gateway serving its login page is the common one. Left
    // unchecked the parser would chew HTML, find no frames, and leave the
    // stream "live" and permanently silent, indistinguishable from a quiet
    // table. `EventSource` fails the connection here too.
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().split(";")[0].trim().startsWith("text/event-stream")) {
      this._emitError({
        status: res.status,
        code: "SSE_BAD_CONTENT_TYPE",
        message: `Expected \`text/event-stream\`, got \`${contentType || "(none)"}\`. Something between the client and WaveHouse answered this request — an auth gateway's login page is the usual cause.`,
        retryable: false,
      });
      releaseBody(res);
      return { liveMs: 0, terminal: true };
    }

    // `options.fetch` only has to stream on this path — every REST call reads
    // the body with `.text()`. A wrapper that buffers, or clones and logs the
    // body, satisfies REST and then hangs here forever, so say so instead.
    // `locked` and `bodyUsed` both matter and neither implies the other: after
    // `.text()` both are set, but after a bare `getReader()` only `locked` is.
    const body = res.body;
    if (!body || typeof body.getReader !== "function" || body.locked || res.bodyUsed) {
      this._emitError({
        status: res.status,
        code: "SSE_NO_STREAM_BODY",
        message:
          "Streaming requires a response with a readable body. The configured `options.fetch` " +
          "returned one whose body is absent or already read — an implementation that buffers " +
          "or consumes the response cannot be used for `.stream()` or `.liveQuery()`.",
        retryable: false,
      });
      releaseBody(res);
      return { liveMs: 0, terminal: true };
    }

    if (!this._opts.since && !this._lastEventId && !this._resumeSince) {
      // The server's clock, since that is what `since` is compared against.
      // `Date` has whole-second resolution, so it is never later than the real
      // start; without it, local time less a skew allowance.
      const date = Date.parse(res.headers.get("Date") ?? "");
      this._resumeSince = new Date(Number.isNaN(date) ? Date.now() - 5000 : date).toISOString();
    }

    this._emitStatus("live");
    const openedAt = Date.now();
    const overflowed = await this._pump(body); // true: overflow or protocol error
    // An overflow or a protocol error ends a connection that was readable but
    // not healthy: counting it as held would reset the backoff each cycle, and a
    // peer that does it every time (a broken intermediary) would be re-dialed at
    // a flat rate.
    return { liveMs: overflowed ? 0 : Date.now() - openedAt, terminal: false };
  }

  /** Resolve the stream URL. Throws on a `baseURL` that isn't a usable http(s) origin. */
  private _url(): string {
    const url = resolveURL(this._opts.baseURL, "/v1/stream");
    // Caught here rather than at `fetch`, which reports an unusable scheme as a
    // generic failure the loop would then retry forever. `baseURL` must be
    // absolute, so a bare host throws out of `resolveURL` above; this catches
    // the absolute-but-wrong case, `ws://` being the tempting one for streams.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `baseURL must use http or https, got "${url.protocol}". Streaming is plain HTTP — there is no WebSocket endpoint.`,
      );
    }
    url.searchParams.set("table", this._opts.table);
    // Once an event id exists it travels as `Last-Event-ID` (see `_init`) and
    // `since` is left off, so the header is the one resumption point. Before
    // that, `since` is all there is to send.
    const since = this._lastEventId ? null : this._opts.since || this._resumeSince;
    if (since) {
      url.searchParams.set("since", since);
    }
    return url.toString();
  }

  /** Build the request init, minting a token for this attempt. */
  private async _init(signal: AbortSignal): Promise<RequestInit> {
    const base: Record<string, string> = { Accept: "text/event-stream" };

    // Resolved per attempt, not once per stream: a stream outlives its token,
    // and a reconnect replaying an expired JWT authenticates as no one — which
    // this endpoint answers with a silently reduced view, not an error.
    if (this._opts.auth) {
      const token = await this._opts.auth();
      if (token) {
        base.Authorization = `Bearer ${token}`;
      }
    }

    // The server reads the event id as the resume timestamp. Before any event
    // has been delivered there is no id, so `_url` sends `since` instead.
    if (this._lastEventId) base["Last-Event-ID"] = this._lastEventId;

    // Anything a redirect target must not be handed: the bearer token, or the
    // configured headers that carry proxy service-token secrets.
    // An explicit `credentials: "include"` is the documented opt-in to cookie
    // auth, so it counts too — in a browser only, the one place it is honored.
    // The implicit `same-origin` default stays invisible: it cannot be told
    // from a deployment with no cookies at all.
    const credentialed =
      base.Authorization !== undefined ||
      Object.keys(this._opts.headers ?? {}).length > 0 ||
      ("window" in globalThis && this._opts.fetchOptions?.credentials === "include");

    const init: RequestInit = {
      ...this._opts.fetchOptions,
      method: "GET",
      headers: mergeHeaders(base, this._opts.headers),
      signal,
      // Owned by the SDK rather than left to `fetchOptions`, unlike the REST
      // path, because on a stream these are correctness rather than preference:
      //
      //   cache    — as an init field, not a `Cache-Control` header. The header
      //              form is not in the server's Access-Control-Allow-Headers,
      //              so it would fail every cross-origin preflight.
      //   redirect — followed only when this request carries no credential.
      //              Platforms strip `Authorization` on a cross-origin redirect
      //              (whatwg/fetch#1544) and forward other headers intact, so a
      //              credentialed hop either silently downgrades the stream to
      //              the default role — this endpoint answers an unauthenticated
      //              caller rather than rejecting them — or delivers a configured
      //              secret to whatever the redirect names. Neither is worth a
      //              convenience. Without either, redirects are followed, so CDN
      //              canonicalization, geo/LB indirection, and an http→https
      //              upgrade all just work. The test is deliberately that
      //              concrete set and not "is this authenticated": an explicit
      //              `credentials: "include"` is in it, but cookies relied on
      //              through the implicit same-origin default are not. A cookie
      //              is re-derived per destination rather than carried, so under
      //              the default same-origin credentials mode it survives a
      //              redirect only while the hop stays inside both the request's
      //              origin and the cookie's Path; outside either the stream is
      //              silently unauthed. See #478 and the SDK guide under
      //              "Supplying your own fetch".
      //              `manual` over `error` for the credentialed case so the
      //              outcome stays inspectable: `error` rejects with a bare
      //              TypeError indistinguishable from a connection failure, which
      //              the loop above would retry forever against a redirect that
      //              is never going to stop happening.
      cache: "no-store",
      redirect: credentialed ? "manual" : "follow",
      // Neutralized like the REST path does, and for a sharper reason here: a
      // body on a GET makes `fetch` throw, which reads as a network failure and
      // would be retried forever against a request that can never be built.
      body: undefined,
    };

    // Only browsers get `credentials`: some runtimes (Cloudflare Workers) throw
    // outright if it is present. Inside a browser an explicit value from
    // `fetchOptions` survives, which is how a cookie-authenticated origin opts
    // into `include`.
    if (!("window" in globalThis)) {
      delete init.credentials;
    }

    return init;
  }

  /**
   * Decode and parse frames until the stream ends, aborts, or errors. Returns
   * whether the connection ended unhealthy: a buffer overflow or a protocol error.
   */
  private async _pump(body: ReadableStream<Uint8Array>): Promise<boolean> {
    // Set when the parser reports a buffer overflow: it is terminated at that
    // point, so the read loop must stop rather than feed it again.
    let overflowed = false;
    // Set by a protocol error: the rest of the chunk is discarded and the
    // connection reopened, so no later frame is delivered or advances the id.
    let broken = false;
    const parser = createParser({
      onEvent: (msg) => {
        if (broken) return;
        if (!msg.data) {
          if (msg.id) this._lastEventId = msg.id;
          return;
        }
        // The server announces the column list before the rows that use it,
        // and again whenever it changes mid-stream.
        if (msg.event === "schema") {
          if (msg.id) this._lastEventId = msg.id;
          this._applySchema(msg.data);
          return;
        }
        const problem = this._dispatch(msg.data);
        if (problem !== undefined) {
          broken = true;
          this._emitError({
            status: 0,
            code: "SSE_PROTOCOL_ERROR",
            message: problem,
            retryable: true,
          });
          return;
        }
        // Only after delivery: a frame that was refused must not move the
        // resume point past itself, or the reconnect would skip it.
        if (msg.id) this._lastEventId = msg.id;
      },
      onRetry: (ms) => {
        this._retryFloorMs = Math.min(Math.max(ms, 0), MAX_BACKOFF_MS);
      },
      onError: (err) => {
        if (err.type === "max-buffer-size-exceeded") overflowed = true;
        this._emitError({
          status: 0,
          code: "SSE_PARSE_ERROR",
          message: err.message,
          retryable: true,
        });
      },
      maxBufferSize: MAX_BUFFER_CHARS,
    });

    const reader = body.getReader();
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return false;
        parser.feed(decoder.decode(value, { stream: true }));
        // End the connection on the overflow we just reported, instead of
        // feeding a terminated parser and re-reporting it as a read failure.
        // A protocol error ends it too, to be reopened from the last delivered id.
        if (overflowed || broken) return true;
      }
    } catch (e) {
      if (this._closed) return overflowed || broken;
      this._emitError({
        status: 0,
        code: "SSE_READ_ERROR",
        message: e instanceof Error ? e.message : String(e),
        retryable: true,
      });
      return overflowed || broken;
    } finally {
      reader.cancel().catch(() => {
        // Already torn down — nothing left to release.
      });
    }
  }

  /**
   * Record the column list an `event: schema` frame announces. Rows that follow
   * are zipped against it, so a malformed announcement drops the list rather
   * than keeping a stale one: mislabeling values is worse than delivering none.
   */
  private _applySchema(data: string): void {
    try {
      const msg = JSON.parse(data) as { table_name?: string; columns?: unknown };
      if (!Array.isArray(msg.columns) || msg.columns.some((c) => typeof c !== "string")) {
        throw new Error("columns must be an array of strings");
      }
      // A repeated name has no single meaning when the row is zipped into an
      // object: the later value wins and the earlier one vanishes, with no
      // signal. Refuse the announcement instead — dropping rows until the next
      // one is the same failure mode as a malformed frame, and it is loud.
      if (new Set(msg.columns as string[]).size !== msg.columns.length) {
        throw new Error("columns contains a duplicate name");
      }
      this._columns = msg.columns as string[];
    } catch {
      this._columns = null;
      this._warnBounded(
        "bad-schema-frame",
        "[wavehouse] SSE received a malformed schema event:",
        data,
      );
    }
  }

  /**
   * Turn one frame's `data` into a StreamEvent and deliver it.
   *
   * The row arrives positionally — a JSON array — and is zipped back into an
   * object against the announced column list, so the public API still yields
   * row objects. A row with no announcement, one that is not an array, or one
   * whose length disagrees with the list cannot be read: there is no way to say
   * which value is which, so it is never delivered under guessed names. Those
   * are protocol errors: the reason is returned, and the caller reopens the
   * connection from the last delivered event, so the server announces the
   * columns again. Anything else wrong with a frame is warned about and dropped.
   *
   * Guarded like `_emitError` and `_emitStatus`: `parser.feed()` dispatches
   * every complete frame in a chunk synchronously, so a subscriber that closes
   * from inside its own `next` — "read until I see my event, then stop" —
   * would otherwise keep receiving the rest of that chunk. `EventSource` ended
   * delivery on `close()`, and gap-fill replay routinely lands many frames in
   * one chunk.
   */
  private _dispatch(data: string): string | undefined {
    if (this._closed) return undefined;

    // Two failures with one culprit each, so they are caught separately: a
    // shared catch blamed the server's frame for an exception thrown by the
    // consumer's own handler, pointing a debugging reader at the wrong side.
    let event: StreamEvent<T>;
    try {
      const msg = JSON.parse(data) as {
        table_name: string;
        received_timestamp: string;
        row: unknown;
      };
      const columns = this._columns;
      if (!columns) return "A data frame arrived before any schema frame";
      if (!Array.isArray(msg.row)) return "A data frame's row is not an array";
      if (msg.row.length !== columns.length) {
        return `A data frame's row has ${msg.row.length} value(s) but ${columns.length} column(s) were announced`;
      }
      // Null-prototype: a ClickHouse column may legitimately be named
      // `__proto__`, and on a normal object literal that name hits the
      // inherited setter instead of creating an own property — the value would
      // vanish from the row (and, on a plain assignment, could reshape the
      // object). There is no prototype to walk here, so every column name is
      // just a key.
      const row: Record<string, unknown> = Object.create(null);
      for (let i = 0; i < columns.length; i++) {
        row[columns[i]] = msg.row[i];
      }
      event = { table: msg.table_name, timestamp: msg.received_timestamp, data: row as T };
    } catch {
      this._warnBounded("bad-json", "[wavehouse] SSE received malformed message:", data);
      return undefined; // ignore malformed messages
    }

    try {
      this.onEvent?.(event);
    } catch (e) {
      console.error("[wavehouse] SSE event handler threw:", e);
    }
    return undefined;
  }

  /** Suppress callbacks that race a `disconnect()`. */
  private _emitError(error: WaveHouseError): void {
    if (this._closed) return;
    // Guarded like `_dispatch`: a subscriber that throws must not take the
    // transport with it. Unguarded, the throw unwinds `_run` into `connect()`'s
    // terminal handler, which reports a spurious SSE_CONNECT_ERROR and then
    // calls `disconnect()` — whose own `onStatus("closed")` throws again, this
    // time out of the `.catch()`, as a process-fatal unhandled rejection.
    // `EventSource` isolated a throwing handler and kept streaming. Note this
    // protects the transport, not the fan-out: StreamController still stops
    // delivering to later subscribers when an earlier one throws (#473).
    try {
      this.onError?.(error);
    } catch (e) {
      console.error("[wavehouse] SSE error handler threw:", e);
    }
  }

  /**
   * Same guard for status. Aborting does not retract an already-resolved
   * `Response`, so a `disconnect()` landing between the fetch settling and the
   * "live" below would otherwise flip a closed controller back to live — and it
   * stays there, since the loop then exits without emitting anything further.
   * `disconnect()` calls `onStatus` directly; that terminal "closed" is the one
   * status that must always get through.
   */
  private _emitStatus(status: StreamStatus): void {
    if (this._closed) return;
    try {
      this.onStatus?.(status);
    } catch (e) {
      console.error("[wavehouse] SSE status handler threw:", e);
    }
  }

  /** Wait out a reconnect gap, cut short by `disconnect()`. */
  private _sleep(ms: number): Promise<void> {
    // `_wake` only cuts a gap short once the timer exists. A `disconnect()`
    // raised synchronously from the "reconnecting" status callback runs a line
    // earlier than that, so without this the loop would install a timer nobody
    // can cancel and hold the event loop open for the whole backoff — the one
    // hole in the `_wake` machinery.
    if (this._closed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._wake = null;
        resolve();
      }, ms);
      this._wake = () => {
        clearTimeout(timer);
        this._wake = null;
        resolve();
      };
    });
  }
}

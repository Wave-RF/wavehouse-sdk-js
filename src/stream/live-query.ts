import type { Result, StreamEvent, StreamSubscriber } from "../types.js";
import type { StreamController } from "./controller.js";

/**
 * An RFC 3339 timestamp (or ClickHouse's space-separated form, read as UTC when
 * it carries no offset) as nanoseconds since the epoch, or `undefined` if it is
 * not one. `Date.parse` alone would truncate to milliseconds and could drop a
 * row that differs from the boundary by less than that.
 * @internal
 */
export function parseInstant(value: unknown): bigint | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d(?::?\d\d)?)?$/i.exec(
    value.trim(),
  );
  if (!m) return undefined;
  let zone = (m[4] ?? "Z").toUpperCase();
  if (zone !== "Z" && !zone.includes(":")) zone = `${zone.slice(0, 3)}:${zone.slice(3) || "00"}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  if (Number.isNaN(ms)) return undefined;
  const nanos = (m[3] ?? "").slice(0, 9).padEnd(9, "0");
  return BigInt(ms) * 1_000_000n + BigInt(nanos);
}

/**
 * Stream-first live query orchestrator.
 *
 * 1. Opens a live stream immediately (buffers events).
 * 2. Fetches historical data.
 * 3. Calls `subscriber.initial(result)` with the historical snapshot.
 * 4. Deduplicates buffered events against the fetch result.
 * 5. Flushes remaining buffered events through `subscriber.next()`.
 * 6. Resumes live: pipes stream events directly to `subscriber.next()`.
 */
export class LiveQuery<T = Record<string, unknown>> {
  private _stream: StreamController<T>;
  private _subscriber: StreamSubscriber<T>;
  private _buffer: StreamEvent<T>[] = [];
  private _buffering = true;
  private _unsubStream: (() => void) | null = null;
  private _closed = false;
  private _signal: AbortSignal | undefined;
  private _onAbort: (() => void) | undefined;

  constructor(
    stream: StreamController<T>,
    fetchFn: () => Promise<Result<T[]>>,
    subscriber: StreamSubscriber<T>,
    signal?: AbortSignal,
  ) {
    this._stream = stream;
    this._subscriber = subscriber;
    // An abort ends the live query like `close()`: the backfill that is still
    // running must not call `initial` or `next` afterwards.
    if (signal) {
      this._onAbort = () => this.close();
      if (signal.aborted) this._closed = true;
      else signal.addEventListener("abort", this._onAbort, { once: true });
      this._signal = signal;
    }

    // Step 1: Subscribe to live events and buffer them.
    this._unsubStream = stream.subscribe({
      next: (event) => {
        if (this._closed) return;
        if (this._buffering) {
          this._buffer.push(event);
        } else {
          subscriber.next(event);
        }
      },
      status: (s) => subscriber.status?.(s),
      error: (e) => subscriber.error?.(e),
    });

    // Step 2-5: Fetch historical and flush. Not started for a signal that was
    // aborted before the call: nothing may reach the subscriber then.
    if (this._closed) {
      this._unsubStream?.();
      this._stream.close();
      return;
    }
    this._runBackfill(fetchFn);
  }

  private async _runBackfill(fetchFn: () => Promise<Result<T[]>>): Promise<void> {
    let result: Result<T[]> | undefined;
    try {
      result = await fetchFn();
    } catch {
      // The fetch itself rejected (a failing `auth`, a bad `baseURL`). The
      // buffered live events are still valid, so deliver them without a boundary.
    }

    if (this._closed) return;

    // Step 3: Call initial() with the historical snapshot.
    if (result) {
      try {
        this._subscriber.initial?.(result);
      } catch (e) {
        console.error("[wavehouse] liveQuery initial handler threw:", e);
      }
    }

    // Step 4: Deduplicate buffered events against fetched rows. The boundary is
    // the newest `received_timestamp` among the rows, as a parsed instant — not
    // the last row, which is the oldest under a descending order, and not a
    // string compare, which misorders `...:05Z` against `...:05.123Z`. A table
    // without that column (or a projection that drops it) gives no boundary, so
    // events that arrived during the fetch may repeat a row already in `initial`;
    // the SDK has nothing to tell them apart with.
    let boundary: bigint | undefined;
    if (result && !result.error) {
      for (const row of result.data) {
        const t = parseInstant((row as Record<string, unknown> | null)?.received_timestamp);
        if (t !== undefined && (boundary === undefined || t > boundary)) boundary = t;
      }
    }

    // Step 5: Flush buffered events newer than that boundary. A failed fetch has
    // no boundary, so every buffered event is delivered.
    this._buffering = false;
    const buffered = this._buffer;
    this._buffer = [];
    for (const event of buffered) {
      if (this._closed) break;
      // An event whose own timestamp won't parse can't be proven covered, so it
      // is delivered rather than dropped.
      const at = parseInstant(event.timestamp);
      if (boundary !== undefined && at !== undefined && at <= boundary) {
        continue; // already covered by the fetch
      }
      try {
        this._subscriber.next(event);
      } catch (e) {
        console.error("[wavehouse] liveQuery next handler threw:", e);
      }
    }
  }

  /** Close the live query and the underlying stream. */
  close(): void {
    if (this._onAbort) this._signal?.removeEventListener("abort", this._onAbort);
    this._closed = true;
    this._buffering = false;
    this._buffer = [];
    this._unsubStream?.();
    this._stream.close();
  }
}

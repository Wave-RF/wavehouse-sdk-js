import type { QueryFilter, Result, StreamEvent, StreamSubscriber } from "../types.js";
import type { StreamController } from "./controller.js";

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

  constructor(
    stream: StreamController<T>,
    fetchFn: () => Promise<Result<T[]>>,
    subscriber: StreamSubscriber<T>,
    _filters: QueryFilter[],
  ) {
    this._stream = stream;
    this._subscriber = subscriber;

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

    // Step 2-5: Fetch historical and flush.
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
    // the `received_timestamp` of the *last row returned* — not the newest,
    // unless the query happens to order ascending. The ways that misbehaves
    // (and there are three) are enumerated once, in the SDK docs under Live
    // Queries → How it works; #449 tracks the fix. Stated there rather than
    // restated here, because this claim has already drifted out of sync three
    // times across the docs and this comment.
    let lastTimestamp: string | undefined;
    if (result && !result.error) {
      const rows = result.data;
      if (rows.length > 0) {
        const lastRow = rows[rows.length - 1] as Record<string, unknown>;
        lastTimestamp = lastRow?.received_timestamp as string | undefined;
      }
    }

    // Step 5: Flush buffered events newer than that boundary. A failed fetch has
    // no boundary, so every buffered event is delivered.
    this._buffering = false;
    const buffered = this._buffer;
    this._buffer = [];
    for (const event of buffered) {
      if (this._closed) break;
      if (lastTimestamp && event.timestamp <= lastTimestamp) {
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
    this._closed = true;
    this._buffering = false;
    this._buffer = [];
    this._unsubStream?.();
    this._stream.close();
  }
}

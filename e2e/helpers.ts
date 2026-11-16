import { inject } from "vitest";
import { createClient, type StreamController, type StreamEvent } from "../src/index.js";

/** A client authenticated as the admin role, with one retry. */
export function newClient() {
  const token = inject("adminToken");
  return createClient({
    baseURL: inject("serverUrl"),
    auth: () => token,
    options: { maxRetries: 1 },
  });
}

let seq = 0;

/** A value no other test or run writes, to find a test's own rows. */
export function uniqueName(label: string): string {
  return `${label}-${Date.now()}-${++seq}`;
}

/** One e2e_events row with a unique dedupe id. */
export function eventRow(name: string, value: number) {
  return { event_id: `${name}-${++seq}`, name, value };
}

/** Polls until `fn` stops throwing; ingest writes to ClickHouse asynchronously. */
export async function eventually<T>(fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** Resolves with the first `n` events a stream delivers, or rejects after `timeoutMs`. */
export function collect<T>(
  stream: StreamController<T>,
  n: number,
  timeoutMs = 15_000,
): { events: StreamEvent<T>[]; done: Promise<StreamEvent<T>[]> } {
  const events: StreamEvent<T>[] = [];
  const done = new Promise<StreamEvent<T>[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`got ${events.length} of ${n} events within ${timeoutMs}ms`)),
      timeoutMs,
    );
    stream.subscribe({
      next: (e) => {
        events.push(e);
        if (events.length >= n) {
          clearTimeout(timer);
          resolve(events);
        }
      },
      error: (err) => {
        clearTimeout(timer);
        reject(new Error(`stream error: ${err.message}`));
      },
    });
  });
  return { events, done };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchLike, StreamEvent, WaveHouseError } from "../types.js";
import { SSETransport } from "./sse.js";

const BASE = "http://localhost:8080";

function open() {
  const encoder = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    res: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    push: (chunk: string) => ctrl.enqueue(encoder.encode(chunk)),
  };
}

const stall: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SSETransport attemptTimeoutMs", () => {
  it("re-dials a connect that gets no response, reporting a retryable error", async () => {
    const live = open();
    let calls = 0;
    const t = new SSETransport({
      baseURL: BASE,
      table: "clicks",
      attemptTimeoutMs: 2000,
      fetch: (url, init) => (++calls === 1 ? stall(url, init) : Promise.resolve(live.res)),
    });
    const errors: WaveHouseError[] = [];
    const statuses: string[] = [];
    t.onError = (e) => errors.push(e);
    t.onStatus = (s) => statuses.push(s);
    t.connect();

    await vi.advanceTimersByTimeAsync(2000);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "SSE_ATTEMPT_TIMEOUT", retryable: true });
    expect(statuses).toContain("reconnecting");

    await vi.advanceTimersByTimeAsync(2000); // the reconnect backoff
    expect(calls).toBe(2);
    expect(statuses).toContain("live");
    t.disconnect();
  });

  it("does not cut off an established stream", async () => {
    const live = open();
    let calls = 0;
    const t = new SSETransport({
      baseURL: BASE,
      table: "clicks",
      attemptTimeoutMs: 1000,
      fetch: () => {
        calls++;
        return Promise.resolve(live.res);
      },
    });
    const events: StreamEvent[] = [];
    const errors: WaveHouseError[] = [];
    t.onEvent = (e) => events.push(e);
    t.onError = (e) => errors.push(e);
    t.connect();
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(60_000); // far past the deadline
    live.push(
      `event: schema\ndata: {"table_name":"clicks","columns":["n"]}\n\nid: t1\ndata: {"table_name":"clicks","received_timestamp":"t1","row":[1]}\n\n`,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(calls).toBe(1);
    t.disconnect();
  });

  it("ends a connect even when a custom fetch ignores its signal", async () => {
    const live = open();
    let calls = 0;
    const t = new SSETransport({
      baseURL: BASE,
      table: "clicks",
      attemptTimeoutMs: 1000,
      fetch: () => (++calls === 1 ? new Promise<Response>(() => {}) : Promise.resolve(live.res)),
    });
    const errors: WaveHouseError[] = [];
    t.onError = (e) => errors.push(e);
    t.connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors[0]?.code).toBe("SSE_ATTEMPT_TIMEOUT");
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
    t.disconnect();
  });

  it("a disconnect during the connect is not reported as a timeout", async () => {
    const t = new SSETransport({
      baseURL: BASE,
      table: "clicks",
      attemptTimeoutMs: 1000,
      fetch: stall,
    });
    const errors: WaveHouseError[] = [];
    t.onError = (e) => errors.push(e);
    t.connect();
    await vi.advanceTimersByTimeAsync(100);
    t.disconnect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(errors).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../client.js";
import type { FetchLike, Result, StreamEvent, StreamStatus } from "../types.js";
import type { StreamTransport } from "./controller.js";
import { StreamController } from "./controller.js";
import { LiveQuery } from "./live-query.js";

/**
 * `liveQuery()` opens the stream and runs the REST backfill in the same tick,
 * so which of them calls `auth` first decides what a rejecting token provider
 * looks like to a subscriber — and the two outcomes are documented differently
 * (`sdk/streaming.md`, "When the backfill doesn't complete"). The ordering is
 * emergent rather than declared: it holds because `SSETransport._run` yields on
 * `await Promise.resolve()` while `_runBackfill` reaches `ctx.auth()` with no
 * intervening await. One added `await` on the REST path would silently swap the
 * documented cases, so it is pinned here.
 */

/** Distinguishes the two request paths by URL, since both share one `auth`. */
function isStreamURL(url: string): boolean {
  return url.includes("/v1/stream");
}

function makeFetch(): { impl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const impl: FetchLike = async (url) => {
    urls.push(url);
    if (isStreamURL(url)) {
      // A connection that opens and stays open, like a real stream.
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { impl, urls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("liveQuery auth ordering", () => {
  it("spends the first auth() call on the backfill, which never retries it", async () => {
    const calls: string[] = [];
    const f = makeFetch();

    const wh = createClient({
      baseURL: "http://localhost:8080",
      // Rejects only the first call. If the stream were to win the race, the
      // stream would absorb the rejection (retryable) and the backfill would
      // succeed — the opposite of what the docs describe.
      auth: () => {
        calls.push("auth");
        if (calls.length === 1) return Promise.reject(new Error("token endpoint down"));
        return Promise.resolve("t0ken");
      },
      options: { fetch: f.impl, maxRetries: 2 },
    });

    const initial: Array<Result<Record<string, unknown>[]>> = [];
    const errors: string[] = [];
    const statuses: StreamStatus[] = [];
    const events: StreamEvent<Record<string, unknown>>[] = [];

    const lq = wh
      .from("clicks")
      .select("*")
      .liveQuery({
        initial: (r) => initial.push(r),
        next: (e) => events.push(e),
        status: (s) => statuses.push(s),
        error: (e) => errors.push(e.code),
      });

    await vi.waitFor(() => expect(statuses).toContain("live"));

    // The rejection landed on the backfill: it is gone, and gone silently.
    expect(initial).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(f.urls.filter((u) => !isStreamURL(u))).toHaveLength(0);

    // The stream got the second call and connected normally.
    expect(f.urls.filter(isStreamURL)).toHaveLength(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);

    lq.close();
  });

  it("reports a persistently rejecting auth on the stream, still never on the backfill", async () => {
    const f = makeFetch();
    const wh = createClient({
      baseURL: "http://localhost:8080",
      auth: () => Promise.reject(new Error("token endpoint down")),
      options: { fetch: f.impl },
    });

    const initial: unknown[] = [];
    const errors: string[] = [];

    const lq = wh
      .from("clicks")
      .select("*")
      .liveQuery({
        initial: (r) => initial.push(r),
        next: () => {},
        error: (e) => errors.push(e.code),
      });

    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));

    // Every error comes from the stream; the backfill never reports at all.
    expect(new Set(errors)).toEqual(new Set(["SSE_AUTH_ERROR"]));
    expect(initial).toHaveLength(0);
    expect(f.urls).toHaveLength(0);

    lq.close();
  });
});

/** A StreamController over a transport the test drives by hand. */
function manualStream() {
  const t: StreamTransport & { fire(e: StreamEvent): void } = {
    connect: () => {},
    disconnect: () => {},
    onEvent: null,
    onStatus: null,
    onError: null,
    fire(e) {
      this.onEvent?.(e);
    },
  };
  return { t, stream: new StreamController(t) };
}

const ev = (ts: string, n: number): StreamEvent => ({
  table: "t",
  timestamp: ts,
  data: { n },
});

describe("liveQuery backfill isolation", () => {
  it("keeps flushing buffered events when next() throws on one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { t, stream } = manualStream();
    const seen: number[] = [];
    let release!: (r: Result<Record<string, unknown>[]>) => void;
    const fetchFn = () => new Promise<Result<Record<string, unknown>[]>>((r) => (release = r));
    new LiveQuery(
      stream,
      fetchFn,
      {
        next: (e) => {
          seen.push(e.data.n as number);
          if (e.data.n === 1) throw new Error("boom");
        },
      },
      [],
    );
    t.fire(ev("2026-01-01T00:00:01Z", 1));
    t.fire(ev("2026-01-01T00:00:02Z", 2));
    release({ ok: true, data: [], error: null } as Result<Record<string, unknown>[]>);
    await vi.waitFor(() => expect(seen).toEqual([1, 2]));
  });

  it("keeps flushing when initial() throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { t, stream } = manualStream();
    const seen: number[] = [];
    new LiveQuery(
      stream,
      async () => ({ ok: true, data: [], error: null }) as Result<Record<string, unknown>[]>,
      {
        initial: () => {
          throw new Error("boom");
        },
        next: (e) => seen.push(e.data.n as number),
      },
      [],
    );
    t.fire(ev("2026-01-01T00:00:01Z", 1));
    await vi.waitFor(() => expect(seen).toEqual([1]));
  });

  it("delivers buffered events when the fetch returns an error result", async () => {
    const { t, stream } = manualStream();
    const seen: number[] = [];
    const initial = vi.fn();
    new LiveQuery(
      stream,
      async () =>
        ({
          ok: false,
          data: null,
          error: { status: 500, code: "X", message: "m", retryable: false },
        }) as unknown as Result<Record<string, unknown>[]>,
      { initial, next: (e) => seen.push(e.data.n as number) },
      [],
    );
    t.fire(ev("2026-01-01T00:00:01Z", 1));
    await vi.waitFor(() => expect(seen).toEqual([1]));
    expect(initial).toHaveBeenCalledOnce();
  });

  it("delivers buffered events when the fetch rejects", async () => {
    const { t, stream } = manualStream();
    const seen: number[] = [];
    new LiveQuery(
      stream,
      () => Promise.reject(new Error("auth down")),
      { next: (e) => seen.push(e.data.n as number) },
      [],
    );
    t.fire(ev("2026-01-01T00:00:01Z", 1));
    await vi.waitFor(() => expect(seen).toEqual([1]));
  });
});

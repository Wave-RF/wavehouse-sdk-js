import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import type { FetchLike } from "./types.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Never answers until the attempt's signal fires, as a request on a dead path does. */
const stall: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

/** A fetch whose first `n` calls stall and the rest answer `[{ n: 1 }]`. */
function stallFirst(n: number) {
  const calls = { count: 0 };
  const impl: FetchLike = (url, init) => {
    calls.count++;
    return calls.count <= n ? stall(url, init) : Promise.resolve(json(200, [{ n: 1 }]));
  };
  return { impl, calls };
}

function client(fetch: FetchLike, options: Record<string, unknown> = {}) {
  return createClient({
    baseURL: "http://localhost:8080",
    options: { fetch, maxRetries: 2, ...options },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("attemptTimeoutMs", () => {
  it("is off by default: a slow attempt is waited for", async () => {
    let calls = 0;
    const wh = client(() => {
      calls++;
      return new Promise((resolve) => setTimeout(() => resolve(json(200, [])), 3_600_000));
    });
    const p = wh.from("t").select("*").fetch();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect((await p).ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("retries a stalled first attempt and succeeds on the second", async () => {
    const { impl, calls } = stallFirst(1);
    const wh = client(impl, { attemptTimeoutMs: 2000 });
    const p = wh.from("t").select("*").fetch();

    await vi.advanceTimersByTimeAsync(1999);
    expect(calls.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // the first attempt's deadline
    expect(calls.count).toBe(1); // backing off, not yet re-sent
    await vi.advanceTimersByTimeAsync(1000); // the backoff
    const r = await p;
    expect(r.ok).toBe(true);
    expect(calls.count).toBe(2);
  });

  it("gives each attempt its own deadline", async () => {
    // Attempt 1 stalls and times out at t=1000; attempt 2 starts after the
    // 1000 ms backoff and has until t=3000, not until t=1000 + the remainder.
    let calls = 0;
    const wh = client(
      (url, init) => {
        calls++;
        if (calls === 1) return stall(url, init);
        return new Promise((resolve) => setTimeout(() => resolve(json(200, [])), 900));
      },
      { attemptTimeoutMs: 1000 },
    );
    const p = wh.from("t").select("*").fetch();
    await vi.advanceTimersByTimeAsync(1000 + 1000 + 900);
    expect((await p).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("a per-call value overrides the client's, and 0 switches it off for the call", async () => {
    const { impl, calls } = stallFirst(1);
    const wh = client(impl, { attemptTimeoutMs: 60_000 });
    const p = wh.from("t").select("*").fetch({ attemptTimeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500 + 1000);
    expect((await p).ok).toBe(true);
    expect(calls.count).toBe(2);

    // 0: the stalled attempt is never cut off, so only the caller's signal ends it.
    const { impl: impl2, calls: calls2 } = stallFirst(1);
    const ac = new AbortController();
    const off = client(impl2, { attemptTimeoutMs: 100 })
      .from("t")
      .select("*")
      .fetch({ attemptTimeoutMs: 0, signal: ac.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls2.count).toBe(1);
    ac.abort();
    expect((await off).error?.code).toBe("ABORTED");
  });

  it("a caller abort during the retry wait stops at once", async () => {
    const { impl, calls } = stallFirst(99);
    const wh = client(impl, { attemptTimeoutMs: 1000 });
    const ac = new AbortController();
    const p = wh.from("t").select("*").fetch({ signal: ac.signal });

    await vi.advanceTimersByTimeAsync(1000); // timed out; now in the 1000 ms backoff
    await vi.advanceTimersByTimeAsync(300);
    ac.abort();
    const r = await p;
    expect(r.error?.code).toBe("ABORTED");
    expect(calls.count).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a caller abort during an attempt is ABORTED, not an attempt timeout", async () => {
    const { impl, calls } = stallFirst(99);
    const wh = client(impl, { attemptTimeoutMs: 60_000 });
    const ac = new AbortController();
    const p = wh.from("t").select("*").fetch({ signal: ac.signal });
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    const r = await p;
    expect(r.error?.code).toBe("ABORTED");
    expect(calls.count).toBe(1);
  });

  it("an already aborted signal never starts an attempt's timer", async () => {
    const { impl } = stallFirst(99);
    const ac = new AbortController();
    ac.abort();
    const r = await client(impl, { attemptTimeoutMs: 1000 })
      .from("t")
      .select("*")
      .fetch({ signal: ac.signal });
    expect(r.error?.code).toBe("ABORTED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("all attempts timing out give one error naming the attempt count", async () => {
    const { impl, calls } = stallFirst(99);
    const wh = client(impl, { attemptTimeoutMs: 1000 });
    const p = wh.from("t").select("*").fetch();
    await vi.advanceTimersByTimeAsync(1000 + 1000 + 1000 + 2000 + 1000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(calls.count).toBe(3);
    expect(r.error).toMatchObject({ status: 0, code: "ATTEMPT_TIMEOUT", retryable: true });
    expect(r.error?.message).toContain("1000 ms, after 3 attempts");
  });

  it("covers the response body, not only the headers", async () => {
    let calls = 0;
    const wh = client(
      (_url, init) => {
        calls++;
        if (calls > 1) return Promise.resolve(json(200, [{ n: 1 }]));
        const res = json(200, []);
        // Headers arrive; the body never does.
        res.text = () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        return Promise.resolve(res);
      },
      { attemptTimeoutMs: 1000 },
    );
    const p = wh.from("t").select("*").fetch();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await p).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("ends an attempt even when a custom fetch ignores its signal", async () => {
    let calls = 0;
    const wh = client(
      () => {
        calls++;
        return calls === 1 ? new Promise<Response>(() => {}) : Promise.resolve(json(200, []));
      },
      { attemptTimeoutMs: 1000 },
    );
    const p = wh.from("t").select("*").fetch();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await p).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("leaves no timer or listener behind", async () => {
    const ac = new AbortController();
    const wh = client(() => Promise.resolve(json(200, [])), { attemptTimeoutMs: 1000 });
    for (let i = 0; i < 20; i++) await wh.from("t").select("*").fetch({ signal: ac.signal });
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("calls that may write are not resent after the request may have been sent", () => {
    it("wh.sql() is sent once and says so", async () => {
      const { impl, calls } = stallFirst(99);
      const wh = client(impl, { attemptTimeoutMs: 1000 });
      const p = wh.sql("DROP TABLE x");
      await vi.advanceTimersByTimeAsync(60_000);
      const r = await p;
      expect(calls.count).toBe(1);
      expect(r.error).toMatchObject({ code: "ATTEMPT_TIMEOUT", retryable: false });
      expect(r.error?.message).toContain("after 1 attempt");
      expect(r.error?.message).not.toContain("attempts");
    });

    it("a pipe call is sent once", async () => {
      const { impl, calls } = stallFirst(99);
      const wh = client(impl, { attemptTimeoutMs: 1000 });
      const p = wh.pipe("p").fetch();
      await vi.advanceTimersByTimeAsync(60_000);
      const r = await p;
      expect(calls.count).toBe(1);
      expect(r.error).toMatchObject({ code: "ATTEMPT_TIMEOUT", retryable: false });
    });

    it("an insert, which the server dedupes, is retried like a read", async () => {
      const { impl, calls } = stallFirst(1);
      const wh = client(impl, { attemptTimeoutMs: 1000 });
      const p = wh.from("t").insert({ a: 1 });
      await vi.advanceTimersByTimeAsync(2000);
      await p;
      expect(calls.count).toBe(2);
    });
  });
});

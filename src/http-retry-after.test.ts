import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRetryAfter, request } from "./http.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");

describe("parseRetryAfter", () => {
  it.each([
    ["seconds", "5", 5000],
    ["zero, which means retry now", "0", 0],
    ["seconds with padding", " 7 ", 7000],
    ["an HTTP-date in the future", "Thu, 29 Oct 2026 12:00:05 GMT", 5000],
    ["an HTTP-date in the past", "Thu, 29 Oct 2026 11:59:00 GMT", 0],
    ["garbage", "soon", undefined],
    ["a negative number", "-3", undefined],
    ["a fraction", "1.5", undefined],
    ["an empty value", "", undefined],
    ["no header", null, undefined],
  ])("reads %s", (_name, value, want) => {
    expect(parseRetryAfter(value, NOW)).toBe(want);
  });
});

describe("Retry-After in request()", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const ctx = (maxRetryAfterMs?: number) => ({
    baseURL: "http://localhost:8080",
    options: { maxRetries: 1, maxRetryAfterMs },
  });
  const answer503 = (retryAfter: string) => () =>
    new Response(JSON.stringify({ error: "busy" }), {
      status: 503,
      headers: { "Retry-After": retryAfter },
    });
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // No jitter, so the wait is exactly what the header asked for.
    vi.spyOn(Math, "random").mockReturnValue(0);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Starts a call whose first answer is `first`, and returns it with a way to wait. */
  function start(first: () => Response, maxRetryAfterMs?: number) {
    fetchSpy.mockImplementationOnce(async () => first()).mockImplementation(async () => ok());
    return request(ctx(maxRetryAfterMs), { method: "GET", path: "/x" });
  }

  it.each([
    ["seconds", "5", 5000],
    ["an HTTP-date in the future", "Thu, 29 Oct 2026 12:00:05 GMT", 5000],
    ["0, which is not the 30 s fallback", "0", 0],
    ["an HTTP-date in the past", "Thu, 29 Oct 2026 11:00:00 GMT", 0],
  ])("waits for %s", async (_name, header, waitMs) => {
    const p = start(answer503(header));
    await vi.advanceTimersByTimeAsync(Math.max(0, waitMs - 1));
    // `waitMs - 1` ms in: still waiting, unless there was nothing to wait for.
    expect(fetchSpy).toHaveBeenCalledTimes(waitMs === 0 ? 2 : 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((await p).error).toBeNull();
  });

  it("falls back to normal backoff, not 30 s, for a value it cannot read", async () => {
    const p = start(answer503("soon"));
    // First backoff is 1 s.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((await p).error).toBeNull();
  });

  it("returns the server's answer instead of sleeping past the cap", async () => {
    const result = await start(answer503("3600"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.error?.status).toBe(503);
    expect(result.error?.message).toBe("busy");
  });

  it("applies the same cap to an HTTP-date", async () => {
    const result = await start(answer503("Thu, 29 Oct 2026 14:00:00 GMT"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.error?.status).toBe(503);
  });

  it("honours a configured maxRetryAfterMs, up and down", async () => {
    // Raised: a 60 s ask is waited out.
    const waited = start(answer503("60"), 120_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((await waited).error).toBeNull();

    // Lowered: a 5 s ask is refused.
    fetchSpy.mockReset();
    const refused = await start(answer503("5"), 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(refused.error?.status).toBe(503);
  });

  it("jitters the wait but never below what the server asked", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const p = start(answer503("5"));
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((await p).error).toBeNull();
  });

  it("applies the cap to a pipe call's 429 too", async () => {
    fetchSpy.mockImplementation(
      async () => new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }),
    );
    const result = await request(ctx(), { method: "POST", path: "/x", body: {}, kind: "pipe" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.error?.status).toBe(429);
  });

  it("honors Retry-After on a read's 429 and caps it", async () => {
    const answer429 = (retryAfter: string) => () =>
      new Response("{}", { status: 429, headers: { "Retry-After": retryAfter } });
    fetchSpy
      .mockImplementationOnce(async () => answer429("5")())
      .mockImplementationOnce(async () => ok());
    const p = request(ctx(), { method: "GET", path: "/x" });
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((await p).error).toBeNull();

    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async () => answer429("3600")());
    const refused = await request(ctx(), { method: "GET", path: "/x" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(refused.error?.status).toBe(429);
  });

  it("never resends raw SQL after a 429", async () => {
    fetchSpy.mockImplementation(
      async () => new Response("{}", { status: 429, headers: { "Retry-After": "1" } }),
    );
    const result = await request(ctx(), { method: "POST", path: "/x", body: {}, kind: "sql" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.error?.status).toBe(429);
  });
});

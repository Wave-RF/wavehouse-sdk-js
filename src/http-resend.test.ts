import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CallKind, request } from "./http.js";

const ctx = { baseURL: "http://localhost:8080", options: { maxRetries: 2 } };

/** A rejection shaped like undici's: `TypeError: fetch failed` with a `cause`. */
function failed(cause?: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}
const sysErr = (code: string) => Object.assign(new Error(code), { code });

const json = (status: number, body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });
const ok = () => json(200, [{ n: 1 }]);

describe("resend safety by call kind", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Runs one call to completion and reports how many times fetch ran. */
  async function run(kind: CallKind, ...answers: Array<() => Response | Promise<never>>) {
    for (const a of answers) {
      fetchSpy.mockImplementationOnce(async () => a());
    }
    const p = request(ctx, { method: "POST", path: "/x", body: {}, kind });
    await vi.runAllTimersAsync();
    const result = await p;
    return { result, calls: fetchSpy.mock.calls.length };
  }
  const reject = (e: unknown) => () => Promise.reject(e) as Promise<never>;

  describe.each(["sql", "pipe"] as const)("%s: network errors", (kind) => {
    it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])("resends after %s", async (code) => {
      const { result, calls } = await run(kind, reject(failed(sysErr(code))), ok);
      expect(calls).toBe(2);
      expect(result.error).toBeNull();
    });

    it("resends when every address of an AggregateError was refused", async () => {
      const agg = new AggregateError([sysErr("ECONNREFUSED"), sysErr("ECONNREFUSED")]);
      const { calls } = await run(kind, reject(failed(agg)), ok);
      expect(calls).toBe(2);
    });

    it.each([
      ["a reset after connecting", failed(sysErr("ECONNRESET"))],
      ["a bare TypeError, as a browser reports", new TypeError("Failed to fetch")],
      [
        "an aggregate with one non-dial error",
        failed(new AggregateError([sysErr("ECONNREFUSED"), sysErr("ECONNRESET")])),
      ],
    ])("does not resend after %s", async (_n, e) => {
      const { result, calls } = await run(kind, reject(e), ok);
      expect(calls).toBe(1);
      expect(result.error?.code).toBe("NETWORK_ERROR");
    });
  });

  describe("sql: error answers", () => {
    it.each([500, 502, 503, 504])("does not resend a %i", async (status) => {
      const { calls } = await run("sql", () => json(status, {}, { "Retry-After": "1" }), ok);
      expect(calls).toBe(1);
    });
    it("does not resend when the server says retryable", async () => {
      const { calls } = await run("sql", () => json(503, { retryable: true }), ok);
      expect(calls).toBe(1);
    });
  });

  describe("pipe: error answers", () => {
    it.each([500, 502, 504])("does not resend a bare %i", async (status) => {
      const { result, calls } = await run("pipe", () => json(status, {}), ok);
      expect(calls).toBe(1);
      expect(result.error?.status).toBe(status);
    });
    it("does not resend a bare 503 without Retry-After", async () => {
      const { calls } = await run("pipe", () => new Response("", { status: 503 }), ok);
      expect(calls).toBe(1);
    });
    it("does not resend when the server says retryable:false", async () => {
      const { calls } = await run("pipe", () => json(500, { retryable: false }), ok);
      expect(calls).toBe(1);
    });
    it("does not resend a 503 with Retry-After when the server says retryable:false", async () => {
      const { calls } = await run(
        "pipe",
        () => json(503, { retryable: false }, { "Retry-After": "1" }),
        ok,
      );
      expect(calls).toBe(1);
    });
    it("resends when the server says retryable:true", async () => {
      const { result, calls } = await run("pipe", () => json(500, { retryable: true }), ok);
      expect(calls).toBe(2);
      expect(result.error).toBeNull();
    });
    it("resends a 429", async () => {
      const { calls } = await run("pipe", () => json(429, {}, { "Retry-After": "1" }), ok);
      expect(calls).toBe(2);
    });
    it("resends a 503 with Retry-After", async () => {
      const { calls } = await run("pipe", () => json(503, {}, { "Retry-After": "1" }), ok);
      expect(calls).toBe(2);
    });
  });

  describe("read: unchanged", () => {
    it("resends any network error", async () => {
      const { calls } = await run("read", reject(failed(sysErr("ECONNRESET"))), ok);
      expect(calls).toBe(2);
    });
    it("resends a bare 5xx", async () => {
      const { calls } = await run("read", () => json(502, {}), ok);
      expect(calls).toBe(2);
    });
    it("does not resend a 4xx", async () => {
      const { calls } = await run("read", () => json(400, {}), ok);
      expect(calls).toBe(1);
    });
  });
});

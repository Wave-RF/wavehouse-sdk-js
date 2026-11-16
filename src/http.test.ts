import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "./http.js";
import type { HttpContext } from "./types.js";

function makeCtx(overrides?: Partial<HttpContext>): HttpContext {
  return {
    baseURL: "http://localhost:8080",
    options: { maxRetries: 0 },
    ...overrides,
  };
}

describe("request", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes a successful GET request", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

    const result = await request<{ status: string }>(makeCtx(), {
      method: "GET",
      path: "/health",
    });

    expect(result.data).toEqual({ status: "ok" });
    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/health");
    expect(init.method).toBe("GET");
  });

  it("makes a POST request with JSON body", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await request(makeCtx(), {
      method: "POST",
      path: "/v1/ingest?table=clicks",
      body: { page: "/home" },
    });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ page: "/home" }));
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("sends no Content-Type on a request without a body", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

    await request(makeCtx(), { method: "GET", path: "/health" });

    // A Content-Type here would make a cross-origin browser read preflight.
    const [, init] = fetchSpy.mock.calls[0];
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain("content-type");
    expect(init.headers.Accept).toBe("application/json");
  });

  it("sends rawBody verbatim with a custom Content-Type", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ total: 1 }), { status: 200 }));

    const ndjson = '{"page":"/a"}\n{"page":"/b"}';
    await request(makeCtx(), {
      method: "POST",
      path: "/v1/ingest?table=clicks",
      rawBody: ndjson,
      contentType: "application/x-ndjson",
    });

    const [, init] = fetchSpy.mock.calls[0];
    // rawBody is sent as-is — no JSON.stringify wrapping.
    expect(init.body).toBe(ndjson);
    expect(init.headers["Content-Type"]).toBe("application/x-ndjson");
  });

  it("injects auth token when auth function provided", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await request(makeCtx({ auth: async () => "my-token" }), {
      method: "GET",
      path: "/v1/ops/schema",
    });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer my-token");
  });

  it("does not inject auth header when auth returns empty", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await request(makeCtx({ auth: async () => "" }), {
      method: "GET",
      path: "/v1/ops/schema",
    });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("returns error for 4xx responses", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "unknown table: foo" }), { status: 404 }),
    );

    const result = await request(makeCtx(), { method: "GET", path: "/v1/ops/schema?table=foo" });

    expect(result.data).toBeNull();
    expect(result.error?.status).toBe(404);
    expect(result.error?.message).toBe("unknown table: foo");
    expect(result.error?.retryable).toBe(false);
  });

  it("does not retry a 5xx the server marks not retryable", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Authentication failed",
          code: "clickhouse.misconfigured",
          retryable: false,
        }),
        { status: 502 },
      ),
    );

    const result = await request(makeCtx({ options: { maxRetries: 2 } }), {
      method: "POST",
      path: "/v1/query?table=clicks",
      body: {},
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.error?.code).toBe("clickhouse.misconfigured");
    expect(result.error?.retryable).toBe(false);
  });

  it("returns error for 500 without retry when maxRetries=0", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
    );

    const result = await request(makeCtx({ options: { maxRetries: 0 } }), {
      method: "GET",
      path: "/health",
    });

    expect(result.error?.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("retries on 5xx up to maxRetries", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "err" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "err" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await request(makeCtx({ options: { maxRetries: 2 } }), {
      method: "GET",
      path: "/health",
    });

    expect(result.data).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("retries on network error", async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await request(makeCtx({ options: { maxRetries: 1 } }), {
      method: "GET",
      path: "/health",
    });

    expect(result.data).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns abort error when signal is aborted", async () => {
    fetchSpy.mockRejectedValue(new DOMException("Aborted", "AbortError"));

    const ac = new AbortController();
    ac.abort();

    const result = await request(makeCtx(), {
      method: "GET",
      path: "/health",
      signal: ac.signal,
    });

    expect(result.error?.code).toBe("ABORTED");
    expect(result.error?.retryable).toBe(false);
  });

  it("returns ABORTED when the abort lands during a retry backoff", async () => {
    // The existing abort test rejects the *fetch*, which is caught by the
    // branch at the top of the catch. This one aborts during the backoff that
    // runs inside that same catch — the one sleep whose rejection had no
    // handler, so it escaped `request()` as a raw DOMException and reached the
    // caller as an unhandled rejection instead of the documented Result.
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);

    // maxRetries must be > 0 or there is no backoff to abort during —
    // the default fixture is 0, which returns NETWORK_ERROR on the first pass.
    const result = await request(makeCtx({ options: { maxRetries: 1 } }), {
      method: "GET",
      path: "/health",
      signal: ac.signal,
    });

    expect(result.error?.code).toBe("ABORTED");
    expect(result.error?.retryable).toBe(false);
  });

  it.each([0, 2])(
    "reports ABORTED regardless of the rejection type, at maxRetries=%i",
    async (maxRetries) => {
      // AbortSignal.timeout() rejects with a TimeoutError, and node-fetch with
      // its own AbortError class — neither is a DOMException named AbortError.
      // Keying the check off the error alone made the answer depend on whether
      // a retry remained for the backoff sleep to notice the signal.
      const ac = new AbortController();
      fetchSpy.mockImplementation(async () => {
        ac.abort();
        throw new TypeError("fetch failed");
      });

      const result = await request(makeCtx({ options: { maxRetries } }), {
        method: "GET",
        path: "/health",
        signal: ac.signal,
      });

      expect(result.error?.code).toBe("ABORTED");
    },
  );

  it("retries a middleware's own AbortError when the caller did not cancel", async () => {
    // An `options.fetch` enforcing a per-attempt deadline aborts an internal
    // controller and rejects with a real AbortError, while the caller's signal
    // is untouched. Nobody asked to cancel, so this is transient — matching on
    // the error type instead of the signal would end the call as ABORTED.
    fetchSpy
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await request<{ ok: boolean }>(makeCtx({ options: { maxRetries: 1 } }), {
      method: "GET",
      path: "/health",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("appends query params to URL", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await request(makeCtx(), {
      method: "GET",
      path: "/v1/ops/dlq/stats",
      params: { table: "clicks" },
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("table=clicks");
  });

  it("keeps a base path prefix on the request URL", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await request(makeCtx({ baseURL: "https://app.example.com/api/warehouse" }), {
      method: "POST",
      path: "/v1/query?table=clicks",
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/warehouse/v1/query?table=clicks");
  });

  it("keeps a base path prefix when appending params", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await request(makeCtx({ baseURL: "https://app.example.com/api/warehouse/" }), {
      method: "GET",
      path: "/v1/ops/dlq/stats",
      params: { table: "clicks" },
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/warehouse/v1/ops/dlq/stats?table=clicks");
  });

  it("handles empty response body", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 200 }));

    const result = await request(makeCtx(), {
      method: "POST",
      path: "/v1/ops/schema/refresh",
    });

    expect(result.data).toBeUndefined();
    expect(result.error).toBeNull();
  });

  it("leaves no abort listener behind on a shared signal after retries", async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const added = vi.spyOn(ac.signal, "addEventListener");
      const removed = vi.spyOn(ac.signal, "removeEventListener");
      for (let i = 0; i < 12; i++) {
        fetchSpy
          .mockResolvedValueOnce(new Response("{}", { status: 503 }))
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        const pending = request(makeCtx({ options: { maxRetries: 1 } }), {
          method: "GET",
          path: "/health",
          signal: ac.signal,
        });
        await vi.advanceTimersByTimeAsync(2_000);
        expect((await pending).data).toEqual({ ok: true });
      }
      const aborts = (spy: typeof added) => spy.mock.calls.filter((c) => c[0] === "abort").length;
      expect(aborts(added)).toBeGreaterThan(0);
      // Every listener `sleep` attached has been taken off again.
      expect(aborts(removed)).toBe(aborts(added));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("request redirects", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const redirect = () =>
    new Response(null, {
      status: 307,
      headers: { Location: "https://other.example/v1/ops/query" },
    });

  it("does not follow a redirect when the call carries a token and headers", async () => {
    fetchSpy.mockImplementation(async () => redirect());
    const res = await request(
      makeCtx({
        options: { maxRetries: 2, headers: { "X-Proxy-Secret": "s3cret" } },
        auth: () => "tok",
      }),
      { method: "POST", path: "/v1/ops/query", rawBody: "DELETE FROM t", kind: "sql" },
    );
    expect(fetchSpy.mock.calls[0][1].redirect).toBe("manual");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(res.data).toBeNull();
    expect(res.error).toMatchObject({ code: "REDIRECT", status: 307, retryable: false });
    expect(res.error?.message).toContain("307");
    expect(res.error?.message).toContain("https://other.example/v1/ops/query");
  });

  it("does not follow one for a call carrying only per-call headers", async () => {
    fetchSpy.mockImplementation(async () => redirect());
    const res = await request(makeCtx(), {
      method: "GET",
      path: "/x",
      headers: { "X-Trace-Id": "abc" },
    });
    expect(fetchSpy.mock.calls[0][1].redirect).toBe("manual");
    expect(res.error?.code).toBe("REDIRECT");
  });

  it("reports a browser's opaque redirect, which has status 0 and no Location", async () => {
    fetchSpy.mockImplementation(async () => {
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, "type", { value: "opaqueredirect" });
      Object.defineProperty(r, "status", { value: 0 });
      Object.defineProperty(r, "ok", { value: false });
      return r;
    });
    const res = await request(makeCtx({ auth: () => "tok" }), { method: "GET", path: "/x" });
    expect(res.error).toMatchObject({ code: "REDIRECT", status: 0, retryable: false });
  });

  it("leaves redirects to fetch when the request carries no credential", async () => {
    fetchSpy.mockImplementation(async () => new Response("{}", { status: 200 }));
    await request(makeCtx(), { method: "GET", path: "/x" });
    expect(fetchSpy.mock.calls[0][1].redirect).toBeUndefined();
  });
});

describe("request with a 200 that is not JSON", () => {
  it.each(["read", "sql", "pipe"] as const)(
    "returns DECODE_ERROR once for a %s call",
    async (kind) => {
      const fetchSpy = vi.fn(async () => new Response("<html>login</html>", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);
      const res = await request(makeCtx({ options: { maxRetries: 2 } }), {
        method: "POST",
        path: "/x",
        body: {},
        kind,
      });
      vi.unstubAllGlobals();
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(res.error).toMatchObject({ code: "DECODE_ERROR", status: 200, retryable: false });
      expect(res.error?.message).not.toContain("login");
    },
  );
});

describe("request with an unusable maxRetries", () => {
  it("still makes one attempt and returns a result, never null data and null error", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await request(makeCtx({ options: { maxRetries: -1 } }), {
      method: "GET",
      path: "/x",
    });
    vi.unstubAllGlobals();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(res.error).toBeNull();
    expect(res.data).toEqual({});
  });
});

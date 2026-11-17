import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import type { FetchLike } from "./types.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// The contract (see `ClientConfig.auth`): `auth` runs before EVERY attempt.
describe("auth runs before every attempt", () => {
  it("is called once per attempt, and the token that changed in between is the one sent", async () => {
    const sent: string[] = [];
    let n = 0;
    const fetch: FetchLike = async (_url, init) => {
      sent.push(((init?.headers ?? {}) as Record<string, string>).Authorization);
      return ++n < 3 ? json(503, { error: "busy" }) : json(200, [{ a: 1 }]);
    };
    let minted = 0;
    const auth = vi.fn(() => `tok-${++minted}`);
    const wh = createClient({
      baseURL: "http://localhost:8080",
      auth,
      options: { fetch, maxRetries: 2 },
    });

    const p = wh.from("t").select("*").fetch();
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    const r = await p;

    expect(r.ok).toBe(true);
    expect(auth).toHaveBeenCalledTimes(3);
    expect(sent).toEqual(["Bearer tok-1", "Bearer tok-2", "Bearer tok-3"]);
  });

  it("is called once for a call that is not retried", async () => {
    const auth = vi.fn(() => "tok");
    const wh = createClient({
      baseURL: "http://localhost:8080",
      auth,
      options: { fetch: async () => json(200, []), maxRetries: 2 },
    });
    await wh.from("t").select("*").fetch();
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it("is re-run after a network error too", async () => {
    let n = 0;
    const sent: string[] = [];
    const fetch: FetchLike = async (_url, init) => {
      sent.push(((init?.headers ?? {}) as Record<string, string>).Authorization);
      if (++n === 1) throw new TypeError("fetch failed");
      return json(200, []);
    };
    let minted = 0;
    const wh = createClient({
      baseURL: "http://localhost:8080",
      auth: async () => `tok-${++minted}`,
      options: { fetch, maxRetries: 1 },
    });
    const p = wh.from("t").select("*").fetch();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).ok).toBe(true);
    expect(sent).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  it("a rejection on a retry throws out of the call, as on the first attempt", async () => {
    let n = 0;
    const fetch: FetchLike = async () => json(503, { error: "busy" });
    const wh = createClient({
      baseURL: "http://localhost:8080",
      auth: async () => {
        if (++n === 2) throw new Error("token endpoint down");
        return "tok";
      },
      options: { fetch, maxRetries: 2 },
    });
    const p = wh.from("t").select("*").fetch();
    const settled = p.then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await settled).toBe("token endpoint down");
  });

  it("is re-run on every stream connect", async () => {
    const sent: string[] = [];
    const fetch: FetchLike = async (_url, init) => {
      sent.push(((init?.headers ?? {}) as Record<string, string>).Authorization);
      // Ends at once, so the stream reconnects.
      return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    let minted = 0;
    const wh = createClient({
      baseURL: "http://localhost:8080",
      auth: () => `tok-${++minted}`,
      options: { fetch },
    });
    const stream = wh.from("t").stream();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    stream.close();
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.slice(0, 3)).toEqual(["Bearer tok-1", "Bearer tok-2", "Bearer tok-3"]);
  });
});

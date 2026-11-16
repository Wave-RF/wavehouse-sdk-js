import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import { overlayHeaders } from "./http.js";
import type { FetchLike } from "./types.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

interface Seen {
  url: string;
  init: RequestInit;
}

/** A fetch that records every call and answers `[]`. */
function recorder(answer: () => Response = () => json(200, [])) {
  const seen: Seen[] = [];
  const impl: FetchLike = async (url, init) => {
    seen.push({ url, init: init ?? {} });
    return answer();
  };
  return { impl, seen };
}

/** The headers a call sent, as a plain object. */
const sent = (s: Seen) => s.init.headers as Record<string, string>;

/** True when no two keys differ only in case: `Headers` would comma-join those. */
const noDuplicateNames = (h: Record<string, string>) => {
  const lower = Object.keys(h).map((k) => k.toLowerCase());
  return new Set(lower).size === lower.length;
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("overlayHeaders", () => {
  it("lets a later layer replace an earlier name, in any case, never joining", () => {
    const out = overlayHeaders({ "X-A": "1", "x-b": "1" }, undefined, { "x-a": "2", "X-B": "2" });
    expect(out).toEqual({ "x-a": "2", "X-B": "2" });
  });
});

describe("header precedence", () => {
  it("is client < per-call < auth's Authorization < the SDK's own", async () => {
    const { impl, seen } = recorder();
    const wh = createClient({
      baseURL: "http://localhost:8080",
      auth: () => "jwt",
      options: {
        fetch: impl,
        maxRetries: 0,
        headers: {
          "X-A": "client",
          "x-b": "client",
          "X-Client": "c",
          Authorization: "Basic client",
          "content-type": "text/client",
        },
      },
    });

    await wh.from("t").select("*").fetch();
    let h = sent(seen[0]);
    expect(h["X-A"]).toBe("client");
    expect(h["X-Client"]).toBe("c");
    expect(h.Authorization).toBe("Bearer jwt");
    expect(h["Content-Type"]).toBe("application/json");
    expect(noDuplicateNames(h)).toBe(true);

    await wh
      .from("t")
      .select("*")
      .fetch({
        headers: {
          "x-a": "call",
          "X-B": "call",
          "X-Call": "yes",
          authorization: "Basic call",
          "CONTENT-TYPE": "text/call",
          accept: "text/call",
        },
      });
    h = sent(seen[1]);
    const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    expect(lower["x-a"]).toBe("call");
    expect(lower["x-b"]).toBe("call");
    expect(lower["x-call"]).toBe("yes");
    expect(lower["x-client"]).toBe("c");
    expect(lower.authorization).toBe("Bearer jwt");
    expect(lower["content-type"]).toBe("application/json");
    expect(lower.accept).toBe("application/json");
    // Case-insensitive and never joined: one entry per name.
    expect(noDuplicateNames(h)).toBe(true);
    expect(Object.values(h).some((v) => v.includes(","))).toBe(false);
  });

  it("a dynamic client header is the lowest layer too", async () => {
    const { impl, seen } = recorder();
    const wh = createClient({
      baseURL: "http://localhost:8080",
      auth: () => "jwt",
      options: {
        fetch: impl,
        maxRetries: 0,
        headers: () => ({ "X-A": "dyn", Authorization: "Basic dyn" }),
      },
    });
    await wh
      .from("t")
      .select("*")
      .fetch({ headers: { "x-a": "call" } });
    const h = sent(seen[0]);
    expect(h["x-a"]).toBe("call");
    expect(h.Authorization).toBe("Bearer jwt");
    expect(noDuplicateNames(h)).toBe(true);
  });

  it("applies to every REST call", async () => {
    const { impl, seen } = recorder(() => json(200, { ok: true }));
    const wh = createClient({
      baseURL: "http://localhost:8080",
      options: { fetch: impl, maxRetries: 0 },
    });
    const headers = { "X-Call": "1" };
    await wh.from("t").select("*").fetch({ headers });
    await wh.from("t").fetch({ headers });
    await wh.from("t").insert({ a: 1 }, { headers });
    await wh.from("t").insert([{ a: 1 }], { headers });
    await wh.from("t").insertNDJSON('{"a":1}', { headers });
    await wh.from("t").schema({ headers });
    await wh.pipe("p").fetch({ headers });
    await wh.sql("SELECT 1", { headers });
    await wh.schema.list({ headers });
    await wh.schema.refresh({ headers });
    await wh.dlq.list({ headers });
    await wh.dlq.table("t", { headers });
    await wh.pipes.list({ headers });
    await wh.pipes.get("p", { headers });
    await wh.settings.reload({ headers });
    await wh.sys.health({ headers });
    await wh.version({ headers });
    expect(seen).toHaveLength(17);
    for (const s of seen) expect(sent(s)["X-Call"], s.url).toBe("1");
  });
});

describe("dynamic headers", () => {
  it("run before every attempt, so a rotated value is the one a retry sends", async () => {
    let n = 0;
    const seen: string[] = [];
    const fetch: FetchLike = async (_url, init) => {
      seen.push(((init?.headers ?? {}) as Record<string, string>)["X-Rotating"]);
      return ++n < 3 ? json(503, { error: "busy" }) : json(200, []);
    };
    let minted = 0;
    const provider = vi.fn(async () => ({ "X-Rotating": `v${++minted}` }));
    const wh = createClient({
      baseURL: "http://localhost:8080",
      options: { fetch, maxRetries: 2, headers: provider },
    });
    const p = wh.from("t").select("*").fetch();
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).ok).toBe(true);
    expect(provider).toHaveBeenCalledTimes(3);
    expect(seen).toEqual(["v1", "v2", "v3"]);
  });

  it("a rejection throws out of the call, like a rejecting auth", async () => {
    const { impl, seen } = recorder();
    const wh = createClient({
      baseURL: "http://localhost:8080",
      options: {
        fetch: impl,
        headers: async () => {
          throw new Error("vault down");
        },
      },
    });
    await expect(wh.from("t").select("*").fetch()).rejects.toThrow("vault down");
    expect(seen).toHaveLength(0);
  });
});

describe("per-call fetchOptions and fetch", () => {
  it("fetchOptions merge over the client's, and the SDK's own fields still win", async () => {
    const { impl, seen } = recorder();
    const ac = new AbortController();
    const wh = createClient({
      baseURL: "http://localhost:8080",
      options: {
        fetch: impl,
        maxRetries: 0,
        fetchOptions: { cache: "no-store", credentials: "omit" },
      },
    });
    await wh
      .from("t")
      .select("*")
      .fetch({
        signal: ac.signal,
        fetchOptions: {
          credentials: "include",
          keepalive: true,
          ...({ next: { tags: ["t"] } } as object),
          method: "DELETE",
          body: "nope",
          headers: { "X-Nope": "1" },
        },
      });
    const init = seen[0].init as RequestInit & { next?: unknown };
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("include");
    expect(init.keepalive).toBe(true);
    expect(init.next).toEqual({ tags: ["t"] });
    expect(init.method).toBe("POST");
    expect(init.body).not.toBe("nope");
    expect(sent(seen[0])["X-Nope"]).toBeUndefined();
  });

  it("a per-call fetch replaces the client's for that call only", async () => {
    const client = recorder();
    const call = recorder();
    const wh = createClient({
      baseURL: "http://localhost:8080",
      options: { fetch: client.impl, maxRetries: 0 },
    });
    await wh.from("t").select("*").fetch({ fetch: call.impl });
    await wh.from("t").select("*").fetch();
    expect(call.seen).toHaveLength(1);
    expect(client.seen).toHaveLength(1);
  });
});

describe("streams", () => {
  const emptyStream = () =>
    new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });

  it("take client headers (static and dynamic) and per-subscription headers", async () => {
    for (const clientHeaders of [
      { "X-A": "client", "X-B": "client" },
      () => ({ "X-A": "client", "X-B": "client" }),
    ]) {
      const { impl, seen } = recorder(emptyStream);
      const wh = createClient({
        baseURL: "http://localhost:8080",
        auth: () => "jwt",
        options: { fetch: impl, headers: clientHeaders },
      });
      const stream = wh
        .from("t")
        .stream({ headers: { "x-a": "sub", Authorization: "Basic sub", accept: "nope" } });
      await vi.advanceTimersByTimeAsync(10);
      stream.close();
      const h = sent(seen[0]);
      expect(h["x-a"]).toBe("sub");
      expect(h["X-B"]).toBe("client");
      expect(h.Authorization).toBe("Bearer jwt");
      expect(h.Accept).toBe("text/event-stream");
      expect(noDuplicateNames(h)).toBe(true);
    }
  });

  it("run a dynamic header function on every connect", async () => {
    const { impl, seen } = recorder(emptyStream);
    let n = 0;
    const wh = createClient({
      baseURL: "http://localhost:8080",
      options: { fetch: impl, headers: () => ({ "X-N": String(++n) }) },
    });
    const stream = wh.from("t").stream();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    stream.close();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.slice(0, 3).map((s) => sent(s)["X-N"])).toEqual(["1", "2", "3"]);
  });

  it("a rejecting header function is a retryable SSE_AUTH_ERROR that the stream rides out", async () => {
    const { impl, seen } = recorder(emptyStream);
    let n = 0;
    const wh = createClient({
      baseURL: "http://localhost:8080",
      options: {
        fetch: impl,
        headers: async () => {
          if (++n === 1) throw new Error("vault down");
          return { "X-K": "v" };
        },
      },
    });
    const errors: string[] = [];
    const stream = wh.from("t").stream();
    stream.subscribe({ next: () => {}, error: (e) => errors.push(e.code) });
    await vi.advanceTimersByTimeAsync(3000);
    stream.close();
    expect(errors[0]).toBe("SSE_AUTH_ERROR");
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(sent(seen[0])["X-K"]).toBe("v");
  });

  it("a header counts as a credential: the stream refuses redirects", async () => {
    const { impl, seen } = recorder(emptyStream);
    const wh = createClient({
      baseURL: "http://localhost:8080",
      options: { fetch: impl },
    });
    const stream = wh.from("t").stream({ headers: { "X-Key": "secret" } });
    await vi.advanceTimersByTimeAsync(10);
    stream.close();
    expect(seen[0].init.redirect).toBe("manual");
  });
});

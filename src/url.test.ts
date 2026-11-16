import { describe, expect, it } from "vitest";
import { normalizeBaseURL, resolveURL } from "./url.js";

describe("resolveURL", () => {
  it("resolves against a root-hosted base", () => {
    expect(resolveURL("http://localhost:8080", "/v1/query").toString()).toBe(
      "http://localhost:8080/v1/query",
    );
  });

  it("preserves a base path prefix", () => {
    expect(resolveURL("https://app.example.com/api/warehouse", "/v1/query").toString()).toBe(
      "https://app.example.com/api/warehouse/v1/query",
    );
  });

  it("preserves a prefix whether or not the base ends in a slash", () => {
    const withSlash = resolveURL("https://app.example.com/api/warehouse/", "/v1/query").toString();
    const without = resolveURL("https://app.example.com/api/warehouse", "/v1/query").toString();
    expect(withSlash).toBe(without);
    expect(without).toBe("https://app.example.com/api/warehouse/v1/query");
  });

  it("preserves a multi-segment prefix", () => {
    expect(resolveURL("https://example.com/a/b/c", "/v1/ops/pipes").toString()).toBe(
      "https://example.com/a/b/c/v1/ops/pipes",
    );
  });

  it("accepts a path with or without a leading slash", () => {
    expect(resolveURL("https://example.com/api", "v1/ops/schema").toString()).toBe(
      resolveURL("https://example.com/api", "/v1/ops/schema").toString(),
    );
  });

  it("keeps the query string embedded in a path", () => {
    expect(resolveURL("https://example.com/api", "/v1/ingest?table=clicks").toString()).toBe(
      "https://example.com/api/v1/ingest?table=clicks",
    );
  });

  it("appends params after the prefix", () => {
    const url = resolveURL("https://example.com/api", "/v1/ops/dlq/stats", { table: "clicks" });
    expect(url.toString()).toBe("https://example.com/api/v1/ops/dlq/stats?table=clicks");
  });

  it("merges params with a query string already on the path", () => {
    const url = resolveURL("https://example.com/api", "/v1/query?table=clicks", { limit: "10" });
    expect(url.pathname).toBe("/api/v1/query");
    expect(url.searchParams.get("table")).toBe("clicks");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("percent-encodes param values", () => {
    const url = resolveURL("https://example.com", "/v1/ops/schema", { table: "a b&c" });
    expect(url.searchParams.get("table")).toBe("a b&c");
    expect(url.toString()).toContain("table=a+b%26c");
  });

  it("drops a query or fragment on the base rather than letting it eat the prefix", () => {
    expect(resolveURL("https://example.com/api?stale=1", "/v1/query").toString()).toBe(
      "https://example.com/api/v1/query",
    );
    expect(resolveURL("https://example.com/api#frag", "/v1/query").toString()).toBe(
      "https://example.com/api/v1/query",
    );
  });

  it("preserves a non-default port", () => {
    expect(resolveURL("https://example.com:8443/api", "/v1/query").toString()).toBe(
      "https://example.com:8443/api/v1/query",
    );
  });

  it("gives a base with no scheme one", () => {
    expect(resolveURL("example.com/api", "/v1/query").toString()).toBe(
      "https://example.com/api/v1/query",
    );
  });
});

// The same table is in wavehouse-sdk-go's client_test.go: both SDKs must
// resolve one input to one base.
describe("normalizeBaseURL", () => {
  it.each([
    ["example.com", "https://example.com"],
    ["example.com:8080/api/warehouse", "https://example.com:8080/api/warehouse"],
    ["HTTPS://X.COM", "https://X.COM"],
    ["localhost", "http://localhost"],
    ["localhost:8080", "http://localhost:8080"],
    ["127.0.0.1:9000/x", "http://127.0.0.1:9000/x"],
    ["127.5.6.7", "http://127.5.6.7"],
    ["[::1]:8080", "http://[::1]:8080"],
    ["::1", "http://[::1]"],
    ["foo.localhost:3000", "http://foo.localhost:3000"],
    ["//example.com/api", "https://example.com/api"],
    ["//localhost:8080", "http://localhost:8080"],
    ["user@host:8080", "https://user@host:8080"],
    ["  example.com  ", "https://example.com"],
    ["http://lan-host:8080", "http://lan-host:8080"],
    ["http://example.com", "http://example.com"],
    ["https://example.com/api/", "https://example.com/api/"],
  ])("%s -> %s", (input, want) => {
    expect(normalizeBaseURL(input).replace(/\/+$/, "")).toBe(want.replace(/\/+$/, ""));
  });

  it("resolves a scheme-less base like the same base with its scheme", () => {
    expect(resolveURL("localhost:8080/api", "/v1/query").toString()).toBe(
      "http://localhost:8080/api/v1/query",
    );
    expect(resolveURL("example.com/api", "/v1/query").toString()).toBe(
      "https://example.com/api/v1/query",
    );
  });

  it.each(["", "   ", "https://"])("rejects %j with a message naming the requirement", (input) => {
    expect(() => resolveURL(input, "/v1/query")).toThrow(/baseURL .* is not a usable URL/);
  });
});

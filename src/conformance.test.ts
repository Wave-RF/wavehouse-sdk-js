import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createClient } from "./client.js";
import type { QueryBuilder } from "./query-builder.js";
import type { TableRef } from "./table.js";
import type { FetchLike } from "./types.js";

/**
 * Replays the request-conformance cases shared with wavehouse-sdk-go
 * (`testdata/wire_cases.json`, identical in both repositories): each case is an
 * SDK call and the exact request it must send.
 */
interface WireCase {
  name: string;
  /** Which SDKs replay the case; absent means both. */
  sdks?: string[];
  endpoint: string;
  table?: string;
  tenant?: string;
  operations?: { method: string; args?: unknown[] }[];
  pipe_name?: string;
  pipe_params?: Record<string, unknown> | null;
  sql?: string;
  expected_path?: string;
  expected_method?: string;
  expected_content_type?: string;
  expected_headers?: Record<string, string>;
  expected_body?: unknown;
  expected_ndjson?: unknown[];
  expected_no_request?: boolean;
}

const cases: WireCase[] = JSON.parse(
  readFileSync(new URL("../testdata/wire_cases.json", import.meta.url), "utf8"),
);

/**
 * The query builder sends `limit: 1000` when none is set (until
 * Wave-RF/WaveHouse#999); the shared cases describe the Go SDK, which sends
 * none. Applied here once, so a case without a limit op expects the default,
 * and `sdks`-scoped cases pin each side's own behaviour.
 */
const DEFAULT_LIMIT = 1000;

interface Seen {
  url: URL;
  init: RequestInit;
  body: string;
}

function answer(path: string, search: URLSearchParams): string {
  if (path === "/version") return '{"version":"1","git_commit":"","build_time":"","go_version":""}';
  if (path === "/v1/ingest") return '{"total":0,"succeeded":0,"failed":0,"duplicates":0}';
  if (path === "/v1/ops/settings/reload") return '{"adopted":true}';
  if (path === "/v1/ops/schema" && search.has("table")) return '{"name":"events","columns":[]}';
  if (path === "/v1/ops/dlq/stats") return '{"tables":{},"total":0}';
  if (path.startsWith("/v1/ops/pipes/")) return '{"name":"my_pipe","sql":"SELECT 1"}';
  return "[]";
}

/** Case-insensitive header lookup over the plain-object headers the SDK sends. */
function header(init: RequestInit, name: string): string | undefined {
  const h = (init.headers ?? {}) as Record<string, string>;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : h[key];
}

async function run(tc: WireCase): Promise<Seen[]> {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    seen.push({ url: u, init: init ?? {}, body: String(init?.body ?? "") });
    return new Response(answer(u.pathname, u.searchParams), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  // The data routes take the tenant from the client; the admin routes' cases
  // pass it per call, which also pins that a call-level tenant is honored.
  const dataTenant = ["query", "ingest", "pipe", "health", "version"].includes(tc.endpoint);
  const wh = createClient({
    baseURL: "http://wavehouse.test",
    options: { fetch, maxRetries: 0, tenant: dataTenant ? tc.tenant : undefined },
  });
  const ops = tc.operations ?? [];
  const opts = tc.tenant === undefined ? undefined : { tenant: tc.tenant };

  switch (tc.endpoint) {
    case "query":
      await applyOps(wh.from(tc.table ?? ""), ops).fetch();
      break;
    case "ingest":
      await wh.from(tc.table ?? "").insert(ops[0].args?.[0] as Record<string, unknown>);
      break;
    case "pipe":
      await wh.pipe(tc.pipe_name ?? "", tc.pipe_params ?? undefined).fetch();
      break;
    // JS has one raw-SQL call; Go splits it into Fetch and Exec.
    case "sql":
    case "sql_exec":
      await wh.sql(tc.sql ?? "", opts);
      break;
    case "health":
      await wh.sys.health();
      break;
    case "version":
      await wh.version();
      break;
    case "schema_list":
      await wh.schema.list(opts);
      break;
    case "schema_table":
      await wh.from(tc.table ?? "").schema(opts);
      break;
    case "schema_refresh":
      await wh.schema.refresh(opts);
      break;
    case "dlq_list":
      await wh.dlq.list(opts);
      break;
    case "settings_reload":
      await wh.settings.reload(opts);
      break;
    case "pipes_list":
      await wh.pipes.list(opts);
      break;
    case "pipes_get":
      await wh.pipes.get(tc.pipe_name ?? "", opts);
      break;
    default:
      // A hard failure, so a case nobody wired up can't hide drift between the SDKs.
      throw new Error(`unhandled endpoint "${tc.endpoint}": add it to run()`);
  }
  return seen;
}

function applyOps(table: TableRef, ops: WireCase["operations"]): QueryBuilder {
  let q = table.select();
  for (const op of ops ?? []) {
    const a = (op.args ?? []) as never[];
    // Go spells "no alias" as "", where JS takes the argument's default.
    const alias = (i: number) => ((a[i] as string) === "" ? undefined : (a[i] as string));
    switch (op.method) {
      case "select":
        q = q.select(...(a as string[]));
        break;
      case "selectAll":
        q = q.selectAll();
        break;
      case "where":
        q = q.where(a[0], a[1], a[2]);
        break;
      case "groupBy":
        q = q.groupBy(...(a as string[]));
        break;
      case "orderBy":
        q = q.orderBy(a[0], a[1]);
        break;
      case "limit":
        q = q.limit(a[0]);
        break;
      case "timeRange":
        q = q.timeRange(a[0], a[1], (a[2] as string) === "" ? undefined : a[2]);
        break;
      case "count":
        q = q.count(a[0], alias(1));
        break;
      case "sum":
        q = q.sum(a[0], alias(1));
        break;
      case "avg":
        q = q.avg(a[0], alias(1));
        break;
      case "min":
        q = q.min(a[0], alias(1));
        break;
      case "max":
        q = q.max(a[0], alias(1));
        break;
      case "countDistinct":
        q = q.countDistinct(a[0], alias(1));
        break;
      case "aggregate":
        q = q.aggregate(a[0], a[1], a[2]);
        break;
      default:
        throw new Error(`unhandled operation "${op.method}": add it to applyOps()`);
    }
  }
  return q;
}

/** Compare request URIs by meaning: same path, same decoded query values, any order. */
function normalize(p: string): string {
  const u = new URL(p, "http://x");
  const q = new URLSearchParams([...u.searchParams.entries()].sort());
  return `${u.pathname}?${q.toString()}`;
}

describe("request conformance (shared cases)", () => {
  for (const tc of cases.filter((c) => !c.sdks || c.sdks.includes("js"))) {
    it(tc.name, async () => {
      const seen = await run(tc);

      if (tc.expected_no_request) {
        expect(seen).toHaveLength(0);
        return;
      }
      expect(seen).toHaveLength(1);
      const got = seen[0];
      expect(got.init.method).toBe(tc.expected_method);
      expect(normalize(got.url.pathname + got.url.search)).toBe(normalize(tc.expected_path ?? ""));
      // The path itself is compared as sent (escaping included), the query by meaning.
      expect(got.url.pathname).toBe(new URL(tc.expected_path ?? "", "http://x").pathname);
      if (tc.expected_content_type) {
        expect(header(got.init, "Content-Type")).toBe(tc.expected_content_type);
      }
      for (const [k, v] of Object.entries(tc.expected_headers ?? {})) {
        expect(header(got.init, k) ?? "", `header ${k}`).toBe(v);
      }
      if (tc.expected_ndjson) {
        const lines = got.body.split("\n");
        expect(lines.map((l) => JSON.parse(l))).toEqual(tc.expected_ndjson);
      } else if (tc.expected_body !== undefined) {
        let want = tc.expected_body;
        const sdkDefault =
          tc.endpoint === "query" &&
          !tc.sdks &&
          !(tc.operations ?? []).some((o) => o.method === "limit");
        if (sdkDefault) want = { ...(want as object), limit: DEFAULT_LIMIT };
        expect(JSON.parse(got.body)).toEqual(want);
      } else {
        expect(got.body).toBe("");
      }
    });
  }
});

import { describe, expect, inject, it } from "vitest";
import { createClient } from "../src/index.js";
import { collect, eventRow, eventually, newClient, uniqueName } from "./helpers.js";

const wh = newClient();
// Older servers answer some things differently; see global-setup's probeServer.
const clickhouseRows = inject("clickhouseRows");

type Row = { event_id: string; name: string; value: number; ts: string };

/** Waits until `want` rows named `name` are queryable, ordered by value. */
async function rowsNamed(name: string, want: number) {
  return eventually(async () => {
    const res = await wh
      .from("e2e_events")
      .selectAll()
      .where("name", "=", name)
      .orderBy("value", "asc")
      .limit(100);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(want);
    return res.data as Row[];
  });
}

describe("health", () => {
  it("reports the server healthy", async () => {
    const res = await wh.sys.health();
    expect(res.error).toBeNull();
    expect(res.ok).toBe(true);
  });
});

describe("version", () => {
  it("reports the server build", async () => {
    const res = await wh.version();
    expect(res.error).toBeNull();
    expect(res.data?.version).toBeTruthy();
    expect(res.data?.go_version).toMatch(/^go/);
  });
});

describe("schema", () => {
  it("lists the fixture table", async () => {
    const res = await wh.schema.list();
    expect(res.error).toBeNull();
    expect(Object.keys(res.data ?? {})).toContain("e2e_events");
  });

  it("describes its columns", async () => {
    const res = await wh.from("e2e_events").schema();
    expect(res.error).toBeNull();
    const cols = res.data!.columns;
    expect(cols.map((c) => c.name)).toEqual(["event_id", "name", "value", "ts"]);
    expect(cols.map((c) => c.position)).toEqual([1, 2, 3, 4]);
    expect(cols.find((c) => c.name === "ts")?.default_kind).toBe("DEFAULT");
  });
});

describe("insert", () => {
  it("inserts one row", async () => {
    const name = uniqueName("one");
    const res = await wh.from("e2e_events").insert(eventRow(name, 1));
    expect(res.error).toBeNull();
    expect(res.data?.ok).toBe(true);

    const rows = await rowsNamed(name, 1);
    expect(rows[0].value).toBe(1);
  });

  it("inserts a batch and reports each record", async () => {
    const name = uniqueName("batch");
    const res = await wh
      .from("e2e_events")
      .insert([eventRow(name, 1), eventRow(name, 2), eventRow(name, 3)]);
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ ok: true, total: 3, succeeded: 3, failed: 0, duplicates: 0 });

    const rows = await rowsNamed(name, 3);
    expect(rows.map((r) => r.value)).toEqual([1, 2, 3]);
  });

  it("flags a repeated dedupe id as a duplicate", async () => {
    const row = eventRow(uniqueName("dup"), 1);
    const first = await wh.from("e2e_events").insert(row);
    expect(first.error).toBeNull();
    expect(first.data?.duplicate).toBeFalsy();

    const second = await wh.from("e2e_events").insert(row);
    expect(second.error).toBeNull();
    expect(second.data?.duplicate).toBe(true);
  });
});

describe("insert with an unknown column", () => {
  it("refuses the whole body, or rejects the record on an older server", async () => {
    const name = uniqueName("unknown-col");
    const bad = { ...eventRow(name, 2), no_such_column: 1 };
    const res = await wh.from("e2e_events").insert([eventRow(name, 1), bad]);
    if (clickhouseRows) {
      // ClickHouse's parser refuses the body as its INSERT would, and nothing is published.
      expect(res.data).toBeNull();
      expect(res.error?.status).toBe(400);
      expect(res.error?.code).toBe("clickhouse.rejected");
      expect((res.error?.details as { exception_code?: number })?.exception_code).toBe(117);
      expect(res.error?.message).toContain("record 2: ");
      expect(res.error?.retryable).toBe(false);
      // A later row landing shows the refused body's first row never will.
      const after = uniqueName("after-refusal");
      expect((await wh.from("e2e_events").insert(eventRow(after, 1))).error).toBeNull();
      await rowsNamed(after, 1);
      const left = await wh.from("e2e_events").selectAll().where("name", "=", name).limit(10);
      expect(left.data).toHaveLength(0);
    } else {
      expect(res.error).toBeNull();
      expect(res.data).toMatchObject({ ok: false, total: 2, succeeded: 1, failed: 1 });
      await rowsNamed(name, 1);
    }
  });
});

describe("non-finite floats", () => {
  // An older server answers a query holding a NaN or an infinity with a 500; from
  // Wave-RF/WaveHouse#882 on it renders them as "nan", "inf" and "-inf".
  it.skipIf(!clickhouseRows)("round-trips a NaN and both infinities", async () => {
    const name = uniqueName("nonfinite");
    const sent = ["-inf", 1.5, "inf", "nan"];
    const res = await wh
      .from("e2e_events")
      .insert(sent.map((value, i) => ({ event_id: `${name}-${i}`, name, value })));
    expect(res.error).toBeNull();
    const rows = await eventually(async () => {
      const q = await wh
        .from("e2e_events")
        .select("event_id", "value")
        .where("name", "=", name)
        .orderBy("event_id", "asc")
        .limit(10);
      expect(q.error).toBeNull();
      expect(q.data).toHaveLength(sent.length);
      return q.data as { event_id: string; value: number | string }[];
    });
    expect(rows.map((r) => r.value)).toEqual(sent);
  });
});

describe("query", () => {
  const name = uniqueName("query");

  it("projects and orders", async () => {
    const seeded = await wh.from("e2e_events").insert([eventRow(name, 10), eventRow(name, 20)]);
    expect(seeded.error).toBeNull();
    await rowsNamed(name, 2);

    const res = await wh
      .from("e2e_events")
      .select("name", "value")
      .where("name", "=", name)
      .orderBy("value", "desc")
      .limit(5);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(2);
    expect(res.data?.[0]).toEqual({ name, value: 20 });
  });

  it("filters on timeRange with Dates", async () => {
    const name = uniqueName("window");
    const seeded = await wh.from("e2e_events").insert(eventRow(name, 1));
    expect(seeded.error).toBeNull();
    await rowsNamed(name, 1);
    // Wide enough to absorb the server's bucket rounding and any clock skew.
    const now = Date.now();
    const inside = await wh
      .from("e2e_events")
      .select("name")
      .where("name", "=", name)
      .timeRange("ts", new Date(now - 3_600_000), new Date(now + 3_600_000));
    expect(inside.error).toBeNull();
    expect(inside.data?.length).toBeGreaterThanOrEqual(1);

    const past = await wh
      .from("e2e_events")
      .select("name")
      .where("name", "=", name)
      .timeRange("ts", new Date(now - 7_200_000), new Date(now - 3_600_000));
    expect(past.error).toBeNull();
    expect(past.data).toHaveLength(0);
  });

  it("filters on last", async () => {
    const name = uniqueName("last");
    const seeded = await wh.from("e2e_events").insert(eventRow(name, 1));
    expect(seeded.error).toBeNull();
    await rowsNamed(name, 1);
    const res = await wh
      .from("e2e_events")
      .select("name")
      .where("name", "=", name)
      .last("ts", "1h");
    expect(res.error).toBeNull();
    expect(res.data?.length).toBeGreaterThanOrEqual(1);
  });

  it("aggregates", async () => {
    const res = await wh.from("e2e_events").select().sum("value", "total").where("name", "=", name);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
    expect(res.data?.[0]).toMatchObject({ total: 30 });
  });
});

describe("sql", () => {
  it("runs raw SQL as admin", async () => {
    const res = await wh.sql("SELECT 1 AS n");
    expect(res.error).toBeNull();
    expect(res.data).toEqual([{ n: 1 }]);
  });
});

describe("pipes", () => {
  it("lists and describes a pipe", async () => {
    const list = await wh.pipes.list();
    expect(list.error).toBeNull();
    expect(list.data?.map((p) => p.name)).toContain("e2e_count");

    const one = await wh.pipes.get("e2e_count");
    expect(one.error).toBeNull();
    expect(one.data?.sql).toContain("count()");
  });

  it("executes a pipe", async () => {
    const name = uniqueName("pipe");
    const seeded = await wh.from("e2e_events").insert([eventRow(name, 1), eventRow(name, 2)]);
    expect(seeded.error).toBeNull();
    await rowsNamed(name, 2);

    const res = await wh.pipe("e2e_count", { name });
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
    expect(res.data?.[0]).toMatchObject({ n: 2 });
  });
});

describe("stream", () => {
  it("delivers inserted rows with named fields", async () => {
    const name = uniqueName("stream");
    const stream = wh.from("e2e_events").stream();
    const { done } = collect(stream, 2);
    try {
      await stream.connected();
      expect(stream.status).toBe("live");

      const res = await wh.from("e2e_events").insert([eventRow(name, 1), eventRow(name, 2)]);
      expect(res.error).toBeNull();

      const events = (await done).filter((e) => (e.data as Row).name === name);
      expect(events).toHaveLength(2);
      for (const e of events) expect(e.table).toBe("e2e_events");
      const byValue = events.map((e) => e.data as Row).sort((a, b) => a.value - b.value);
      expect(byValue.map((r) => r.value)).toEqual([1, 2]);
      expect(byValue[0].event_id).toMatch(new RegExp(`^${name}-`));
    } finally {
      stream.close();
    }
  });

  it("delivers only rows matching a where filter", async () => {
    const want = uniqueName("match");
    const other = uniqueName("other");
    const stream = wh.from("e2e_events").selectAll().where("name", "=", want).stream();
    const { events, done } = collect(stream, 1);
    try {
      await stream.connected();
      // The non-matching row goes first, so a leaked filter would arrive before the match.
      await wh.from("e2e_events").insert(eventRow(other, 1));
      await wh.from("e2e_events").insert(eventRow(want, 2));

      await done;
      // Give a late non-matching event a moment to show up before asserting its absence.
      await new Promise((r) => setTimeout(r, 500));
      expect(events.map((e) => (e.data as Row).name)).toEqual([want]);
    } finally {
      stream.close();
    }
  });

  it("delivers a row ingested while an early reconnect was backing off", async () => {
    // Drop the first stream connection once it is live and before any event,
    // so the reconnect has no event id and only the connection's own
    // start to resume from.
    let drop: (() => void) | undefined;
    let streams = 0;
    const token = inject("adminToken");
    const dropping = createClient({
      baseURL: inject("serverUrl"),
      auth: () => token,
      options: {
        fetch: async (url, init) => {
          const res = await fetch(url, init);
          if (!url.includes("/v1/stream") || ++streams > 1 || !res.body) return res;
          const reader = res.body.getReader();
          const body = new ReadableStream<Uint8Array>({
            start(ctrl) {
              drop = () => {
                reader.cancel().catch(() => {});
                ctrl.close();
              };
            },
            async pull(ctrl) {
              try {
                const { done, value } = await reader.read();
                if (done) ctrl.close();
                else ctrl.enqueue(value);
              } catch {
                // The test dropped the connection.
              }
            },
          });
          return new Response(body, { status: res.status, headers: res.headers });
        },
      },
    });

    const name = uniqueName("early-reconnect");
    // Filtered by name: the resume replays earlier tests' rows too.
    const stream = dropping.from("e2e_events").selectAll().where("name", "=", name).stream();
    const { done } = collect(stream, 1);
    try {
      await stream.connected();
      drop?.();
      // During the backoff: the row lands after the drop and before the re-dial.
      const res = await wh.from("e2e_events").insert(eventRow(name, 1));
      expect(res.error).toBeNull();

      const events = (await done).filter((e) => (e.data as Row).name === name);
      expect(events).toHaveLength(1);
      expect(streams).toBeGreaterThan(1);
    } finally {
      stream.close();
    }
  });
});

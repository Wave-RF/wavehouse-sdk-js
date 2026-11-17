import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import type { TestProject } from "vitest/node";

// The server's own test pin. A server that validates ingest with ClickHouse's parser
// (Wave-RF/WaveHouse#882) needs a line chtypes publishes, which 26.6 is not.
const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:26.8.34.13";
// The rolling tag of the server's main branch: the SDK follows the server's current protocol.
const DEFAULT_SERVER_IMAGE = "ghcr.io/wave-rf/wavehouse:dev";
// Matches auth.jwt_secret in testdata/settings/config.json.
const JWT_SECRET = "sdk-e2e-secret";
const SETTINGS = ["config.json", "roles.json", "policies.json", "pipes.json"];

declare module "vitest" {
  export interface ProvidedContext {
    serverUrl: string;
    adminToken: string;
    /**
     * True for a server that validates ingest with ClickHouse's own parser and sends rows as
     * ClickHouse renders them (Wave-RF/WaveHouse#882), false for an older one.
     */
    clickhouseRows: boolean;
  }
}

/** Signs an HS256 JWT with the stack's secret, carrying role in the configured claim. */
function mintToken(role: string, ttlSeconds: number): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const signing = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({
    sub: "sdk-e2e",
    role,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  })}`;
  const sig = createHmac("sha256", JWT_SECRET).update(signing).digest("base64url");
  return `${signing}.${sig}`;
}

async function startStack(): Promise<{ url: string; stop: () => Promise<void> }> {
  const cleanups: Array<() => Promise<unknown>> = [];
  const stop = async () => {
    for (const c of cleanups.reverse()) await c().catch(() => {});
  };

  try {
    const network: StartedNetwork = await new Network().start();
    cleanups.push(() => network.stop());

    const clickhouse = await new GenericContainer(CLICKHOUSE_IMAGE)
      .withNetwork(network)
      .withNetworkAliases("clickhouse")
      .withExposedPorts(8123)
      .withEnvironment({
        CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
        CLICKHOUSE_PASSWORD: "",
      })
      // The image declares a VOLUME here; tmpfs keeps it from leaving an anonymous volume behind.
      .withTmpFs({ "/var/lib/clickhouse": "rw" })
      .withWaitStrategy(Wait.forHttp("/ping", 8123).withStartupTimeout(120_000))
      .start();
    cleanups.push(() => clickhouse.stop());

    const image = process.env.WAVEHOUSE_IMAGE || DEFAULT_SERVER_IMAGE;
    const settingsDir = join(dirname(fileURLToPath(import.meta.url)), "testdata", "settings");
    let server: StartedTestContainer | undefined;
    // A container that fails its wait is never returned, so capture its output as it runs.
    const serverLogs: string[] = [];
    try {
      const builder = new GenericContainer(image)
        .withNetwork(network)
        .withExposedPorts(8080)
        .withEnvironment({ WH_DATA_DIR: "/app/data" })
        .withLogConsumer((stream) => {
          stream.on("data", (line) => serverLogs.push(String(line)));
        })
        // Copied in as root; the server runs as nonroot and must be able to read them.
        .withCopyFilesToContainer(
          SETTINGS.map((f) => ({
            source: join(settingsDir, f),
            target: `/app/settings/${f}`,
            mode: 0o644,
          })),
        )
        .withWaitStrategy(Wait.forHttp("/readyz", 8080).withStartupTimeout(120_000));
      // :dev moves with the server's main branch, so a cached copy would test an old server.
      server = await (image === DEFAULT_SERVER_IMAGE
        ? builder.withPullPolicy(alwaysPull)
        : builder
      ).start();
    } catch (e) {
      process.stderr.write(`e2e: server logs:\n${serverLogs.join("")}\n`);
      throw new Error(`starting ${image}: ${e instanceof Error ? e.message : e}`);
    }
    cleanups.push(() => server!.stop());

    return { url: `http://${server.getHost()}:${server.getMappedPort(8080)}`, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

const alwaysPull = { shouldPull: () => true };

/** Goes through the server's admin endpoints directly, so a broken SDK fails its own tests, not setup. */
async function adminCall(
  url: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  const res = await fetch(url + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 4096).trim()}`);
  }
}

// Idempotent, so an external server can be reused.
const FIXTURE_DDL = [
  `CREATE TABLE IF NOT EXISTS e2e_events (
    event_id String,
    name     String,
    value    Float64,
    ts       DateTime64(3) DEFAULT now64(3)
  ) ENGINE = MergeTree ORDER BY (name, ts)`,
];

async function createFixtures(url: string, token: string): Promise<void> {
  for (const sql of FIXTURE_DDL) await adminCall(url, token, "POST", "/v1/ops/query", { sql });
  await adminCall(url, token, "POST", "/v1/ops/schema/refresh");
  // The refresh is synchronous on one instance; poll anyway so a lagging server is not a flake.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await adminCall(url, token, "GET", "/v1/ops/schema?table=e2e_events");
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`e2e_events never appeared in the schema: ${e}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/**
 * Tells the two servers apart by one record naming a column e2e_events lacks: refused whole
 * with ClickHouse's code 117 by a server that parses ingest with ClickHouse, rejected on its
 * own in a 200 by an older one. Neither publishes anything. Any other answer fails the run.
 */
async function probeServer(url: string, token: string): Promise<boolean> {
  const res = await fetch(`${url}/v1/ingest?table=e2e_events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
    body: '{"event_id":"e2e-probe","no_such_column":1}',
  });
  const text = (await res.text()).slice(0, 4096).trim();
  let body: { code?: string; exception_code?: number; failed?: number } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Reported below with the raw answer.
  }
  if (res.status === 400 && body.code === "clickhouse.rejected" && body.exception_code === 117) {
    return true;
  }
  if (res.status === 200 && body.failed === 1) return false;
  throw new Error(`probing a record with an unknown column: ${res.status} ${text}`);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let url = process.env.WAVEHOUSE_URL;
  let token = process.env.WAVEHOUSE_ADMIN_TOKEN;
  let stop = async () => {};

  if (url) {
    // An external server: the token must carry the admin role so fixtures can be created.
    if (!token) throw new Error("WAVEHOUSE_URL is set, so WAVEHOUSE_ADMIN_TOKEN must be too");
  } else {
    ({ url, stop } = await startStack());
    token = mintToken("admin", 24 * 3600);
  }

  let clickhouseRows: boolean;
  try {
    await createFixtures(url, token);
    clickhouseRows = await probeServer(url, token);
  } catch (e) {
    await stop();
    throw e;
  }
  project.provide("serverUrl", url);
  project.provide("adminToken", token);
  project.provide("clickhouseRows", clickhouseRows);
  process.stderr.write(`e2e: server renders rows with ClickHouse: ${clickhouseRows}\n`);
  return stop;
}

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

// Pinned to the server's own test harness; 26.8 changed numeric DateTime64 parsing.
const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:26.6.3.62";
// The rolling tag of the server's main branch: the SDK follows the server's current protocol.
const DEFAULT_SERVER_IMAGE = "ghcr.io/wave-rf/wavehouse:dev";
// Matches auth.jwt_secret in testdata/settings/config.json.
const JWT_SECRET = "sdk-e2e-secret";
const SETTINGS = ["config.json", "roles.json", "policies.json", "pipes.json"];

declare module "vitest" {
  export interface ProvidedContext {
    serverUrl: string;
    adminToken: string;
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
    try {
      const builder = new GenericContainer(image)
        .withNetwork(network)
        .withExposedPorts(8080)
        .withEnvironment({ WH_DATA_DIR: "/app/data" })
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

  try {
    await createFixtures(url, token);
  } catch (e) {
    await stop();
    throw e;
  }
  project.provide("serverUrl", url);
  project.provide("adminToken", token);
  return stop;
}

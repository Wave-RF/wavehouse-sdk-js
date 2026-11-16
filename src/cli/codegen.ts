#!/usr/bin/env node
/// <reference types="node" />
/**
 * WaveHouse Codegen CLI
 *
 * Introspects a WaveHouse server's /v1/ops/schema endpoint and generates
 * a TypeScript Database interface for use with createClient<DB>().
 *
 * Usage:
 *   npx tsx src/cli/codegen.ts --url http://localhost:8080 --out ./db.d.ts
 *   npm run codegen -- --url http://localhost:8080 --out ./db.d.ts
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveURL } from "../url.js";

// ── Arg parsing (zero deps) ────────────────────────────────────────────────

interface CliArgs {
  url: string;
  out: string;
  auth?: string;
  /** `--auth` came from argv, where `ps` and shell history can read it. */
  authFromArgv?: boolean;
  /** Read the token from stdin (`--auth-stdin`). */
  authStdin?: boolean;
  tenant?: string;
  operatorKey?: string;
}

// Every flag parseArgs reads, which is what a flag's value can never be.
const FLAGS = new Set([
  "--url",
  "-u",
  "--out",
  "-o",
  "--auth",
  "-a",
  "--tenant",
  "-t",
  "--auth-stdin",
  "--operator-key",
  "-k",
  "--help",
  "-h",
]);

// A flag's value: the next argument, which has to be there, non-empty, and not
// another flag. An unset shell variable is how it comes to be otherwise:
// quoted it leaves "", unquoted it lets the flag after it slide into its
// place, to be sent as the tenant or the credential. Only a flag is refused,
// not every leading dash: a tenant id or an operator key may start with one.
function operand(value: string | undefined, usage: string): string {
  if (!value || FLAGS.has(value)) throw new Error(usage);
  return value;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { url: "http://localhost:8080", out: "./wavehouse.d.ts" };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--url":
      case "-u":
        args.url = operand(argv[++i], "--url needs a URL");
        break;
      case "--out":
      case "-o":
        args.out = operand(argv[++i], "--out needs a file path");
        break;
      case "--auth":
      case "-a":
        args.auth = operand(argv[++i], "--auth needs a token");
        args.authFromArgv = true;
        break;
      case "--auth-stdin":
        args.authStdin = true;
        break;
      case "--tenant":
      case "-t":
        // The id itself goes unchecked: its grammar is the server's, which
        // answers a bad one with 400, an empty ?tenant= included, so an
        // empty value could never have meant "tenant 0".
        args.tenant = operand(argv[++i], "--tenant needs a tenant id");
        break;
      case "--operator-key":
      case "-k":
        args.operatorKey = operand(argv[++i], "--operator-key needs a key");
        break;
      case "--help":
      case "-h":
        console.log(`wavehouse codegen — Generate TypeScript types from WaveHouse schema

Options:
  --url, -u           WaveHouse base URL (default: http://localhost:8080)
  --out, -o           Output file path   (default: ./wavehouse.d.ts)
  --auth-stdin        Read the bearer token from stdin (or set
                      WAVEHOUSE_ADMIN_TOKEN); neither shows up in ps or
                      shell history
  --auth, -a          Bearer token as an argument. Deprecated: the process
                      table and shell history record it
  --operator-key, -k  Operator key, sent as X-Operator-Key (the credential a
                      nested settings directory's /v1/ops/* routes admit);
                      WAVEHOUSE_OPERATOR_KEY sets it without an argument
  --tenant, -t        Tenant whose schema to read, sent as ?tenant=
                      (default: tenant 0)
  --help, -h          Show this help`);
        process.exit(0);
        break;
      default:
        // A mistyped --tenant must not read as an absent one: that falls back
        // to tenant 0 and writes the wrong tenant's types with exit 0.
        throw new Error(`unknown argument ${JSON.stringify(argv[i])}; see --help`);
    }
  }
  return args;
}

// ── ClickHouse → TypeScript type mapping ───────────────────────────────────

function chTypeToTS(chType: string): string {
  // Unwrap Nullable
  if (chType.startsWith("Nullable(") && chType.endsWith(")")) {
    const inner = chType.slice(9, -1);
    return `${chTypeToTS(inner)} | null`;
  }

  // Unwrap LowCardinality
  if (chType.startsWith("LowCardinality(") && chType.endsWith(")")) {
    return chTypeToTS(chType.slice(15, -1));
  }

  // String-like types
  if (
    chType === "String" ||
    chType.startsWith("FixedString(") ||
    chType === "UUID" ||
    chType.startsWith("DateTime") ||
    chType.startsWith("Date") ||
    chType.startsWith("Enum8(") ||
    chType.startsWith("Enum16(") ||
    chType === "IPv4" ||
    chType === "IPv6"
  ) {
    return "string";
  }

  // Decimal arrives as a quoted JSON string (the server keeps its precision,
  // which a float64 number would lose), so `number` would lie about the value.
  if (isDecimal(chType)) return "string";

  // Boolean
  if (chType === "Bool") return "boolean";

  // Numeric types
  if (isNumeric(chType)) return "number";

  // Array
  if (chType.startsWith("Array(") && chType.endsWith(")")) {
    const inner = chType.slice(6, -1);
    return `${chTypeToTS(inner)}[]`;
  }

  // Map
  if (chType.startsWith("Map(") && chType.endsWith(")")) {
    const inner = chType.slice(4, -1);
    const comma = findTopLevelComma(inner);
    if (comma !== -1) {
      const keyType = chTypeToTS(inner.slice(0, comma).trim());
      const valType = chTypeToTS(inner.slice(comma + 1).trim());
      return `Record<${keyType}, ${valType}>`;
    }
    return "Record<string, unknown>";
  }

  // Tuple → object or array (fall back to unknown[])
  if (chType.startsWith("Tuple(")) {
    return "unknown[]";
  }

  return "unknown";
}

/** Whether a column type, under any Nullable/LowCardinality wrapper, is a Decimal. */
function isDecimal(t: string): boolean {
  const inner = t.match(/^(?:Nullable|LowCardinality)\((.*)\)$/);
  if (inner) return isDecimal(inner[1]);
  return t === "Decimal" || t.startsWith("Decimal(") || /^Decimal(32|64|128|256)\(/.test(t);
}

function isNumeric(t: string): boolean {
  const numericPrefixes = [
    "UInt8",
    "UInt16",
    "UInt32",
    "UInt64",
    "UInt128",
    "UInt256",
    "Int8",
    "Int16",
    "Int32",
    "Int64",
    "Int128",
    "Int256",
    "Float32",
    "Float64",
  ];
  return numericPrefixes.some((p) => t === p || t.startsWith(`${p}(`));
}

/** Find the first comma that isn't inside parentheses. */
function findTopLevelComma(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) return i;
  }
  return -1;
}

// ── Fetch schema + generate ────────────────────────────────────────────────

interface Column {
  name: string;
  type: string;
  is_nullable: boolean;
  has_default: boolean;
}

interface TableSchema {
  name: string;
  columns: Column[];
}

// Runtime guards mirroring the interfaces above, limited to the fields whose
// absence would crash generation (`is_nullable` is unused and `has_default` is
// truthiness-safe, so a server that omits a boolean still generates fine) — a
// malformed member should fail fetchSchemas' loud shape error, not surface as
// a TypeError mid-generation.
function isColumn(value: unknown): value is Column {
  if (typeof value !== "object" || value === null) return false;
  const col = value as Record<string, unknown>;
  return typeof col.name === "string" && typeof col.type === "string";
}

function isTableSchema(value: unknown): value is TableSchema {
  if (typeof value !== "object" || value === null) return false;
  const table = value as Record<string, unknown>;
  return (
    typeof table.name === "string" && Array.isArray(table.columns) && table.columns.every(isColumn)
  );
}

interface FetchOptions {
  /** Bearer token, sent as `Authorization: Bearer <token>`. */
  auth?: string;
  /** Operator key, sent as `X-Operator-Key`; independent of `auth`. */
  operatorKey?: string;
  /** Tenant to read, sent as `?tenant=`; absent reads tenant 0. */
  tenant?: string;
}

async function fetchSchemas(url: string, opts: FetchOptions = {}): Promise<TableSchema[]> {
  const headers: Record<string, string> = {};
  if (opts.auth) headers.Authorization = `Bearer ${opts.auth}`;
  if (opts.operatorKey) headers["X-Operator-Key"] = opts.operatorKey;

  const target = resolveURL(
    url,
    "/v1/ops/schema",
    opts.tenant ? { tenant: opts.tenant } : undefined,
  );
  // A redirect is followed only when the request carries no credential, the
  // streaming transport's rule (stream/sse.ts `_init`): fetch drops
  // Authorization on a cross-origin hop and re-sends every other header, so
  // following one would hand X-Operator-Key to wherever it points. `manual`
  // over `error`, whose bare "fetch failed" could not name that target.
  const credentialed = Boolean(opts.auth || opts.operatorKey);
  const res = await fetch(target.toString(), {
    headers,
    redirect: credentialed ? "manual" : "follow",
  });
  if (credentialed && res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") ?? "an unnamed location";
    throw new Error(
      `Schema fetch was redirected (${res.status}) to ${location}, and a request carrying a credential does not follow a redirect: point --url at the final address`,
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Schema fetch failed (${res.status}): ${text}`);
  }
  // /v1/ops/schema returns a JSON array of tables — reject any other shape,
  // malformed members included, loudly rather than crashing mid-generation.
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body) || !body.every(isTableSchema)) {
    throw new Error("Unexpected /v1/ops/schema response: expected a JSON array of table schemas");
  }
  return body as TableSchema[];
}

async function readStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

/**
 * Where the credentials come from, most private first. The argv form still
 * works, with a warning, so existing scripts keep running.
 * @internal
 */
async function resolveCredentials(
  args: CliArgs,
  env: Record<string, string | undefined>,
  stdin: () => Promise<string>,
  warn: (msg: string) => void,
): Promise<{ auth?: string; operatorKey?: string }> {
  let auth = args.auth;
  if (args.authStdin) {
    if (args.auth) throw new Error("--auth-stdin and --auth are alternatives; pass one");
    auth = (await stdin()) || undefined;
    if (!auth) throw new Error("--auth-stdin read an empty token from stdin");
  } else if (args.authFromArgv) {
    warn(
      "warning: --auth is deprecated: the token is visible in the process list and shell history. Use --auth-stdin or WAVEHOUSE_ADMIN_TOKEN.",
    );
  } else {
    auth = env.WAVEHOUSE_ADMIN_TOKEN || undefined;
  }
  return { auth, operatorKey: args.operatorKey ?? (env.WAVEHOUSE_OPERATOR_KEY || undefined) };
}

function generateTypes(schemas: TableSchema[]): string {
  const lines: string[] = [
    "// Auto-generated by @wavehouse/sdk codegen",
    `// Generated at: ${new Date().toISOString()}`,
    "// Do not edit manually — re-run: npm run codegen",
    "",
    "export interface Database {",
  ];

  // Code-unit comparison, not localeCompare: db.d.ts is a committed artifact,
  // so its ordering must not vary with the generating host's ICU locale.
  const tables = [...schemas].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rowTypes = rowTypeNames(tables);
  for (const table of tables) {
    lines.push(`  ${propertyKey(table.name)}: ${rowTypes.get(table.name)};`);
  }
  lines.push("}");
  lines.push("");

  // Generate row interfaces
  for (const table of tables) {
    lines.push(`export interface ${rowTypes.get(table.name)} {`);

    for (const col of table.columns) {
      const tsType = chTypeToTS(col.type);
      const optional = col.has_default ? "?" : "";
      if (isDecimal(col.type)) {
        lines.push(
          "  /** A Decimal, which the server sends as a quoted string to keep its precision. */",
        );
      }
      lines.push(`  ${propertyKey(col.name)}${optional}: ${tsType};`);
    }

    lines.push("}");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * A schema name as a property key: bare when it is an identifier, else a
 * string literal. Names come off the wire, so quoting also keeps a name from
 * writing declarations of its own into the file.
 */
function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function pascalCase(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

/**
 * One valid, distinct `...Row` interface name per table. Case-sensitive
 * ClickHouse allows `user_events` and `USER_EVENTS` side by side, and
 * pascalCase folds both to `UserEvents`, so a repeat gets a numeric suffix.
 * Tables arrive sorted, which keeps the choice stable between runs.
 */
function rowTypeNames(tables: TableSchema[]): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const table of tables) {
    // A leading digit or an all-symbol name is not an identifier on its own.
    const base = `T${pascalCase(table.name)}`.replace(/^T(?=[A-Za-z_])/, "");
    let name = `${base}Row`;
    for (let n = 2; taken.has(name); n++) name = `${base}${n}Row`;
    taken.add(name);
    names.set(table.name, name);
  }
  return names;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  console.log(`Fetching schema from ${args.url}...`);
  const creds = await resolveCredentials(args, process.env, readStdin, console.warn);
  const schemas = await fetchSchemas(args.url, { ...creds, tenant: args.tenant });

  if (schemas.length === 0) {
    console.warn("No tables found. Is WaveHouse running with tables in ClickHouse?");
    process.exit(1);
  }

  console.log(`Found ${schemas.length} table(s): ${schemas.map((t) => t.name).join(", ")}`);

  const output = generateTypes(schemas);

  const { writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const outPath = resolve(args.out);
  await writeFile(outPath, output, "utf-8");

  console.log(`✓ Types written to ${outPath}`);
}

// Exported for unit tests; the package entry point (src/index.ts) does not
// re-export the CLI.
export { chTypeToTS, fetchSchemas, generateTypes, parseArgs, resolveCredentials };

// Run only when invoked as a script (the `wavehouse-codegen` bin or tsx), not
// when imported by tests. realpath the argv side: npm bin shims are symlinks,
// while the ESM loader resolves import.meta.url to the real file.
function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((err) => {
    console.error("Codegen failed:", err.message);
    process.exit(1);
  });
}

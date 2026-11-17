import { DLQNamespace } from "./dlq.js";
import { err, ok } from "./errors.js";
import { callOpts, request } from "./http.js";
import { PipeRef, PipesNamespace } from "./pipes.js";
import { SchemaNamespace } from "./schema.js";
import { SettingsNamespace } from "./settings.js";
import { sql } from "./sql.js";
import { StreamController } from "./stream/controller.js";
import { SSETransport } from "./stream/sse.js";
import { SysNamespace } from "./sys.js";
import { TableRef } from "./table.js";
import type {
  CallOptions,
  ClientConfig,
  Database,
  HttpContext,
  OpsRequestOptions,
  Result,
  StreamOptions,
  VersionInfo,
} from "./types.js";
import { assertBaseHasHost, assertBaseScheme } from "./url.js";

type TableName<DB> = DB extends Database ? Extract<keyof DB, string> : string;
type RowType<DB, T extends string> = DB extends Database
  ? T extends keyof DB
    ? DB[T]
    : Record<string, unknown>
  : Record<string, unknown>;

export class WaveHouseClient<DB extends Database = Database> {
  /** @internal */
  readonly _ctx: HttpContext;

  /** Schema introspection namespace. */
  readonly schema: SchemaNamespace;
  /** Dead Letter Queue namespace. */
  readonly dlq: DLQNamespace;
  /** System health/readiness namespace. */
  readonly sys: SysNamespace;
  /** Named query pipes admin namespace. */
  readonly pipes: PipesNamespace;
  /** Settings directory namespace (admin). */
  readonly settings: SettingsNamespace;

  constructor(config: ClientConfig<DB>) {
    // Request paths are joined onto the base, so a query or fragment on it
    // could only ever be dropped; say so rather than lose it silently.
    if (/[?#]/.test(config.baseURL)) {
      throw new TypeError(
        `baseURL ${JSON.stringify(config.baseURL)} must not carry a query string or fragment: give the origin and an optional path prefix, such as "https://example.com/api"`,
      );
    }
    // Refused here, not on the first call: a base that names no host (a bare
    // path such as "/api") would otherwise read as one.
    assertBaseHasHost(config.baseURL);
    assertBaseScheme(config.baseURL);
    // A negative or fractional count would make the retry loop run zero times.
    const maxRetries = config.options?.maxRetries;
    if (maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 0)) {
      throw new TypeError(
        `options.maxRetries must be a non-negative integer, got ${String(maxRetries)}`,
      );
    }
    this._ctx = {
      baseURL: config.baseURL.replace(/\/+$/, ""),
      auth: config.auth,
      options: {
        maxRetries: maxRetries ?? 2,
        maxRetryAfterMs: config.options?.maxRetryAfterMs,
        attemptTimeoutMs: config.options?.attemptTimeoutMs,
        fetch: config.options?.fetch,
        headers: config.options?.headers,
        fetchOptions: config.options?.fetchOptions,
      },
    };

    this.schema = new SchemaNamespace(this._ctx);
    this.dlq = new DLQNamespace(this._ctx);
    this.sys = new SysNamespace(this._ctx);
    this.pipes = new PipesNamespace(this._ctx);
    this.settings = new SettingsNamespace(this._ctx);
  }

  /**
   * The server's build metadata, from `GET /version`.
   */
  async version(opts?: CallOptions): Promise<Result<VersionInfo>> {
    const { data, error } = await request<VersionInfo>(this._ctx, {
      method: "GET",
      path: "/version",
      ...callOpts(opts),
    });
    if (error) return err(error);
    return ok(data!);
  }

  /** Get a table reference for building queries, inserts, and streams. */
  from<T extends TableName<DB>>(table: T): TableRef<RowType<DB, T>> {
    return new TableRef<RowType<DB, T>>(this._ctx, table, (t, opts) =>
      this._createStream<RowType<DB, T>>(t, opts),
    );
  }

  /** Get a reference to a named query pipe. PromiseLike — `await` it to execute. */
  pipe<Row = Record<string, unknown>>(
    name: string,
    params?: Record<string, unknown>,
  ): PipeRef<Row> {
    return new PipeRef<Row>(this._ctx, name, params);
  }

  /**
   * Execute a raw SQL query against ClickHouse. Requires the admin role (the
   * configured `admin_role`, `"admin"` by default; there is no separate
   * `service` role). The endpoint proxies straight to ClickHouse's HTTP
   * interface so any ClickHouse-accepted SQL works; positional `?` param
   * binding is NOT supported — inline literals or use the structured query
   * builder for safe binding. See sql.ts for details.
   */
  sql<Row = Record<string, unknown>>(
    query: string,
    opts?: OpsRequestOptions,
  ): Promise<Result<Row[]>> {
    // Migration guard: the second argument used to be a positional-`?`
    // params array. TS callers get a compile-time error from the type
    // signature, but JS callers (or `any`-typed callsites) would silently
    // pass an array as `opts` and only discover the break via downstream
    // SQL errors. Throw a clear runtime error pointing at the migration.
    if (Array.isArray(opts)) {
      throw new Error(
        "[WaveHouse SDK] client.sql(sql, params) was removed. The /v1/ops/query endpoint does not accept positional `?` params. Inline literals into the SQL, or use the structured query builder (wh.from(table)…) for safe binding from user input.",
      );
    }
    return sql<Row>(this._ctx, query, opts);
  }

  /** @internal Create a stream for the given table. */
  private _createStream<T = Record<string, unknown>>(
    table: string,
    opts?: StreamOptions,
  ): StreamController<T> {
    const transport = new SSETransport<T>({
      baseURL: this._ctx.baseURL,
      table,
      since: opts?.since,
      auth: this._ctx.auth,
      fetch: this._ctx.options.fetch,
      headers: this._ctx.options.headers,
      callHeaders: opts?.headers,
      attemptTimeoutMs: opts?.attemptTimeoutMs ?? this._ctx.options.attemptTimeoutMs,
      fetchOptions: this._ctx.options.fetchOptions,
    });
    const controller = new StreamController<T>(transport);
    if (opts?.signal) controller.attachSignal(opts.signal);
    return controller;
  }
}

/** Create a new WaveHouse client instance. */
export function createClient<DB extends Database = Database>(
  config: ClientConfig<DB>,
): WaveHouseClient<DB> {
  return new WaveHouseClient(config);
}

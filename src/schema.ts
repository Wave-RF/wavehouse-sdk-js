import { err, ok } from "./errors.js";
import { callOpts, request } from "./http.js";
import type { HttpContext, OpsRequestOptions, Result, Schemas } from "./types.js";

/** Namespace for schema introspection. */
export class SchemaNamespace {
  private readonly _ctx: HttpContext;

  constructor(ctx: HttpContext) {
    this._ctx = ctx;
  }

  /**
   * List all table schemas discovered from ClickHouse. A `503` with
   * `Retry-After` means the first discovery has not succeeded yet.
   */
  async list(opts?: OpsRequestOptions): Promise<Result<Schemas>> {
    // The backend returns TableSchema[] — transform to Record<string, TableSchema>.
    const { data, error } = await request<unknown>(this._ctx, {
      method: "GET",
      path: "/v1/ops/schema",
      ...callOpts(opts),
    });
    if (error) return err(error);

    let schemas: Schemas;
    if (Array.isArray(data)) {
      schemas = {};
      for (const table of data) {
        if (table && typeof table === "object" && "name" in table) {
          schemas[(table as { name: string }).name] = table as Schemas[string];
        }
      }
    } else {
      schemas = data as Schemas;
    }
    return ok(schemas);
  }

  /** Force a schema refresh from ClickHouse system.columns. */
  async refresh(opts?: OpsRequestOptions): Promise<Result<void>> {
    const { error } = await request<Schemas>(this._ctx, {
      method: "POST",
      path: "/v1/ops/schema/refresh",
      ...callOpts(opts),
    });
    if (error) return err<void>(error);
    return ok(undefined as undefined);
  }
}

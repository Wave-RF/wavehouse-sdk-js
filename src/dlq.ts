import { err, ok } from "./errors.js";
import { callOpts, request } from "./http.js";
import type { DLQStats, HttpContext, OpsRequestOptions, Result } from "./types.js";

/** Namespace for Dead Letter Queue operations. */
export class DLQNamespace {
  private readonly _ctx: HttpContext;

  constructor(ctx: HttpContext) {
    this._ctx = ctx;
  }

  /** Get DLQ statistics (message counts per table). */
  async list(opts?: OpsRequestOptions): Promise<Result<DLQStats>> {
    const { data, error } = await request<DLQStats>(this._ctx, {
      method: "GET",
      path: "/v1/ops/dlq/stats",
      ...callOpts(opts),
    });
    if (error) return err(error);
    return ok(data!);
  }

  /** Get DLQ stats filtered by table name. */
  async table(name: string, opts?: OpsRequestOptions): Promise<Result<DLQStats>> {
    const { data, error } = await request<DLQStats>(this._ctx, {
      method: "GET",
      path: "/v1/ops/dlq/stats",
      params: { table: name },
      ...callOpts(opts),
    });
    if (error) return err(error);
    return ok(data!);
  }
}

import { err, okPage } from "./errors.js";
import { callOpts, request } from "./http.js";
import type { StreamTransport } from "./stream/controller.js";
import { StreamController } from "./stream/controller.js";
import { LiveQuery } from "./stream/live-query.js";
import type {
  Aggregation,
  Duration,
  FilterOp,
  HttpContext,
  OrderClause,
  QueryFilter,
  RequestOptions,
  Result,
  StreamOptions,
  StreamSubscriber,
  StructuredQuery,
  TimeRange,
} from "./types.js";

/** Longest span the server's Go time.Duration holds: 2^63 - 1 ns. */
const MAX_DURATION_NS = 2 ** 63;

const NS_PER_UNIT: Record<string, number> = {
  ms: 1e6,
  s: 1e9,
  m: 60e9,
  h: 3600e9,
  d: 86400e9,
  w: 604800e9,
};

/** A `Date` as UTC ISO-8601, a string as given; an invalid `Date` is an error. */
function timeBound(
  v: Date | string,
): { value: string; error?: undefined } | { value: ""; error: string } {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return { value: "", error: "invalid Date" };
    return { value: v.toISOString() };
  }
  return { value: v };
}

/**
 * The server's relative form of a duration. The server runs Go's
 * `time.ParseDuration` after expanding d and w, so a plain decimal and one of
 * its units always parses there; anything that cannot, or is not above zero,
 * is refused here.
 */
function durationString(d: Duration | number): string | { error: string } {
  if (typeof d === "number") {
    // String(1e21) is "1e+21", which Go cannot parse, so only plain decimals pass.
    if (
      !Number.isFinite(d) ||
      d <= 0 ||
      !/^\d+(\.\d+)?$/.test(String(d)) ||
      d * 1e6 >= MAX_DURATION_NS
    ) {
      return { error: `duration must be a positive number of milliseconds, got ${d}` };
    }
    return `${d}ms`;
  }
  const m = typeof d === "string" ? /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(d) : null;
  const ns = m ? Number(m[1]) * (NS_PER_UNIT[m[2] as string] as number) : 0;
  if (!m || !(ns >= 1) || ns >= MAX_DURATION_NS) {
    return {
      error: `duration must be a positive number with a unit of ms, s, m, h, d or w, got ${JSON.stringify(d)}`,
    };
  }
  return d;
}

/** SDK operator → backend operator mapping. */
const OP_MAP: Record<FilterOp, string> = {
  "=": "eq",
  "!=": "neq",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
  in: "in",
  like: "like",
};

interface QueryState {
  table: string;
  columns: string[];
  selectAll?: boolean;
  aggregations: Aggregation[];
  filters: QueryFilter[];
  groupBy: string[];
  orderBy: OrderClause[];
  limit?: number;
  timeRange?: TimeRange;
  /** First builder misuse; `fetch()` returns it before sending anything. */
  error?: string;
}

type CreateStreamFn<Row> = (table: string, opts?: StreamOptions) => StreamController<Row>;

/**
 * Immutable, PromiseLike query builder.
 * Every chain method returns a new instance. `await builder` auto-executes `.fetch()`.
 */
export class QueryBuilder<Row = Record<string, unknown>> implements PromiseLike<Result<Row[]>> {
  /** @internal */
  private readonly _state: Readonly<QueryState>;
  /** @internal */
  private readonly _ctx: HttpContext;
  /** @internal */
  private readonly _createStream: CreateStreamFn<Row>;

  constructor(ctx: HttpContext, state: QueryState, createStream: CreateStreamFn<Row>) {
    this._ctx = ctx;
    this._state = Object.freeze({ ...state });
    this._createStream = createStream;
  }

  // --- Builder methods (each returns a new QueryBuilder) ---

  select(...columns: string[]): QueryBuilder<Row> {
    return this._clone({ columns: [...this._state.columns, ...columns] });
  }

  /**
   * Select every column the caller's role is allowed to read (the all-columns
   * wildcard). Use this instead of `.select(...)` when you want a full-row read;
   * a bare `.fetch()` with no `.select()` does this implicitly. Mutually
   * exclusive with `.select(...)` and the aggregation methods: a query that
   * combines them, in either order, resolves to an `INVALID_QUERY` error
   * without being sent.
   */
  selectAll(): QueryBuilder<Row> {
    return this._clone({ selectAll: true });
  }

  where(column: string, op: FilterOp, value: unknown): QueryBuilder<Row> {
    const filter: QueryFilter = { column, op: OP_MAP[op], value };
    return this._clone({ filters: [...this._state.filters, filter] });
  }

  count(column = "*", alias = "count"): QueryBuilder<Row> {
    return this._addAgg("count", column, alias);
  }

  sum(column: string, alias = `sum_${column}`): QueryBuilder<Row> {
    return this._addAgg("sum", column, alias);
  }

  avg(column: string, alias = `avg_${column}`): QueryBuilder<Row> {
    return this._addAgg("avg", column, alias);
  }

  min(column: string, alias = `min_${column}`): QueryBuilder<Row> {
    return this._addAgg("min", column, alias);
  }

  max(column: string, alias = `max_${column}`): QueryBuilder<Row> {
    return this._addAgg("max", column, alias);
  }

  countDistinct(column: string, alias = `count_distinct_${column}`): QueryBuilder<Row> {
    return this._addAgg("countDistinct", column, alias);
  }

  aggregate(fn: string, column: string, alias = ""): QueryBuilder<Row> {
    return this._addAgg(fn, column, alias);
  }

  groupBy(...columns: string[]): QueryBuilder<Row> {
    return this._clone({ groupBy: [...this._state.groupBy, ...columns] });
  }

  orderBy(column: string, dir: "asc" | "desc" = "asc"): QueryBuilder<Row> {
    // The server reads anything but "desc" as ascending, so "DESC" would sort
    // the wrong way without a word; lowercase it and refuse what is not a direction.
    const d = String(dir).toLowerCase();
    if (d !== "asc" && d !== "desc") {
      return this._clone({
        error:
          this._state.error ??
          `orderBy direction must be "asc" or "desc", got ${JSON.stringify(dir)}`,
      });
    }
    return this._clone({ orderBy: [...this._state.orderBy, { column, dir: d }] });
  }

  limit(n: number): QueryBuilder<Row> {
    return this._clone({ limit: n });
  }

  /**
   * Keep rows where `column >= since AND column <= until`. `since` and `until`
   * are each a `Date` (sent as `toISOString()`, UTC), an RFC 3339 string or a
   * relative string such as `"1h"`, sent as given. A relative value means that
   * long before the server's clock, not yours. The server rounds each bound
   * down to `query.timestamp_bucket_seconds` (60 s by default), and ignores
   * `until` when there is no `since`.
   *
   * Prefer a `Date` or `last()` to a hand-built string: `"now-1h"` is a 400,
   * and `"-1h"` is accepted as a negative duration, which puts the bound in
   * the future and matches nothing, without a word. An invalid `Date` resolves
   * to an `INVALID_QUERY` error before anything is sent.
   */
  timeRange(column: string, since: Date | string, until?: Date | string): QueryBuilder<Row> {
    const s = timeBound(since);
    const u = until === undefined ? undefined : timeBound(until);
    const bad = s.error ?? u?.error;
    if (bad !== undefined) return this._clone({ error: this._state.error ?? `timeRange: ${bad}` });
    return this._clone({ timeRange: { column, since: s.value, until: u?.value } });
  }

  /**
   * Keep rows from the last `duration` by the server's clock: `last("ts", "1h")`.
   * `duration` is a number of milliseconds (above 0) or a string such as `"90s"`,
   * `"1h"`, `"7d"` or `"2w"` (units ms, s, m, h, d, w). It is the same as
   * `timeRange(column, duration)`, but checked here: a zero, negative or
   * unparseable duration resolves to an `INVALID_QUERY` error before anything is
   * sent. The start rounds down to `query.timestamp_bucket_seconds` (60 s by
   * default), so a window can reach back up to a bucket further than asked.
   */
  last(column: string, duration: Duration | number): QueryBuilder<Row> {
    const d = durationString(duration);
    if (typeof d !== "string") {
      return this._clone({ error: this._state.error ?? `last: ${d.error}` });
    }
    return this._clone({ timeRange: { column, since: d } });
  }

  // --- Execution ---

  /** Default row limit when none is specified — deliberately tighter than the backend's DefaultMaxRows (10000) safety cap. */
  static readonly DEFAULT_LIMIT = 1000;

  async fetch(opts?: RequestOptions): Promise<Result<Row[]>> {
    if (this._state.error) {
      return err({
        status: 0,
        code: "INVALID_QUERY",
        message: this._state.error,
        retryable: false,
      });
    }
    // The server refuses select_all next to columns or aggregations with a
    // 400; saying so here, in either call order, saves the round trip and
    // names the cause.
    if (
      this._state.selectAll &&
      (this._state.columns.length > 0 || this._state.aggregations.length > 0)
    ) {
      return err({
        status: 0,
        code: "INVALID_QUERY",
        message: "selectAll() can't be combined with select() columns or aggregations",
        retryable: false,
      });
    }
    const effectiveLimit = opts?.limit ?? this._state.limit ?? QueryBuilder.DEFAULT_LIMIT;
    const ast = this._buildAST(effectiveLimit);

    const { data, error } = await request<Row[]>(this._ctx, {
      method: "POST",
      path: `/v1/query?table=${encodeURIComponent(this._state.table)}`,
      body: ast,
      ...callOpts(opts),
    });

    if (error) return err(error);

    const rows = data!;
    const hasMore = effectiveLimit != null && rows.length >= effectiveLimit;

    // next() needs an order column for its cursor; with no .orderBy() we still
    // report hasMore honestly from the row count but can't offer a next().
    if (hasMore && this._state.orderBy.length > 0) {
      const nextFn = () => this._fetchNext(rows, effectiveLimit!, opts);
      return okPage(rows, true, nextFn);
    }

    return okPage(rows, hasMore);
  }

  stream(opts?: StreamOptions): StreamController<Row> {
    const raw = this._createStream(this._state.table, opts);
    const filters = this._state.filters;
    const columns = this._state.columns;

    // If no filters or column projection, return the raw stream.
    if (filters.length === 0 && columns.length === 0) {
      return raw;
    }

    // Wrap with a filtering transport that applies AST predicates client-side.
    return new FilteredStreamController<Row>(raw, filters, columns);
  }

  /**
   * Start a live query: fetches historical data, then streams live updates.
   *
   * The subscriber's `initial()` is called once with the fetch result, then
   * `next()` fires for each live event. Events that arrived during the fetch
   * are deduplicated and flushed automatically, against the newest
   * `received_timestamp` among the fetched rows. A table without that column,
   * or a `.select()` that drops it, has nothing to deduplicate against: events
   * that arrived during the fetch may then repeat rows already in `initial()`.
   *
   * Returns a LiveQuery handle with a `.close()` method.
   */
  liveQuery(subscriber: StreamSubscriber<Row>, opts?: StreamOptions): LiveQuery<Row> {
    const stream = this.stream(opts);
    const fetchFn = () => this.fetch();
    return new LiveQuery<Row>(stream, fetchFn, subscriber, this._state.filters);
  }

  // --- PromiseLike implementation ---

  then<TResult1 = Result<Row[]>, TResult2 = never>(
    onfulfilled?: ((value: Result<Row[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.fetch().then(onfulfilled, onrejected);
  }

  // --- Private helpers ---

  private _clone(overrides: Partial<QueryState>): QueryBuilder<Row> {
    return new QueryBuilder(this._ctx, { ...this._state, ...overrides }, this._createStream);
  }

  private _addAgg(fn: string, column: string, alias: string): QueryBuilder<Row> {
    // No alias: send none, and the server names the column.
    const agg: Aggregation = alias === "" ? { fn, column } : { fn, column, alias };
    return this._clone({ aggregations: [...this._state.aggregations, agg] });
  }

  private _buildAST(effectiveLimit?: number): StructuredQuery {
    const ast: StructuredQuery = {};
    const hasColumns = this._state.columns.length > 0;
    const hasAggs = this._state.aggregations.length > 0;
    // Projection: an explicit select_all, then explicit columns, else — for a
    // bare query with no projection intent and no aggregations — default to
    // select_all so `from(t).fetch()` returns rows. (The wire default for omitted
    // columns is "nothing"; the SDK opts into select_all on the caller's behalf.)
    if (this._state.selectAll) {
      ast.select_all = true;
    } else if (hasColumns) {
      ast.columns = this._state.columns;
    } else if (!hasAggs) {
      ast.select_all = true;
    }
    if (hasAggs) ast.aggregations = this._state.aggregations;
    if (this._state.filters.length > 0) ast.filters = this._state.filters;
    if (this._state.groupBy.length > 0) ast.group_by = this._state.groupBy;
    if (this._state.orderBy.length > 0) ast.order_by = this._state.orderBy;
    if (effectiveLimit != null) ast.limit = effectiveLimit;
    if (this._state.timeRange) ast.time_range = this._state.timeRange;
    return ast;
  }

  private async _fetchNext(
    prevRows: Row[],
    _limit: number,
    opts?: RequestOptions,
  ): Promise<Result<Row[]>> {
    // No explicit order → no keyset cursor to build; nothing to page by.
    const cursor = this._state.orderBy[0];
    if (cursor == null) return okPage([] as unknown as Row[], false);
    const { column: orderCol, dir: orderDir } = cursor;

    const lastRow = prevRows[prevRows.length - 1] as Record<string, unknown>;
    const lastValue = lastRow?.[orderCol];

    if (lastValue === undefined) return okPage([] as unknown as Row[], false);

    const cursorOp = orderDir === "desc" ? "lt" : "gt";
    const cursorFilter: QueryFilter = { column: orderCol, op: cursorOp, value: lastValue };
    const nextBuilder = this._clone({
      filters: [...this._state.filters, cursorFilter],
      orderBy: this._state.orderBy,
    });

    return nextBuilder.fetch(opts);
  }
}

// ============================================================================
// Client-side stream filtering
// ============================================================================

/**
 * Wraps a StreamController, applying client-side filters and column projection
 * before delivering events to subscribers.
 *
 * Lifecycle: by the time we reach this constructor, `inner` has already been
 * built (and is opening its own SSE connection). The outer transport's
 * `connect()` doesn't open a new connection — it bridges `inner`'s events
 * through a filter into the outer subscriber set. On `disconnect()`, closing
 * `inner` is what actually tears down the SSE socket; the subscription we
 * register on `inner` is left to be garbage-collected with it, which is why
 * we don't bother saving the unsubscribe handle.
 * @internal
 */
class FilteredStreamController<T = Record<string, unknown>> extends StreamController<T> {
  constructor(inner: StreamController<T>, filters: QueryFilter[], columns: string[]) {
    const transport: StreamTransport<T> = {
      onEvent: null,
      onStatus: null,
      onError: null,
      connect() {
        inner.subscribe({
          next: (event) => {
            if (!matchesFilters(event.data as Record<string, unknown>, filters)) {
              return;
            }
            const projected =
              columns.length > 0
                ? {
                    ...event,
                    data: projectColumns(event.data as Record<string, unknown>, columns) as T,
                  }
                : event;
            this.onEvent?.(projected);
          },
          status: (s) => this.onStatus?.(s),
          error: (e) => this.onError?.(e),
        });
      },
      disconnect() {
        inner.close();
      },
    };
    super(transport);
  }
}

/** @internal Evaluate all filters against a data row. All must pass (AND). */
function matchesFilters(row: Record<string, unknown>, filters: QueryFilter[]): boolean {
  for (const f of filters) {
    const val = row[f.column];
    if (!evaluateFilter(val, f.op, f.value)) return false;
  }
  return true;
}

/** @internal Evaluate a single filter predicate. */
function evaluateFilter(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return compareOrdered(actual, expected, (a, b) => a > b);
    case "gte":
      return compareOrdered(actual, expected, (a, b) => a >= b);
    case "lt":
      return compareOrdered(actual, expected, (a, b) => a < b);
    case "lte":
      return compareOrdered(actual, expected, (a, b) => a <= b);
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "like": {
      if (typeof actual !== "string" || typeof expected !== "string") return false;
      // Convert SQL LIKE pattern to regex: % → .*, _ → .
      const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = escaped.replace(/%/g, ".*").replace(/_/g, ".");
      return new RegExp(`^${pattern}$`, "i").test(actual);
    }
    default:
      return true; // unknown op — pass through
  }
}

/**
 * @internal Apply an ordered comparison only when both sides are the same
 * comparable primitive (number-vs-number or string-vs-string — strings are
 * lexicographic, which is correct for ISO-8601 timestamps). Mismatched or
 * unsupported types return false instead of relying on JS coercion.
 */
function compareOrdered(
  actual: unknown,
  expected: unknown,
  cmp: (a: number, b: number) => boolean,
): boolean {
  if (typeof actual === "number" && typeof expected === "number") {
    return cmp(actual, expected);
  }
  if (typeof actual === "string" && typeof expected === "string") {
    // `>`/`<` on strings is lexicographic; reuse the same comparator by
    // casting through `as unknown as number` — the runtime operator works
    // identically on strings.
    return cmp(actual as unknown as number, expected as unknown as number);
  }
  return false;
}

/**
 * @internal Project a row to only the specified columns.
 *
 * Null-prototype, matching the rows the SSE transport hands us: a ClickHouse
 * column may legitimately be named `__proto__`, and on a plain object literal
 * that assignment hits the inherited setter instead of creating an own
 * property, so the column would vanish from a `.select(…)` projection while
 * surviving an unprojected stream.
 */
function projectColumns(row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const col of columns) {
    if (col in row) result[col] = row[col];
  }
  return result;
}

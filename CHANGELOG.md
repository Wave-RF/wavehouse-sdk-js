# Changelog

## [Unreleased]

### Breaking

- Removed `"not_like"` from `FilterOp`. It type-checked and then failed with a 400 on a query, because the server's filter builder has no such operator. Use a positive `like`, or filter the rows you get back. Fixes #53.
- Removed `QueryBuilder.cacheTTL()`. It stored a value that was never sent, and the query wire type has no TTL field: the server picks the result-cache TTL itself. Delete the call; behaviour is unchanged. Fixes #45.
- Removed `wh.pipe(name).stream()` and `wh.dlq.stream()`. The server has no stream for a pipe or for dead letters, so both opened a healthy-looking connection that never delivered an event (`GET /v1/stream` serves ingest tables only). Fixes #54.

### Deprecated

- `wavehouse-codegen --auth <token>`: an argument is visible in the process list and shell history. It still works and now prints a warning. Pass the token in `WAVEHOUSE_ADMIN_TOKEN` or on stdin with the new `--auth-stdin`; `WAVEHOUSE_OPERATOR_KEY` likewise supplies the operator key. Fixes #38.

### Fixed

- A bodyless request (every `GET`, such as `schema.get()` or `pipes.list()`) no longer sends `Content-Type`. `application/json` is not a CORS-safelisted value, so each cross-origin browser read cost a preflight. Requests with a body are unchanged. Fixes #27.
- `Retry-After` is read as seconds or an HTTP-date; `0` retries at once instead of waiting 30 s; an unreadable value backs off normally. A wait over the new `options.maxRetryAfterMs` (default 30000) is not slept: the call returns the server's 503, or a pipe call's 429, as its error. Fixes #5.
- `selectAll()` combined with `select()` columns or an aggregation, in either order, now resolves to an `INVALID_QUERY` error without sending a request, instead of reaching the server and failing with a 400. Fixes #31.
- `wavehouse-codegen` quotes table and column names that are not identifiers (`user-id`, `2fa`, `order id`), and gives tables whose names differ only in case, or that start with a digit, distinct valid interface names. Fixes #37.
- `wh.sql()` and pipe calls are no longer sent twice. A raw SQL statement is resent only when the connection was never made; a pipe call also when the server answers `retryable: true`, with a 429, or with a 503 and `Retry-After`. A bare 5xx or a dropped connection, which may follow a write that ran, is returned as the error. Fixes #56.
- `wavehouse-codegen` refuses an argument it does not recognise (a mistyped `--tenant`, a bare positional, `--flag=value`) instead of skipping it, which read as tenant `0` with exit 0. Fixes #44.
- A stream that connects without `since` and drops before its first event now resumes from that connection's start, so rows ingested during the reconnect backoff are delivered. Fixes #57.
- A stream with a callback subscriber no longer queues every event for an async iterator nobody started, so a long-lived `subscribe()` or `liveQuery()` stops growing in memory. Events that arrive before the first subscriber are dropped once one registers and no iterator exists. Fixes #21.
- A subscriber that throws no longer stops delivery to the others. Each `next`, `status` and `error` callback is isolated and its throw is logged, so a `for await` still receives the event and still ends on `closed`; a throwing `status` handler no longer escapes `.subscribe()` or `.liveQuery()`; and a throwing `initial()` or `next()` during the live-query backfill no longer discards the remaining buffered events, which are also delivered when the backfill fetch fails. Fixes #28.
- A subscriber that registers after a stream ended on a terminal error now receives that error, so it learns why the stream closed rather than only that it did. Fixes #36.
- A retried request no longer leaves an abort listener on the caller's `AbortSignal` each time its backoff timer wins, which tripped Node's `MaxListenersExceededWarning` on a signal shared across many requests. Fixes #29.
- A stream that takes a `429 Too Many Requests` now re-dials instead of staying dead until a reload (unless the body says `retryable: false`); every other 4xx still ends it. A `Retry-After` on a retryable stream response, in seconds or as an HTTP-date, sets the floor for that wait, clamped to 30 s. Fixes #25 and the stream half of #43.
- A reconnecting stream resumes with `?since=<last event id>` instead of a `Last-Event-ID` header. The header is not CORS-safelisted, so behind a proxy that answers CORS without allowing it, every reconnect failed its preflight and the stream re-dialed forever; a query parameter never preflights, and the server reads both the same way. Fixes #26.
- In a browser, a stream configured with `fetchOptions: { credentials: "include" }` now refuses redirects (`SSE_REDIRECT`) like one carrying a token or `headers`, instead of following one that drops its cookie and downgrades it to the default role. Cookies relied on through the implicit `same-origin` default remain invisible to the check, as documented on `fetchOptions`. Fixes #30.
- `liveQuery` deduplicates against the newest `received_timestamp` among the fetched rows, compared as parsed instants, instead of the last row compared as text. A descending order no longer redelivers rows already in `initial()`, and a second-precision boundary no longer drops same-second events that are newer. Buffered events are no longer dropped when the fetch fails (see #28). A table with no `received_timestamp` column, or a `.select()` that drops it, still has nothing to deduplicate against, so events that arrived during the fetch may repeat rows in `initial()`. Fixes #52 on the SDK side.
- A stream whose connection ends in a buffer overflow no longer resets the reconnect backoff just because it ran past the stable window, so a peer that overflows every time is re-dialed on a growing schedule rather than at a flat rate. A `fetch` that ignores `init.signal` can no longer open a stream after `close()`, and `FetchLike`'s documentation now says the signal must be honored. Fixes #32.

Releases up to 0.2.0 are recorded in the [WaveHouse changelog](https://github.com/Wave-RF/WaveHouse/blob/main/CHANGELOG.md).

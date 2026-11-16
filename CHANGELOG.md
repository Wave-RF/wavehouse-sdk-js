# Changelog

## [Unreleased]

### Added

- `options.attemptTimeoutMs` (default off) and a per-call `attemptTimeoutMs` give each attempt its own deadline, linked to the caller's `signal`, so a stalled attempt is retried instead of holding the call or, with `AbortSignal.timeout()`, aborting it with no retry. An attempt that hits it is retried after a backoff while `maxRetries` allows, with the safety rules of any network error: `wh.sql()` and pipe calls are not resent, since a timeout always counts as possibly sent. The caller's own abort still ends the call at once with `ABORTED`. A call that gives up returns `ATTEMPT_TIMEOUT` naming the attempt count. For `.stream()` and `.liveQuery()` it bounds each connect up to the response headers (`SSE_ATTEMPT_TIMEOUT`, retried), never an established stream; `StreamOptions` takes it too. Mirrors `RetryPolicy.AttemptTimeout` in `wavehouse-sdk-go`.
- `timeRange` takes a `Date` for `since` and `until`, sent as `toISOString()` (UTC); a string is still sent as given. An invalid `Date` resolves to an `INVALID_QUERY` error before any request.
- `last(column, duration)` keeps rows from the last `duration` by the server's clock, as `wavehouse-sdk-go`'s `Last` does. `duration` is a number of milliseconds or a `Duration` string (`"90s"`, `"1h"`, `"7d"`; units ms, s, m, h, d, w), sent in the server's relative form. A zero, negative or unparseable duration is an `INVALID_QUERY` error before any request.
- `wh.version()` returns the server's build (`version`, `git_commit`, `build_time`, `go_version`) from `GET /version`, as `wavehouse-sdk-go`'s `Version` does.
- Documented: a multi-tenant deployment sets `options.headers: { "X-Tenant-ID": "acme" }`, which reaches every REST call and the stream unchanged. The shared conformance cases gain an optional `"headers"` map for it.

### Changed

- A stream treats a data frame that arrives before any `event: schema` frame, a row that is not an array, or a row whose length disagrees with the announced columns as a protocol error: it reports a retryable `SSE_PROTOCOL_ERROR` and reconnects from the last delivered event, as `wavehouse-sdk-go` does, where it used to warn and drop the frame. The refused frame does not move the resume point. The `no-schema` warning and the README's notes on SDK and server version skew, which described the pre-`event: schema` stream format, are removed.
- `orderBy()` lowercases its direction and resolves a direction other than `asc` or `desc` to an `INVALID_QUERY` error before anything is sent. The server read `"DESC"` as ascending.
- `aggregate()` with an empty alias omits `alias` from the request instead of sending `""`.
- A `baseURL` carrying a query string or fragment throws at construction, naming the problem; it used to be dropped silently.

### Breaking

- Removed `"not_like"` from `FilterOp`. It type-checked and then failed with a 400 on a query, because the server's filter builder has no such operator. Use a positive `like`, or filter the rows you get back. Fixes #53.
- Removed `QueryBuilder.cacheTTL()`. It stored a value that was never sent, and the query wire type has no TTL field: the server picks the result-cache TTL itself. Delete the call; behaviour is unchanged. Fixes #45.
- Removed `wh.pipe(name).stream()` and `wh.dlq.stream()`. The server has no stream for a pipe or for dead letters, so both opened a healthy-looking connection that never delivered an event (`GET /v1/stream` serves ingest tables only). Fixes #54.

### Internal

- Request-conformance tests: `src/conformance.test.ts` replays the cases shared with `wavehouse-sdk-go` (`testdata/wire_cases.json`) and checks the exact request each call sends. Fixes #3.

### Deprecated

- `wavehouse-codegen --auth <token>`: an argument is visible in the process list and shell history. It still works and now prints a warning. Pass the token in `WAVEHOUSE_ADMIN_TOKEN` or on stdin with the new `--auth-stdin`; `WAVEHOUSE_OPERATOR_KEY` likewise supplies the operator key. Fixes #38.

### Fixed

- A `baseURL` with no scheme is accepted: `http://` is prepended for a loopback host (`localhost`, `127.0.0.0/8`, `::1`, `*.localhost`), `https://` for any other, and an explicit scheme is never changed, so `localhost:8080` no longer fails as a URL with the scheme `localhost:`. A `baseURL` that is still unusable now throws an error naming what is expected. `wavehouse-sdk-go` resolves the same inputs to the same base. Fixes #24.
- A `429 Too Many Requests` is now retryable on REST reads and ingest (unless the body says `retryable: false`): the SDK waits the `Retry-After` it carries, capped by `maxRetryAfterMs` (30 s by default), then resends, and a 429 that is returned reports `retryable: true`. Raw SQL is still never resent. Fixes #40 and the REST half of #43.
- `wavehouse-codegen` types a `Decimal` column as `string`, not `number`: the server sends Decimals as quoted strings, so `number` hid a string at runtime. The generated field carries a comment saying so. Fixes #39.
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
- In a browser, a stream configured with `fetchOptions: { credentials: "include" }` now refuses redirects (`SSE_REDIRECT`) like one carrying a token or `headers`, instead of following one that drops its cookie and downgrades it to the default role. Cookies relied on through the implicit `same-origin` default remain invisible to the check, as documented on `fetchOptions`. Fixes #30.
- `liveQuery` deduplicates against the newest `received_timestamp` among the fetched rows, compared as parsed instants, instead of the last row compared as text. A descending order no longer redelivers rows already in `initial()`, and a second-precision boundary no longer drops same-second events that are newer. Buffered events are no longer dropped when the fetch fails (see #28). A table with no `received_timestamp` column, or a `.select()` that drops it, still has nothing to deduplicate against, so events that arrived during the fetch may repeat rows in `initial()`. Fixes #52 on the SDK side.
- A stream whose connection ends in a buffer overflow no longer resets the reconnect backoff just because it ran past the stable window, so a peer that overflows every time is re-dialed on a growing schedule rather than at a flat rate. A `fetch` that ignores `init.signal` can no longer open a stream after `close()`, and `FetchLike`'s documentation now says the signal must be honored. Fixes #32.

Releases up to 0.2.0 are recorded in the [WaveHouse changelog](https://github.com/Wave-RF/WaveHouse/blob/main/CHANGELOG.md).

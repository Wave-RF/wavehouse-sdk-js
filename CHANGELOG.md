# Changelog

## [Unreleased]

### Fixed

- `wh.sql()` and pipe calls are no longer sent twice. A raw SQL statement is resent only when the connection was never made; a pipe call also when the server answers `retryable: true`, with a 429, or with a 503 and `Retry-After`. A bare 5xx or a dropped connection, which may follow a write that ran, is returned as the error. Fixes #56.
- A stream that connects without `since` and drops before its first event now resumes from that connection's start, so rows ingested during the reconnect backoff are delivered. Fixes #57.
- A stream with a callback subscriber no longer queues every event for an async iterator nobody started, so a long-lived `subscribe()` or `liveQuery()` stops growing in memory. Events that arrive before the first subscriber are dropped once one registers and no iterator exists. Fixes #21.
- A subscriber that throws no longer stops delivery to the others. Each `next`, `status` and `error` callback is isolated and its throw is logged, so a `for await` still receives the event and still ends on `closed`; a throwing `status` handler no longer escapes `.subscribe()` or `.liveQuery()`; and a throwing `initial()` or `next()` during the live-query backfill no longer discards the remaining buffered events, which are also delivered when the backfill fetch fails. Fixes #28.
- A subscriber that registers after a stream ended on a terminal error now receives that error, so it learns why the stream closed rather than only that it did. Fixes #36.
- A retried request no longer leaves an abort listener on the caller's `AbortSignal` each time its backoff timer wins, which tripped Node's `MaxListenersExceededWarning` on a signal shared across many requests. Fixes #29.

Releases up to 0.2.0 are recorded in the [WaveHouse changelog](https://github.com/Wave-RF/WaveHouse/blob/main/CHANGELOG.md).

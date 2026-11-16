# Changelog

## [Unreleased]

### Breaking

- Removed `"not_like"` from `FilterOp`. It type-checked and then failed with a 400 on a query, because the server's filter builder has no such operator. Use a positive `like`, or filter the rows you get back. Fixes #53.
- Removed `QueryBuilder.cacheTTL()`. It stored a value that was never sent, and the query wire type has no TTL field: the server picks the result-cache TTL itself. Delete the call; behaviour is unchanged. Fixes #45.

### Deprecated

- `wavehouse-codegen --auth <token>`: an argument is visible in the process list and shell history. It still works and now prints a warning. Pass the token in `WAVEHOUSE_ADMIN_TOKEN` or on stdin with the new `--auth-stdin`; `WAVEHOUSE_OPERATOR_KEY` likewise supplies the operator key. Fixes #38.

### Fixed

- `selectAll()` combined with `select()` columns or an aggregation, in either order, now resolves to an `INVALID_QUERY` error without sending a request, instead of reaching the server and failing with a 400. Fixes #31.
- `wavehouse-codegen` quotes table and column names that are not identifiers (`user-id`, `2fa`, `order id`), and gives tables whose names differ only in case, or that start with a digit, distinct valid interface names. Fixes #37.
- `wh.sql()` and pipe calls are no longer sent twice. A raw SQL statement is resent only when the connection was never made; a pipe call also when the server answers `retryable: true`, with a 429, or with a 503 and `Retry-After`. A bare 5xx or a dropped connection, which may follow a write that ran, is returned as the error. Fixes #56.
- `wavehouse-codegen` refuses an argument it does not recognise (a mistyped `--tenant`, a bare positional, `--flag=value`) instead of skipping it, which read as tenant `0` with exit 0. Fixes #44.
- A stream that connects without `since` and drops before its first event now resumes from that connection's start, so rows ingested during the reconnect backoff are delivered. Fixes #57.

Releases up to 0.2.0 are recorded in the [WaveHouse changelog](https://github.com/Wave-RF/WaveHouse/blob/main/CHANGELOG.md).

# Changelog

## [Unreleased]

### Deprecated

- `wavehouse-codegen --auth <token>`: an argument is visible in the process list and shell history. It still works and now prints a warning. Pass the token in `WAVEHOUSE_ADMIN_TOKEN` or on stdin with the new `--auth-stdin`; `WAVEHOUSE_OPERATOR_KEY` likewise supplies the operator key. Fixes #38.

### Fixed

- `wh.sql()` and pipe calls are no longer sent twice. A raw SQL statement is resent only when the connection was never made; a pipe call also when the server answers `retryable: true`, with a 429, or with a 503 and `Retry-After`. A bare 5xx or a dropped connection, which may follow a write that ran, is returned as the error. Fixes #56.
- `wavehouse-codegen` refuses an argument it does not recognise (a mistyped `--tenant`, a bare positional, `--flag=value`) instead of skipping it, which read as tenant `0` with exit 0. Fixes #44.
- A stream that connects without `since` and drops before its first event now resumes from that connection's start, so rows ingested during the reconnect backoff are delivered. Fixes #57.

Releases up to 0.2.0 are recorded in the [WaveHouse changelog](https://github.com/Wave-RF/WaveHouse/blob/main/CHANGELOG.md).

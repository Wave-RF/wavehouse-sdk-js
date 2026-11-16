# Changelog

## [Unreleased]

### Fixed

- `wh.sql()` and pipe calls are no longer sent twice. A raw SQL statement is resent only when the connection was never made; a pipe call also when the server answers `retryable: true`, with a 429, or with a 503 and `Retry-After`. A bare 5xx or a dropped connection, which may follow a write that ran, is returned as the error. Fixes #56.

Releases up to 0.2.0 are recorded in the [WaveHouse changelog](https://github.com/Wave-RF/WaveHouse/blob/main/CHANGELOG.md).

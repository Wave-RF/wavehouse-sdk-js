# AGENTS.md — Wave-RF/wavehouse-sdk-js

`@wavehouse/sdk` is the TypeScript client for [WaveHouse](https://github.com/Wave-RF/WaveHouse). It was extracted with its history from the server repository's `clients/ts/`; releases up to 0.2.0 are recorded in that repository's changelog. The rules both WaveHouse SDKs share are in the last section of this file.

## Layout

- `src/` is the SDK: `client.ts` and `http.ts` (REST), `query-builder.ts`, `pipes.ts`, `table.ts`, `errors.ts` and the other top-level modules, with `src/index.ts` as the only public entry point. Tests sit next to the code as `*.test.ts`.
- `src/stream/` is SSE streaming and live queries, built on `fetch` so it needs no polyfill.
- `src/cli/` is the `wavehouse-codegen` command, which turns the server's schema into a `Database` type.
- `scripts/smoke-dist.mjs` and `scripts/fetch-node.sh` check the built package (see Tests). `scripts/lint-pr-title.sh` and `scripts/ci/` are kept in step with `wavehouse-sdk-go` (see *Files kept in step*).
- The build is `tsup`: ESM and CJS with declarations, a browser IIFE bundle (`dist/index.global.js`, global `WaveHouse`) and the codegen CLI.

## Commands

- `make ci` runs everything CI runs: install, Biome, typecheck, unit tests with coverage, build and smoke check, shellcheck and actionlint. Run it before every push.
- `make fix` formats and applies safe Biome fixes.
- `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `make smoke` run the pieces. Use pnpm, not npm or yarn; Node 22 or newer.

## One runtime dependency

The package has one runtime dependency, `eventsource-parser`, and keeps it that way: the SDK ships to browsers through a CDN bundle, so size and supply-chain surface matter. A second dependency needs the same scrutiny: say in the PR why a few lines of our own would not do, and check that it works in the browser, in the CJS build and on Node 22.0. `eventsource-parser` 4 is held back for that reason: it drops CJS and needs Node 22.12.

## Tests

Two layers exist today: unit tests (`pnpm test`, HTTP mocked, gated at a 40% statement floor) and the built-package smoke check (`make smoke`), which loads the ESM, CJS and IIFE builds and the bin at the oldest Node `engines.node` admits and type-checks a CommonJS and an ESM consumer. Request conformance tests and live tests against a real server do not exist yet; don't describe a mocked test as covering them.

## Releases

A release is a tag `vX.Y.Z` on `main`; the tag is the version, and `.github/workflows/publish-npm.yml` stamps it into `package.json` at publish time, so don't bump `version` in a PR. Pushes to `main` also publish a `dev` snapshot. Publishing is gated on the repository variable `NPM_PUBLISH_ENABLED` and stays off until npm's trusted publisher is moved here from the server repository; the cutover steps are in the workflow's header.

## Documentation

User docs live on the WaveHouse docs site ([wavehouse.dev/sdk](https://wavehouse.dev/sdk)), in the server repository, not here. This repo's `README.md` is the npm page. A change to public behaviour needs a docs PR over there.

## Rules shared by both WaveHouse SDKs

This section is the same in both SDK repositories, and so are the files listed under *Files kept in step* below. Change them in both, in matching PRs that link each other.

### The SDKs and the server

- The server is [Wave-RF/WaveHouse](https://github.com/Wave-RF/WaveHouse). It defines the HTTP and SSE protocol, and an SDK follows it. When an SDK and the server disagree, the server's code and its [API reference](https://wavehouse.dev/api) decide, not another SDK.
- The SDKs are [`wavehouse-sdk-js`](https://github.com/Wave-RF/wavehouse-sdk-js) (`@wavehouse/sdk` on npm) and [`wavehouse-sdk-go`](https://github.com/Wave-RF/wavehouse-sdk-go) (`github.com/Wave-RF/wavehouse-sdk-go`). They share no code, but they should behave the same. When one SDK's public behaviour changes, open an issue in the other unless one exists.
- The user documentation for every SDK lives on the [WaveHouse docs site](https://wavehouse.dev/sdk), in the server repository under `docs/src/content/docs/sdk/`, one page per topic with every language on it. A change to public behaviour needs a docs PR there; link it from this repo's PR.
- A server bug goes to the server's issue tracker, not here.

### Operating rules

1. **Run `make ci` before every push.** It runs what CI runs. Don't use CI as your first feedback loop.
2. **Record every user-visible change in `CHANGELOG.md`** under `## [Unreleased]`, in the same PR.
3. **Drafts only, and a valid title.** Agents open PRs with `gh pr create --draft` and never mark one ready, approve or merge it. The title becomes the squash-merge commit on `main`, so it must be a Conventional Commit of at most 72 characters with a lowercase subject and no trailing period. Check it with `scripts/lint-pr-title.sh "<title>"` before creating the PR; the `PR title` job runs the same script.
4. **Never force-push or rebase a PR branch.** To take in `main`, `git merge origin/main`.
5. **Address and resolve every review finding.** Fix it, or open an issue and link it in your reply, then resolve the thread. Reply to a bot with an @-mention (`@coderabbitai`), or it never sees the reply. Unresolved threads block the merge.
6. **Comment the why, not the what,** in one or two lines, at the density of the file around it.

### Merging and releasing

- `main` takes squash merges through a merge queue, after one maintainer approval and the `CI` check. `CI` is the aggregator job in `.github/workflows/ci.yml`; add every new job to its `needs`.
- A release is a tag, and the tag is the version: `vX.Y.Z`, or `vX.Y.Z-alpha.N`, `-beta.N` or `-rc.N` for a prerelease. `scripts/ci/release-channel.sh` maps a tag to its channel (`latest`, `alpha`, `beta`, `rc` or `next`) and rejects one that isn't semver. Only maintainers can push release tags.
- Before 1.0 a minor release may break the API. Mark a breaking PR's title with `!` and label it `breaking-change`, so the release notes lead with it.

### Tests

Every SDK works toward four layers. The repo's own section says which it has today.

| Layer | Runs in | Proves |
| --- | --- | --- |
| Unit | this repo | the SDK's own logic |
| Request conformance | this repo, from shared cases | for each SDK call in the cases, the exact request it sends: method, path, content type and body |
| Live | this repo, against a real server | that real responses decode and streams work end to end |
| Server end-to-end | the server repo, pinned to a released SDK | that the server still works with the released SDK |

A test that hand-writes a server response can't catch a decoding bug against the real server. That is the live layer's job, so don't count a mocked test as coverage of it.

### Files kept in step

These files are identical in both SDK repositories: `.claude/settings.json`, `.editorconfig`, `.github/copilot-instructions.md`, `.github/release.yml`, `.github/workflows/shared-checks.yml`, `CLAUDE.md`, `LICENSE`, `scripts/lint-pr-title.sh`, `scripts/ci/check-pr-title.sh`, `scripts/ci/release-channel.sh` and `scripts/ci/require-needs.sh`. Nothing syncs them, so a change to one goes into both repositories. Branch and tag protection come from organization rulesets that match every `wavehouse-sdk-*` repository.

### This repository is public

Everything here is world-readable: issues, PRs, commits, branch names and Actions logs. Write only what an outside contributor could see. That rules out internal hostnames, infrastructure, private repositories and their issue numbers, and credentials.

.DEFAULT_GOAL := ci

.PHONY: ci fix install lint typecheck test build smoke

ci: install lint typecheck test build smoke ## Everything CI runs

install:
	pnpm install --frozen-lockfile

lint: ## biome, shellcheck, actionlint
	pnpm run lint
	git ls-files -z '*.sh' | xargs -0 -r shellcheck -x
	actionlint

typecheck:
	pnpm run typecheck

test: ## unit tests with the coverage floor
	pnpm run test:coverage

build:
	pnpm run build

# Runs at the oldest Node engines.node admits: an ESM-only dependency only breaks require() there.
smoke: build ## load every built entry point and type-check CJS and ESM consumers
	v=$$(node scripts/smoke-dist.mjs --min-node) && \
		n=$$(scripts/fetch-node.sh $$v .bin) && \
		"$$n" scripts/smoke-dist.mjs --expect-node $$v

fix: ## format and apply safe lint fixes
	pnpm run fix

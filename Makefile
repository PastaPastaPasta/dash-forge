SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

COMPOSE_FILE := infra/docker-compose.yml

.PHONY: check check-rust check-web build build-rust build-web infra-up infra-down e2e devnet-identities devnet-identities-verify

## check: run rust + web lint/test suites; tolerant of dirs that don't exist yet
check: check-rust check-web

check-rust:
	@if [ -f Cargo.toml ] && [ -d crates ]; then \
		echo "== rust: fmt =="; cargo fmt --all -- --check; \
		echo "== rust: clippy =="; cargo clippy --all-targets -- -D warnings; \
		echo "== rust: test =="; cargo test --all; \
	else \
		echo "== rust: skipped (no Cargo.toml / crates/ yet) =="; \
	fi

## check-web: one `cd` for the whole recipe — each line of a recipe is its own shell,
## but the lines within it are not, so a second `cd forge-web` would fail from inside it.
check-web:
	@if [ -f forge-web/package.json ]; then \
		cd forge-web && \
		echo "== web: typecheck ==" && pnpm typecheck && \
		echo "== web: lint ==" && pnpm lint && \
		echo "== web: test ==" && pnpm test; \
	else \
		echo "== web: skipped (no forge-web/package.json yet) =="; \
	fi

## build: build rust workspace + web app; tolerant of dirs that don't exist yet
build: build-rust build-web

build-rust:
	@if [ -f Cargo.toml ] && [ -d crates ]; then \
		echo "== rust: build =="; cargo build --all; \
	else \
		echo "== rust: skipped (no Cargo.toml / crates/ yet) =="; \
	fi

build-web:
	@if [ -f forge-web/package.json ]; then \
		echo "== web: build =="; cd forge-web && pnpm build; \
	else \
		echo "== web: skipped (no forge-web/package.json yet) =="; \
	fi

## infra-up: start e2e storage backend fixtures (kubo, minio, static-http)
infra-up:
	docker compose -f $(COMPOSE_FILE) up -d

## infra-down: stop and remove e2e storage backend fixtures + volumes
infra-down:
	docker compose -f $(COMPOSE_FILE) down -v

## e2e: run the CLI end-to-end suite (LIVE testnet) against the reused m1 repo.
## Builds the binaries if needed, then drives real git push/clone through the
## dash:// helper. See e2e/cli/README-less run.sh header for env knobs
## (RUN_ID, E2E_TIMEOUT, E2E_NO_CLEANUP, subset args). Exits non-zero on any FAIL.
e2e: build-rust
	@bash e2e/cli/run.sh

## devnet-identities: mint (or resume) the 9-role identity pool on a devnet,
## funded from the devnet's faucet wallet key, then verify every identity on
## Platform. The key is read from dash-network-configs at runtime (process
## substitution, never copied to disk) unless FORGE_DEVNET_FUNDING_WIF is set.
## Knobs: DEVNET (moutai), DEVNET_CONFIGS (~/workspace/dash-network-configs),
## DEVNET_IDENTITY_DIR, DEVNET_POOL_AMOUNT (DASH per role), DEVNET_ROLE_AMOUNTS.
DEVNET ?= moutai
DEVNET_CONFIGS ?= $(HOME)/workspace/dash-network-configs
DEVNET_IDENTITY_DIR ?= $(HOME)/.config/dash-forge/test-identities/devnet-$(DEVNET)
DEVNET_POOL_AMOUNT ?= 5
DEVNET_ROLE_AMOUNTS ?= DEPLOYER=50
MINT := node tools/mint-identity/mint.mjs
DEVNET_POOL := $(MINT) pool --network devnet --devnet-name $(DEVNET) --out "$(DEVNET_IDENTITY_DIR)" \
	--amount $(DEVNET_POOL_AMOUNT) --role-amounts "$(DEVNET_ROLE_AMOUNTS)"

tools/mint-identity/node_modules: tools/mint-identity/package.json tools/mint-identity/package-lock.json
	cd tools/mint-identity && npm ci
	@touch $@

devnet-identities: tools/mint-identity/node_modules
	@if [ -n "$${FORGE_DEVNET_FUNDING_WIF:-}" ]; then \
		$(DEVNET_POOL); \
	else \
		$(DEVNET_POOL) --funding-key-file <(git -C "$(DEVNET_CONFIGS)" show origin/master:devnet-$(DEVNET).yml); \
	fi
	$(MINT) verify --dir "$(DEVNET_IDENTITY_DIR)"

## devnet-identities-verify: check the devnet pool exists on Platform with balances and keys.
devnet-identities-verify: tools/mint-identity/node_modules
	$(MINT) verify --dir "$(DEVNET_IDENTITY_DIR)"

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

COMPOSE_FILE := infra/docker-compose.yml

.PHONY: check check-rust check-web dev-web build build-rust build-web infra-up infra-down e2e e2e-fixture devnet-identities devnet-identities-verify storage-it survivability storage-e2e

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

## dev-web: run the web app's dev server on http://localhost:3000, reading devnet sakura
## (forge-web/.env.development). Installs its dependencies first when they are missing.
dev-web:
	@cd forge-web && { [ -d node_modules ] || pnpm install --frozen-lockfile; } && pnpm dev

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

## infra-up: start e2e storage backend fixtures (kubo, RustFS + its bucket setup, static-http).
## --remove-orphans drops containers of services no longer in the file (the old MinIO ones,
## which would otherwise keep port 9000).
infra-up:
	docker compose -f $(COMPOSE_FILE) up -d --remove-orphans

## infra-down: stop and remove e2e storage backend fixtures + volumes
infra-down:
	docker compose -f $(COMPOSE_FILE) down -v

## e2e: run the CLI end-to-end suite (LIVE devnet sakura, forge-v2) against the
## OWNER-owned e2e-cli repo (created on first run).
## Builds the binaries if needed, then drives real git push/clone through the
## dash:// helper. See e2e/cli/README-less run.sh header for env knobs
## (RUN_ID, E2E_TIMEOUT, E2E_NO_CLEANUP, subset args). Exits non-zero on any FAIL.
e2e: build-rust
	@bash e2e/cli/run.sh

## e2e-fixture: seed the browser specs' forge-v2 read fixture on DEVNET (idempotent; needs
## `npm ci` in forge-contracts/sdk-v2 and the devnet OWNER/MAINTAINER/COLLAB/CONTRIB fixtures).
e2e-fixture:
	@node forge-contracts/scripts/seed-v2-fixture.mjs --network devnet --devnet-name $(DEVNET)

## devnet-identities: mint (or resume) the 9-role identity pool on a devnet,
## funded from the devnet's faucet wallet key, then verify every identity on
## Platform. The key is read from dash-network-configs at runtime (process
## substitution, never copied to disk) unless FORGE_DEVNET_FUNDING_WIF is set.
## Devnet sakura is not in dash-network-configs: run with DEVNET=sakura and
## FORGE_DEVNET_FUNDING_WIF set (or use the QA harness outside this repo,
## dash-forge-qa's `QA_NETWORK=sakura qa mint`).
## Knobs: DEVNET (sakura), DEVNET_CONFIGS (~/workspace/dash-network-configs),
## DEVNET_IDENTITY_DIR, DEVNET_POOL_AMOUNT (DASH per role), DEVNET_ROLE_AMOUNTS.
DEVNET ?= sakura
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
	@if [ -z "$${FORGE_DEVNET_FUNDING_WIF:-}" ] && ! git -C "$(DEVNET_CONFIGS)" cat-file -e origin/master:devnet-$(DEVNET).yml 2>/dev/null; then \
		echo "devnet-$(DEVNET) is not in $(DEVNET_CONFIGS): set FORGE_DEVNET_FUNDING_WIF to its funding key" >&2; exit 1; \
	fi
	@if [ -n "$${FORGE_DEVNET_FUNDING_WIF:-}" ]; then \
		$(DEVNET_POOL); \
	else \
		$(DEVNET_POOL) --funding-key-file <(git -C "$(DEVNET_CONFIGS)" show origin/master:devnet-$(DEVNET).yml); \
	fi
	$(MINT) verify --dir "$(DEVNET_IDENTITY_DIR)"

## devnet-identities-verify: check the devnet pool exists on Platform with balances and keys.
devnet-identities-verify: tools/mint-identity/node_modules
	$(MINT) verify --dir "$(DEVNET_IDENTITY_DIR)"

## storage-it: bring-your-own-storage integration tests against LOCAL RustFS (S3) + kubo
## (infra/docker-compose.yml): SigV4-signed PUT/HEAD/GET/DELETE on a bucket that refuses
## anonymous writes, kubo CID == local CIDv1 derivation, N-of-M replication + gateway
## read-back. FORGE_IT_S3/FORGE_IT_IPFS turn an unreachable fixture into a FAILURE
## instead of a silent skip. No network beyond localhost; no Platform spend.
## The buckets, their policies and CORS exist only once s3-init has exited 0; `docker wait`
## by container name also works when kubo belongs to another compose project.
storage-it: infra-up
	@rc=$$(docker wait forge-e2e-s3-init) && [ "$$rc" = 0 ] || \
		{ echo "s3-init did not set up the buckets (exit $$rc): docker logs forge-e2e-s3-init" >&2; exit 1; }
	@for i in $$(seq 1 60); do \
		curl -fsS -o /dev/null http://127.0.0.1:9000/health/ready && \
		curl -fsS -o /dev/null -X POST http://127.0.0.1:5001/api/v0/version && \
		curl -fsS -o /dev/null http://127.0.0.1:8082/README.txt && break; \
		[ "$$i" = 60 ] && { echo "storage fixture not ready after 120 s (docker compose -f $(COMPOSE_FILE) ps)" >&2; exit 1; }; \
		sleep 2; \
	done
	FORGE_IT_S3=1 FORGE_IT_IPFS=1 cargo test --locked -p forge-core --lib -- backends::live_tests storage::

## survivability: the survivability drill (roadmap Phase 1 gate) against the LOCAL fixture:
## deletes buckets of its own and STOPS/STARTS the kubo container (forge-e2e-kubo), so it is
## not part of storage-it. Clone (forge-core), browse (web reader) and web host (the static
## build killed, served again from a second host and from kubo as an IPFS build, by subdomain
## and by path). No chain.
## CI: .github/workflows/survivability.yml.
survivability: infra-up
	@for i in $$(seq 1 60); do \
		curl -fsS -o /dev/null http://127.0.0.1:9000/health/ready && \
		curl -fsS -o /dev/null http://127.0.0.1:8081/ipfs/bafkqaaa && break; \
		[ "$$i" = 60 ] && { echo "storage fixture not ready after 120 s (docker compose -f $(COMPOSE_FILE) ps)" >&2; exit 1; }; \
		sleep 2; \
	done
	FORGE_DRILL=1 cargo test --locked -p forge-core --lib survivability -- --test-threads=1
	cd forge-web && FORGE_DRILL=1 pnpm exec vitest run lib/view/survivability.drill.test.ts && \
		pnpm build:ipfs && FORGE_DRILL=1 pnpm exec playwright test -c e2e-drill/playwright.config.ts

## storage-e2e: a REAL `git push` / `git clone` through git-remote-dash with packs stored
## on local RustFS (S3) + kubo and only the manifest + ref on devnet sakura, against the
## dedicated storage-e2e-a / storage-e2e-b repos (e2e/README.md; ~0.001 DASH each, once).
## Builds the helper with the `test-hooks` fault-injection feature. Opt-in.
storage-e2e: infra-up
	cargo build -p dg
	cargo build -p git-remote-dash --features test-hooks
	@bash e2e/cli/storage-byo.sh

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

COMPOSE_FILE := infra/docker-compose.yml

.PHONY: check check-rust check-web build build-rust build-web infra-up infra-down e2e

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

check-web:
	@if [ -f forge-web/package.json ]; then \
		echo "== web: typecheck =="; cd forge-web && pnpm typecheck; \
		echo "== web: lint =="; cd forge-web && pnpm lint; \
		echo "== web: test =="; cd forge-web && pnpm test; \
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

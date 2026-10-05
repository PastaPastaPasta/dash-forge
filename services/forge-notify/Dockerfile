# forge-notify from source. Build from the repository root:
#
#   docker build -f services/forge-notify/Dockerfile -t forge-notify .
#
# Self-hosting: services/forge-notify/docker-compose.yml and docs/hosting/forge-notify.md.
# Base images are pinned by digest; bump them deliberately (the same pins as forge-relay).

FROM rust:1.98-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS builder
# tenderdash-proto needs protoc >= 25; Debian's is older, so take the pinned upstream zip and
# check it against the same digests .github/workflows/release.yml pins.
ARG PROTOC_VERSION=28.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip cmake \
 && rm -rf /var/lib/apt/lists/* \
 && case "$(uname -m)" in \
      x86_64) asset=linux-x86_64; sum=0ad949f04a6a174da83cdcbdb36dee0a4925272a5b6d83f79a6bf9852076d53f ;; \
      aarch64) asset=linux-aarch_64; sum=1de522032a8b194002fe35cab86d747848238b5e4de4f99648372079f5b46f9a ;; \
      *) echo "unsupported architecture $(uname -m)"; exit 1 ;; \
    esac \
 && curl --proto '=https' --tlsv1.2 -fsSLo /tmp/protoc.zip \
      "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-${asset}.zip" \
 && echo "${sum}  /tmp/protoc.zip" | sha256sum -c - \
 && unzip -q /tmp/protoc.zip -d /usr/local \
 && rm /tmp/protoc.zip \
 && protoc --version
WORKDIR /src
# Only what the Rust build reads (no forge-web/node_modules, no .git).
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY build-support build-support
COPY crates crates
COPY services services
COPY docs/errors.md docs/errors.md
COPY forge-contracts/deployments forge-contracts/deployments
COPY forge-contracts/config forge-contracts/config
# `--version` names this commit when built with --build-arg DASH_FORGE_BUILD_SHA=$(git rev-parse HEAD).
ARG DASH_FORGE_BUILD_SHA=unknown
ENV DASH_FORGE_BUILD_SHA=${DASH_FORGE_BUILD_SHA}
RUN cargo build --locked --release -p forge-notify --features forge-core/vendored-openssl \
 && cp target/release/forge-notify /forge-notify

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
# curl: the container health check only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10003 --no-create-home --shell /usr/sbin/nologin notify \
 && install -d -o 10003 -g 10003 -m 0700 /data
COPY --from=builder /forge-notify /usr/local/bin/forge-notify
# The SQLite store (subscribers, encrypted addresses and push subscriptions, cursors). Back it
# up: docs/hosting/forge-notify.md, "Backups".
ENV FORGE_NOTIFY_DATA_DIR=/data \
    FORGE_NOTIFY_LISTEN=0.0.0.0:8080
VOLUME /data
EXPOSE 8080
USER 10003:10003
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["forge-notify"]
CMD ["serve"]

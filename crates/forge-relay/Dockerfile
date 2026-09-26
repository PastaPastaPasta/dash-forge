# forge-relay from source. Build from the repository root:
#
#   docker build -f crates/forge-relay/Dockerfile -t forge-relay .
#
# Release images are built from the prebuilt static binary instead (Dockerfile.release).

FROM rust:1.98-bookworm AS builder
# tenderdash-proto needs protoc >= 25; Debian's is older, so take the pinned upstream zip.
ARG PROTOC_VERSION=28.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip cmake \
 && rm -rf /var/lib/apt/lists/* \
 && arch="$(uname -m)" && case "$arch" in aarch64) arch=aarch_64 ;; esac \
 && curl --proto '=https' --tlsv1.2 -fsSLo /tmp/protoc.zip \
      "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-${arch}.zip" \
 && unzip -q /tmp/protoc.zip -d /usr/local \
 && rm /tmp/protoc.zip \
 && protoc --version
WORKDIR /src
# Only what the Rust build reads (no forge-web/node_modules, no .git).
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY build-support build-support
COPY crates crates
COPY docs/errors.md docs/errors.md
COPY forge-contracts/deployments forge-contracts/deployments
COPY forge-contracts/config forge-contracts/config
# `--version` names this commit when built with --build-arg DASH_FORGE_BUILD_SHA=$(git rev-parse HEAD).
ARG DASH_FORGE_BUILD_SHA=unknown
ENV DASH_FORGE_BUILD_SHA=${DASH_FORGE_BUILD_SHA}
RUN cargo build --locked --release -p forge-relay --features forge-core/vendored-openssl \
 && cp target/release/forge-relay /forge-relay

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin relay
COPY --from=builder /forge-relay /usr/local/bin/forge-relay
USER 10001:10001
ENTRYPOINT ["forge-relay", "run"]

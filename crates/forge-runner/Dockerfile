# forge-runner: dg + git-remote-dash + nektos/act + the Docker CLI, from source. Build from the
# repository root:
#
#   docker build -f crates/forge-runner/Dockerfile -t forge-runner .
#
# The runner starts job containers through a Docker daemon it is given (DOCKER_HOST). That
# daemon is the security boundary: a job container on it is only as contained as the daemon
# lets it be. Give the runner a daemon of its own: rootless Docker, a sysbox runtime, or a
# Docker-in-Docker sidecar with TLS (tcp://…:2376) or a unix socket shared only with the
# runner. Never the host's /var/run/docker.sock, and never an unauthenticated tcp://…:2375.
# docs/guides/self-host-runner.md §Security.
# Base images are pinned by digest; bump them deliberately (same pins as forge-relay's Dockerfile).

FROM rust:1.98-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS builder
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
 && unzip -q /tmp/protoc.zip -d /usr/local && rm /tmp/protoc.zip
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY build-support build-support
COPY crates crates
COPY docs/errors.md docs/errors.md
COPY forge-contracts/deployments forge-contracts/deployments
COPY forge-contracts/config forge-contracts/config
ARG DASH_FORGE_BUILD_SHA=unknown
ENV DASH_FORGE_BUILD_SHA=${DASH_FORGE_BUILD_SHA}
RUN cargo build --locked --release -p dg -p git-remote-dash -p forge-runner --features forge-core/vendored-openssl \
 && mkdir /out && cp target/release/dg target/release/git-remote-dash target/release/forge-runner /out/

# nektos/act, a pinned release. Its archive is checked against a digest pinned here (bump both
# with ACT_VERSION; the digests match the release's checksums.txt for v0.2.89).
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS act
ARG ACT_VERSION=0.2.89
ARG ACT_SHA256_X86_64=0191d6f1f3b716b5c55820032605d05fc3c1cdbf581ebeff655019e5dd1524c0
ARG ACT_SHA256_ARM64=daa8679ba9615a74d2d0cec321dc593f21948a2a11bb65862b063d8b930f4bcb
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && case "$(uname -m)" in x86_64) a=x86_64; sum="$ACT_SHA256_X86_64" ;; aarch64) a=arm64; sum="$ACT_SHA256_ARM64" ;; *) exit 1 ;; esac \
 && curl --proto '=https' --tlsv1.2 -fsSLo /tmp/act.tgz "https://github.com/nektos/act/releases/download/v${ACT_VERSION}/act_Linux_${a}.tar.gz" \
 && echo "${sum}  /tmp/act.tgz" | sha256sum -c - \
 && tar -xzf /tmp/act.tgz -C /usr/local/bin act && act --version

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git docker.io \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 runner \
 && mkdir -p /var/lib/forge-runner /etc/forge-runner \
 && chown runner:runner /var/lib/forge-runner
COPY --from=builder /out/ /usr/local/bin/
COPY --from=act /usr/local/bin/act /usr/local/bin/act
USER runner
ENV DASH_FORGE_NO_KEYCHAIN=1
VOLUME ["/var/lib/forge-runner"]
ENTRYPOINT ["forge-runner"]
CMD ["-c", "/etc/forge-runner/runner.toml", "watch"]

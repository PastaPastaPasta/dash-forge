#!/bin/sh
# The reproducible IPFS build of the web app (docs/guides/verify-the-app.md).
#
#   scripts/ipfs-release.sh reproduce [REF] [OUTDIR]
#       Build REF (default HEAD) from `git archive` in the pinned Node image, then compute its
#       CID and CAR with the pinned kubo image. Writes OUTDIR (default ./ipfs-build):
#         forge-web.cid   the site's root CID (CIDv1), one line
#         forge-web.car   the whole site as a CAR (`ipfs dag import` it to pin it)
#         site.tar        the files, for serving or diffing
#       Needs git and Docker. This is what the release workflow runs, and what you run to
#       check a release: the same tag gives the same CID. It builds with REF's own copy of this
#       script (its pins and network), whichever checkout you run it from.
#
#   scripts/ipfs-release.sh cid DIR [OUTDIR]
#       Only the CID (and CAR) of an existing build directory, with the pinned kubo image.
#
# Everything that decides the output is pinned here or in the repository: the Node image (by
# its multi-arch index digest; CI checks that its amd64 and arm64 images build the same bytes),
# the pnpm version (by integrity), the dependencies (pnpm-lock.yaml), the network the build
# reads, and the kubo import settings. The build id is the commit (next.config.js), and the
# environment is cleared before the build, so nothing from the host leaks in. SOURCE_DATE_EPOCH
# (the commit's time) dates the files in site.tar; the CID does not record times.
set -eu

NODE_IMAGE='node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9'
PNPM_VERSION='11.9.0'
PNPM_INTEGRITY='sha512-vWgtXQP+Ul73yf1ngMaITR51asTJyf4AxTh4KCQxDc+Q493E9Tg18G3669UIXkGFXgvLs7YN4qxburieUDbwOw=='
KUBO_IMAGE='ipfs/kubo:v0.43.1@sha256:b293923d66e490e70ced64df42ea7a6cf7eac2740e3fb29101df18070fa7be48'
# The network a release build reads. Part of the output, so it is fixed per commit: change it
# here (for mainnet), never per run.
RELEASE_NETWORK='devnet'
RELEASE_DEVNET_NAME='sakura'
# UnixFS import: the throwaway repository is initialised with IPIP-499's unixfs-v1-2025 profile
# (which also sets 1024 links per file node and the HAMT directory settings); the flags restate
# CIDv1, raw leaves, SHA-256 and 1 MiB chunks. Hidden files and empty directories are part of
# the site, so they are kept.
IPFS_ADD_FLAGS='-r -Q --hidden --empty-dirs=true --cid-version=1 --raw-leaves --hash=sha2-256 --chunker=size-1048576 --pin=false'

die() { printf 'ipfs-release: %s\n' "$*" >&2; exit 1; }
log() { printf 'ipfs-release: %s\n' "$*" >&2; }

# Inside the Node image: the source tree arrives as a tar on stdin, the built site leaves as a
# tar on stdout. Everything else goes to stderr.
container_build() {
  : "${FORGE_BUILD_COMMIT:?}" "${SOURCE_DATE_EPOCH:?}"
  mkdir -p /src
  tar -x -C /src
  cd /tmp
  npm pack --silent "pnpm@${PNPM_VERSION}" >/dev/null
  actual=$(node -e 'const c=require("node:crypto");process.stdout.write("sha512-"+c.createHash("sha512").update(require("node:fs").readFileSync(process.argv[1])).digest("base64"))' "pnpm-${PNPM_VERSION}.tgz")
  [ "$actual" = "$PNPM_INTEGRITY" ] || die "pnpm-${PNPM_VERSION}.tgz is $actual, not the pinned $PNPM_INTEGRITY"
  npm install --global --silent --no-audit --no-fund "./pnpm-${PNPM_VERSION}.tgz" >&2
  cd /src/forge-web
  env -i HOME=/root PATH="$PATH" CI=1 LANG=C.UTF-8 TZ=UTC \
    NEXT_TELEMETRY_DISABLED=1 \
    SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
    FORGE_BUILD_COMMIT="$FORGE_BUILD_COMMIT" \
    NEXT_PUBLIC_NETWORK="$RELEASE_NETWORK" \
    NEXT_PUBLIC_DEVNET_NAME="$RELEASE_DEVNET_NAME" \
    sh -c 'pnpm install --frozen-lockfile && pnpm run build:ipfs' >&2
  tar -C out --sort=name --owner=0 --group=0 --numeric-owner --mtime="@${SOURCE_DATE_EPOCH}" -cf - .
}

# Inside the kubo image: the site as a tar on stdin; a tar of forge-web.cid and forge-web.car
# on stdout. An offline, throwaway repository; nothing is announced or pinned anywhere.
container_cid() {
  export IPFS_PATH=/tmp/ipfs-repo
  mkdir -p /tmp/site /tmp/result
  tar -x -C /tmp/site
  ipfs init --empty-repo --profile=test,unixfs-v1-2025 >/dev/null
  # shellcheck disable=SC2086 # word-split on purpose
  cid=$(ipfs add $IPFS_ADD_FLAGS /tmp/site)
  printf '%s\n' "$cid" > /tmp/result/forge-web.cid
  ipfs dag export "$cid" > /tmp/result/forge-web.car
  tar -C /tmp/result -cf - forge-web.cid forge-web.car
}

# The script itself runs in both containers, fed on stdin, so both use the pins above.
in_container() {
  image=$1 fn=$2
  shift 2
  script=$(cat "$0")
  docker run -i --rm "$@" --entrypoint sh "$image" \
    -c "$script" ipfs-release "$fn"
}

# site.tar -> OUTDIR/forge-web.{cid,car}. Through a file, not a pipe: a failed container must
# not leave an earlier run's CID in place (macOS tar accepts an empty stream).
cid_of_tar() {
  rm -f "$2/forge-web.cid" "$2/forge-web.car" "$2/cid-result.tar"
  in_container "$KUBO_IMAGE" _cid --network=none < "$1" > "$2/cid-result.tar"
  tar -x -C "$2" -f "$2/cid-result.tar"
  rm -f "$2/cid-result.tar"
  cid=$(cat "$2/forge-web.cid")
  printf '%s\n' "$cid" | grep -Eq '^bafy[a-z2-7]{55}$' || die "kubo gave no CID: '$cid'"
  log "CID $cid"
}

reproduce() {
  ref=${1:-HEAD}
  out=${2:-ipfs-build}
  root=${IPFS_RELEASE_ROOT:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}
  commit=$(git -C "$root" rev-parse --verify "${ref}^{commit}") || die "no commit $ref"
  # Build with the script (and so the pins and network) of the commit being built: a checkout
  # of master must reproduce an older tag exactly as that tag's release did.
  if [ "${IPFS_RELEASE_SCRIPT_OF:-}" != "$commit" ]; then
    target=$(mktemp "${TMPDIR:-/tmp}/ipfs-release.XXXXXX")
    if ! git -C "$root" show "$commit:forge-web/scripts/ipfs-release.sh" > "$target" 2>/dev/null; then
      rm -f "$target"
      die "$ref has no forge-web/scripts/ipfs-release.sh: it predates the reproducible IPFS build"
    fi
    if IPFS_RELEASE_SCRIPT_OF=$commit IPFS_RELEASE_ROOT=$root sh "$target" reproduce "$commit" "$out"; then st=0; else st=$?; fi
    rm -f "$target"
    exit "$st"
  fi
  epoch=$(git -C "$root" log -1 --format=%ct "$commit")
  mkdir -p "$out"
  rm -f "$out/site.tar"
  log "building $commit ($(git -C "$root" describe --tags --always "$commit")) in $NODE_IMAGE"
  git -C "$root" archive --format=tar "$commit" \
    | in_container "$NODE_IMAGE" _build -e FORGE_BUILD_COMMIT="$commit" -e SOURCE_DATE_EPOCH="$epoch" \
    > "$out/site.tar"
  [ -s "$out/site.tar" ] || die "the build produced nothing"
  cid_of_tar "$out/site.tar" "$out"
  printf '%s\n' "$cid"
}

cid_of_dir() {
  dir=${1:?usage: ipfs-release.sh cid DIR [OUTDIR]}
  out=${2:-ipfs-build}
  [ -f "$dir/index.html" ] || die "$dir/index.html not found"
  mkdir -p "$out"
  # No macOS metadata (AppleDouble ._ files, .DS_Store): they would be part of the CID.
  COPYFILE_DISABLE=1 tar -C "$dir" --exclude=.DS_Store -cf "$out/site.tar" .
  cid_of_tar "$out/site.tar" "$out"
  printf '%s\n' "$cid"
}

case "${1:-}" in
  reproduce) shift; reproduce "$@" ;;
  cid) shift; cid_of_dir "$@" ;;
  _build) container_build ;;
  _cid) container_cid ;;
  *) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

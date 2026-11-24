#!/bin/sh
# Forced command for the forge-ci SSH key on the IPFS host (tools/forge-sync/README.md):
# read ONE CAR from stdin, import it into the forge-ipfs kubo container and pin its roots,
# printing `confirmed<TAB><cid>` for each root that is pinned. Empty stdin is the workflow's
# preflight and answers `ready`. SSH_ORIGINAL_COMMAND is ignored on purpose.
# Installed as ~pasta/forge-ipfs/ci-import.sh, with this in ~pasta/.ssh/authorized_keys:
#   restrict,command="/home/pasta/forge-ipfs/ci-import.sh" ssh-ed25519 AAAA... forge-ci-github-actions
set -eu
max=$((512 * 1024 * 1024))
umask 077
tmp=$(mktemp /tmp/forge-ci-XXXXXXXX)
name="${tmp##*/}.car"
cleanup() { rm -f "$tmp"; docker exec forge-ipfs rm -f "/tmp/$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
head -c $((max + 1)) > "$tmp"
size=$(stat -c %s "$tmp")
if [ "$size" -eq 0 ]; then
  docker exec forge-ipfs ipfs id >/dev/null 2>&1 || { echo "kubo is not answering" >&2; exit 3; }
  echo ready
  exit 0
fi
[ "$size" -le "$max" ] || { echo "refused: CAR over 512 MiB" >&2; exit 3; }
docker cp "$tmp" "forge-ipfs:/tmp/$name"
out=$(docker exec forge-ipfs ipfs dag import --pin-roots "/tmp/$name")
printf '%s\n' "$out"
for cid in $(printf '%s\n' "$out" | awk -F'\t' '$1 == "Pinned root" && $3 == "success" {print $2}'); do
  docker exec forge-ipfs ipfs pin ls --type=recursive "$cid" >/dev/null
  printf 'confirmed\t%s\n' "$cid"
  (docker exec forge-ipfs ipfs routing provide "$cid" >/dev/null 2>&1 &)
done

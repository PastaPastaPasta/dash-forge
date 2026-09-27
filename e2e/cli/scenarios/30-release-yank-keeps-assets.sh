#!/usr/bin/env bash
# Scenario 30: republishing a release carries forward what it does not change (D-504).
#
#   1. OWNER publishes release e2e-<run>-y with a name, notes and one asset (on RustFS).
#   2. `dg release create --tag e2e-<run>-y --yanked`, with no --asset/--name/--notes: the new
#      revision is yanked and keeps the asset, name and notes (before: 0 assets, so a yank
#      dropped the files).
#   3. `dg release download` still fetches and verifies the asset of the yanked release.
#   4. `dg release create … --notes <new>` un-yanks, keeps the asset, replaces only the notes.
#
# Needs RustFS for the asset (SKIPs without it, like 11); the release is on the suite repo.
SCENARIO_NAME="30 release yank keeps its assets (D-504)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

S3="http://127.0.0.1:9000"
curl -fsS -m 3 -o /dev/null "${S3}/health/ready" || skip_scenario "the local S3 store (RustFS) is not up (make infra-up)"

REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
TAG="e2e-${RUN_ID}-y"
LOG="${WORKROOT}/s30"
CFG="${WORKROOT}/s30-storage.toml"
READER_CFG="${WORKROOT}/s30-reader.toml"
ASSET="${WORKROOT}/s30-app-${RUN_ID}.tar.gz"

jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

export FORGE_E2E_S3_SECRET="minioadmin"
cat >"$CFG" <<EOF
[profiles.rustfs]
kind = "s3"
endpoint = "${S3}"
region = "us-east-1"
bucket = "forge-byo"
path_style = true
public_url = "${S3}/forge-byo"
prefix = "e2e/${RUN_ID}/releases"
access_key_id = "minioadmin"
secret_access_key = "env:FORGE_E2E_S3_SECRET"
allow_private_uri = true
EOF
# A reader follows a loopback URL a release recorded only when a profile of its own names that
# host (as in 11): the RustFS public URL, no credentials.
cat >"$READER_CFG" <<EOF
[read]
ipfs_gateways = []

[profiles.rustfs-public]
kind = "s3"
endpoint = "${S3}"
region = "us-east-1"
bucket = "forge-byo"
path_style = true
public_url = "${S3}/forge-byo"
allow_private_uri = true
EOF
head -c 5000 /dev/urandom | gzip -c >"$ASSET"
SHA="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ASSET")"
NAME="$(basename "$ASSET")"

publish() { # publish <log> <dg release create args…>
  local log="$1"; shift
  DASH_FORGE_STORAGE_CONFIG="$CFG" dg_as "$ID_OWNER" --yes --json release create "$REPO" --tag "$TAG" "$@" \
    >"$log.json" 2>"$log.err" && return 0
  cat "$log.err" "$log.json" >&2
  is_flake "$log.err" && skip_scenario "release create flaked"
  bad "release create $* failed"; finish_scenario
}
# The newest revision of TAG as `dg release list` shows it (retried until it is the one
# just written: reads can lag a block).
# shellcheck disable=SC2329 # called through `check`
current() { # current <log> <python predicate on r>
  local _
  for _ in $(seq 1 10); do
    if dg_read_retry "$ID_CONTRIB" "$1.json" "$1.err" --json release list "$REPO" \
      && python3 - "$1.json" "$TAG" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
r = next(r for r in d["releases"] if r["tag"] == sys.argv[2])
assert eval(sys.argv[3]), r
PY
    then return 0; fi
    sleep 3
  done
  return 1
}

step "1. publish ${TAG} with a name, notes and an asset"
publish "$LOG-create" --name "e2e ${RUN_ID}" --notes "first notes" --asset "$ASSET" --storage rustfs
check "asset recorded" assert_eq "$SHA" "$(jq_py "$LOG-create.json" 'd["assets"][0]["sha256"]')"

step "2. --yanked alone keeps the asset, name and notes"
publish "$LOG-yank" --yanked
check "the yank's own output lists the asset" assert_eq "$SHA" "$(jq_py "$LOG-yank.json" 'd["assets"][0]["sha256"]')"
check "listed yanked, with its asset, name and notes" current "$LOG-list-yanked" \
  "r['yanked'] and len(r['assets']) == 1 and r['assets'][0]['sha256'] == '$SHA' and r['name'] == 'e2e ${RUN_ID}' and r['notes'] == 'first notes'"

step "3. the yanked release's asset still downloads and verifies"
OUT="${WORKROOT}/s30-download"
if DASH_FORGE_STORAGE_CONFIG="$READER_CFG" dg_as "$ID_CONTRIB" --json release download "$REPO" "$TAG" \
    --asset "$NAME" --output "$OUT" >"$LOG-dl.json" 2>"$LOG-dl.err"; then
  check "bytes identical" cmp -s "$ASSET" "$OUT"
else
  cat "$LOG-dl.err" "$LOG-dl.json" >&2; bad "download of the yanked release's asset failed"
fi

step "4. new notes only: un-yanked, asset and name kept"
publish "$LOG-notes" --notes "second notes"
check "listed un-yanked with new notes, same asset and name" current "$LOG-list-notes" \
  "not r['yanked'] and len(r['assets']) == 1 and r['assets'][0]['sha256'] == '$SHA' and r['name'] == 'e2e ${RUN_ID}' and r['notes'] == 'second notes'"

finish_scenario

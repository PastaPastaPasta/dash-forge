#!/usr/bin/env bash
# Scenario 11: a release with an asset on the maintainer's own storage (local MinIO).
#
#   1. COLLAB (not a maintainer) tries to publish: refused before anything is uploaded (E601).
#   2. OWNER publishes release e2e-<run> with one asset: the file goes to MinIO (SigV4),
#      is re-read and verified, and the release records {name, sha256, sizeBytes, uris}.
#   3. `dg release list` shows it, published by OWNER, with the recorded sha256.
#   4. A reader with NO storage credentials downloads it through the public URL; the bytes
#      are sha256-verified and identical to the file.
#
# Needs infra/docker-compose.yml up (MinIO). SKIPs when MinIO is down (the nightly runner has
# none); `make storage-e2e` brings it up. The asset lives on this machine's MinIO, which is
# fine for a release (no clone depends on it).
SCENARIO_NAME="11 release with an asset on MinIO"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

MINIO="http://127.0.0.1:9000"
curl -fsS -o /dev/null "${MINIO}/minio/health/live" || skip_scenario "MinIO not up (make infra-up)"

REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
TAG="e2e-${RUN_ID}"
LOG="${WORKROOT}/s11"
CFG="${WORKROOT}/s11-storage.toml"
READER_CFG="${WORKROOT}/s11-reader.toml"
ASSET="${WORKROOT}/s11-dg-${RUN_ID}.tar.gz"

jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

export FORGE_E2E_MINIO_SECRET="minioadmin"
cat >"$CFG" <<EOF
[profiles.minio]
kind = "s3"
endpoint = "${MINIO}"
region = "us-east-1"
bucket = "forge-byo"
path_style = true
public_url = "${MINIO}/forge-byo"
prefix = "e2e/${RUN_ID}/releases"
access_key_id = "minioadmin"
secret_access_key = "env:FORGE_E2E_MINIO_SECRET"
EOF
printf '[read]\nipfs_gateways = []\n' >"$READER_CFG"
head -c 20000 /dev/urandom | gzip -c >"$ASSET"
SHA="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ASSET")"

step "COLLAB (not a maintainer) is refused before anything is uploaded"
if DASH_FORGE_STORAGE_CONFIG="$CFG" dg_as "$ID_COLLAB" --yes --json release create "$REPO" --tag "$TAG-x" \
    --asset "$ASSET" --storage minio >"$LOG-deny.json" 2>"$LOG-deny.err"; then
  bad "a non-maintainer published a release"
else
  check "E601" assert_eq "E601" "$(jq_py "$LOG-deny.json" 'd["error"]["code"]')"
  check "names the maintainer role" assert_file_contains "$LOG-deny.json" "maintainer"
fi

step "OWNER publishes ${TAG} with an asset on MinIO"
if DASH_FORGE_STORAGE_CONFIG="$CFG" dg_as "$ID_OWNER" --yes --json release create "$REPO" --tag "$TAG" \
    --name "e2e ${RUN_ID}" --notes "published by the e2e suite" --asset "$ASSET" --storage minio \
    >"$LOG-create.json" 2>"$LOG-create.err"; then
  check "sha256 recorded" assert_eq "$SHA" "$(jq_py "$LOG-create.json" 'd["assets"][0]["sha256"]')"
  check "a public MinIO URL recorded" assert_contains "$(jq_py "$LOG-create.json" 'd["assets"][0]["uris"]')" "${MINIO}/forge-byo/e2e/${RUN_ID}/releases/"
  ok "published ($(jq_py "$LOG-create.json" 'd["cost"]["dash"]') DASH)"
else
  cat "$LOG-create.err" "$LOG-create.json" >&2
  is_flake "$LOG-create.err" && skip_scenario "release create flaked"
  bad "release create failed"; finish_scenario
fi

step "dg release list shows it"
listed() {
  dg_read_retry "$ID_CONTRIB" "$LOG-list.json" "$LOG-list.err" --json release list "$REPO" \
    && python3 - "$LOG-list.json" "$TAG" "$SHA" "$IDID_OWNER" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
r = next(r for r in d["releases"] if r["tag"] == sys.argv[2])
assert r["publishedBy"] == sys.argv[4], r
assert r["assets"][0]["sha256"] == sys.argv[3], r
PY
}
li=1; for _ in $(seq 1 10); do listed 2>/dev/null && { li=0; break; }; sleep 3; done
check "listed, published by OWNER, sha256 intact" test "$li" -eq 0

step "a reader with no storage credentials downloads and verifies it"
OUT="${WORKROOT}/s11-download"
if DASH_FORGE_STORAGE_CONFIG="$READER_CFG" dg_as "$ID_CONTRIB" --json release download "$REPO" "$TAG" \
    --output "$OUT" >"$LOG-dl.json" 2>"$LOG-dl.err"; then
  check "bytes identical" cmp -s "$ASSET" "$OUT"
else
  cat "$LOG-dl.err" "$LOG-dl.json" >&2; bad "download failed"
fi

finish_scenario

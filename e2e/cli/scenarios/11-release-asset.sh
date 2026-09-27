#!/usr/bin/env bash
# Scenario 11: a release with an asset on the maintainer's own storage (local RustFS).
#
#   1. COLLAB (not a maintainer) tries to publish: refused before anything is uploaded (E601).
#   2. OWNER publishes release e2e-<run> with one asset: the file goes to RustFS (SigV4),
#      is re-read and verified, and the release records {name, sha256, sizeBytes, uris}.
#   3. `dg release list` shows it, published by OWNER, with the recorded sha256.
#   4. A reader who has not configured that host is refused with E503: a loopback URL from a
#      manifest is never followed. A reader with NO storage credentials whose profile names the
#      RustFS public URL downloads it; the bytes are sha256-verified and identical to the file.
#
# Needs infra/docker-compose.yml up (RustFS). SKIPs when RustFS is down (the nightly starts it;
# locally `make infra-up`). The asset lives on this machine's RustFS, which is
# fine for a release (no clone depends on it).
SCENARIO_NAME="11 release with an asset on RustFS"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

S3="http://127.0.0.1:9000"
curl -fsS -o /dev/null "${S3}/health/ready" || skip_scenario "the local S3 store (RustFS) is not up (make infra-up)"

REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
TAG="e2e-${RUN_ID}"
LOG="${WORKROOT}/s11"
CFG="${WORKROOT}/s11-storage.toml"
READER_CFG="${WORKROOT}/s11-reader.toml"
ASSET="${WORKROOT}/s11-dg-${RUN_ID}.tar.gz"

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
# A loopback S3 URL: a local fixture, never readable by anyone else.
allow_private_uri = true
EOF
# The reader has no credentials. It trusts this RustFS the way a user trusts their own storage,
# with a profile whose public_url is it. A reader without one never follows a loopback URL that
# a manifest recorded, which is what UNTRUSTED_CFG checks.
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
UNTRUSTED_CFG="${WORKROOT}/s11-untrusted.toml"
printf '[read]\nipfs_gateways = []\n' >"$UNTRUSTED_CFG"
head -c 20000 /dev/urandom | gzip -c >"$ASSET"
SHA="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ASSET")"

step "COLLAB (not a maintainer) is refused before anything is uploaded"
if DASH_FORGE_STORAGE_CONFIG="$CFG" dg_as "$ID_COLLAB" --yes --json release create "$REPO" --tag "$TAG-x" \
    --asset "$ASSET" --storage rustfs >"$LOG-deny.json" 2>"$LOG-deny.err"; then
  bad "a non-maintainer published a release"
else
  check "E601" assert_eq "E601" "$(jq_py "$LOG-deny.json" 'd["error"]["code"]')"
  check "names the maintainer role" assert_file_contains "$LOG-deny.json" "maintainer"
fi

step "OWNER publishes ${TAG} with an asset on RustFS"
if DASH_FORGE_STORAGE_CONFIG="$CFG" dg_as "$ID_OWNER" --yes --json release create "$REPO" --tag "$TAG" \
    --name "e2e ${RUN_ID}" --notes "published by the e2e suite" --asset "$ASSET" --storage rustfs \
    >"$LOG-create.json" 2>"$LOG-create.err"; then
  check "sha256 recorded" assert_eq "$SHA" "$(jq_py "$LOG-create.json" 'd["assets"][0]["sha256"]')"
  check "a public RustFS URL recorded" assert_contains "$(jq_py "$LOG-create.json" 'd["assets"][0]["uris"]')" "${S3}/forge-byo/e2e/${RUN_ID}/releases/"
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

step "a reader who does not trust that host is told why (E503), not \"not found\""
if DASH_FORGE_STORAGE_CONFIG="$UNTRUSTED_CFG" dg_as "$ID_CONTRIB" --json release download "$REPO" "$TAG" \
    --output "${WORKROOT}/s11-untrusted" >"$LOG-untrusted.json" 2>"$LOG-untrusted.err"; then
  bad "downloaded from a loopback URL the reader never configured"
else
  check "E503" assert_eq "E503" "$(jq_py "$LOG-untrusted.json" 'd["error"]["code"]')"
  check "names the untrusted copy" assert_file_contains "$LOG-untrusted.json" "${S3}/forge-byo/"
fi

step "a reader with no storage credentials downloads and verifies it"
OUT="${WORKROOT}/s11-download"
if DASH_FORGE_STORAGE_CONFIG="$READER_CFG" dg_as "$ID_CONTRIB" --json release download "$REPO" "$TAG" \
    --output "$OUT" >"$LOG-dl.json" 2>"$LOG-dl.err"; then
  check "bytes identical" cmp -s "$ASSET" "$OUT"
else
  cat "$LOG-dl.err" "$LOG-dl.json" >&2; bad "download failed"
fi

finish_scenario

#!/usr/bin/env bash
# storage-byo.sh — bring-your-own-storage end to end: a REAL `git push` / `git clone`
# over dash:// whose pack bytes go to LOCAL MinIO (SigV4-signed) + kubo, with only the
# packManifest + refUpdate written to testnet. Run via `make storage-e2e`.
#
# Proves:
#   1. push with dash.storage=minio,kubo dash.replicas=2 → the manifest records
#      storage=1 (external), chunkCount=0, the MinIO public URL, the s3:// locator and
#      the ipfs:// CID; the pack is really in the bucket and pinned in kubo.
#   2. a clone by a reader with NO S3 profile (only a gateway list) gets byte-identical
#      history from the public copies — no Platform chunk exists to fall back on.
#   3. with a dead second target and N=2 the push FAILS and the remote ref does NOT move.
#   4. with N=1 of the same two targets the push succeeds (one failure tolerated).
#
# Spend: ~3 manifests + ~4 ref updates on testnet (a few hundred thousand credits of the
# e2e DEPLOYER identity), no chunk documents. Requires infra/docker-compose.yml up.
SCENARIO_NAME="storage-byo (MinIO + kubo, real push/clone)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
harness_init

MINIO="http://127.0.0.1:9000"
KUBO_API="http://127.0.0.1:5001"
KUBO_GW="http://127.0.0.1:8081"
curl -fsS -o /dev/null "${MINIO}/minio/health/live" || skip_scenario "MinIO not up (make infra-up)"
curl -fsS -o /dev/null -X POST "${KUBO_API}/api/v0/version" || skip_scenario "kubo not up (make infra-up)"

BR="e2e/${RUN_ID}/byo"
SRC="${WORKROOT}/byo-src"
CLONE="${WORKROOT}/byo-clone"
LOG="${WORKROOT}/byo"
PUSHER_CFG="${WORKROOT}/storage-pusher.toml"
READER_CFG="${WORKROOT}/storage-reader.toml"

# The pusher's profiles: SigV4 MinIO bucket (secret via env reference) + kubo.
export FORGE_E2E_MINIO_SECRET="minioadmin"
cat >"$PUSHER_CFG" <<EOF
[profiles.minio]
kind = "s3"
endpoint = "${MINIO}"
region = "us-east-1"
bucket = "forge-byo"
path_style = true
public_url = "${MINIO}/forge-byo"
prefix = "e2e/${RUN_ID}"
access_key_id = "minioadmin"
secret_access_key = "env:FORGE_E2E_MINIO_SECRET"

[profiles.kubo]
kind = "ipfs-kubo"
api = "${KUBO_API}"
gateway = "${KUBO_GW}"

[profiles.dead]
kind = "s3"
endpoint = "http://127.0.0.1:9"
bucket = "nowhere"
public_url = "http://127.0.0.1:9/nowhere"
EOF
# The reader knows NO S3 credentials — only the local kubo gateway to race ipfs:// on.
cat >"$READER_CFG" <<EOF
[read]
ipfs_gateways = ["${KUBO_GW}"]
EOF

step "profiles: dg storage list / test (pusher)"
if DASH_FORGE_STORAGE_CONFIG="$PUSHER_CFG" "$DG" storage test minio >"$LOG-test-minio.out" 2>&1; then
  ok "dg storage test minio (signed put/get/delete, public read, CORS)"
else
  cat "$LOG-test-minio.out" >&2; bad "dg storage test minio"
fi
if DASH_FORGE_STORAGE_CONFIG="$PUSHER_CFG" "$DG" storage test kubo >"$LOG-test-kubo.out" 2>&1; then
  ok "dg storage test kubo (add, CID match, pin, gateway)"
else
  cat "$LOG-test-kubo.out" >&2; bad "dg storage test kubo"
fi

step "seed source repo (branch ${BR})"
SRC_TIP="$(seed_tiny_repo "$SRC" "$BR")"
git -C "$SRC" config dash.storage "minio,kubo"
git -C "$SRC" config dash.replicas 2

step "1. push with dash.storage=minio,kubo dash.replicas=2"
if ! DASH_FORGE_STORAGE_CONFIG="$PUSHER_CFG" git_dash_retry "$ID_DEPLOYER" "$LOG-push" \
      -C "$SRC" push -v "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
  cat "$LOG-push.err" >&2
  is_flake "$LOG-push.err" && skip_scenario "testnet transport flake"
  bad "push failed"; finish_scenario
fi
register_ref "refs/heads/${BR}"
ok "push accepted"
check "helper printed what goes where" assert_file_contains "$LOG-push.err" "→ minio, kubo (need 2 of 2)"
check "helper reported manifest+refs-only Platform cost" assert_file_contains "$LOG-push.err" "manifest + refs only"
check "helper reported 2 verified copies" assert_file_contains "$LOG-push.err" "(2 verified)"

step "manifest records the external copies"
DASH_FORGE_KEY="$ID_DEPLOYER" "$DG" --json storage status "${E2E_OWNER_ID}/${E2E_REPO_NAME}" \
  >"$LOG-status.json" 2>"$LOG-status.err" || { cat "$LOG-status.err" >&2; bad "storage status"; }
PACK_HASH="$(git -C "$SRC" cat-file -p "$SRC_TIP" >/dev/null && python3 - "$LOG-status.json" "$RUN_ID" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
run = sys.argv[2]
for p in d["packs"]:
    if p.get("kind") == 0 and any(f"/e2e/{run}/packs/" in m["uri"] for m in p["mirrors"]):
        print(p["packHash"]); break
PY
)"
if [[ -n "$PACK_HASH" ]]; then
  ok "found this push's manifest (pack ${PACK_HASH:0:12})"
  python3 - "$LOG-status.json" "$PACK_HASH" <<'PY' >"$LOG-manifest-check.out" 2>&1
import json, sys
d = json.load(open(sys.argv[1])); h = sys.argv[2]
p = next(p for p in d["packs"] if p["packHash"] == h)
uris = [m["uri"] for m in p["mirrors"]]
assert p["storageTier"] == "external", p
assert p["chunkCount"] == 0, p
assert not any(u.startswith("platform://") for u in uris), uris
assert any(u.startswith("s3://forge-byo/") for u in uris), uris
assert any("/forge-byo/" in u and u.startswith("http") and m["ok"] for m in p["mirrors"] for u in [m["uri"]]), uris
print("ok", uris)
PY
  check "storage=external, chunkCount=0, MinIO public URL live, s3:// locator recorded" \
    grep -q '^ok' "$LOG-manifest-check.out"
  cat "$LOG-manifest-check.out" >&2
  # The object is really in the bucket at the content-addressed key.
  check "pack object present in MinIO (anonymous public GET)" \
    curl -fsS -o "$LOG-pack.bin" "${MINIO}/forge-byo/e2e/${RUN_ID}/packs/${PACK_HASH}.pack"
  check "MinIO copy hashes to the manifest packHash" \
    bash -c "[[ \"\$(shasum -a 256 '$LOG-pack.bin' | cut -d' ' -f1)\" == '$PACK_HASH' ]]"
else
  cat "$LOG-status.json" >&2; bad "no manifest for this push found in storage status"
fi

step "2. clone as a reader with NO S3 profile (public URL + kubo gateway only)"
rm -rf "$CLONE"
if DASH_FORGE_STORAGE_CONFIG="$READER_CFG" git_dash_retry "$ID_DEPLOYER" "$LOG-clone" \
     clone "$E2E_REMOTE" "$CLONE"; then
  ok "clone completed"
  git -C "$CLONE" checkout -q "$BR" 2>/dev/null
  check "branch tip matches source" assert_eq "$SRC_TIP" "$(git -C "$CLONE" rev-parse "refs/heads/${BR}" 2>/dev/null)"
  check "worktrees byte-identical" diff -r --exclude=.git "$SRC" "$CLONE"
  check "git fsck --full --strict clean" git -C "$CLONE" fsck --full --strict
else
  cat "$LOG-clone.err" >&2
  is_flake "$LOG-clone.err" && skip_scenario "clone hit a transport flake"
  bad "clone failed"
fi

step "3. replication failure: dash.storage=minio,dead dash.replicas=2 → push fails, ref unchanged"
printf 'second commit %s\n' "$RUN_ID" >"$SRC/second.txt"
git -C "$SRC" add -A && git -C "$SRC" commit -q -m "second ${RUN_ID}"
NEW_TIP="$(git -C "$SRC" rev-parse HEAD)"
git -C "$SRC" config dash.storage "minio,dead"
if DASH_FORGE_STORAGE_CONFIG="$PUSHER_CFG" git_dash "$ID_DEPLOYER" "$LOG-push-fail" \
     -C "$SRC" push -v "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
  bad "push unexpectedly succeeded with an unreachable replica and N=2"
else
  ok "push refused"
  check "error names the policy" assert_file_contains "$LOG-push-fail.err" "storage policy not met: 1 of 2"
  check "error names the dead target" assert_file_contains "$LOG-push-fail.err" "dead:"
fi
DASH_FORGE_KEY="$ID_DEPLOYER" git ls-remote "$E2E_REMOTE" "refs/heads/${BR}" >"$LOG-lsremote.out" 2>"$LOG-lsremote.err"
check "remote ref still at the first tip" assert_eq "$SRC_TIP" "$(cut -f1 "$LOG-lsremote.out")"

step "4. N=1 of the same targets tolerates the dead one"
git -C "$SRC" config dash.replicas 1
if DASH_FORGE_STORAGE_CONFIG="$PUSHER_CFG" git_dash_retry "$ID_DEPLOYER" "$LOG-push-n1" \
     -C "$SRC" push -v "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
  ok "push accepted with 1 of 2"
  check "warned about the dead target" assert_file_contains "$LOG-push-n1.err" "dead did not confirm"
  DASH_FORGE_KEY="$ID_DEPLOYER" git ls-remote "$E2E_REMOTE" "refs/heads/${BR}" >"$LOG-lsremote2.out" 2>/dev/null
  check "remote ref advanced" assert_eq "$NEW_TIP" "$(cut -f1 "$LOG-lsremote2.out")"
else
  cat "$LOG-push-n1.err" >&2
  is_flake "$LOG-push-n1.err" && skip_scenario "testnet transport flake"
  bad "N=1 push failed"
fi

finish_scenario

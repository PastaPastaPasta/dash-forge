#!/usr/bin/env bash
# Scenario 26: a new user with no identity at all reads public repositories (L-12, L-22, L-35).
# Every read runs in an empty HOME / XDG_CONFIG_HOME, with the OS keychain off, no DASH_FORGE_*
# variables and stdin closed, so nothing can prompt:
#
#   1. `dg repo view`, `dg issue list` / `view`, `dg pr list` / `view` on the read fixture
#      (forge-v2-demo) succeed. They used to fail with E301 and a `DASH_FORGE_KEY=[redacted]>`
#      fix line. `dg issue view` shows issue #3's label and close events, as the web does.
#      Issues and PRs share one number sequence (dense numbering): the fixture's issues are
#      #1-#4, and its open/approved PR is `demo_pull_number approved` (lib.sh; #5 unless the
#      seeder's summary says otherwise).
#   2. A configured key that cannot be opened here (a passphrase-sealed file, no passphrase, no
#      terminal) does not stop a public read: it used to fail with E303.
#   3. A private repo read with no identity stops with a clear E301 saying it is private.
#   4. `dg release list` and `dg release download --output <dir>` on a public repo made for the
#      run: both assets land in the directory by name, hash-verified. The download used to
#      fail with "Is a directory" and fetch only the first asset. The publish prints "1 copy"
#      for one storage profile. A rerun keeps the files already there; another file under an
#      asset's name is refused with E201 and kept.
#
# Writes (under an identity minted for the run; E2E_S26_OWNER=<identity file> skips the mint):
# a public repo `e2e-anon-<run-id>` with one release of two small assets on the local RustFS,
# and a private repo `e2e-anon-p-<run-id>` (about 0.004 DASH together). Nothing is written to
# the fixtures. Step 4 is not run when RustFS is down (`make infra-up`).
SCENARIO_NAME="26 anonymous reads: repo/issue/pr view and list, release download to a directory"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

: "${MINT_DIR:=${E2E_REPO_ROOT}/tools/mint-identity}"
: "${E2E_V2_OWNER:=${IDID_OWNER}}"  # the read fixture is OWNER-owned (make e2e-fixture)
: "${E2E_V2_NAME:=forge-v2-demo}"
DEVNET="$DASH_FORGE_DEVNET_NAME"
DEMO="${E2E_V2_OWNER}/${E2E_V2_NAME}"
LOG="${WORKROOT}/s26"
S3="http://127.0.0.1:9000"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1" 2>/dev/null; }

# --- a machine with nothing configured ----------------------------------------
H="${WORKROOT}/s26-home"
rm -rf "$H"; mkdir -p "$H/home" "$H/xdg" "$H/state"
# `anon <out> <err> [VAR=value…] -- <dg args…>`: one dg read in the empty home, stdin closed.
anon_once() {
  local out="$1" err="$2" rc; shift 2
  local extra=()
  while [[ "$1" != -- ]]; do extra+=("$1"); shift; done
  shift
  ( export HOME="$H/home" XDG_CONFIG_HOME="$H/xdg" XDG_STATE_HOME="$H/state" \
      GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 NO_COLOR=1 RUST_LOG=error
    # shellcheck disable=SC2046
    unset $(compgen -v DASH_FORGE_)
    export DASH_FORGE_NO_KEYCHAIN=1
    [[ ${#extra[@]} -gt 0 ]] && export "${extra[@]}"
    _tmo "$DG" --network devnet --devnet-name "$DEVNET" "$@" </dev/null ) >"$out" 2>"$err"; rc=$?
  [[ $rc -ne 0 ]] && cat "$out" >>"$err" 2>/dev/null
  return $rc
}
anon() { local err="$2"; _retry "$err" anon_once "$@"; }
# No prompt was shown and no key was asked for.
unprompted() { ! grep -qiE 'passphrase|recovery words|\[y/N\]|\[Y/n\]' "$1"; }

# Dense numbering: issues #1-#4, PRs #5 (open, approved), #6 (merged), #7 (review-parity draft).
PR_APPROVED="$(demo_pull_number approved)"

step "1. repo, issues and PRs of ${E2E_V2_NAME} with no identity"
if anon "$LOG-repo.json" "$LOG-repo.err" -- --json repo view "$DEMO"; then
  check "repo view: ${E2E_V2_NAME}" assert_eq "$E2E_V2_NAME" "$(jq_py "$LOG-repo.json" 'd["name"]')"
  check "repo view: it has refs" test "$(jq_py "$LOG-repo.json" 'len(d["refs"])')" -ge 1
  check "repo view: no prompt" unprompted "$LOG-repo.err"
else
  cat "$LOG-repo.err" >&2; bad "anonymous dg repo view"
fi
if anon "$LOG-il.json" "$LOG-il.err" -- --json issue list "$DEMO" --state all; then
  check "issue list: the fixture's issues" test "$(jq_py "$LOG-il.json" 'd["total"]')" -ge 4
else
  cat "$LOG-il.err" >&2; bad "anonymous dg issue list"
fi
if anon "$LOG-iv.json" "$LOG-iv.err" -- --json issue view "$DEMO" 3; then
  KINDS="$(jq_py "$LOG-iv.json" '" ".join(e["kind"] for e in d["events"])')"
  check "issue view --json: #3's label event" assert_contains "$KINDS" "labelAdd"
  check "issue view --json: #3's close event" assert_contains "$KINDS" "close"
else
  cat "$LOG-iv.err" >&2; bad "anonymous dg issue view --json"
fi
if anon "$LOG-iv.txt" "$LOG-iv-h.err" -- issue view "$DEMO" 3; then
  check "issue view: shows the label event" assert_file_contains "$LOG-iv.txt" "added the docs label"
  check "issue view: shows the close event" assert_file_contains "$LOG-iv.txt" "closed this"
else
  cat "$LOG-iv-h.err" >&2; bad "anonymous dg issue view"
fi
if anon "$LOG-pl.json" "$LOG-pl.err" -- --json pr list "$DEMO" --state all; then
  check "pr list: the fixture's PRs" test "$(jq_py "$LOG-pl.json" 'd["count"]')" -ge 3
else
  cat "$LOG-pl.err" >&2; bad "anonymous dg pr list"
fi
if anon "$LOG-pv.json" "$LOG-pv.err" -- --json pr view "$DEMO" "$PR_APPROVED"; then
  check "pr view: #${PR_APPROVED}" assert_eq "$PR_APPROVED" "$(jq_py "$LOG-pv.json" 'd["number"]')"
else
  cat "$LOG-pv.err" >&2; bad "anonymous dg pr view"
fi

step "2. a sealed key with no passphrase and no terminal does not stop a public read"
SEALED="${H}/sealed.key"
python3 - "$SEALED" <<'PY'
import json, sys
# Never opened by a read; its contents do not matter.
json.dump({"dashForgeSealed": 1, "kdf": "argon2id", "m": 65536, "t": 3, "p": 1,
           "salt": "00" * 16, "cipher": "xchacha20poly1305", "nonce": "00" * 24,
           "ciphertext": "00" * 32}, open(sys.argv[1], "w"))
PY
if anon "$LOG-sealed.json" "$LOG-sealed.err" "DASH_FORGE_KEY=${SEALED}" -- --json issue list "$DEMO"; then
  ok "issue list with a sealed key configured"
  check "sealed: no passphrase asked" unprompted "$LOG-sealed.err"
else
  cat "$LOG-sealed.err" >&2
  check "sealed: not E303" assert_not_file_contains "$LOG-sealed.err" "E303"
  bad "a sealed key stopped a public read"
fi

# --- the run's repos (writes, under the run's identity) --------------------------
step "the run's identity and repos"
IDS="${WORKROOT}/s26-ids"
mkdir -p "$IDS" && chmod 700 "$IDS"
if [[ -n "${E2E_S26_OWNER:-}" ]]; then
  cp "$E2E_S26_OWNER" "$IDS/S26.identity.json"
else
  [[ -r "$E2E_MINT_FUNDING" ]] || skip_scenario "no ${DASH_FORGE_DEVNET_NAME} funding key ($E2E_MINT_FUNDING); set E2E_S26_OWNER"
  [[ -d "$MINT_DIR/node_modules/@dashevo/evo-sdk" ]] || skip_scenario "tools/mint-identity has no node_modules (npm ci there)"
  lock=() lf="$E2E_MINT_LOCK"
  if command -v lockf >/dev/null; then lock=(lockf -t 1200 "$lf")
  elif command -v flock >/dev/null; then lock=(flock -w 1200 "$lf"); fi
  "${lock[@]}" node "$MINT_DIR/mint.mjs" --network devnet --devnet-name "$DEVNET" --funding fund-from-key \
    --funding-key-file "$E2E_MINT_FUNDING" --out "$IDS" --label S26 --amount 0.05 >"$LOG-mint.log" 2>&1 \
    || { tail -5 "$LOG-mint.log" >&2; skip_scenario "minting failed (funding or network)"; }
fi
W="$IDS/S26.identity.json"
WID="$(_idid "$W")"
[[ -n "$WID" ]] || { bad "cannot read the identity id from $W"; finish_scenario; }
ok "writer ${WID:0:10}…"
NAME="$(printf 'e2e-anon-%s' "$RUN_ID" | tr 'A-Z' 'a-z')"; NAME="${NAME:0:60}"
PNAME="$(printf 'e2e-anon-p-%s' "$RUN_ID" | tr 'A-Z' 'a-z')"; PNAME="${PNAME:0:60}"

step "3. a private repo read with no identity is a clear E301"
if dg_as "$W" --yes --json repo create "$PNAME" --private --storage platform >"$LOG-pcreate.json" 2>"$LOG-pcreate.err"; then
  anon_once "$LOG-priv.json" "$LOG-priv.err" -- --json issue list "${WID}/${PNAME}"
  rc=$?
  if [[ $rc -ne 0 ]] && is_flake "$LOG-priv.err"; then
    anon "$LOG-priv.json" "$LOG-priv.err" -- --json issue list "${WID}/${PNAME}"; rc=$?
  fi
  check "refused (exit 3)" assert_eq "3" "$rc"
  check "E301" assert_eq "E301" "$(jq_py "$LOG-priv.json" 'd["error"]["code"]')"
  check "says the repo is private" assert_contains "$(jq_py "$LOG-priv.json" 'd["error"]["message"]')" "is private"
  check "its fix line names DASH_FORGE_KEY=<file> (not [redacted]>)" \
    assert_contains "$(jq_py "$LOG-priv.json" '" ".join(d["error"]["fix"])')" "DASH_FORGE_KEY=<file>"
else
  cat "$LOG-pcreate.err" "$LOG-pcreate.json" >&2
  is_flake "$LOG-pcreate.err" && skip_scenario "private repo create flaked"
  bad "private repo create failed"
fi

step "4. release list and download --output <dir> with no identity"
if ! curl -fsS -o /dev/null "${S3}/health/ready"; then
  info "the local S3 store (RustFS) is not up (make infra-up): release steps not run"
  finish_scenario
fi
if ! _retry "$LOG-create.err" _dg_read "$W" "$LOG-create.json" "$LOG-create.err" \
    --yes --json repo create "$NAME" --storage platform; then
  cat "$LOG-create.err" >&2
  is_flake "$LOG-create.err" && skip_scenario "repo create flaked"
  bad "repo create failed"; finish_scenario
fi
export FORGE_E2E_S3_SECRET="minioadmin"
CFG="${WORKROOT}/s26-storage.toml"
cat >"$CFG" <<EOF
[profiles.rustfs]
kind = "s3"
endpoint = "${S3}"
region = "us-east-1"
bucket = "forge-byo"
path_style = true
public_url = "${S3}/forge-byo"
prefix = "e2e/${RUN_ID}/anon"
access_key_id = "minioadmin"
secret_access_key = "env:FORGE_E2E_S3_SECRET"
allow_private_uri = true
EOF
# The reader holds no identity and no storage credentials: only a profile saying it trusts that
# RustFS host, as a user trusts their own storage (a loopback URL is never followed otherwise).
READER_CFG="${WORKROOT}/s26-reader.toml"
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
A1="${WORKROOT}/s26-tool-${RUN_ID}.tar.gz"; A2="${WORKROOT}/s26-notes-${RUN_ID}.txt"
head -c 12000 /dev/urandom | gzip -c >"$A1"
printf 'release notes %s\n' "$RUN_ID" >"$A2"
TAG="v0.0.1-${RUN_ID}"
if DASH_FORGE_STORAGE_CONFIG="$CFG" dg_as "$W" --yes release create "${WID}/${NAME}" --tag "$TAG" \
    --asset "$A1" --asset "$A2" --storage rustfs >"$LOG-rel.out" 2>"$LOG-rel.err"; then
  check "L-35: one profile is \"1 copy\", not \"2 cop(ies)\"" assert_file_contains "$LOG-rel.err" "→ 1 copy"
else
  cat "$LOG-rel.err" >&2
  is_flake "$LOG-rel.err" && skip_scenario "release create flaked"
  bad "release create failed"; finish_scenario
fi
listed() {
  anon "$LOG-rl.json" "$LOG-rl.err" -- --json release list "${WID}/${NAME}" \
    && [[ "$(jq_py "$LOG-rl.json" 'len(next(r for r in d["releases"] if r["tag"] == "'"$TAG"'")["assets"])')" == 2 ]]
}
li=1; for _ in $(seq 1 10); do listed && { li=0; break; }; sleep 3; done
check "release list: ${TAG} with 2 assets" test "$li" -eq 0
OUT="${WORKROOT}/s26-download"
rm -rf "$OUT"; mkdir -p "$OUT"
if anon "$LOG-dl.json" "$LOG-dl.err" "DASH_FORGE_STORAGE_CONFIG=${READER_CFG}" -- \
     --json release download "${WID}/${NAME}" "$TAG" --output "$OUT"; then
  check "downloaded 2 assets" assert_eq "2" "$(jq_py "$LOG-dl.json" 'd["count"]')"
  check "asset 1 in the directory, byte-identical" cmp -s "$A1" "$OUT/$(basename "$A1")"
  check "asset 2 in the directory, byte-identical" cmp -s "$A2" "$OUT/$(basename "$A2")"
  check "download: no prompt" unprompted "$LOG-dl.err"
else
  cat "$LOG-dl.err" >&2; bad "anonymous dg release download --output <dir>"
fi
# A rerun into the same directory resumes: files already holding an asset's bytes are kept.
if anon "$LOG-dl2.json" "$LOG-dl2.err" "DASH_FORGE_STORAGE_CONFIG=${READER_CFG}" -- \
     --json release download "${WID}/${NAME}" "$TAG" --output "$OUT"; then
  check "a rerun keeps both files (already there)" \
    assert_eq "True True" "$(jq_py "$LOG-dl2.json" '" ".join(str(a.get("alreadyThere")) for a in d["assets"])')"
else
  cat "$LOG-dl2.err" >&2; bad "a rerun of the download"
fi
# A different file under an asset's name is never overwritten: the names came from the
# release, and nothing is replaced without an explicit --output file.
printf 'mine\n' >"$OUT/$(basename "$A2")"
anon_once "$LOG-dl3.json" "$LOG-dl3.err" "DASH_FORGE_STORAGE_CONFIG=${READER_CFG}" -- \
  --json release download "${WID}/${NAME}" "$TAG" --output "$OUT"
check "another file of that name is refused (E201)" assert_eq "E201" "$(jq_py "$LOG-dl3.json" 'd["error"]["code"]')"
check "and kept" assert_eq "mine" "$(cat "$OUT/$(basename "$A2")")"
check "and its headline is not \"could not read releases\"" \
  assert_not_file_contains "$LOG-dl3.json" "could not read releases"

finish_scenario

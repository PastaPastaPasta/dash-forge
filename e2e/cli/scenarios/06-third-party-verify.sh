#!/usr/bin/env bash
# Scenario 6 (⭐): Third-party verification — "no trust in any server".
#
# A standalone verifier that does NOT use the helper's git-fetch happy path to
# decide what is true. It reads the repo's authoritative state from RAW Platform
# documents and then verifies every object hash locally with git's own
# content-addressing:
#
#   ref  : `git-remote-dash --dump-refs`  -> raw refUpdate docs; fold the
#          prevOid->newOid chain to derive the authoritative branch tip.
#   pack : `dg storage status --json`     -> raw packManifest docs; packHash,
#          size, chunkCount, platform:// URI.
#   objs : clone, then `git fsck --strict` (every object's SHA-1 == its bytes),
#          `git verify-pack` (pack SHA-1 trailer), explicit re-hash of the tip
#          commit + tree, and bind rev-parse(tip) == the RAW on-chain tip.
#
# Given only a 40-hex tip + a packHash read straight from Platform, the entire
# history is reconstructed and every hash re-derived locally — the transport is
# never trusted.
SCENARIO_NAME="06 third-party verification (⭐)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

OWNER="$E2E_OWNER_ID"; RNAME="$E2E_REPO_NAME"; REPO="${OWNER}/${RNAME}"
LOG="${WORKROOT}/s06"

step "select a target branch (reuse scenario 1's, else seed our own)"
RT="e2e/${RUN_ID}/roundtrip"
BR=""
git_dash "$ID_DEPLOYER" "$LOG-lsrt" ls-remote "$E2E_REMOTE" "refs/heads/${RT}" || true
if grep -q "refs/heads/${RT}" "$LOG-lsrt.out" 2>/dev/null; then
  BR="$RT"; info "reusing scenario 1 branch: ${BR}"
else
  BR="e2e/${RUN_ID}/verify"
  info "seeding own branch: ${BR}"
  SRC="${WORKROOT}/s06-src"; seed_tiny_repo "$SRC" "$BR" >/dev/null
  if ! git_dash_retry "$ID_DEPLOYER" "$LOG-push" -C "$SRC" push "$E2E_REMOTE" "refs/heads/${BR}:refs/heads/${BR}"; then
    cat "$LOG-push.err" >&2 || true
    is_flake "$LOG-push.err" && skip_scenario "could not seed a branch (transport flake)"
    grep -qiE 'insufficient|balance' "$LOG-push.err" && skip_scenario "DEPLOYER out of credits"
    bad "seed push failed"; finish_scenario
  fi
  register_ref "refs/heads/${BR}"
fi

step "RAW read #1: on-chain refUpdate documents (git-remote-dash --dump-refs)"
if ! DASH_FORGE_KEY="$ID_DEPLOYER" RUST_LOG=error _tmo "${BIN_DIR}/git-remote-dash" --dump-refs "$OWNER" "$RNAME" >"$LOG-dump.out" 2>"$LOG-dump.err"; then
  cat "$LOG-dump.err" >&2 || true
  is_flake "$LOG-dump.err" && skip_scenario "raw refUpdate read failed (transport flake)"
  bad "--dump-refs failed"; finish_scenario
fi
# Fold the refUpdate chain for BR: sort by createdAt, require each prev == prior new,
# emit the final tip. (A fresh branch is a single new-ref doc.)
RAW_TIP="$(python3 - "refs/heads/${BR}" "$LOG-dump.out" <<'PY'
import sys,re
want=sys.argv[1]
rows=[]
for ln in open(sys.argv[2]):
    m=re.search(r'ref="([^"]*)"\s+new=(\w*)\s+prev=(\w*)\s+force=(\w+)\s+createdAt=(\d+)',ln)
    if not m: continue
    ref,new,prev,force,ts=m.group(1),m.group(2),m.group(3),m.group(4),int(m.group(5))
    if ref==want: rows.append((ts,new,prev,force))
if not rows:
    print("NONE"); sys.exit(0)
rows.sort(key=lambda r:r[0])
zero="0"*40
tip=None
for ts,new,prev,force in rows:
    p=prev if (prev and set(prev)!={"0"}) else ""
    if tip is None:
        # first update: either a new ref (empty/zero prev) or forced
        pass
    else:
        if force!="true" and p and p!=tip:
            print("CHAINBREAK"); sys.exit(0)
    tip=new
print(tip if tip else "NONE")
PY
)"
info "raw on-chain tip for ${BR}: ${RAW_TIP}"
check "ref chain folds to a valid tip (no chain break)" \
  bash -c "[[ '$RAW_TIP' != NONE && '$RAW_TIP' != CHAINBREAK ]]"
check "raw tip is a 40-hex oid" bash -c "[[ '$RAW_TIP' =~ ^[0-9a-f]{40}$ ]]"

step "RAW read #2: on-chain packManifest documents (dg storage status --json)"
if ! dg_as "$ID_DEPLOYER" --json storage status "$REPO" >"$LOG-store.json" 2>"$LOG-store.err"; then
  cat "$LOG-store.err" >&2 || true
  is_flake "$LOG-store.err" && skip_scenario "raw manifest read failed (transport flake)"
  bad "storage status failed"; finish_scenario
fi
PACK_SUMMARY="$(python3 - "$LOG-store.json" <<'PY'
import json,sys,re
try: d=json.load(open(sys.argv[1]))
except Exception: print("ERR"); sys.exit(0)
packs=d.get("packs",[])
n=len(packs); good=0; plat=0
for p in packs:
    h=p.get("packHash","")
    if re.fullmatch(r"[0-9a-f]{64}",h or ""): good+=1
    for m in p.get("mirrors",[]):
        if m.get("scheme")=="platform": plat+=1
print(f"{n} {good} {plat}")
# also dump first packHash for the report
if packs: print(packs[0].get("packHash",""))
PY
)"
NPACKS="$(echo "$PACK_SUMMARY" | awk 'NR==1{print $1}')"
NGOOD="$(echo "$PACK_SUMMARY" | awk 'NR==1{print $2}')"
NPLAT="$(echo "$PACK_SUMMARY" | awk 'NR==1{print $3}')"
FIRST_HASH="$(echo "$PACK_SUMMARY" | awk 'NR==2{print $1}')"
info "packs=${NPACKS} valid-sha256-hashes=${NGOOD} platform-uris=${NPLAT} first=${FIRST_HASH:0:16}…"
check "at least one packManifest on-chain" bash -c "[[ '${NPACKS:-0}' -ge 1 ]]"
check "every advertised packHash is a valid 64-hex sha256" bash -c "[[ '${NPACKS:-0}' -ge 1 && '${NGOOD:-0}' -eq '${NPACKS:-0}' ]]"
check "at least one pack is served from platform:// (on-chain chunks)" bash -c "[[ '${NPLAT:-0}' -ge 1 ]]"

step "reconstruct + verify EVERY object hash locally (content-addressing)"
CLONE="${WORKROOT}/s06-clone"; rm -rf "$CLONE"
if ! git_dash_retry "$ID_DEPLOYER" "$LOG-clone" clone "$E2E_REMOTE" "$CLONE"; then
  cat "$LOG-clone.err" >&2 || true
  is_flake "$LOG-clone.err" && skip_scenario "verification clone failed (transport flake)"
  bad "clone failed"; finish_scenario
fi
git -C "$CLONE" checkout -q "$BR" 2>/dev/null || true

# (a) fsck: recomputes and checks the SHA-1 of every object against its bytes.
if git -C "$CLONE" fsck --full --strict >"$LOG-fsck.out" 2>&1; then
  ok "git fsck --strict: every object hash re-derived and verified"
else
  cat "$LOG-fsck.out" >&2; bad "fsck found a hash/connectivity problem"
fi

# (b) verify-pack: the received packfile's own SHA-1 integrity trailer.
PACKF="$(ls "$CLONE"/.git/objects/pack/*.pack 2>/dev/null | head -1)"
if [[ -n "$PACKF" ]] && git -C "$CLONE" verify-pack -v "$PACKF" >"$LOG-vpack.out" 2>&1; then
  ok "git verify-pack: pack SHA-1 integrity verified ($(basename "$PACKF"))"
else
  cat "$LOG-vpack.out" 2>/dev/null >&2 || true; bad "verify-pack failed / no pack present"
fi

# (c) BIND raw-on-chain tip to the locally hash-verified graph.
CLONE_TIP="$(git -C "$CLONE" rev-parse "refs/heads/${BR}" 2>/dev/null || echo none)"
check "clone tip == RAW on-chain tip (server told the truth)" assert_eq "$RAW_TIP" "$CLONE_TIP" "tip binding"

# (d) explicit re-hash of the tip commit and its tree (demonstrate "every hash").
REHASH_C="$(git -C "$CLONE" cat-file commit "$RAW_TIP" 2>/dev/null | git -C "$CLONE" hash-object -t commit --stdin 2>/dev/null || echo x)"
check "re-hash(commit bytes) == tip oid" assert_eq "$RAW_TIP" "$REHASH_C" "commit re-hash"
TREE="$(git -C "$CLONE" rev-parse "${RAW_TIP}^{tree}" 2>/dev/null || echo x)"
REHASH_T="$(git -C "$CLONE" cat-file tree "$TREE" 2>/dev/null | git -C "$CLONE" hash-object -t tree --stdin 2>/dev/null || echo y)"
check "re-hash(tree bytes) == tree oid" assert_eq "$TREE" "$REHASH_T" "tree re-hash"

# (e) whole reachable object set is present (nothing withheld).
MISS="$(git -C "$CLONE" rev-list --objects --missing=print "$RAW_TIP" 2>/dev/null | grep -c '^?' || true)"
NOBJ="$(git -C "$CLONE" rev-list --objects "$RAW_TIP" 2>/dev/null | wc -l | tr -d ' ')"
info "reachable objects=${NOBJ} missing=${MISS:-0}"
check "no object reachable from the raw tip is missing" assert_eq "0" "${MISS:-0}" "missing objects"

finish_scenario

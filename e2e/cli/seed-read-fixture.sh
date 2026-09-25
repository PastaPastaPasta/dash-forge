#!/usr/bin/env bash
# seed-read-fixture.sh — make the nightly's browser read fixture exist and hold exactly
# the expected content. Idempotent: a run that finds `main` already at the fixture commit
# writes nothing.
#
# The fixture (NIGHTLY_FIXTURE_REPO, config.sh; reserved in e2e/README.md) is what
# forge-web's Playwright specs read. It is written only here, so no other suite's refs,
# packs or storage choices can reach what the browser sees:
#   * `main` = one deterministic commit (fixed author, committer and dates) holding a
#     README, a `src/` and a `lib/` directory — the entries the tree-browse spec looks for;
#   * its pack is stored on Platform (chunk documents), never external storage;
#   * no browse index is published (DASH_FORGE_NO_BROWSE_INDEX), so the web app takes the
#     in-browser fallback clone, which fallback-browse.spec.ts exercises.
#
# The repo is created (repo-v1, ~1.18 tDASH, once) only if absent. Exit 0 = seeded or
# already seeded; 1 = could not seed.
SCENARIO_NAME="seed the nightly read fixture (${NIGHTLY_FIXTURE_REPO:-m1-5124})"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
harness_init

FIX_REPO="${E2E_OWNER_ID}/${NIGHTLY_FIXTURE_REPO}"
FIX_REMOTE="dash://${FIX_REPO}"
SRC="${WORKROOT}/fixture-src"
LOG="${WORKROOT}/fixture"

step "fixture repo ${FIX_REPO}"
if dg_read_retry "$ID_DEPLOYER" "$LOG-view.json" "$LOG-view.err" --json repo view "$FIX_REPO"; then
  info "reusing ${FIX_REPO}"
elif grep -qiE 'not found|no such|does not exist|unknown repo' "$LOG-view.err"; then
  info "creating ${FIX_REPO} (one-time, ~1.18 tDASH)"
  dg_as "$ID_DEPLOYER" --yes --json repo create "$NIGHTLY_FIXTURE_REPO" \
    --description "Dash Forge nightly read fixture (reserved; see e2e/README.md)" \
    >"$LOG-create.out" 2>"$LOG-create.err" || {
    cat "$LOG-create.err" >&2; bad "could not create ${FIX_REPO}"; finish_scenario
  }
else
  cat "$LOG-view.err" >&2; bad "could not read ${FIX_REPO}"; finish_scenario
fi

step "build the deterministic fixture commit"
rm -rf "$SRC"; mkdir -p "$SRC/src" "$SRC/lib"
git init -q -b main "$SRC"
cat >"$SRC/README.md" <<'EOF'
# Dash Forge nightly read fixture

This repository is the fixture the Dash Forge web app's browser tests read. It is written
only by `e2e/cli/seed-read-fixture.sh`; do not push to it.
EOF
printf 'fn main() {\n    println!("hello from the nightly fixture");\n}\n' >"$SRC/src/main.rs"
printf 'pub fn answer() -> u32 {\n    42\n}\n' >"$SRC/lib/answer.rs"
export GIT_AUTHOR_NAME="Dash Forge Fixture" GIT_AUTHOR_EMAIL="fixture@dash-forge.test"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE="2026-09-25T00:00:00Z" GIT_COMMITTER_DATE="2026-09-25T00:00:00Z"
git -C "$SRC" -c commit.gpgsign=false add -A
git -C "$SRC" -c commit.gpgsign=false commit -q -m "nightly read fixture"
WANT="$(git -C "$SRC" rev-parse HEAD)"
info "fixture commit ${WANT}"

remote_main() { # prints the remote main oid, or nothing
  git_dash_retry "$ID_DEPLOYER" "$1" ls-remote "$FIX_REMOTE" refs/heads/main || return 1
  awk '$2 == "refs/heads/main" { print $1 }' "$1.out"
}

# The stored packs, as `dg storage status` sees them: prints "ok" when every manifest is a
# kind-0 git pack stored on Platform (no external copy, no browse index), else what is wrong.
packs_ok() { # packs_ok <log-prefix>
  dg_read_retry "$ID_DEPLOYER" "$1.json" "$1.err" --json storage status "$FIX_REPO" || return 1
  python3 - "$1.json" <<'PY'
import json, sys
packs = json.load(open(sys.argv[1])).get("packs", [])
bad = [f"{p.get('packHash','?')[:12]} kind={p.get('kind')} tier={p.get('storageTier')}"
       for p in packs if p.get("kind") != 0 or p.get("storageTier") != "platform"]
print("ok" if packs and not bad else ("no packs" if not packs else "; ".join(bad)))
PY
}

step "is ${FIX_REMOTE} main already at the fixture commit, on Platform, unindexed?"
if ! HAVE="$(remote_main "$LOG-ls1")"; then
  cat "$LOG-ls1.err" >&2; bad "could not list the fixture's refs"; finish_scenario
fi
if [[ "$HAVE" == "$WANT" ]]; then
  if ! PACKS="$(packs_ok "$LOG-packs1")"; then
    cat "$LOG-packs1.err" >&2; bad "could not read the fixture's pack manifests"; finish_scenario
  fi
  if [[ "$PACKS" == "ok" ]]; then
    ok "already seeded (main = ${WANT}, Platform-stored, no browse index); nothing written"
  else
    # A re-push cannot fix this: the right pack is already recorded and the helper will not
    # store it again. The repo needs its storage torn down (dg repo delete) and reseeding.
    bad "main is at the fixture commit but its storage is wrong (${PACKS}); tear the fixture's storage down and reseed"
  fi
  finish_scenario
fi
info "main is ${HAVE:-absent}; force-pushing the fixture commit"

step "push the fixture (Platform storage only, no browse index)"
# `-c` is git's command scope, which the helper ranks above any global or repo setting, so
# a developer's `dash.storage=minio` (or a per-remote override) cannot redirect this pack.
if ! DASH_FORGE_NO_BROWSE_INDEX=1 git_dash_retry "$ID_DEPLOYER" "$LOG-push" \
      -C "$SRC" -c dash.storage=platform -c dash.platformFallback=false \
      -c "remote.origin.dashStorage=platform" \
      push "$FIX_REMOTE" "+refs/heads/main:refs/heads/main"; then
  cat "$LOG-push.err" >&2; bad "fixture push failed"; finish_scenario
fi
if HAVE="$(remote_main "$LOG-ls2")" && [[ "$HAVE" == "$WANT" ]]; then
  ok "seeded: main = ${WANT}"
else
  bad "after the push, main is ${HAVE:-unreadable}, not ${WANT}"
fi
if PACKS="$(packs_ok "$LOG-packs2")" && [[ "$PACKS" == "ok" ]]; then
  ok "fixture packs are Platform-stored with no browse index"
else
  bad "fixture storage after the push: ${PACKS:-unreadable}"
fi
finish_scenario

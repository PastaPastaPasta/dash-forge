#!/usr/bin/env bash
# Scenario 19: sealed issues, pull requests, comments, reviews and labels in a private repository
# (docs/security/private-repos.md §4, §7, §8).
#
# Runs under two identities minted for this run (P_OWNER, P_MEMBER; no shared-identity nonce
# races), plus the shared CONTRIB as a reader who never joins.
#
#   1. P_OWNER `dg repo create --private`, pushes main and a feature branch, adds P_MEMBER
#   2. P_OWNER opens an issue and a PR (feature → main); with dense numbering (issues and PRs
#      share one number sequence per repo) the PR is not #1 — both scripts read their numbers
#      back from `dg ... create`'s own JSON rather than assuming any. P_MEMBER comments on the
#      issue, labels it, and approves the PR with a body
#   3. the stored documents carry no plaintext title, body, branch name, path or label name:
#      every one has `epoch` + `enc`, and the PR's base hash is not sha256("refs/heads/main")
#   4. P_MEMBER reads the issue (title, body, comment, label) and the PR (title, base, approval);
#      CONTRIB (never a member) is refused (E307) and lists nothing readable
#   5. sealed edits: P_OWNER edits the issue title and PR description, P_MEMBER edits their
#      comment; the stored documents stay sealed (no plaintext), the PR keeps its base hash
#      and epoch, the member reads the new text; a non-author's edit of an issue or a comment
#      is refused before signing, and so is P_MEMBER naming their private comment through a
#      public repo of theirs (which would otherwise write it in plaintext)
#   6. P_OWNER merges the PR (1 approval counted from the sealed review)
#
# Needs the devnet's funding key (E2E_MINT_FUNDING, config.sh; default the QA harness's) and
# tools/mint-identity's node modules; skips without them.
SCENARIO_NAME="19 private repository: sealed issues, PRs, comments, reviews and labels"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init

: "${MINT_DIR:=${E2E_REPO_ROOT}/tools/mint-identity}"
[[ -n "${E2E_P_OWNER:-}" || -r "$E2E_MINT_FUNDING" ]] || skip_scenario "no ${DASH_FORGE_DEVNET_NAME} funding key ($E2E_MINT_FUNDING)"
[[ -n "${E2E_P_OWNER:-}" || -d "$MINT_DIR/node_modules/@dashevo/evo-sdk" ]] || skip_scenario "tools/mint-identity has no node_modules (npm ci there)"

LOG="${WORKROOT}/s19"
IDS="${WORKROOT}/s19-ids"
mkdir -p "$IDS" && chmod 700 "$IDS"
json_field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {"d": d}))' "$1" "$2" 2>/dev/null; }

mint() { # mint <label>: a funded devnet identity with an ENCRYPTION key, for this run only
  # One mint at a time across every agent sharing the funding key (its UTXOs), as `qa mint` does.
  local lock=() lf="$E2E_MINT_LOCK"
  if command -v lockf >/dev/null; then lock=(lockf -t 1200 "$lf")      # macOS
  elif command -v flock >/dev/null; then lock=(flock -w 1200 "$lf"); fi  # Linux
  "${lock[@]}" node "$MINT_DIR/mint.mjs" --network devnet --devnet-name "$DASH_FORGE_DEVNET_NAME" --funding fund-from-key \
    --funding-key-file "$E2E_MINT_FUNDING" --out "$IDS" --label "$1" --amount 0.2 >"$LOG-mint-$1.log" 2>&1
}

step "this run's identities"
if [[ -n "${E2E_P_OWNER:-}" && -n "${E2E_P_MEMBER:-}" ]]; then
  # dedicated identities given by the caller (not the shared pool), e.g. when minting is down
  cp "$E2E_P_OWNER" "$IDS/P_OWNER.identity.json" && cp "$E2E_P_MEMBER" "$IDS/P_MEMBER.identity.json"
  P_OWNER="$IDS/P_OWNER.identity.json"; P_MEMBER="$IDS/P_MEMBER.identity.json"
  ID_P_OWNER="$(_idid "$P_OWNER")"; ID_P_MEMBER="$(_idid "$P_MEMBER")"
  ok "using dedicated P_OWNER ${ID_P_OWNER:0:10}… and P_MEMBER ${ID_P_MEMBER:0:10}…"
elif mint P_OWNER && mint P_MEMBER; then
  P_OWNER="$IDS/P_OWNER.identity.json"; P_MEMBER="$IDS/P_MEMBER.identity.json"
  ID_P_OWNER="$(_idid "$P_OWNER")"; ID_P_MEMBER="$(_idid "$P_MEMBER")"
  ok "minted P_OWNER ${ID_P_OWNER:0:10}… and P_MEMBER ${ID_P_MEMBER:0:10}…"
else
  tail -5 "$LOG"-mint-*.log >&2
  skip_scenario "minting failed (funding or network)"
fi

NAME="e2e-sealed-${RUN_ID}"
NAME="${NAME:0:63}"
REPO="${ID_P_OWNER}/${NAME}"
REMOTE="dash://${REPO}"
SRC="${WORKROOT}/s19-src"

step "P_OWNER creates a private repo, pushes main and feature, adds P_MEMBER"
if ! _retry "$LOG-create.err" _dg_read "$P_OWNER" "$LOG-create.json" "$LOG-create.err" \
    --yes --json repo create "$NAME" --no-protect --private --storage platform; then
  cat "$LOG-create.err" >&2
  is_flake "$LOG-create.err" && skip_scenario "create failed on a transport flake"
  bad "private create failed"; finish_scenario
fi
seed_tiny_repo "$SRC" main >/dev/null
git -C "$SRC" checkout -q -b feature
printf 'feature %s\n' "$RUN_ID" >"$SRC/feature.txt"
git -C "$SRC" add -A && git -C "$SRC" commit -q -m "feature ${RUN_ID}"
FEATURE="$(git -C "$SRC" rev-parse HEAD)"
if git_dash_retry "$P_OWNER" "$LOG-push" -C "$SRC" push "$REMOTE" "refs/heads/main:refs/heads/main" "refs/heads/feature:refs/heads/feature" \
   && collab_accept "$P_MEMBER" "$REPO" "$LOG-add" \
   && dg_as "$P_OWNER" -y --json collab add "$REPO" "$ID_P_MEMBER" >"$LOG-add.json" 2>"$LOG-add.err"; then
  ok "created, pushed main and feature @ ${FEATURE:0:12}, added P_MEMBER"
else
  cat "$LOG-push.err" "$LOG-add.err" >&2; bad "setup failed"; finish_scenario
fi

ISSUE_TITLE="sealed issue ${RUN_ID}"
PR_TITLE="sealed pr ${RUN_ID}"
LABEL="secret-label-${RUN_ID}"
LABEL="${LABEL:0:120}"
step "P_OWNER opens an issue and a PR; P_MEMBER comments, labels and approves"
if dg_as "$P_OWNER" -y --json issue create "$REPO" --title "$ISSUE_TITLE" --body "secret body ${RUN_ID}" >"$LOG-issue.json" 2>"$LOG-issue.err" \
   && dg_as "$P_OWNER" -y --json pr create "$REPO" --head feature --base main --title "$PR_TITLE" --body "pr body ${RUN_ID}" >"$LOG-pr.json" 2>"$LOG-pr.err"; then
  ISSUE="$(json_field "$LOG-issue.json" 'd["number"]')"; PR="$(json_field "$LOG-pr.json" 'd["number"]')"
  ok "opened issue #$ISSUE and PR #$PR"
else
  cat "$LOG-issue.err" "$LOG-issue.json" "$LOG-pr.err" "$LOG-pr.json" >&2; bad "opening failed"; finish_scenario
fi
if dg_as "$P_MEMBER" -y --json issue comment "$REPO" "$ISSUE" --body "member comment ${RUN_ID}" >"$LOG-com.json" 2>"$LOG-com.err" \
   && dg_as "$P_MEMBER" -y --json issue label "$REPO" "$ISSUE" --add "$LABEL" >"$LOG-lab.json" 2>"$LOG-lab.err" \
   && dg_as "$P_MEMBER" -y --json pr review "$REPO" "$PR" --approve --body "looks right ${RUN_ID}" >"$LOG-rev.json" 2>"$LOG-rev.err"; then
  ok "P_MEMBER commented, labelled and approved"
else
  cat "$LOG-com.err" "$LOG-com.json" "$LOG-lab.err" "$LOG-lab.json" "$LOG-rev.err" "$LOG-rev.json" >&2; bad "member writes failed"; finish_scenario
fi

step "the chain holds no plaintext: every document is sealed"
if DASH_FORGE_KEY="$P_OWNER" RUST_LOG=error NO_COLOR=1 _tmo "${BIN_DIR}/git-remote-dash" --dump-collab "$ID_P_OWNER" "$NAME" >"$LOG-dump.txt" 2>"$LOG-dump.err"; then
  rows="$(grep -c "^  type=" "$LOG-dump.txt")"
  if [[ "$rows" -ge 5 ]] && grep -q '^  type=event ' "$LOG-dump.txt" && ! grep -q "$RUN_ID" "$LOG-dump.txt" \
     && ! grep -q 'plaintext=\[[^]]' "$LOG-dump.txt" && ! grep -q 'epoch=- \| enc=0 ' "$LOG-dump.txt"; then
    ok "$rows documents (the label event too), each with epoch + enc and no plaintext text"
  else
    cat "$LOG-dump.txt" >&2; bad "plaintext or unsealed collaboration documents on chain"
  fi
  SHA_MAIN="$(printf 'refs/heads/main' | shasum -a 256 | cut -d' ' -f1)"
  BASE_HASH="$(grep '^  type=patch ' "$LOG-dump.txt" | grep -oE 'baseRefNameHash=[0-9a-f]{64}' | head -1 | cut -d= -f2)"
  if [[ -z "$BASE_HASH" ]]; then
    bad "the PR carries no baseRefNameHash"
  elif [[ "$BASE_HASH" == "$SHA_MAIN" ]]; then
    bad "the PR's base hash is sha256(refName)"
  else
    ok "the PR's base hash is keyed, not sha256"
  fi
else
  cat "$LOG-dump.err" >&2; bad "dump failed"
fi

step "P_MEMBER reads everything; CONTRIB reads nothing"
if dg_read_retry "$P_MEMBER" "$LOG-iv.json" "$LOG-iv.err" --json issue view "$REPO" "$ISSUE" \
   && dg_read_retry "$P_MEMBER" "$LOG-pv.json" "$LOG-pv.err" --json pr view "$REPO" "$PR"; then
  [[ "$(json_field "$LOG-iv.json" 'd["title"]')" == "$ISSUE_TITLE" && "$(json_field "$LOG-iv.json" 'd["comments"][0]["body"]')" == "member comment ${RUN_ID}" ]] \
    && ok "issue #$ISSUE: title and comment decrypt" || { cat "$LOG-iv.json" >&2; bad "issue view"; }
  [[ "$(json_field "$LOG-iv.json" 'd["labels"]')" == "['$LABEL']" ]] \
    && ok "issue #$ISSUE: the sealed label opens" || { cat "$LOG-iv.json" >&2; bad "issue label"; }
  # the list folds every issue from the repo's event feed: the sealed label filters it too
  if dg_read_retry "$P_MEMBER" "$LOG-il.json" "$LOG-il.err" --json issue list "$REPO" --label "$LABEL" --state all \
     && [[ "$(json_field "$LOG-il.json" '[i["number"] for i in d["issues"]]')" == "[$ISSUE]" ]]; then
    ok "dg issue list --label finds issue #$ISSUE by its sealed label"
  else
    cat "$LOG-il.json" "$LOG-il.err" >&2; bad "issue list --label"
  fi
  [[ "$(json_field "$LOG-pv.json" 'd["title"]')" == "$PR_TITLE" && "$(json_field "$LOG-pv.json" 'd["baseRef"]')" == refs/heads/main \
     && "$(json_field "$LOG-pv.json" 'len(d["approvedBy"])')" == 1 ]] \
    && ok "PR #$PR: title, base branch and the sealed approval" || { cat "$LOG-pv.json" >&2; bad "pr view"; }
else
  cat "$LOG-iv.err" "$LOG-pv.err" >&2; bad "member reads failed"
fi
if dg_as "$ID_CONTRIB" --json issue list "$REPO" >"$LOG-cl.json" 2>"$LOG-cl.err"; then
  cat "$LOG-cl.json" >&2; bad "a non-member listed a private repo's issues"
elif grep -qE 'E307|E306' "$LOG-cl.json" "$LOG-cl.err"; then
  ok "non-member refused ($(grep -ohE 'E30[67]' "$LOG-cl.json" "$LOG-cl.err" | head -1))"
else
  cat "$LOG-cl.json" "$LOG-cl.err" >&2
  is_flake "$LOG-cl.err" && skip_scenario "non-member list failed on a flake"
  bad "non-member list failed without E306/E307"
fi

step "sealed edits: the text is re-sealed, never written in plaintext"
NEW_TITLE="sealed issue edited ${RUN_ID}"
COMMENT_ID="$(json_field "$LOG-iv.json" 'd["comments"][0]["id"]')"
# the PR's stored base hash and epoch, to compare after the edit (§4.5: a PR keeps its epoch)
pr_seal() { grep '^  type=patch ' "$1" | grep -oE 'epoch=[0-9]+|baseRefNameHash=[0-9a-f]{64}' | tr '\n' ' '; }
PR_SEAL_BEFORE="$(pr_seal "$LOG-dump.txt")"
if dg_as "$P_OWNER" -y --json issue edit "$REPO" "$ISSUE" --title "$NEW_TITLE" >"$LOG-ie.json" 2>"$LOG-ie.err" \
   && dg_as "$P_OWNER" -y --json pr edit "$REPO" "$PR" --body "pr body edited ${RUN_ID}" >"$LOG-pe.json" 2>"$LOG-pe.err" \
   && dg_as "$P_MEMBER" -y --json issue edit-comment "$REPO" "$COMMENT_ID" --body "member comment edited ${RUN_ID}" >"$LOG-ce.json" 2>"$LOG-ce.err" \
   && [[ "$(json_field "$LOG-ie.json" 'd["status"]')" == edited && "$(json_field "$LOG-pe.json" 'd["status"]')" == edited \
         && "$(json_field "$LOG-ce.json" 'd["status"]')" == edited ]]; then
  ok "edited the issue title, the PR description and a comment"
else
  cat "$LOG-ie.err" "$LOG-ie.json" "$LOG-pe.err" "$LOG-pe.json" "$LOG-ce.err" "$LOG-ce.json" >&2; bad "sealed edits failed"
fi
if DASH_FORGE_KEY="$P_OWNER" RUST_LOG=error NO_COLOR=1 _tmo "${BIN_DIR}/git-remote-dash" --dump-collab "$ID_P_OWNER" "$NAME" >"$LOG-dump2.txt" 2>"$LOG-dump2.err" \
   && ! grep -q "$RUN_ID" "$LOG-dump2.txt" && ! grep -q 'plaintext=\[[^]]' "$LOG-dump2.txt" && ! grep -q 'epoch=- \| enc=0 ' "$LOG-dump2.txt"; then
  ok "after the edits every document is still sealed, with no plaintext"
  if [[ -n "$PR_SEAL_BEFORE" && "$(pr_seal "$LOG-dump2.txt")" == "$PR_SEAL_BEFORE" ]]; then
    ok "the PR kept its epoch and base hash across the edit ($PR_SEAL_BEFORE)"
  else
    echo "before: $PR_SEAL_BEFORE / after: $(pr_seal "$LOG-dump2.txt")" >&2; bad "the PR edit moved its epoch or base hash"
  fi
else
  cat "$LOG-dump2.txt" "$LOG-dump2.err" >&2; bad "an edit left plaintext on chain"
fi
if dg_read_retry "$P_MEMBER" "$LOG-iv2.json" "$LOG-iv2.err" --json issue view "$REPO" "$ISSUE" \
   && dg_read_retry "$P_MEMBER" "$LOG-pv2.json" "$LOG-pv2.err" --json pr view "$REPO" "$PR" \
   && [[ "$(json_field "$LOG-iv2.json" 'd["title"]')" == "$NEW_TITLE" \
      && "$(json_field "$LOG-iv2.json" 'd["body"]')" == "secret body ${RUN_ID}" \
      && "$(json_field "$LOG-iv2.json" 'd["comments"][0]["body"]')" == "member comment edited ${RUN_ID}" \
      && "$(json_field "$LOG-iv2.json" 'd["labels"]')" == "['$LABEL']" \
      && "$(json_field "$LOG-pv2.json" 'd["body"]')" == "pr body edited ${RUN_ID}" \
      && "$(json_field "$LOG-pv2.json" 'd["baseRef"]')" == refs/heads/main ]]; then
  ok "the member reads the edits (the untouched body, the label and the PR's base branch intact)"
else
  cat "$LOG-iv2.json" "$LOG-pv2.json" "$LOG-iv2.err" "$LOG-pv2.err" >&2; bad "edited text not read back"
fi
if dg_as "$P_MEMBER" -y --json issue edit "$REPO" "$ISSUE" --title "hijack ${RUN_ID}" >"$LOG-he.json" 2>"$LOG-he.err"; then
  bad "a non-author edited the issue"
elif grep -q '"code"' "$LOG-he.json" "$LOG-he.err" && grep -qi 'author' "$LOG-he.json" "$LOG-he.err"; then
  ok "a non-author's edit is refused before signing"
else
  cat "$LOG-he.json" "$LOG-he.err" >&2; bad "non-author edit failed without the author refusal"
fi
if dg_as "$P_OWNER" -y --json issue edit-comment "$REPO" "$COMMENT_ID" --body "hijack ${RUN_ID}" >"$LOG-hc.json" 2>"$LOG-hc.err"; then
  bad "a non-author edited a comment"
elif grep -q '"E601"' "$LOG-hc.json" "$LOG-hc.err"; then
  ok "a non-author's comment edit is refused before signing (E601)"
else
  cat "$LOG-hc.json" "$LOG-hc.err" >&2; bad "non-author comment edit failed without E601"
fi
# the document's own repo decides sealing: naming a private comment through a public repo must
# not take the plaintext path
PUB="e2e-pub-${RUN_ID}"
PUB="${PUB:0:63}"
if ! _retry "$LOG-pub.err" _dg_read "$P_MEMBER" "$LOG-pub.json" "$LOG-pub.err" --yes --json repo create "$PUB" --no-protect --storage platform; then
  cat "$LOG-pub.err" >&2; bad "could not create the public repo for the cross-repo check"
elif dg_as "$P_MEMBER" -y --json issue edit-comment "${ID_P_MEMBER}/${PUB}" "$COMMENT_ID" --body "leak ${RUN_ID}" >"$LOG-xr.json" 2>"$LOG-xr.err"; then
  bad "a private comment was edited through a public repo"
elif grep -q "is not in" "$LOG-xr.json" "$LOG-xr.err"; then
  ok "a private comment named through a public repo is refused (nothing written in plaintext)"
else
  cat "$LOG-xr.json" "$LOG-xr.err" >&2; bad "cross-repo edit failed without the repo refusal"
fi

step "P_OWNER merges the PR"
if dg_as "$P_OWNER" -y --json pr merge "$REPO" "$PR" >"$LOG-merge.json" 2>"$LOG-merge.err" \
   && [[ "$(json_field "$LOG-merge.json" 'd["merged"]')" == True ]]; then
  ok "PR #$PR merged"
else
  cat "$LOG-merge.err" "$LOG-merge.json" >&2; bad "merge failed"
fi

finish_scenario

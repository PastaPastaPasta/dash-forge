#!/usr/bin/env bash
# Scenario 39: environments (dg env; mixed-visibility design §4.5).
#
# OWNER (a maintainer of the suite repo) imports a .env file into a fresh environment
# `e2e-<run-id>` for Maintainers: one snapshot. `dg env run` injects its values into a child
# process; `dg env export -o` writes a 0600 file inside a git work tree, adds it to
# .git/info/exclude and `git check-ignore` confirms it, and `git status` does not list it.
# A new environment without --audience is refused before signing (E611). CONTRIB (not a
# maintainer) is refused a change before signing (E601) and cannot read the environment (E612). The values are fake, made for the run.
SCENARIO_NAME="40 environments (import, run, export -o, check-ignore)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
harness_init
[[ -n "${HARNESS_SHARED:-}" ]] || harness_ensure_repo "$E2E_REPO_NAME" || skip_scenario "could not create/resolve the test repo"

REPO="${E2E_OWNER_ID}/${E2E_REPO_NAME}"
LOG="${WORKROOT}/s39"
ENV_NAME="e2e-${RUN_ID}"
SECRET="fake-e2e-secret-${RUN_ID}"
jq_py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"; }

step "OWNER imports a .env file (one snapshot, Maintainers)"
printf '# e2e\nE2E_ENV_A=alpha\nexport E2E_ENV_SECRET="%s"\nE2E_ENV_SPACED="two words"\n' "$SECRET" >"$LOG.env"
dg_as "$ID_OWNER" --yes --json env import "$REPO" "$LOG.env" --env "$ENV_NAME" --audience maintainers --secret \
  >"$LOG-import.json" 2>"$LOG-import.err" \
  || { cat "$LOG-import.err" "$LOG-import.json" >&2; is_flake "$LOG-import.err" && skip_scenario "import flaked"; bad "import failed"; finish_scenario; }
check "saved" assert_eq "saved" "$(jq_py "$LOG-import.json" 'd["status"]')"
check "for Maintainers" assert_eq "maintainers" "$(jq_py "$LOG-import.json" 'd["audience"]["group"]')"
check "three entries in one change" assert_eq "3" "$(jq_py "$LOG-import.json" 'len(d["changes"])')"
check "sent to OWNER first" assert_eq "$IDID_OWNER" "$(jq_py "$LOG-import.json" 'd["to"][0]')"
check "a padded size" assert_eq "0" "$(jq_py "$LOG-import.json" '(d["sizeBytes"] - 69 - 64*len(d["to"]) - 16) % 512')"

step "a new environment without an audience is refused before signing (E611)"
dg_as "$ID_OWNER" --yes --json env set "$REPO" E2E_ENV_A=alpha --env "${ENV_NAME}-none" >"$LOG-noaud.json" 2>"$LOG-noaud.err"
check "E611" assert_eq "E611" "$(jq_py "$LOG-noaud.json" 'd["error"]["code"]')"

step "dg env run injects the values into the child only"
dg_read_retry "$ID_OWNER" "$LOG-run.out" "$LOG-run.err" env run "$REPO" --env "$ENV_NAME" -- \
  sh -c 'printf "%s|%s|%s" "$E2E_ENV_A" "$E2E_ENV_SECRET" "$E2E_ENV_SPACED"' \
  || bad "run failed: $(head -c 400 "$LOG-run.err")"
check "child saw the values" assert_eq "alpha|${SECRET}|two words" "$(cat "$LOG-run.out")"
check "the child's exit code passes through" bash -c '
  DASH_FORGE_KEY="$1" "$2" env run "$3" --env "$4" -- sh -c "exit 7" >/dev/null 2>&1; [ $? -eq 7 ]' \
  _ "$ID_OWNER" "$DG" "$REPO" "$ENV_NAME"

step "dg env export -o writes a 0600 file that git ignores"
WT="${WORKROOT}/s39-clone"
rm -rf "$WT"; git init -q "$WT"
dg_read_retry "$ID_OWNER" "$LOG-export.json" "$LOG-export.err" --json env export "$REPO" --env "$ENV_NAME" -o "$WT/.env" \
  || bad "export failed: $(head -c 400 "$LOG-export.err")"
check "written" assert_eq "written" "$(jq_py "$LOG-export.json" 'd["status"]')"
check "mode 0600" assert_eq "600" "$(stat -f '%Lp' "$WT/.env" 2>/dev/null || stat -c '%a' "$WT/.env")"
check "git check-ignore confirms it" git -C "$WT" check-ignore -q .env
check "in .git/info/exclude" assert_file_contains "$WT/.git/info/exclude" "/.env"
check "git status does not list it" assert_eq "" "$(git -C "$WT" status --porcelain)"
check "the file holds the secret" assert_file_contains "$WT/.env" "E2E_ENV_SECRET=${SECRET}"
check "a second export without --force is refused" bash -c '
  ! DASH_FORGE_KEY="$1" "$2" env export "$3" --env "$4" -o "$5" >/dev/null 2>&1' \
  _ "$ID_OWNER" "$DG" "$REPO" "$ENV_NAME" "$WT/.env"

step "CONTRIB, not a maintainer, can neither change nor read it"
dg_as "$ID_CONTRIB" --yes --json env set "$REPO" E2E_ENV_A=evil --env "$ENV_NAME" >"$LOG-contrib-set.json" 2>"$LOG-contrib-set.err"
check "change refused (E601)" assert_eq "E601" "$(jq_py "$LOG-contrib-set.json" 'd["error"]["code"]')"
dg_as "$ID_CONTRIB" --json env get "$REPO" E2E_ENV_A --env "$ENV_NAME" >"$LOG-contrib-get.json" 2>"$LOG-contrib-get.err"
check "read refused: not shared with them (E612)" assert_eq "E612" "$(jq_py "$LOG-contrib-get.json" 'd["error"]["code"]')"
check "no value in CONTRIB's output" assert_not_file_contains "$LOG-contrib-get.json" "$SECRET"

finish_scenario

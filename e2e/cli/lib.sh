# shellcheck shell=bash
# lib.sh — shared helpers for the Dash Forge CLI e2e harness.
#
# Provides: binary discovery + PATH wiring for the `dash://` helper, a signing-key
# shim (DASH_FORGE_KEY), git-over-dash push/clone wrappers that capture stderr,
# consensus-vs-flake error classification, assertions, a broadcast retry, a shared
# remote-branch cleanup registry, and PASS/FAIL/SKIP scenario bookkeeping.
#
# Contract for scenario scripts:
#   source lib.sh; source config.sh   (lib.sh sources config.sh for you)
#   harness_init
#   ... checks via  check / assert_* ...
#   finish_scenario         # prints PASS/FAIL and exits 0/1
#   skip_scenario "reason"  # prints SKIP and exits 2  (non-fatal for run.sh)
#
# Exit codes: 0 = PASS, 1 = FAIL, 2 = SKIP.

set -uo pipefail

# Resolve the harness root (dir containing this file) regardless of caller cwd.
E2E_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_LIB_DIR
# Repo root: e2e/cli -> ../..
E2E_REPO_ROOT="$(cd "${E2E_LIB_DIR}/../.." && pwd)"
export E2E_REPO_ROOT

# shellcheck source=config.sh
source "${E2E_LIB_DIR}/config.sh"

# --- colours (tty only) ------------------------------------------------------
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_YEL=''; C_DIM=''; C_RST=''
fi

# --- logging -----------------------------------------------------------------
log()  { printf '%s\n' "$*" >&2; }
info() { printf '%s  %s%s\n' "${C_DIM}" "$*" "${C_RST}" >&2; }
step() { printf '\n%s== %s ==%s\n' "${C_DIM}" "$*" "${C_RST}" >&2; }

# --- per-scenario check bookkeeping -----------------------------------------
SCENARIO_NAME="${SCENARIO_NAME:-scenario}"
SCENARIO_FAILS=0

check() {
  # check "<description>" <cmd...>   -> runs cmd, records ok/FAIL
  local desc="$1"; shift
  if "$@"; then
    printf '  %s[ok]%s   %s\n' "${C_GRN}" "${C_RST}" "${desc}" >&2
  else
    printf '  %s[FAIL]%s %s\n' "${C_RED}" "${C_RST}" "${desc}" >&2
    SCENARIO_FAILS=$((SCENARIO_FAILS + 1))
  fi
}

# record a pass/fail directly (for inline logic)
ok()   { printf '  %s[ok]%s   %s\n' "${C_GRN}" "${C_RST}" "$*" >&2; }
bad()  { printf '  %s[FAIL]%s %s\n' "${C_RED}" "${C_RST}" "$*" >&2; SCENARIO_FAILS=$((SCENARIO_FAILS + 1)); }

# --- assertions (return non-zero on failure; use with `check`) --------------
assert_eq() { # assert_eq <expected> <actual> [label]
  local exp="$1" act="$2" label="${3:-}"
  if [[ "$exp" == "$act" ]]; then return 0; fi
  log "    ${C_RED}expected${C_RST} [$exp] ${C_RED}got${C_RST} [$act] ${label}"
  return 1
}
assert_contains() { # assert_contains <haystack-file-or-string> <needle>
  local hay="$1" needle="$2"
  if [[ -f "$hay" ]]; then grep -qiF -- "$needle" "$hay"; return $?; fi
  case "$hay" in *"$needle"*) return 0;; *) return 1;; esac
}
assert_file_contains() { grep -qiF -- "$2" "$1"; }
assert_not_file_contains() { ! grep -qiF -- "$2" "$1"; }

# --- binary discovery + PATH -------------------------------------------------
harness_find_binaries() {
  local rel="${E2E_REPO_ROOT}/target/release" dbg="${E2E_REPO_ROOT}/target/debug"
  if [[ -x "${rel}/git-remote-dash" && -x "${rel}/dg" ]]; then
    BIN_DIR="${rel}"
  elif [[ -x "${dbg}/git-remote-dash" && -x "${dbg}/dg" ]]; then
    BIN_DIR="${dbg}"
  else
    info "binaries not found; building (debug)…"
    ( cd "${E2E_REPO_ROOT}" && cargo build -p dg -p git-remote-dash >/dev/null 2>&1 ) || {
      log "${C_RED}fatal:${C_RST} could not build dg / git-remote-dash"; return 1; }
    BIN_DIR="${dbg}"
  fi
  export BIN_DIR
  export DG="${BIN_DIR}/dg"
  # The helper must be on PATH so `git` can invoke git-remote-dash for dash:// URLs.
  export PATH="${BIN_DIR}:${PATH}"
  info "using binaries in ${BIN_DIR}"
}

# --- timeout wrapper ---------------------------------------------------------
: "${E2E_TIMEOUT:=200}"
_tmo() { # _tmo <cmd...>  — wrap in `timeout` if available
  if command -v timeout >/dev/null 2>&1; then timeout "${E2E_TIMEOUT}" "$@"; else "$@"; fi
}

# --- signing-key shims -------------------------------------------------------
# Run dg as a given identity. Quiets rs-sdk transport chatter to stderr log.
dg_as() { # dg_as <identity_file> <dg args...>
  local id="$1"; shift
  DASH_FORGE_KEY="$id" RUST_LOG="${RUST_LOG:-error}" _tmo "${DG}" "$@"
}

# git push/clone/ls-remote over dash:// as a given identity, stderr -> logfile.
# Usage: git_dash <identity_file> <logfile> <git args...>
git_dash() {
  local id="$1" logf="$2"; shift 2
  DASH_FORGE_KEY="$id" RUST_LOG="${RUST_LOG:-warn}" \
    _tmo git "$@" >"${logf}.out" 2>"${logf}.err"
}

# --- error classification ----------------------------------------------------
# A transport/timeout/islock flake should SKIP, not FAIL. A consensus/token
# rejection is a genuine, expected outcome for the ACL scenarios.
is_flake() { # is_flake <logfile.err>
  grep -qiE 'connection reset|unavailable|timed out|timeout|deadline|transport error|Connection refused|dns error|no route|temporarily' "$1"
}
is_consensus_frozen() { # token account frozen at consensus
  grep -qiE 'token frozen|account is frozen|IdentityTokenAccountFrozen|token account is frozen|access has been suspended' "$1"
}
is_consensus_unauthorized() { # no/insufficient token -> unauthorized at consensus
  grep -qiE 'not authorized|unauthorized|Unauthorized|insufficient token|token balance|UnauthorizedTokenAction|does not have|WRITE .*token|requires a WRITE' "$1"
}
is_consensus_reject() { is_consensus_frozen "$1" || is_consensus_unauthorized "$1"; }

# --- broadcast retry ---------------------------------------------------------
# Retry a git-over-dash operation once if the first attempt looks like a flake.
# Returns the final exit code; leaves the last attempt's logs at <logfile>.{out,err}.
git_dash_retry() { # git_dash_retry <identity_file> <logfile> <git args...>
  local id="$1" logf="$2"; shift 2
  git_dash "$id" "$logf" "$@"; local rc=$?
  if [[ $rc -ne 0 ]] && is_flake "${logf}.err"; then
    info "flaky broadcast (rc=$rc); retrying once…"
    sleep 3
    git_dash "$id" "$logf" "$@"; rc=$?
  fi
  return $rc
}

# --- shared remote-branch cleanup registry -----------------------------------
# Scenarios register any branch/tag they create; run.sh (or the owning scenario)
# force-deletes them via DEPLOYER at the end. Delete of an already-gone ref is a
# harmless no-op.
register_ref() { # register_ref <refname e.g. refs/heads/e2e/RUN/foo>
  [[ -n "${WORKROOT:-}" ]] || return 0
  printf '%s\n' "$1" >>"${WORKROOT}/cleanup-refs.txt"
}

cleanup_refs() {
  [[ -n "${WORKROOT:-}" && -f "${WORKROOT}/cleanup-refs.txt" ]] || return 0
  step "cleanup: deleting registered test refs (DEPLOYER)"
  local scratch="${WORKROOT}/cleanup-repo"
  rm -rf "$scratch"; git init -q "$scratch" 2>/dev/null
  local ref
  # Batch deletes into one push where possible; simplest is one-by-one, tolerant.
  sort -u "${WORKROOT}/cleanup-refs.txt" | while read -r ref; do
    [[ -n "$ref" ]] || continue
    info "delete ${ref}"
    git_dash "$ID_DEPLOYER" "${WORKROOT}/cleanup-${RANDOM}" \
      -C "$scratch" push "$E2E_REMOTE" ":${ref}" || true
  done
  rm -f "${WORKROOT}/cleanup-refs.txt"
}

# --- run-id / workroot -------------------------------------------------------
harness_init() {
  # RUN_ID: passed env > short git rev of dash-forge > random. Plus a short random
  # suffix so back-to-back runs at the same rev don't collide on branch names.
  if [[ -z "${RUN_ID:-}" ]]; then
    local rev rnd
    rev="$(git -C "${E2E_REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo norev)"
    rnd="$(printf '%04x' $((RANDOM)))"
    RUN_ID="${rev}-${rnd}"
  fi
  export RUN_ID

  # WORKROOT: shared when exported by run.sh; otherwise this scenario owns it and
  # installs its own cleanup trap.
  if [[ -z "${WORKROOT:-}" ]]; then
    WORKROOT="${TMPDIR:-/tmp}/dash-forge-e2e/${RUN_ID}"
    export WORKROOT
    HARNESS_OWNS_CLEANUP=1
    trap 'cleanup_refs' EXIT
  fi
  mkdir -p "${WORKROOT}"

  harness_find_binaries || exit 1

  # Preflight: fixture files present.
  local missing=0 f
  for f in "$ID_DEPLOYER" "$ID_COLLAB" "$ID_CONTRIB"; do
    [[ -f "$f" ]] || { log "${C_RED}missing identity:${C_RST} $f"; missing=1; }
  done
  [[ $missing -eq 0 ]] || { log "identity fixtures missing under ${E2E_IDENTITY_DIR}"; exit 1; }

  info "run-id: ${RUN_ID}   workroot: ${WORKROOT}"
}

# --- scenario finish ---------------------------------------------------------
finish_scenario() {
  if [[ "${SCENARIO_FAILS}" -eq 0 ]]; then
    printf '%sPASS%s  %s\n' "${C_GRN}" "${C_RST}" "${SCENARIO_NAME}" >&2
    exit 0
  else
    printf '%sFAIL%s  %s  (%d check(s) failed)\n' "${C_RED}" "${C_RST}" "${SCENARIO_NAME}" "${SCENARIO_FAILS}" >&2
    exit 1
  fi
}

skip_scenario() {
  printf '%sSKIP%s  %s  — %s\n' "${C_YEL}" "${C_RST}" "${SCENARIO_NAME}" "$*" >&2
  exit 2
}

# Seed a tiny throwaway git repo with N files + a tag in $1 (dir). Fresh, unrelated
# history so the pushed pack is self-contained (few KB). Echoes the tip oid.
seed_tiny_repo() { # seed_tiny_repo <dir> <branch> [tagname]
  local dir="$1" branch="$2" tag="${3:-}"
  rm -rf "$dir"; mkdir -p "$dir"
  git init -q -b "$branch" "$dir"
  git -C "$dir" config user.email "e2e@dash-forge.test"
  git -C "$dir" config user.name "Dash Forge E2E"
  git -C "$dir" config commit.gpgsign false
  printf 'Dash Forge e2e round-trip\nrun-id: %s\n' "${RUN_ID}" >"$dir/README.md"
  printf 'alpha %s\n' "${RUN_ID}" >"$dir/alpha.txt"
  mkdir -p "$dir/sub"
  printf 'nested payload %s\n' "${RUN_ID}" >"$dir/sub/beta.txt"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "e2e seed ${RUN_ID}"
  if [[ -n "$tag" ]]; then
    git -C "$dir" tag -a "$tag" -m "e2e tag ${RUN_ID}"
  fi
  git -C "$dir" rev-parse HEAD
}

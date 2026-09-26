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
  # CARGO_TARGET_DIR is honored, so a build in a shared target dir is found.
  local target="${CARGO_TARGET_DIR:-${E2E_REPO_ROOT}/target}"
  local rel="${target}/release" dbg="${target}/debug"
  if [[ -n "${E2E_BIN_DIR:-}" ]]; then
    BIN_DIR="${E2E_BIN_DIR}"
  elif [[ -x "${rel}/git-remote-dash" && -x "${rel}/dg" ]]; then
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
# EVERY network command a scenario runs goes through _tmo, so one hang costs at most
# E2E_TIMEOUT seconds instead of the CI job's whole budget. timeout(1) puts the command in
# its own process group and signals the whole group, so the TERM reaches git's children
# too (`git` → `git fetch` → `git-remote-dash`: the tree the 07 hang left behind), and
# `-k` follows it with a KILL for anything that ignores TERM.
#
# Because each timeout(1) is its own group, killing a SCENARIO does not reach the command
# it was running. When run.sh sets E2E_PGID_FILE, each command's group is recorded there so
# run.sh can reap them after killing a scenario that overran.
#
# On a timeout the wrapper appends `e2e: command timed out after Ns` to its stderr. That is
# deliberately NOT a flake (see _final_errors): a command is retried after a timeout, but
# one that times out on every attempt is a hang — the scenario FAILs rather than SKIPs.
: "${E2E_TIMEOUT:=200}"
# Retries (_retry): attempts, and the base pause in seconds (attempt N waits N × pause, so
# 20 s then 40 s by default — the SDK bans a failing DAPI node for about a minute).
: "${E2E_ATTEMPTS:=3}"
: "${E2E_RETRY_PAUSE:=20}"
_tmo_for() { # _tmo_for <seconds> <cmd...>
  local secs="$1" t rc; shift
  t="$(command -v timeout || command -v gtimeout || true)"
  if [[ -z "$t" ]]; then
    log "${C_RED}fatal:${C_RST} no timeout(1) on PATH; refusing to run unbounded network commands"
    return 125
  fi
  if [[ -n "${E2E_PGID_FILE:-}" ]]; then
    # Backgrounded only to learn the pid (= the new group's id: timeout(1) makes itself a
    # group leader); waited on at once. No command here reads stdin.
    "$t" -k 15 "$secs" "$@" </dev/null &
    local pid=$!
    printf '%s\n' "$pid" >>"$E2E_PGID_FILE"
    wait "$pid"; rc=$?
  else
    "$t" -k 15 "$secs" "$@"; rc=$?
  fi
  [[ $rc -eq 124 || $rc -eq 137 ]] && printf 'e2e: command timed out after %ss\n' "$secs" >&2
  return $rc
}
_tmo() { _tmo_for "${E2E_TIMEOUT}" "$@"; } # _tmo <cmd...>: one network command

# --- signing-key shims -------------------------------------------------------
# Run dg as a given identity. Quiets rs-sdk transport chatter to stderr log.
dg_as() { # dg_as <identity_file> <dg args...>
  local id="$1"; shift
  DASH_FORGE_KEY="$id" RUST_LOG="${RUST_LOG:-error}" NO_COLOR=1 _tmo "${DG}" "$@"
}

# A READ-ONLY dg command as a given identity, retried like git_dash_retry.
# stdout -> <out>, stderr -> <err>. Never use this for a write: a dg write is not
# guaranteed idempotent to re-run (a second `collab add` mints again).
#
# With `--json`, dg reports its error as a JSON object on STDOUT, not stderr. On failure
# that output is appended to <err> too, so is_flake / _retry see the real error instead
# of an empty stderr (which made every flake read as "not a flake": no retry, then a FAIL).
dg_read_retry() { # dg_read_retry <identity_file> <out> <err> <dg args...>
  local err="$3"
  _retry "$err" _dg_read "$@"
}
_dg_read() {
  local id="$1" out="$2" err="$3" rc; shift 3
  dg_as "$id" "$@" >"$out" 2>"$err"; rc=$?
  [[ $rc -ne 0 ]] && cat "$out" >>"$err" 2>/dev/null
  return $rc
}

# git push/clone/ls-remote over dash:// as a given identity, stderr -> logfile.
# Usage: git_dash <identity_file> <logfile> <git args...>
# NO_COLOR keeps the helper's tracing lines free of ANSI codes so the classifiers below can
# recognize (and ignore) them. A clone's destination is cleared first when it is under
# WORKROOT: git refuses a non-empty one, which is how 07's retry used to FAIL after a
# killed first attempt instead of retrying.
git_dash() {
  local id="$1" logf="$2"; shift 2
  local dest="${!#}"
  [[ " $* " == *" clone "* && -n "${WORKROOT:-}" && "$dest" == "${WORKROOT}/"* ]] && rm -rf "$dest"
  DASH_FORGE_KEY="$id" RUST_LOG="${RUST_LOG:-warn}" NO_COLOR=1 \
    _tmo git "$@" >"${logf}.out" 2>"${logf}.err"
}

# --- error classification ----------------------------------------------------
# A transport/timeout/islock flake should SKIP, not FAIL. A consensus/token
# rejection is a genuine, expected outcome for the ACL scenarios.
#
# The helper logs every DAPI node it bans or retries at WARN, even when the request then
# succeeds on another node — so a push that was genuinely REJECTED usually has "transport
# error" WARN lines above its real error. Classifying those as a flake turned real verdicts
# into SKIPs (02 and 04 every night since 2026-09-21). is_flake therefore reads only the
# lines that are NOT helper log records: git's own output and the helper's final error.
#
# ERROR records are excluded too: the SDK logs `request failed error=NoAvailableAddresses…`
# at ERROR for a request it then hands back to forge-core, whose own retry may succeed on a
# fresh rotation. The binaries' final error never goes through tracing (git-remote-dash
# returns it from main, dg prints `error: …` or a JSON object), so nothing is lost.
#
# The harness's own timeout marker is excluded as well: a timeout is retried (see _retry),
# but a command that times out on every attempt is a hang, not testnet weather.
_final_errors() { # _final_errors <logfile.err> — stderr minus tracing records
  sed -E $'s/\x1b\\[[0-9;]*m//g' "$1" \
    | grep -vE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z +(TRACE|DEBUG|INFO|WARN|ERROR) |^e2e: command timed out'
}
# A proof that fails to verify is a node serving a bad or stale proof, not an answer (the
# SDK retries it on another node too): 06 FAILed on exactly that on 2026-09-17.
is_flake() { # is_flake <logfile.err>
  _final_errors "$1" | grep -qiE 'connection reset|unavailable|timed out|timeout|deadline|transport error|Connection refused|dns error|no route|temporarily|no available addresses|proof verification error'
}
is_timeout() { # is_timeout <logfile.err> — the harness killed the command
  grep -q '^e2e: command timed out' "$1"
}
# forge-v2: a write from an identity with no writer/maintainer document is refused at
# consensus with 40120 (ReferencedEntityNotFound on the `$ownerId` path).
is_consensus_not_member() {
  grep -qE '40120' "$1" && grep -qiE 'not a member|consensus refused|\$ownerId' "$1"
}
is_consensus_reject() { is_consensus_not_member "$1"; }
# The helper's local membership pre-check (never a consensus verdict): E601 with the
# "checked before building or paying" note.
is_local_precheck() { grep -qiE 'checked before building or paying for anything' "$1"; }

# --- retry ---------------------------------------------------------------------
# Run <cmd...> (which writes its stderr to <errfile>) up to E2E_ATTEMPTS times while it
# fails on a flake or a timeout, pausing N × E2E_RETRY_PAUSE before attempt N+1 — the SDK
# bans a failing DAPI node for about a minute, so an immediate retry mostly re-meets the
# nodes that just failed. A failure that is neither (a rejection, a verdict) returns at
# once, so this is also the right wrapper for pushes that are EXPECTED to be rejected: it
# retries until the push reaches consensus and gets an answer. Each failed attempt's
# stderr is kept as <errfile>.attemptN.
#
# If every attempt timed out, the last <errfile> is left saying so and is_flake is false
# for it: that is a hang, and the scenario FAILs on it instead of SKIPping.
_retry() { # _retry <errfile> <cmd...>
  local err="$1"; shift
  local attempt=1 rc
  while :; do
    "$@"; rc=$?
    [[ $rc -ne 0 ]] && { is_flake "$err" || is_timeout "$err"; } || return $rc
    [[ $attempt -lt $E2E_ATTEMPTS ]] || break
    info "attempt ${attempt}/${E2E_ATTEMPTS} failed (rc=$rc): $({ grep '^e2e: command timed out' "$err"; _final_errors "$err" | grep -iE 'error|fatal|timed out'; } | tail -1 | cut -c1-160)"
    cp "$err" "${err%.err}.attempt${attempt}.err" 2>/dev/null || true
    sleep $((E2E_RETRY_PAUSE * attempt))
    attempt=$((attempt + 1))
  done
  info "still failing after ${E2E_ATTEMPTS} attempts"
  return $rc
}

# git_dash under _retry. Pushes are idempotent to retry (resume journal + re-broadcast of
# identical signed bytes), and a rejected push writes nothing.
# Returns the final exit code; leaves the last attempt's logs at <logfile>.{out,err}.
git_dash_retry() { # git_dash_retry <identity_file> <logfile> <git args...>
  _retry "${2}.err" git_dash "$@"
}

# --- shared remote-branch cleanup registry -----------------------------------
# Scenarios register any branch/tag they create; run.sh (or the owning scenario)
# deletes the ones still on the remote via DEPLOYER at the end.
register_ref() { # register_ref <refname e.g. refs/heads/e2e/RUN/foo>
  [[ -n "${WORKROOT:-}" ]] || return 0
  printf '%s\n' "$1" >>"${WORKROOT}/cleanup-refs.txt"
}

cleanup_refs() {
  [[ -n "${WORKROOT:-}" && -f "${WORKROOT}/cleanup-refs.txt" ]] || return 0
  step "cleanup: deleting registered test refs (DEPLOYER)"
  local scratch="${WORKROOT}/cleanup-repo"
  rm -rf "$scratch"; git init -q "$scratch" 2>/dev/null
  # Only refs the remote still advertises are deleted: a delete of an absent ref is NOT a
  # no-op here (the helper still writes a zero-oid refUpdate for it). The survivors then go
  # in one push — each separate push re-reads the whole ref set and pays its own
  # round-trips, which made cleanup take 7-17 minutes a night.
  local refspecs=()
  local ref
  if ! git_dash_retry "$ID_DEPLOYER" "${WORKROOT}/cleanup-ls" ls-remote "$E2E_REMOTE"; then
    info "cleanup: could not list the remote's refs; stale e2e refs may remain on the test repo"
    rm -f "${WORKROOT}/cleanup-refs.txt"
    return 0
  fi
  while read -r ref; do
    [[ -n "$ref" ]] || continue
    awk -v r="$ref" '$2 == r { found = 1 } END { exit !found }' "${WORKROOT}/cleanup-ls.out" \
      && refspecs+=(":${ref}")
  done < <(sort -u "${WORKROOT}/cleanup-refs.txt")
  if [[ ${#refspecs[@]} -gt 0 ]]; then
    info "delete ${#refspecs[@]} ref(s): ${refspecs[*]}"
    git_dash_retry "$ID_DEPLOYER" "${WORKROOT}/cleanup" \
      -C "$scratch" push "$E2E_REMOTE" "${refspecs[@]}" \
      || info "cleanup push failed (rc=$?); stale e2e refs may remain on the test repo"
  else
    info "cleanup: no registered ref is still on the remote"
  fi
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
  for f in "$ID_OWNER" "$ID_COLLAB" "$ID_CONTRIB"; do
    [[ -f "$f" ]] || { log "${C_RED}missing identity:${C_RST} $f"; missing=1; }
  done
  [[ $missing -eq 0 ]] || { log "identity fixtures missing under ${E2E_IDENTITY_DIR}"; exit 1; }

  info "run-id: ${RUN_ID}   workroot: ${WORKROOT}   network: ${DASH_FORGE_NETWORK}-${DASH_FORGE_DEVNET_NAME:-}"
}

# Create the forge-v2 repo <name> under OWNER unless it exists. Idempotent and resumable:
# `dg repo create` finishes an interrupted create without paying twice, and re-running a
# finished one writes nothing. Leaves its --json output at ${WORKROOT}/create-<name>.json.
harness_ensure_repo() { # harness_ensure_repo <name>
  local name="$1" out="${WORKROOT}/create-$1"
  if _retry "${out}.err" _dg_read "$ID_OWNER" "${out}.json" "${out}.err" --yes --json repo create "$name" \
      --description "Dash Forge CLI e2e fixture (reserved; see e2e/README.md)"; then
    info "repo ${name}: $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["status"], d["cost"]["dash"], "DASH")' "${out}.json" 2>/dev/null)"
    return 0
  fi
  cat "${out}.err" >&2
  return 1
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

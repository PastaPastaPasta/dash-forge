#!/usr/bin/env bash
# Offline tests for mirror.sh: a local bare repository stands in for the Forge remote.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export FORGE_NETWORK=testnet DASH_FORGE_KEY=unused
passed=0

commit() { git -C "$1" commit -q --allow-empty -m "$2"; }
# mirror.sh, then replicate.sh whatever mirror.sh did (as the workflow runs them); fails if either does.
run_mirror() {
    local rc=0
    rm -rf "$root/state"
    (cd "$root/github" && FORGE_REMOTE="$root/forge.git" GITHUB_OUTPUT="$root/out" STATE_DIR="$root/state" \
        bash "$here/mirror.sh") >"$root/log" 2>&1 || rc=$?
    STATE_DIR="$root/state" bash "$here/replicate.sh" >>"$root/log" 2>&1 || rc=$?
    return "$rc"
}
expect() {
    local want=$1 name=$2 got=0
    : >"$root/out"
    run_mirror || got=$?
    if { [ "$want" = ok ] && [ "$got" != 0 ]; } || { [ "$want" = fail ] && [ "$got" = 0 ]; }; then
        echo "FAIL: $name (exit $got)"
        cat "$root/log"
        exit 1
    fi
    passed=$((passed + 1))
}
forge_ref() { git -C "$root/forge.git" rev-parse -q --verify "$1" || true; }
diverged() {
    grep -qx "diverged=true" "$root/out" || { echo "FAIL: diverged=true expected"; exit 1; }
    grep -qx "pushed=true" "$root/out" && { echo "FAIL: a divergence must push nothing"; exit 1; }
    return 0
}
check() { [ "$1" = "$2" ] || { echo "FAIL: $3: got '$1', want '$2'"; cat "$root/log"; exit 1; }; }

git init -q -b master "$root/github"
commit "$root/github" one
git -C "$root/github" tag v1
git -C "$root/github" tag -a v1-annotated -m annotated
git init -q --bare "$root/forge.git"

expect ok "first sync"
check "$(forge_ref refs/heads/master)" "$(git -C "$root/github" rev-parse master)" "master after the first sync"
check "$(forge_ref refs/tags/v1-annotated)" "$(git -C "$root/github" rev-parse v1-annotated)" "annotated tag object"
grep -qx "pushed=true" "$root/out" || { echo "FAIL: pushed=true expected"; exit 1; }

expect ok "nothing to do"
grep -qx "pushed=false" "$root/out" || { echo "FAIL: a second run must push nothing"; exit 1; }

commit "$root/github" two
git -C "$root/github" tag v2
git -C "$root/github" checkout -q -b stale HEAD~1
git -C "$root/github" update-ref refs/remotes/origin/master master
expect ok "GitHub ahead, with a stale checkout"
check "$(forge_ref refs/heads/master)" "$(git -C "$root/github" rev-parse master)" "fast-forward from origin/master"
check "$(forge_ref refs/tags/v2)" "$(git -C "$root/github" rev-parse v2)" "new tag"
git -C "$root/github" checkout -q master
git -C "$root/github" update-ref -d refs/remotes/origin/master

git clone -q "$root/forge.git" "$root/other"
commit "$root/other" forge-only
git -C "$root/other" push -q origin master
before=$(forge_ref refs/heads/master)
commit "$root/github" three
expect fail "Forge-only commit on master"
diverged
check "$(forge_ref refs/heads/master)" "$before" "a diverged master is left alone"
git -C "$root/forge.git" update-ref refs/heads/master "$(git -C "$root/github" rev-parse master~1)"

git -C "$root/forge.git" update-ref refs/tags/forge-tag "$(git -C "$root/github" rev-parse master~1)"
expect fail "tag only on Forge"
diverged
git -C "$root/forge.git" update-ref -d refs/tags/forge-tag

git -C "$root/forge.git" update-ref refs/tags/v1 "$(git -C "$root/github" rev-parse master~1)"
expect fail "tag moved on Forge"
diverged
check "$(forge_ref refs/tags/v1)" "$(git -C "$root/github" rev-parse master~1)" "a moved tag is left alone"
git -C "$root/forge.git" update-ref refs/tags/v1 "$(git -C "$root/github" rev-parse v1)"

git -C "$root/forge.git" update-ref refs/heads/feature "$(git -C "$root/github" rev-parse master~1)"
expect fail "branch only on Forge"
diverged
git -C "$root/forge.git" update-ref -d refs/heads/feature

expect ok "recovered"
check "$(forge_ref refs/heads/master)" "$(git -C "$root/github" rev-parse master)" "master after recovery"

# DRY_RUN compares and pushes nothing.
commit "$root/github" four
before=$(forge_ref refs/heads/master)
DRY_RUN=1 expect ok "dry run"
grep -qx "pushed=false" "$root/out" || { echo "FAIL: a dry run must push nothing"; exit 1; }
check "$(forge_ref refs/heads/master)" "$before" "a dry run leaves Forge alone"

# Replication. A stub kubo serves pin/ls from $root/pins and dag/export as `CAR:<cid>`; the
# Forge stand-in's pre-receive hook "pins" $root/pins-add (as the helper's storage would) and
# exits $HOOK_RC; the pin command confirms each CAR unless its CID is $FAIL_CID.
cat >"$root/kubo.py" <<'PY'
import http.server, json, sys, urllib.parse
pins = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/v0/pin/ls":
            body = json.dumps({"Keys": {c: {"Type": "recursive"} for c in open(pins).read().split()}}).encode()
        elif u.path == "/api/v0/dag/export":
            body = ("CAR:" + urllib.parse.parse_qs(u.query)["arg"][0]).encode()
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[2], "w").write(str(s.server_port))
s.serve_forever()
PY
echo bafy-preexisting >"$root/pins"
: >"$root/pins-add"
python3 "$root/kubo.py" "$root/pins" "$root/port" &
kubo_pid=$!
disown "$kubo_pid"
trap 'kill "$kubo_pid" 2>/dev/null; rm -rf "$root"' EXIT
for _ in $(seq 1 50); do [ -s "$root/port" ] && break; sleep 0.1; done
cat >"$root/forge.git/hooks/pre-receive" <<SH
#!/bin/sh
cat "$root/pins-add" >>"$root/pins"
exit \${HOOK_RC:-0}
SH
chmod +x "$root/forge.git/hooks/pre-receive"
cat >"$root/pin.sh" <<'SH'
[ -z "${DASH_FORGE_KEY:-}" ] || { echo "the pin command must not see DASH_FORGE_KEY"; exit 1; }
car=$(cat)
if [ -z "$car" ]; then
    [ -n "${NOT_READY:-}" ] || echo ready
    exit 0
fi
cid=${car#CAR:}
echo "$cid" >>"$ROOT/received"
[ "$cid" != "${FAIL_CID:-}" ] || exit 1
printf 'confirmed\t%s\n' "$cid"
SH
port=$(cat "$root/port")
export KUBO_API="http://127.0.0.1:$port" PIN_CMD="bash $root/pin.sh" ROOT="$root" CAR_DIR="$root/cars"

commit "$root/github" not-ready
before=$(forge_ref refs/heads/master)
NOT_READY=1 expect fail "IPFS host not ready"
check "$(forge_ref refs/heads/master)" "$before" "nothing is pushed while the IPFS host is not ready"
grep -qx "pushed=true" "$root/out" && { echo "FAIL: no push without a ready IPFS host"; exit 1; }

printf 'bafy-a\nbafy-b\n' >"$root/pins-add"
expect ok "replicates what the push pinned"
check "$(sort "$root/received" | tr '\n' ' ')" "bafy-a bafy-b " "replicated CIDs (not the pin from before)"
[ ! -e "$root/cars" ] || { echo "FAIL: CAR_DIR must be removed after a full replication"; exit 1; }

commit "$root/github" five
: >"$root/received"
printf 'bafy-c\n' >"$root/pins-add"
HOOK_RC=1 expect fail "a failed push still replicates what it pinned"
check "$(cat "$root/received")" "bafy-c" "replicated after a failed push"
grep -qx "pushed=true" "$root/out" || { echo "FAIL: an attempted push sets pushed=true"; exit 1; }

: >"$root/received"
printf 'bafy-d\nbafy-e\nbafy-f\n' >"$root/pins-add"
FAIL_CID=bafy-e expect fail "one CID not confirmed"
check "$(sort "$root/received" | tr '\n' ' ')" "bafy-d bafy-e bafy-f " "every CID is tried"
check "$(ls "$root/cars")" "bafy-e.car" "only the unconfirmed CAR is kept"

echo "forge-sync: $passed cases passed"

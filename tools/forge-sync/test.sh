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
run_mirror() { (cd "$root/github" && FORGE_REMOTE="$root/forge.git" GITHUB_OUTPUT="$root/out" bash "$here/mirror.sh") >"$root/log" 2>&1; }
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
grep -qx "diverged=true" "$root/out" || { echo "FAIL: diverged=true expected"; exit 1; }
check "$(forge_ref refs/heads/master)" "$before" "a diverged master is left alone"
git -C "$root/forge.git" update-ref refs/heads/master "$(git -C "$root/github" rev-parse master~1)"

git -C "$root/forge.git" update-ref refs/tags/forge-tag "$(git -C "$root/github" rev-parse master~1)"
expect fail "tag only on Forge"
git -C "$root/forge.git" update-ref -d refs/tags/forge-tag

git -C "$root/forge.git" update-ref refs/tags/v1 "$(git -C "$root/github" rev-parse master~1)"
expect fail "tag moved on Forge"
check "$(forge_ref refs/tags/v1)" "$(git -C "$root/github" rev-parse master~1)" "a moved tag is left alone"
git -C "$root/forge.git" update-ref refs/tags/v1 "$(git -C "$root/github" rev-parse v1)"

git -C "$root/forge.git" update-ref refs/heads/feature "$(git -C "$root/github" rev-parse master~1)"
expect fail "branch only on Forge"
git -C "$root/forge.git" update-ref -d refs/heads/feature

expect ok "recovered"
check "$(forge_ref refs/heads/master)" "$(git -C "$root/github" rev-parse master)" "master after recovery"

echo "forge-sync: $passed cases passed"

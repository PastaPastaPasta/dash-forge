#!/usr/bin/env bash
# Offline checks for the GitLab CI template:
#   1. it validates against GitLab's CI schema (check-jsonschema, when available);
#   2. every script block passes shellcheck (as sh);
#   3. forge-mirror-code, run against a local "GitLab" repository with a stub `git push`,
#      fetches every branch and tag and pushes only refs/heads/* and refs/tags/*, never
#      GitLab's hidden refs or --mirror;
#   4. the rules gate the jobs on FORGE_REPO and FORGE_IMPORT.
# Run: bash integrations/gitlab/test.sh
# Literal $VARS in single quotes below are GitLab rule expressions.
# shellcheck disable=SC2016
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tpl="$here/dash-forge-mirror.yml"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
fail() {
    echo "FAIL: $*"
    fails=$((fails + 1))
}

python3 -c 'import yaml' 2>/dev/null || { echo "python3 with PyYAML is required"; exit 1; }
# yq <path> <file>: a value of the template, by a /-separated path (list indexes as numbers,
# `[]` for every element of a list), printed one per line.
yq() {
    python3 - "$1" "$2" <<'PY'
import sys, yaml
doc = yaml.safe_load(open(sys.argv[2]))
vals = [doc]
for part in sys.argv[1].split("/"):
    nxt = []
    for v in vals:
        if part == "[]":
            nxt.extend(v)
        elif isinstance(v, list):
            nxt.append(v[int(part)])
        else:
            nxt.append(v.get(part))
    vals = nxt
for v in vals:
    print("" if v is None else v)
PY
}

# 1. Schema.
if command -v check-jsonschema >/dev/null; then
    check-jsonschema --builtin-schema vendor.gitlab-ci "$tpl" >/dev/null || fail "schema"
elif command -v uvx >/dev/null; then
    uvx --quiet --from check-jsonschema check-jsonschema --builtin-schema vendor.gitlab-ci "$tpl" >/dev/null ||
        fail "schema"
else
    echo "skip: schema (no check-jsonschema)"
fi

# 2. shellcheck every script block (GitLab runs them with sh in this image).
for key in .dash-forge/before_script/0 forge-mirror-code/script/0 forge-import/script/0; do
    yq "$key" "$tpl" >"$tmp/block.sh"
    [ -s "$tmp/block.sh" ] || fail "no script at $key"
    # SC2016: single-quoted refspecs are literal on purpose.
    # SC2153: FORGE_* come from the template's variables block, not the script.
    shellcheck -s sh -e SC2016,SC2153 "$tmp/block.sh" || fail "shellcheck $key"
done

# 3. The code push, against a local upstream with GitLab's hidden refs.
up="$tmp/upstream.git"
git init -q --bare "$up"
work="$tmp/seed"
git init -q -b main "$work"
git -C "$work" -c user.name=t -c user.email=t@t commit -q --allow-empty -m one
git -C "$work" branch feature
git -C "$work" tag v1
git -C "$work" push -q "$up" main feature v1
oid=$(git -C "$work" rev-parse HEAD)
for hidden in refs/merge-requests/1/head refs/pipelines/9 refs/environments/prod/deployments/1 refs/keep-around/$oid; do
    git -C "$up" update-ref "$hidden" "$oid"
done
# The runner's checkout: only the pipeline's branch, as GitLab fetches it.
job="$tmp/job"
git clone -q --depth 1 --branch main "file://$up" "$job"
# A stub git that records `push` and passes everything else to the real git.
mkdir -p "$tmp/bin"
real_git=$(command -v git)
cat >"$tmp/bin/git" <<EOF
#!/bin/sh
for a in "\$@"; do
    if [ "\$a" = push ]; then printf '%s\n' "\$@" >"$tmp/push-args"; exit 0; fi
done
exec "$real_git" "\$@"
EOF
chmod +x "$tmp/bin/git"
yq forge-mirror-code/script/0 "$tpl" >"$tmp/push.sh"
# The job's checkout is shallow (depth 1); the template sets GIT_DEPTH 0, and the fetch of
# every branch must work from a shallow clone too.
(cd "$job" && git fetch -q --unshallow origin && PATH="$tmp/bin:$PATH" FORGE_REPO=dash://Owner/repo sh "$tmp/push.sh") ||
    fail "the code push script failed"
grep -qx -- '--prune' "$tmp/push-args" || fail "push without --prune"
grep -qx -- '--mirror' "$tmp/push-args" && fail "push uses --mirror"
grep -qx -- '+refs/forge/heads/\*:refs/heads/\*' "$tmp/push-args" || fail "no heads refspec"
grep -qx -- '+refs/tags/\*:refs/tags/\*' "$tmp/push-args" || fail "no tags refspec"
grep -q 'merge-requests\|pipelines\|environments\|keep-around' "$tmp/push-args" && fail "a hidden ref namespace is pushed"
refs=$(git -C "$job" for-each-ref --format='%(refname)' refs/forge/heads refs/tags | tr '\n' ' ')
[ "$refs" = "refs/forge/heads/feature refs/forge/heads/main refs/tags/v1 " ] || fail "fetched refs: $refs"
git -C "$job" for-each-ref --format='%(refname)' | grep -q 'merge-requests\|pipelines' && fail "hidden refs were fetched"

# 4. Rules.
[ "$(yq forge-mirror-code/rules/0/if "$tpl")" = '$FORGE_REPO == ""' ] || fail "code job not gated on FORGE_REPO"
yq forge-import/rules/0/if "$tpl" | grep -q 'FORGE_IMPORT != "true"' || fail "import job not gated on FORGE_IMPORT"
[ "$(yq .dash-forge/variables/GIT_DEPTH "$tpl")" = 0 ] || fail "GIT_DEPTH is not 0"
[ "$(yq .dash-forge/resource_group "$tpl")" = dash-forge-mirror ] || fail "no resource_group"
for src in push schedule web; do
    yq 'forge-mirror-code/rules/[]/if' "$tpl" | grep -q "\"$src\"" || fail "code job lacks the $src rule"
done

if [ "$fails" -ne 0 ]; then
    echo "$fails check(s) failed"
    exit 1
fi
echo "integrations/gitlab/test.sh: all checks passed"

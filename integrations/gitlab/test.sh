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
# The job's checkout is shallow (depth 1), as a runner that ignored GIT_DEPTH would leave
# it: the script's fetch of every branch must still work, as is.
[ -f "$job/.git/shallow" ] || fail "the test checkout is not shallow"
(cd "$job" && PATH="$tmp/bin:$PATH" FORGE_REPO=dash://Owner/repo FORGE_PUSH_CAP=0.05 sh "$tmp/push.sh") ||
    fail "the code push script failed"
grep -qx -- '--prune' "$tmp/push-args" || fail "push without --prune"
grep -qx -- 'dash.confirm=refuse' "$tmp/push-args" || fail "push not capped (dash.confirm=refuse)"
grep -qx -- 'dash.costWarnThreshold=0.05' "$tmp/push-args" || fail "push without FORGE_PUSH_CAP"
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
for job_name in forge-mirror-code forge-import; do
    yq "$job_name/rules/1/if" "$tpl" | grep -qx '$CI_COMMIT_REF_PROTECTED != "true"' ||
        fail "$job_name runs on unprotected refs"
    [ "$(yq "$job_name/rules/1/when" "$tpl")" = never ] || fail "$job_name protected rule is not never"
done
[ "$(yq 'forge-import/allow_failure/exit_codes/0' "$tpl")" = 4 ] || fail "partial (4) is not a warning"

# 5. before_script: the key must be a file; nothing installs without a pinned version.
yq .dash-forge/before_script/0 "$tpl" >"$tmp/before.sh"
# Stop the script right after the key checks and the install decision: replace the rest
# with a marker (the lines up to "Network and storage" are what is tested here).
sed '/--- Network and storage/,$d' "$tmp/before.sh" >"$tmp/before-head.sh"
printf '%s\n' 'echo REACHED-END' >>"$tmp/before-head.sh"
mkdir -p "$tmp/fakebin"
for b in git-remote-dash forge-import dg; do printf '#!/bin/sh\necho "%s 0.0.0"\n' "$b" >"$tmp/fakebin/$b"; done
chmod +x "$tmp/fakebin"/*
before() {
    env -i PATH="$tmp/fakebin:/usr/bin:/bin" CI_PROJECT_DIR="$tmp/proj" FORGE_VERSION="" FORGE_SOURCE_REF="" \
        "$@" sh "$tmp/before-head.sh" >"$tmp/before.out" 2>&1
}
mkdir -p "$tmp/proj"
secret='{"identityId":"X","identityKeys":[{"privateKeyWif":"cSECRETwif"}]}'
if before DASH_FORGE_KEY="$secret"; then fail "a non-file DASH_FORGE_KEY was accepted"; fi
grep -q 'must be a File variable' "$tmp/before.out" || fail "no File-variable message"
grep -q cSECRET "$tmp/before.out" && fail "the key was printed"
if before DASH_FORGE_KEY=dfk1:devnet:X:3:cSECRETwif; then fail "an inline dfk1 key was accepted"; fi
grep -q cSECRET "$tmp/before.out" && fail "the dfk1 key was printed"
printf '%s' "$secret" >"$tmp/key.json"
before DASH_FORGE_KEY="$tmp/key.json" || fail "a File variable was refused: $(cat "$tmp/before.out")"
grep -q REACHED-END "$tmp/before.out" || fail "before_script stopped early with a key file"
# Nothing on PATH and nothing pinned: refuse to install.
rm -rf "$tmp/fakebin"
if before DASH_FORGE_KEY="$tmp/key.json"; then fail "installed with neither FORGE_VERSION nor FORGE_SOURCE_REF"; fi
grep -q 'FORGE_VERSION' "$tmp/before.out" || fail "no pinning message"
# Installers run without secrets; protoc is checksummed.
grep -q 'env -u DASH_FORGE_KEY -u GITLAB_TOKEN' "$tmp/before.sh" || fail "an installer sees the secrets"
grep -q 'sha256sum -c' "$tmp/before.sh" || fail "protoc is not checksummed"
grep -q 'dash.replicas' "$tmp/before.sh" || fail "s3 storage does not set dash.replicas"

if [ "$fails" -ne 0 ]; then
    echo "$fails check(s) failed"
    exit 1
fi
echo "integrations/gitlab/test.sh: all checks passed"

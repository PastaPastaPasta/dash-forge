# Dash Forge mirror for GitLab CI

[`dash-forge-mirror.yml`](dash-forge-mirror.yml) is a GitLab CI template. It keeps a Forge repository in step with a GitLab project:

- **Code:** every branch and tag, on every push.
- **Issues, merge requests, labels and releases:** on a schedule, with `forge-import`.

The full walk-through, with the variables to set and what is and is not mirrored, is in [Mirror a GitLab project](../../docs/guides/mirror-a-gitlab-project.md#2-keep-it-in-sync-from-gitlab-ci).

```yaml
include:
  - remote: https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/<commit>/integrations/gitlab/dash-forge-mirror.yml
variables:
  FORGE_REPO: dash://<owner identity id>/<repo name>
  FORGE_SOURCE_REF: <the same commit>
```

| Variable | Default | Meaning |
|---|---|---|
| `FORGE_REPO` | (required) | The destination, `dash://<owner>/<name>`. Nothing runs while it is empty. |
| `FORGE_NETWORK`, `FORGE_DEVNET_NAME` | `devnet`, `moutai` | The network. |
| `FORGE_VERSION` | empty | A Dash Forge release to install. Empty means the latest release, if one exists. |
| `FORGE_SOURCE_REF` | empty | The dash-forge commit to build when no release can be installed. Pin a reviewed commit id. |
| `FORGE_STORAGE_KIND` | `platform` | `s3` to put packs in your bucket (`FORGE_S3_ENDPOINT`, `_REGION`, `_BUCKET`, `_PUBLIC_URL`, `_PREFIX`, `_VIRTUAL_HOSTED`), with the `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` variables. |
| `FORGE_IMPORT` | `"false"` | `"true"` runs `forge-import` on scheduled and manual pipelines. |
| `FORGE_SYNC` | `code,issues,prs,labels,releases` | What `forge-import` mirrors. |
| `FORGE_COST_CAP` | `"0.05"` | The hard cap in DASH for one import run. |

Secrets, all Protected:

- `DASH_FORGE_KEY`: a **File** variable holding the CI identity or a `dfk1:` key.
- `GITLAB_TOKEN`: masked, a project access token with `read_api`.
- The S3 keys, masked.

`bash integrations/gitlab/test.sh` checks the template offline:

- It validates against GitLab's CI schema.
- It runs shellcheck on every script.
- It runs the code push against a local repository that has GitLab's hidden refs, and asserts that only `refs/heads/*` and `refs/tags/*` are pushed.
- It checks the rules.

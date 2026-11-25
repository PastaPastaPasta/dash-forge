# Docs audit, 2026-11-25

On 2026-11-25 every claim the docs and the in-app copy make about Dash Forge was checked against the code on `master` and against the live sites (forge.dashhq.org, testnet-forge.dashhq.org, the docs hub and dash.site). Each lane checked one area, fixed what was wrong in one PR, and left a table of every claim it checked.

| Lane | Table | PR |
|---|---|---|
| CLI: `dg` commands, flags and help | [cli.md](cli.md) | [#736](https://github.com/PastaPastaPasta/dash-forge/pull/736) |
| Install, build, README, CHANGELOG | [install.md](install.md) | [#735](https://github.com/PastaPastaPasta/dash-forge/pull/735) |
| Storage, IPFS, hosting, limits and costs | [storage.md](storage.md) | [#733](https://github.com/PastaPastaPasta/dash-forge/pull/733) |
| Guides: identity, wallet sign-in, settings sync | [guides-identity.md](guides-identity.md) | [#732](https://github.com/PastaPastaPasta/dash-forge/pull/732) |
| Guides: migration, verification, operators | [guides-ops.md](guides-ops.md) | [#734](https://github.com/PastaPastaPasta/dash-forge/pull/734) |
| Web copy: sign-in, keys, settings | [webcopy-identity.md](webcopy-identity.md) | [#731](https://github.com/PastaPastaPasta/dash-forge/pull/731) |
| Web copy: repository pages | [webcopy-repo.md](webcopy-repo.md) | [#737](https://github.com/PastaPastaPasta/dash-forge/pull/737) |
| Maintainer storage sharing (after [#740](https://github.com/PastaPastaPasta/dash-forge/pull/740)) | [maintainer-sharing.md](maintainer-sharing.md) | [#743](https://github.com/PastaPastaPasta/dash-forge/pull/743) |
| dash-sites and dash.site | [audit-2026-11-25.md](https://github.com/PastaPastaPasta/dash-sites/blob/main/docs/audit-2026-11-25.md) | [dash-sites #27](https://github.com/PastaPastaPasta/dash-sites/pull/27) |

**Verdicts.** `ok` matches the code; `stale` was true once and isn't now; `wrong` never matched; `missing` is shipped behaviour the docs didn't cover; `fixed` (or `(fixed)`) means the lane's PR changed it. `deferred` rows were about maintainer storage sharing while #740 was changing it; each now points to its row in [maintainer-sharing.md](maintainer-sharing.md). Code problems were recorded as product questions at the end of each table, not changed.

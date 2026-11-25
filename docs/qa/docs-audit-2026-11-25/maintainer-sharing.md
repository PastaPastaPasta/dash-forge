# Docs audit 2026-11-25: maintainer storage sharing

Every passage the other lanes marked `deferred` (maintainer storage sharing, which another thread was changing), checked against `origin/master` at 1aa3f302, the merge of [#740](https://github.com/PastaPastaPasta/dash-forge/pull/740) ("share only repo-specific storage with maintainers"), and against testnet-forge.dashhq.org, which runs 1aa3f302. Also two rows deferred to other lanes, and whether `rotate-storage-credentials.md` belongs in the in-app docs hub.

Verdicts: **ok** (matches the code), **stale** (true once, not now), **wrong** (never matched), **missing** (shipped behaviour the docs don't cover). `(fixed)` means this PR changes it.

## The rotation guide

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| 1 | "When you share a repository's storage with its maintainers (`dg storage share <owner/repo> <profile>`, or the repo's Settings → Storage) … decrypts the storage profiles you set for that repository" | docs/guides/rotate-storage-credentials.md:3 | ok | `crates/dg/src/storage.rs:451` (`share`); `ShareRule::of` reads only `repo:<id>` (`crates/forge-core/src/user_sync/mod.rs:615`); web `SHARE_ACTION` (`forge-web/components/storage/repo-share-notes.tsx:117`) |
| 2 | Sharing is testnet only | rotate-storage-credentials.md (whole page) | missing (fixed) | `dg storage share` refuses without `v2.user`: "sync isn't available on this network" (`storage.rs:461`); forge-user is in the testnet deployment only. The page now says so up front |
| 3 | Leads with "Cloudflare R2"; "Other S3-compatible storage (AWS, Backblaze B2, MinIO, a NAS)" | rotate-storage-credentials.md:13-31 (before) | stale (fixed) | #715 limits docs to tested providers: RustFS and Garage (bring-your-own-storage.md:97). Rewritten as one S3-compatible section using the tested Garage and RustFS commands from home-nas-storage.md:193, :225-235; example profile `r2-main` → `nas` |
| 4 | "`dg storage add` … keep the old name" (replacing a profile) | rotate-storage-credentials.md, dg step | ok | `dg storage add --help`: "Add (or replace) a storage profile"; a replaced synced profile re-syncs (`storage.rs:192`, `sync::after_profile_change`) |
| 5 | "Your next push … re-encrypts the share … So do `dg collab add`, `dg collab remove` and `dg storage share`" | rotate-storage-credentials.md:11 | ok; missing the web (fixed) | owner push: `helper.rs` `reconcile_share`; collab: `crates/dg/src/sync.rs` `after_membership_change`; web reconciles on each owner visit to repo Settings (`forge-web/hooks/use-repo-share.ts:193-206`) |
| 6 | "Maintainers only ever get storage set for their repository, never your default storage" | rotate-storage-credentials.md:11 | ok | `ShareRule::of` never reads `default`; fixture `forge-contracts/fixtures/user-sync/share-rule.json` (both clients test it) |
| 7 | Other guides send a reader here when the settings-sync key may have leaked; the page spoke only of removed maintainers | identity-and-keys.md:377, revoke-keys.md:88 → rotate-storage-credentials.md | missing (fixed) | the page now names both cases |
| 8 | Existing testnet shares from the default storage stop at the next push / collab / share / settings visit, epoch moves, grants revoked | rotate-storage-credentials.md, "What happens to existing testnet maintainers" | ok | `Wanted::over` and `share_epoch` (`mod.rs:687`, `:711`); `stopped_default_line` (`mod.rs:755`) |
| 9 | "dg says so once" | same section | missing (fixed) | the web says it once too: `useStoppedShareNotice` + `StoppedShareLine` (`repo-share-notes.tsx:49-72`, key `forge:user-sync:stopped-default:<network>:<repo>`). Also added the web action for setting repo storage |
| 10 | "Forge never lets a shared profile record a non-public address on chain from the maintainer's machine" | rotate-storage-credentials.md, "What a maintainer trusts" | ok | `ShareContent::as_profiles` calls `forbid_private_uri()` (`mod.rs:560-571`) |
| 11 | `dg storage test`, one push to each repository whose maintainers changed | rotate-storage-credentials.md, "Check" | ok | owner push reconciles (row 5) |

## Guides

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| 12 | What maintainers can use (storage) | docs/guides/collaborating.md, Members | missing (fixed) | nothing described sharing. New "Storage for maintainers (testnet)" subsection: `dg storage share` / `--stop`, web action, owner's own pushes follow the repo setting, maintainers' own `dash.storage` and per-repo choice win (`crates/git-remote-dash/src/policy.rs:115-121`; `forge-web/lib/user-sync/maintainers.ts:450`), writers get nothing (`user_sync::repo::current_maintainers`), maintainer line when nothing is shared (`mod.rs:808`; `merge-upload.tsx:181`) |
| 13 | "each file … goes to *your* storage from Settings → Storage" (web release assets) | collaborating.md, "Releases from the browser" | stale (fixed) | on testnet a maintainer's assets go to the owner's shared storage when granted: `forge-web/components/repo/new-release.tsx:235` (`useGrantedStorage`) |
| 14 | "`dg storage list` marks each profile `local`, `synced`, … or `shared`" | docs/guides/bring-your-own-storage.md:121 | wrong (fixed) | `list` uses `sync::merged` → `user_sync::effective` (`mod.rs:252`), which never sets `Origin::Shared`; only push-time `push_storage` does (`user_sync/repo.rs:94`). The guide now says shared storage isn't listed, its `share.<owner8>.<name>` name, and the push line (`helper.rs:1609`) |
| 15 | "In the web app the per-repository choice … follows too" | bring-your-own-storage.md:120 | ok; missing that it is what maintainers get (fixed) | an owner's synced `repo:<id>` policy is the share (`ShareRule::of`); the card then says "Shared with this repo's maintainers." (`repo-share-notes.tsx:142`) |
| 16 | "Storage: … the web app's per-repository choices" follow you | docs/guides/identity-and-keys.md:370 | stale (fixed) | `dg storage share` writes `repo:<id>` too (`storage.rs:414`); added that it is what maintainers get |
| 17 | Rotate guide row: "roll the R2/S3 key"; only "after removing a maintainer" | docs/guides/README.md:12 | stale (fixed) | rows 3 and 7 |
| 18 | `dg storage share` help: "Share storage profiles with a repository's maintainers, the only storage they ever get from you (owner only)" | crates/dg/src/main.rs:2359; docs/schemas/dg/storage-share.schema.json | ok | matches `share` and `ShareRule::of` |

## CHANGELOG and design

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| 19 | #740 in Unreleased | CHANGELOG.md | missing (fixed) | no entry named maintainer sharing; added one citing #729 and #740, with the testnet stop and "nothing local is deleted" |
| 20 | #729 entry: settings follow your identity, testnet only, never deletes local settings | CHANGELOG.md:14 | ok | consistent with #740; it covers your own devices only |
| 21 | "Status: design, 2026-11-25" | docs/design/identity-synced-state.md:3 | stale (fixed) | built: #729, #740 merged; testnet-forge.dashhq.org serves 1aa3f302; no release includes them (`gh release list`: v0.2.0 latest) |
| 22 | "(web or `dg repo maintainer remove`)" | identity-synced-state.md §5 | wrong (fixed) | `dg repo maintainer` → E201 "unrecognized subcommand"; the command is `dg collab remove` |
| 23 | Owner reconciles "on owner pushes (dg), on `dg collab add/remove`, and on visits to the repo's settings" | identity-synced-state.md §10 | missing (fixed) | `dg storage share` reconciles too (`storage.rs:498`, `reconcile_repo_by_rule`) |
| 24 | §11 proof: "the pack lands on proof-s3, and the share is written" | identity-synced-state.md §11; forge-contracts/evidence/testnet/user-sync-2026-11-25.md | stale context (fixed) | the proof shared the default storage (evidence line 60: "here the synced default, `proof-s3`"), which #740 stops; a note says so. No live run of the new rule is recorded |

## In-app copy

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| 25 | "The owner's storage reaches you after you sign in with your Dash wallet once" | forge-web/components/storage/repo-share-notes.tsx:33 | wrong (fixed) | shown to any maintainer with no sync key (`use-repo-share.ts:210`), even when the owner shares nothing. Now: "If the owner shares storage for this repo, you get it after signing in with your Dash wallet once". Copy only |
| 26 | Stop lines: "Stopped sharing your default storage with this repo's maintainers. Set storage for this repo to share it." (and `removed`, `legacy`) | repo-share-notes.tsx:50-54 | ok | match dg's `stopped_line` (`mod.rs:779`); rotation detail collapsed under "The keys they saw" |
| 27 | "Use separate storage for this repo to share it with maintainers" | repo-share-notes.tsx:117; repo-storage-policy.tsx:75 | ok | one action, only for an owner with sync, maintainers and no repo storage (`storageCardView`, :143) |
| 28 | "Shared with this repo's maintainers." / "Only you see this." | repo-share-notes.tsx:140-144 | ok | details collapsed under "Who can use it" |
| 29 | "The owner hasn't shared storage for this repo with you yet; your own storage is used. Ask them to set it in this repo's Settings → Storage." | forge-web/components/repo/merge-upload.tsx:181; settings-content.tsx:495, :537 | ok | shown only for grant status `none`; `useRepoGrant` returns `off` with no forge-user contract, so never on mainnet (`use-repo-share.ts:349`) |
| 30 | "They could use your shared storage until now: rotate those storage keys." | repo-share-notes.tsx:44 | ok | shown after a removal when the repo had a share (`use-repo-share.ts:224-240`) |
| 31 | `DOCS.rotateStorage` → GitHub, because the page isn't in the docs hub | forge-web/lib/docs-links.ts:37; forge-web/lib/docs/catalog.ts | missing (fixed) | added `rotate-storage-credentials` to the hub's Storage section; `DOCS.rotateStorage` is now `/docs/rotate-storage-credentials/`, and its three links use `<Link prefetch={false}>` like the other in-app doc links, so a base path is kept. `catalog.test.ts` checks every in-app doc link names a listed page |

## Rows deferred to other lanes

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| 32 | "Readers try the repository's own gateway, then ipfs.dashhq.org, then public gateways" | README.md:60 | ok for dg and git; missing the web app (fixed) | `forge-contracts/config/storage-defaults.json` (own gateway first, then the list headed by ipfs.dashhq.org); the web app reads as an IPFS peer first (`forge-web/lib/storage/p2p/index.ts:174` `peerFirst`; bring-your-own-storage.md, "The web app reads IPFS packs peer to peer first") |
| 33 | "Wallet sign-in works on mainnet with DashPay for Android 11.9.2+ or Dash Wallet for iOS 9.1.4+, and on testnet with DashPay for Android's testnet build" | docs/guides/README.md:51 | ok | already fixed on master; guides-identity.md rows 4 and 15 (`login-modal.tsx:346-350`) |

## Checks run

- `pnpm vitest run lib/docs/catalog.test.ts components/storage/repo-share-ui.test.tsx components/storage/self-host-backend.test.tsx components/hidden-notice.test.tsx components/ui/beta-badge.test.tsx components/docs`: all pass. `repo-share-ui.test.tsx` now compares the link without its trailing slash, since `next/link` drops it outside a `trailingSlash` build.
- `pnpm typecheck`, `pnpm lint` on the changed files, `pnpm lint:copy`: clean.
- No Rust was changed.

## Product questions

1. **`dg storage list` and shared storage.** `storage.rs:590` maps `Origin::Shared` to `shared`, but `list` never sees a shared profile, so a maintainer can't see from `dg` what an owner shares with them (only the push line says so). Should `dg storage list` (or `dg repo view`) show it per repo, or should the dead branch go?
2. **The rotation pointer in dg is a repo path.** `ROTATE_GUIDE` (`mod.rs:49`) prints `docs/guides/rotate-storage-credentials.md`, which isn't a link in a terminal. Now that the page is in the docs hub, should dg print `https://forge.dashhq.org/docs/rotate-storage-credentials/`? Tests and the testnet evidence pin the current string.
3. **No live proof of the repo-only rule.** #740 was tested in sandboxes; the testnet evidence (§11) shows the old default-storage rule. A short live run (`dg storage share`, a maintainer push, `--stop`) would back the guide's claims on testnet.
4. **Release assets from `dg`.** A maintainer's web release upload uses the owner's shared storage, but `dg release create --asset` uses only the clone's `dash.storage` or `--storage`. Should they match?

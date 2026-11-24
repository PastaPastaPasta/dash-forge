# Mainnet-readiness QA — 2026-11-24

A full QA pass of Dash Forge on testnet, run overnight before the mainnet decision. It tested master at `b5917e64`, the tip at the start, and every later merge listed below. Five lanes ran in parallel, each in its own short-lived boat.dev sandbox: web first-load and sign-in, web write flows, CLI, test suites plus relay and import, and a mainnet code audit. Nothing was registered or broadcast on mainnet, and no mainnet keys or funds were used.

**Verdict: GO for mainnet registration and launch, conditional on the owner-only steps in §5.** The QA found no launch blocker in the product. The one finding that would have made a mainnet site point users at testnet, the gateway URL, is fixed (#679). Every other finding is a should-fix or cosmetic.

## 1. Results by area

Severity: **blocker** = don't launch with this. **should-fix** = fix soon, launch can go ahead. **cosmetic** = polish.

### Web app (https://forge.dashhq.org)

| Area | What was tested | Result | Severity / PR |
|---|---|---|---|
| Cold load, desktop | first paint 0.28 s, first repo card 9.5 s, 8 DAPI requests (budget 25) | PASS | |
| Cold load, Fast/Slow 3G | first repo card ~68 s / ~239 s. A 9 MB WASM verifier (26.5 MB unpacked) shows a progress line, no stuck spinner | PARTIAL | should-fix (Brotli/split SDK) |
| Explore layout shift | CLS 0.34 desktop, 0.80 Fast-3G mobile | FAIL | should-fix |
| Cloudflare beacon | CORS error on every page (`cloudflareinsights.com/cdn-cgi/rum`). Analytics may not be recording | FAIL | should-fix (owner: check the CF dashboard) |
| Sign-in: DashPay wallet (App Connect v2) | real end-to-end approval on an Android emulator with DashPay testnet; reload keeps the session | PASS | |
| Sign-in: recovery phrase, identity file, dg handoff, paste key, lock/unlock, forget | all work; wrong-input messages are clear | PASS | |
| Sign-in: malformed Identity ID next to a phrase | raw SDK decoding error | FAIL → fixed | should-fix, #687 |
| Sign-in: passkey on another device | not exercised (headless Chromium lacks PRF) | — | owned by the passkey thread |
| Mobile 360/390/430 | all main pages and dialogs: no horizontal scroll, no overlap | PASS | |
| Error states (22 cases) | each says what happened and what to do | PASS | |
| Out-of-range `number=` on issue/PR URL | blamed the network | FAIL → fixed | should-fix, #686 |
| Profile of a well-formed but nonexistent id | normal profile with a **Follow** button: would spend real DASH on mainnet | FAIL → fixed | should-fix, #693 |
| Offline mid-session | tabs silently do nothing | FAIL | should-fix (online/offline banner) |
| Repo create (Platform storage and your own S3) | works; cost shown ≈ charged | PASS | |
| Code browse (tree, file, README, png, 1.6 MB file, commits, diff, branches, tags, blame) | | PASS | |
| Issues: create, comment, label, assign, close, reopen, filters; non-member view | | PASS | |
| PRs: open, review as non-member and as writer, fast-forward merge, conflict resolved via `dg pr checkout`, merged diff | | PASS | |
| Access control: invite, accept, writer, protected main (E601), remove (E601) | | PASS | |
| Private repo: outsiders and logged-out readers can't read it (canary never in DOM) | | PASS | |
| `/new` Private with no encryption key | asks for an unlock that can't help | FAIL → fixed | should-fix, #692 |
| Settings: description, topics, default branch, archive | | PASS | |
| Cosmetic | stale balance pill after a CLI write; fast-forward merge still asks to unlock storage; "Last activity: none yet" on a private repo; S3 endpoint pre-filled with `https://s3.example.org`; removed reviewer's old approval re-labelled "Doesn't count"; deep links return HTTP 404 from Pages (crawlers) | | cosmetic |
| Network copy | testnet badge and tDASH/faucet copy are correct; a mainnet build shows none of it | PASS | |

### CLI (`dg`, `git-remote-dash`)

| Area | What was tested | Result | Severity / PR |
|---|---|---|---|
| Build from source per docs | protoc needed (as documented); ~10 min on 8 vCPU; `install.sh` v0.2.0 works | PASS | |
| `dg doctor` on git 2.43 | no warning although docs ask for 2.44+ | PARTIAL | cosmetic |
| `dg auth login`: bare (wallet) without and with a terminal, identity file, `--mnemonic`, status, logout, re-login | | PASS | |
| `dg repo create/clone/view/list`, push, branch, tag, non-fast-forward rejection, `--force`, pull | quoted cost = balance delta | PASS | |
| `dg issue *` | | PASS | |
| `dg pr *` including **`dg pr diff` on merged PRs** (merge commit and squash) | #673 verified | PASS | |
| Second user: non-member push refused, fork + PR into parent, collaborator add/accept/remove | | PASS | |
| Storage: Platform, IPFS (kubo), S3 (RustFS); byte-for-byte round trip | | PASS | |
| `dg ipfs up` on Linux | hangs until killed | FAIL → fixed | should-fix, #695 |
| git-remote-dash missing | `dg init` creates the repo on Platform before the push fails | FAIL → fixed | should-fix, #696 |
| No network | instant E701 but blames `--devnet-name testnet` on testnet | FAIL → fixed | cosmetic, #694 |
| `DASH_FORGE_NETWORK` set after `dg auth login` | `dg` silently uses config.toml's network; `git push` uses the env var | FAIL → see §3 | should-fix |
| `dg label create` on an existing label charges again; `dg pr comment` / `collab remove` print no cost line | | | cosmetic |
| `--network mainnet` (doctor, list, view, issue/repo create, init, clone, push) | refuses with E702/E304; nothing broadcast | PASS | |

### Relay, import, Mirror Action

| Area | Result | Severity / PR |
|---|---|---|
| forge-import of a real GitHub repo (3 PRs, 15 comments, 4 reviews): refs and all 95 objects identical; re-run is a no-op | PASS | |
| forge-relay: config and on-chain webhooks, signatures valid, 3–7 s latency, go-github parses payloads, durable queue, clean SIGTERM | PASS | |
| Relay silently ignores mistyped config keys (`poll-interval` vs `poll-interval-secs`) | FAIL | should-fix (design call: a test pins today's behavior) |
| Relay start-up error for a missing repo doesn't name it | FAIL | cosmetic |
| Mirror Action renewal hint linked a 404 page and gave an export the Action refuses | FAIL → fixed | should-fix, #684 |

### Test suites and CI (master `b5917e64`)

| Suite | Result |
|---|---|
| cargo fmt, clippy `-D warnings`, json schemas | PASS |
| cargo test --workspace | PASS (2665 + 124 storage-it; 3 failures only on git 2.43, pass on CI's 2.56) |
| survivability drill, cargo-deny, gitleaks (tree + history), npm audits | PASS |
| forge-web typecheck, lint, copy lint, vitest (10143) | PASS (3 `xdiff.parity` failures are git-version-only, known) |
| forge-web builds (testnet, ipfs) and Playwright read-only testnet (234) | PASS |
| contract-validate (cv-2…cv-23), mint-identity | PASS |
| GitHub CI on master (CI, Rust, Security, Web e2e, Pages, IPFS, Release) | all green |
| Testnet Nightly | last 4 runs green (11-21, 11-22 ×2, 11-23). Tonight's 06:00 UTC schedule had not started by the report time (GitHub delays schedules) |

### Mainnet configuration (code audit)

| Check | Result | Severity / PR |
|---|---|---|
| Hardcoded testnet contract ids, endpoints or faucet links in client code | none; ids come only from `deployments/*.json`; endpoints and copy are network-conditional | PASS |
| Mainnet web build with no mainnet record / with dummy ids | builds, says "Dash Forge isn't on mainnet yet" / "contracts were not found on mainnet"; contacts mainnet hosts only | PASS |
| `dg` / helper with `--network mainnet` and no record / dummy record | E702, no fallback to testnet | PASS |
| Mainnet protocol version | 14, from a proof-verified response | PASS |
| Pages build with `PAGES_NETWORK=mainnet` but the testnet gateway URL | would ship a mainnet site whose clone and share links resolve on testnet | **blocker → fixed, #679** |
| Defaults when nothing is set: CLI, Action, check-action, GitLab template, `pages.yml`, gateway compose | all default to testnet | should-fix (owner decision) |
| Web origin `forge.dashhq.org` hardcoded for every network (CLI links, relay, gateway, passkey RP id, `dg ipfs`) | | should-fix (depends on hosting decision) |
| Security headers on forge.dashhq.org (HSTS, frame-ancestors, X-Frame-Options) | missing; DNS points straight at GitHub Pages, not through Cloudflare | should-fix, high (owner) |
| Docs drift: `deploying-to-a-network.md` (sakura, rc.4, costs), `hosting.md` (says behind Cloudflare), `roadmap.md:38`, in-app quick-start points mainnet users at testnet faucets | | should-fix |

## 2. PRs merged during this pass

All were reviewed independently (a COMMENT review starting "Verdict: approve") and merged with required CI green. PastaClaw has never reviewed a PR in this repo, so it wasn't waited on. From 02:00 to 04:00 CT, merges were held while GitHub Actions was at the account's job cap.

| PR | Fix | Merged (CT) |
|---|---|---|
| #679 | Pages build refuses a gateway that serves another network (the mainnet-site → testnet-gateway blocker) | 00:57 |
| #687 | Malformed Identity ID next to a recovery phrase gets a plain message | 01:29 |
| #684 | Mirror Action renewal hint points at `/mirror/` and the dfk1 export the Action accepts, names the repo, deletes the key file | 01:35 |
| #686 | Out-of-range issue/PR `number=` shows "No PR addressed" with no read | 04:00 |
| #692 | `/new` Private with no stored encryption key doesn't ask for an unlock that can't help | 04:00 |
| #693 | Profile of a nonexistent identity says "No such identity", with no paid Follow | 04:00 |
| #694 | Offline hint no longer blames `--devnet-name testnet` | 04:00 |
| #695 | `dg ipfs up` no longer hangs on Linux; keychain-less hint says `Bearer <token>` | 04:00 |
| #696 | `dg repo clone` / `dg init` stop with E206 before anything is spent when git-remote-dash is missing | 04:00 |
| #698 | `dg` warns when `DASH_FORGE_NETWORK` names a different network than the one it uses | approved; merging once CI is green |


## 3. Open items

**No launch blockers remain.**

Should-fix, can follow the launch:
- Security headers on the web host (owner, §5 step 12).
- Network defaults and the single web origin, which depend on the hosting decision (owner, §5 steps 1–2).
- Docs drift listed in §1.
- Explore layout shift, offline banner, Brotli or a split for the 9 MB verifier.
- Check that the Cloudflare beacon records visits.
- The relay should warn on unknown config keys.
- `?upstream=` on issue/PR URLs has no upper bound (same class as #686).
- An integration test for the #698 warning's call site.

Not exercised:
- Passkey sign-in from another device (headless Chromium lacks PRF; owned by the passkey thread).
- A real mainnet DashPay App Connect v2 sign-in. This is only possible after registration, so it's a launch smoke-test step.
- Tonight's Testnet Nightly, which had not started by the time of this report.


## 4. Spend and cleanup

About 0.28 tDASH was spent across the lanes (cli ~0.10, web-B ~0.09, relay/import ~0.07, web-A ~0.002). RELAY, DEPLOYER and MAINTAINER received faucet top-ups. Every boat sandbox was deleted. Limited keys registered by the CLI lane are disabled on chain. Testnet artifacts left behind:
- the `mnqa-web-0017` and `mnqa-web-priv-0105` repos (MAINTAINER)
- the `mnqa-cli-{plat,ipfs,s3}` repos (DEPLOYER) and FROZEN's fork
- `RELAY/dash-faucet` (import)

The web-A lane tried the BIP-39 example phrase as an "unknown" phrase. It turned out to be a real public testnet identity, and one browser key was registered on it (~0.0003 tDASH).

## 5. Mainnet launch checklist (★ = owner only)

1. ★ Decide hosting: does mainnet replace forge.dashhq.org, or get a new host while testnet stays? This sets the web-origin constants, the passkey RP ids and `NEXT_PUBLIC_SITE_URL`.
2. ★ Decide whether the mainnet release makes mainnet the default network (CLI `network.rs`, Action, check-action, GitLab template, `pages.yml`, gateway compose, docs).
3. ★ Create a dedicated mainnet deployer from a fresh mnemonic, funded with ~2.5 DASH through the bridge (`mint-identity` doesn't support mainnet). Escrow the mnemonic offline.
4. ★ Scratch rehearsal on mainnet with a different deployer, ~1.9 DASH (`deploy-v2.mjs --network mainnet --set mainnet --scratch-on mainnet`).
5. ★ Sign the `--print-sha256 --set mainnet` lines; forge-meta includes `vaultEntry`, `board` and `card` from the start.
6. `refresh-dapi.mjs --network mainnet`, then `deploy-v2.mjs --dry-run`.
7. ★ Register (`deploy-v2.mjs --network mainnet --set mainnet --expect-sha256 …`), then run the C1 check and verify the group owner and memberships by hand.
8. Registration PR: `deployments/mainnet.json` v2, `contracts/registered/mainnet/*`, the `build.py` registration entry, the `deployments/contracts/mainnet.json` snapshot and its `contract-seed.ts` entry, `deployments/fixtures/mainnet.json`, `SHOWCASE.mainnet`.
9. Release clients: tag, `dg`/helper binaries, Action/GitLab `FORGE_VERSION`.
10. ★ Mainnet gateway (`DASH_FORGE_NETWORK=mainnet`, `GATEWAY_WEB_URL`), or unset `PAGES_GATEWAY_URL`. #679 now refuses a mismatched pair.
11. ★ Repository variables `PAGES_NETWORK=mainnet`, `PAGES_GATEWAY_URL`, `PAGES_NOTIFY_URL`; deploy Pages.
12. ★ Security headers: Cloudflare proxy plus the hosting.md §7 rule, or a host that sends them.
13. Mainnet smoke tests with a labelled QA identity (CLI e2e + Playwright). ★ A real DashPay App Connect v2 sign-in and one write on a phone. This can't be tested before registration.
14. ★ Remove the deployer's CRITICAL key from the signing machine; update docs (networks, FAQ, README, in-app guides, CHANGELOG); announce.

Lane evidence (screenshots and logs) was collected on the QA host under `/work/scratch/mnqa/` and is not committed.

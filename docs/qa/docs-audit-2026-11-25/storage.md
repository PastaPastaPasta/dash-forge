# Docs audit 2026-11-25: storage lane

Storage, IPFS, hosting, limits and costs docs, checked against `origin/master` at 1b547336, the prebuilt `dg 0.2.0` from that commit, and the live sites. `fixed` means this PR changes the doc. `deferred` means maintainer storage sharing: another thread is changing it, so those passages are untouched.

| # | Claim (short quote) | Location | Verdict | Evidence |
|---|---|---|---|---|
| 1 | Storage profiles live in `storage.toml`, "only you" can see them | docs/guides/bring-your-own-storage.md:29 | missing, fixed | On testnet a wallet sign-in also syncs them, encrypted, to `forge-user` (`crates/dg/src/sync.rs`, `forge-contracts/deployments/testnet.json` `user`; mainnet.json has no `user`) |
| 2 | "Secrets are never written … to the chain" | bring-your-own-storage.md:41 | wrong (testnet), fixed | `forge-web/lib/user-sync/storage-slot.ts` puts `profile:<name>` `{settings, secrets}` in the encrypted `state` slot |
| 3 | Wizard transcript: Cloudflare R2 preset "recommended: free egress", all rows OK | bring-your-own-storage.md:65-89 | stale, fixed | #715 kept only tested providers (RustFS, Garage). Rewritten on the "MinIO / other S3-compatible" path with the real prompts (`crates/dg/src/storage_wizard.rs:101,169`), check rows (`storage.rs` `run_checks`) and fix text (`forge-core/src/storage/cors.rs:353`) |
| 4 | Transcript's CORS line names `https://forge.dashhq.org` | bring-your-own-storage.md:80 | wrong (default), fixed | `dg` defaults to testnet (`dg storage --help`: "default: testnet"); the check uses `ctx.network().web_origin()` (`storage.rs:182`, `network.rs:98`) |
| 5 | Web wizard at Settings → Storage "on forge.dashhq.org" | bring-your-own-storage.md:101 | stale, fixed | Both sites have it; testnet-forge.dashhq.org live |
| 6 | Web wizard: "Cloudflare R2 (recommended: free egress)", Platform "about 0.33 DASH/MiB" | bring-your-own-storage.md:103 | wrong, fixed | The wizard shows `~${PUSH_COST_DASH.perMib}` = 0.39 (`forge-web/lib/sdk/cost.ts:437-445`); R2/B2/AWS untested (#715) |
| 7 | "Credentials stay in this browser … never written on chain" | bring-your-own-storage.md:105 | wrong (testnet), fixed | `forge-web/components/storage/sync-note.tsx`; design §10 as built |
| 8 | Storage that follows the identity: testnet only, mainnet local until `forge-user` is registered | bring-your-own-storage.md (new section) | missing, fixed | `deployments/testnet.json` `user.contractId 46phmETa…`; mainnet.json has none; `dg auth login --help` `--no-sync`; `dg storage list` origin words (`storage.rs:346-351`) |
| 9 | `dg ipfs up` "opens the web app's connect page" | bring-your-own-storage.md:182 | stale (#727), fixed | `crates/dg/src/ipfs/mod.rs:116-121,330`: prints link and code; `--open` opts in |
| 10 | kubo 0.43.1, checked against a built-in SHA-512 | bring-your-own-storage.md:182; run-your-own-ipfs-node.md:28 | ok | `ipfs/mod.rs:33`, `ipfs/install.rs` |
| 11 | Caddy preflight proxy recipe, `bind 127.0.0.1` | bring-your-own-storage.md:236-273 | ok | Same text the wizard prints (`forge-web/lib/storage/cors.ts:110`); loopback only by design |
| 12 | Push verify: full GET + SHA-256 up to 16 MiB | bring-your-own-storage.md:52; limits.md:25 | ok | `forge-core/src/storage/targets.rs:24` `FULL_VERIFY_MAX` |
| 13 | Read deadline `max(120 s, size ÷ 1 MiB/s)` | bring-your-own-storage.md:408; limits.md:24 | ok | `storage/read.rs:33` |
| 14 | Cost guard 0.05 DASH, `dash.confirm` modes, 1 MiB Platform ask | bring-your-own-storage.md:375-391 | ok | `crates/git-remote-dash/src/policy.rs:11,71,92` |
| 15 | Default gateway list in `storage-defaults.json` | bring-your-own-storage.md:412 | missing, fixed | ipfs.dashhq.org (#702) is the first entry and wasn't named; live (it answers at `https://ipfs.dashhq.org/ipfs/<cid>`; `/` is a 404) |
| 16 | Browser peer reads: Chrome 119 / Firefox 121 / Safari 17.4, 1.5 s head start, ~1 MiB/s floor, 5-minute breaker, `forge.ipfsPeer` | bring-your-own-storage.md:425-429 | ok | `forge-web/lib/storage/p2p/index.ts:22,26,52,149,151` |
| 17 | Mirror record "costs about 0.00075 DASH" | bring-your-own-storage.md:478; pin-and-fork.md:32 | stale, fixed | 0.00075 is the quote (`pack_mirror.rs:26`, `repo_pin.rs:29`); measured 0.00048 later, 0.00064 first (`forge-web/lib/sdk/cost.ts:100-101`, costs.md) |
| 18 | S3 providers named as tested | bring-your-own-storage.md:165, home-nas-storage.md:3 | ok | Only RustFS and Garage, amd64 and arm64 (#715). Example profile names like `r2-main` remain; they claim nothing |
| 19 | `dg ipfs up` steps, files, ports, services (`org.dashforge.ipfs`, `dash-forge-ipfs.service`, `DashForgeIPFS`) | run-your-own-ipfs-node.md:26-110 | ok | `ipfs/service.rs:69,148,152,202`; `pair.rs:26` code lifetime 600 s |
| 20 | "connects it to the Forge web app" | run-your-own-ipfs-node.md:3 | stale (#727), fixed | It prints a link and a code (`ipfs/mod.rs` `print_connection`) |
| 21 | Link opens forge.dashhq.org; both Forge origins always allowed | run-your-own-ipfs-node.md:58 | ok | `ipfs/config.rs:18-20,229` |
| 22 | "Two cautions" followed by one | run-your-own-ipfs-node.md:160 | wrong, fixed | One bullet |
| 23 | Browser table: Edge, Firefox, Brave "work" | run-your-own-ipfs-node.md:137-142 | wrong (untested), fixed | Only Chrome 158 was tested (#727 body); no record of Edge, Brave or Firefox |
| 24 | Web Pin: `Update pin (N new)`, 512 MiB browser cap, copyable `dg repo pin … --follow` | run-your-own-ipfs-node.md:275-279; pin-and-fork.md:12 | ok / stale, fixed | `forge-web/lib/storage/pin-copies.ts:165-168`; `components/repo/pin-button.tsx:68,106`. pin-and-fork said "Update pin" |
| 25 | `dg repo pin/unpin/fork --storage/--no-copy/sync` | pin-and-fork.md:16-27 | ok | `dg repo --help`, `dg repo fork --help`; `repo_pin.rs:37-55` |
| 26 | Link text "Self-host a storage backend" | pin-and-fork.md:8 | wrong, fixed | The page is "Run your own backend" |
| 27 | backend.sh: kubo 0.43.1, Caddy 2.11.7, host networking, IPv4+IPv6 | self-host-backend.md:25-30 | ok | `backend.sh:53-54,224,239,263` (ip4 and ip6 swarm addresses) |
| 28 | Plain-http ports only for private networks incl. IPv6 ULA and link-local | self-host-backend.md:149 | ok | `backend.sh:60` `PRIVATE_NETS` |
| 29 | ufw rules for private networks | self-host-backend.md:50 | ok | `backend.sh:639` includes `fc00::/7 fe80::/10` |
| 30 | "DNS (A and/or AAAA record)" for `--domain` | self-host-backend.md:101 | stale (dual stack), fixed | Now asks for A and AAAA; reachability hint mentions the IPv6 firewall |
| 31 | Troubleshooting messages | self-host-backend.md:157-167 | ok | `backend.sh:169,173,279,393,430,568,573` |
| 32 | RustFS/Garage compose, uid 10001, Garage `[::]` binds | home-nas-storage.md:38-119 | ok | Garage binds are dual stack; Docker `ports:` publishes on IPv4 and IPv6 |
| 33 | Public https address: no DNS guidance | home-nas-storage.md:121-130 | missing (dual stack), fixed | Added A + AAAA and both listeners, or a tunnel |
| 34 | `dg storage test` rows, push output lines | home-nas-storage.md:258-285 | ok | `storage.rs:827,903`; `git-remote-dash/src/progress.rs:414,476`, `helper.rs:6309` |
| 35 | Rotating credentials for shared storage | docs/guides/rotate-storage-credentials.md (whole page) | deferred | Maintainer storage sharing; another thread is changing it. Note: the page doesn't say sharing exists on testnet only, and its R2 section is an untested provider |
| 36 | Fork "parent packs referenced, not uploaded" | costs.md:139; economics.md:93 | stale (#718/#720), fixed | `dg repo fork` copies to your storage unless `--no-copy` |
| 37 | Pack mirror row; pin not mentioned | costs.md:134 | missing, fixed | One mirror per pack on pin (`repo_pin.rs:296`) |
| 38 | `dg storage use r2-main,platform` | costs.md:281 | stale, fixed | Example profile now `nas` |
| 39 | Platform rate ~0.39 DASH/MiB quoted, 0.33–0.36 measured | costs.md:53,279; economics.md:49 | ok | `fmt.rs:224` `platform_rate_dash_only`; `cost.ts:443` |
| 40 | Mainnet epoch 9.125 days; testnet 1 h, ~83 days | costs.md:293; economics.md:60 | ok | rs-drive-abci default cited; not re-measured here |
| 41 | Deployer cost "~1.86 DASH … 1.873 on testnet" | economics.md:100 | noted for guides-ops | The mainnet registration (2026-11-24) is not listed; `deploying-to-a-network.md` owns the number |
| 42 | Hosting: GitHub Pages, no Cloudflare proxy, `max-age=600`, wasm 26.5 MB / 9.0 MB gzip, one beacon, http→https 301 | docs/hosting.md:3-13,97 | ok | `curl -sI https://forge.dashhq.org/` (server GitHub.com, cache-control max-age=600); wasm content-length 9046742, 26513399 bytes; beacon count 1; 301 to https |
| 43 | Sites reachable over IPv4 and IPv6 | docs/hosting.md | ok | `dig AAAA forge.dashhq.org @1.1.1.1`: CNAME to pastapastapasta.github.io with four AAAA records |
| 44 | nginx example with no `listen` lines | docs/hosting.md:229 | missing (dual stack), fixed | Added `listen 443 ssl;` and `listen [::]:443 ssl;` |
| 45 | "dashhq runs one for forge.dashhq.org" (gateway) | docs/hosting/forge-gateway.md:5 | wrong, fixed | `curl https://git-forge.dashhq.org/readyz`: `"network":"testnet"`; `/og/alice/project` and `/alice/project` go to testnet-forge.dashhq.org; repo variables: `TESTNET_SITE_GATEWAY_URL` set, `PAGES_GATEWAY_URL` unset |
| 46 | `.env` example: testnet with `GATEWAY_WEB_URL=https://forge.dashhq.org` | forge-gateway.md:80-82 | wrong, fixed | That's the mainnet site; dashhq's gateway uses testnet-forge |
| 47 | Badge and share-link examples open forge.dashhq.org | forge-gateway.md:196,204-207 | wrong, fixed | git-forge serves testnet repos and opens testnet-forge |
| 48 | `GATEWAY_LISTEN` defaults `127.0.0.1:8080` / image `0.0.0.0:8080` | forge-gateway.md:113 | ok, missing IPv6 note, fixed | `services/forge-gateway/src/config.rs:33`, `Dockerfile:77`; added `[::1]` / `[::]` |
| 49 | VPS DNS "an A (and AAAA) record" | forge-gateway.md:158 | stale (dual stack), fixed | Now A and AAAA, with the proxy on both |
| 50 | Egress firewall: IPv6 rules commented out | forge-gateway.md:244-255 | stale (dual stack), fixed | Full ip6tables block, for a compose network with `enable_ipv6` |
| 51 | IPv6 rate limits by /64 and /48 | forge-gateway.md:230; services/forge-gateway/README.md:28 | ok | `services/forge-gateway/src/limits.rs` |
| 52 | Pages workflow reads `PAGES_GATEWAY_URL` | forge-gateway.md:343 | missing, fixed | Testnet uses `TESTNET_SITE_GATEWAY_URL` (`pages-testnet.yml:70-71`) |
| 53 | "dashhq runs one for forge.dashhq.org" (notify) | docs/hosting/forge-notify.md:5 | wrong, fixed | `notify-forge.dashhq.org` doesn't resolve; no `PAGES_NOTIFY_URL` or `TESTNET_SITE_NOTIFY_URL` variable |
| 54 | Notify `.env` example: testnet with the mainnet web URL | forge-notify.md:84-86 | wrong, fixed | Now `mainnet` |
| 55 | `FORGE_NOTIFY_LISTEN` default `0.0.0.0:8080` | forge-notify.md:121 | ok, missing IPv6 note, fixed | `services/forge-notify/src/config.rs:34` |
| 56 | Privacy URL `https://forge.dashhq.org/privacy/notify/` | forge-notify.md:87 | noted | No such page in forge-web; it is an example for an operator to publish (checklist item 6) |
| 57 | "the hosted notification service (forge-notify, run by dashhq)" | docs/hosting/members-only-notifications.md:3 | wrong, fixed | Not running (row 53) |
| 58 | Sizes: 20,480 B transition, 4,900 B field, 14,700 B chunk | docs/limits.md:15-17 | ok | `forge-core/src/pack.rs:64,70,73` |
| 59 | Browser release asset 256 MiB; `dg auth new` key 0.25 DASH | limits.md:28,66 | ok | `forge-web/lib/repo/new-release.ts:60`; `crates/dg/src/auth/mod.rs:41` |
| 60 | Passkeys live "on testnet since … 2026-10-26"; mainnet "part of the registration set" | docs/security/passkey-vault.md:3,86 | stale, fixed | `deployments/mainnet.json` v2 `forgeMeta` 9M8qFSM4… deployed 2026-11-24, with `vaultEntry` (`contracts/mainnet/forge-meta.json:673`) |
| 61 | RP ids "exactly forge.dashhq.org and localhost" | passkey-vault.md:31 | wrong, fixed | `forge-web/lib/auth/passkey-vault/policy.ts:19` also allows `testnet-forge.dashhq.org` |
| 62 | "§16 … no client implements it yet" | docs/security/private-repos.md:3 | stale, fixed | §16's own status (line 595): dg, forge-web and forge-import read and write sealed releases |
| 63 | Encryption key custody, blast radius, rekey commands | private-repos.md:313-331 | ok | `dg auth keys add --encryption`, `rotate --encryption` exist (`dg auth keys --help`) |
| 64 | `E` (the forge-user key) can't open private-repo content | design/identity-synced-state.md §6 | ok | Separate key, bound to `forge-user` |

## Noted for other lanes

- **webcopy-repo:** the IPFS connect page's Safari notice says "Use dg to push, or Chrome, Firefox or Brave" (`forge-web/lib/storage/kubo-connect.ts:31`); only Chrome was tested. The Pin dialog's no-storage copy says "an S3 or R2 bucket" (`components/repo/pin-button.tsx`).
- **cli:** `dg storage add --kind s3` help lists "AWS S3, Cloudflare R2, Backblaze B2, MinIO" (`main.rs:2411`), and `--endpoint`/`--region` examples use R2/B2.
- **guides-ops:** economics.md and costs.md cite the testnet registration cost; the mainnet one (2026-11-24) belongs in deploying-to-a-network.md.

## Product questions

1. **Wizards recommend an untested provider.** `dg storage add` ("Cloudflare R2 … recommended: free egress", `storage_wizard.rs:169`) and the web wizard (`forge-web/lib/storage/profiles.ts:89`) recommend R2, and list B2, AWS and the archived MinIO, none tested live. The docs now say so. Should the UI drop "recommended", or should R2 get a live test?
2. **dashhq's gateway is testnet only.** Is a mainnet gateway (and `PAGES_GATEWAY_URL`) planned? The compose file and binary default `GATEWAY_WEB_URL` to the mainnet site while `DASH_FORGE_NETWORK` defaults to testnet, so a gateway started with defaults links testnet repositories to forge.dashhq.org. Change the defaults?
3. **IPv4-only listen defaults.** The gateway image (`GATEWAY_LISTEN=0.0.0.0:8080`) and forge-notify (`0.0.0.0:8080`) default to IPv4. Behind a same-host proxy that is harmless, but should they default to `[::]:8080`?
4. **Browser IPFS peer is IPv4 only.** `storage-defaults.json` `ipfsPeers` lists only a `/dns4/…` address for the dashhq node. If that node has IPv6, add a `/dns6/…` entry so IPv6-only browsers can dial it.
5. **forge-notify.** The docs now say dashhq doesn't run one yet. Is it still planned for mainnet?
6. **`forge-user` on mainnet.** Registering it (owner-only, from deployer `CL4UTHLA…`) turns on storage sync there; until then the docs say mainnet storage settings stay on the device.
7. **The rotate-storage-credentials guide** (deferred) says nothing about sharing existing on testnet only, and leads with Cloudflare R2. Worth a pass once the maintainer-storage change lands.

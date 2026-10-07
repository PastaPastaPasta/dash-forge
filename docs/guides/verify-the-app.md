# Verify the app you loaded

Forge's web app is a static site with no backend. Anyone can host it, and every release publishes a copy for IPFS that you pin yourself. This page shows how to check that the copy in your browser was built from the released source, and nothing else.

The check has three independent parts. Each one is enough to catch a swapped build, and they fail in different ways:

1. **Rebuild it yourself.** The build is reproducible: the same tag always gives the same bytes, and so the same IPFS CID. You rebuild from the tag and get a CID.
2. **The GitHub release** names a CID. GitHub Actions built it on two machines, and they had to agree.
3. **The Forge release** of the same tag, on Dash Platform, names the same files by SHA-256, signed by the maintainer's identity.

If your CID, the GitHub release's and the Forge release's all match the CID in the app's footer, the app you loaded is the released one.

1. [What a release publishes](#what-a-release-publishes)
2. [Step 1: the CID of the app you loaded](#step-1-the-cid-of-the-app-you-loaded)
3. [Step 2: rebuild the CID from the tag](#step-2-rebuild-the-cid-from-the-tag)
4. [Step 3: compare with the GitHub release](#step-3-compare-with-the-github-release)
5. [Step 4: compare with the Forge release on chain](#step-4-compare-with-the-forge-release-on-chain)
6. [Check a deployed copy: `dg verify-app`](#check-a-deployed-copy-dg-verify-app)
7. [What this proves, and what it does not](#what-this-proves-and-what-it-does-not)
8. [For maintainers: publishing the Forge release](#for-maintainers-publishing-the-forge-release)

---

## What a release publishes

Each `v<version>` release on GitHub carries, next to the CLI archives:

| File | What it is |
|---|---|
| `forge-web-<version>.cid` | The site's root CID (CIDv1), one line. It is also in the release notes. |
| `forge-web-<version>.car` | The whole site as a [CAR file](https://ipld.io/specs/transport/car/carv1/). Import it into your IPFS node to pin the app. |
| `forge-web-<version>.manifest.json` | Every file of the site with its SHA-256: what [`dg verify-app`](#check-a-deployed-copy-dg-verify-app) checks a copy against. The site also serves it as `forge-manifest.json`. |
| `SHA256SUMS` | The SHA-256 of these files and of every CLI archive, with a GitHub build provenance attestation. |

Nobody pins this copy for you: Forge hosts nothing. To run it from your own node:

```sh
ipfs dag import forge-web-<version>.car      # pins the site; prints its root CID
# then open http://<cid>.ipfs.localhost:8080/
```

The build works from any gateway: by subdomain (`https://<cid>.ipfs.<gateway>/`), by path (`https://<gateway>/ipfs/<cid>/`), or from an ordinary static host. It finds its own base path when it loads.

The release build reads the network set in `forge-web/scripts/ipfs-release.sh` (`RELEASE_NETWORK`, `RELEASE_DEVNET_NAME`): devnet sakura today, mainnet once Forge is registered there. The network is part of the build, so it is fixed per commit.

---

## Step 1: the CID of the app you loaded

The footer of every page says **About this build**: the commit the app was built from and, when it was loaded from IPFS, the CID in the address bar. Write down both.

**The CID in the footer comes from the URL, so it is only as good as whatever served the page.** A public gateway could serve any bytes under any CID. Only an IPFS node checks the blocks it serves against the CID it was asked for. So load the app through a node you run yourself (`ipfs dag import` above, or `ipfs pin add <cid>`, then `http://<cid>.ipfs.localhost:8080/`). Your node then refuses any byte that does not hash to that CID, and the footer's CID is the app you are running.

A build served from an ordinary host (such as forge.dashhq.org on GitHub Pages) shows its commit, but no CID. That build is not the IPFS variant. [`dg verify-app`](#check-a-deployed-copy-dg-verify-app) checks it file by file against the manifest its deploy published. To check it, rebuild that commit with `FORGE_BUILD_COMMIT=<commit> pnpm build`, the network it reads and the optional services it shows (`NEXT_PUBLIC_GATEWAY_URL` and `NEXT_PUBLIC_GATEWAY_LABEL` when the clone box has an HTTPS row, `NEXT_PUBLIC_NOTIFY_URL` when Settings has email and push, `NEXT_PUBLIC_DEVNET_NOTICE` when a devnet notice shows): every file you build should be served byte for byte (the Pages deploy also keeps the previous two builds' chunks, so it serves more files than you built). The commit's page on GitHub is linked from the footer.

---

## Step 2: rebuild the CID from the tag

You need git and Docker (x86_64 or arm64).

```sh
git clone https://github.com/PastaPastaPasta/dash-forge && cd dash-forge
forge-web/scripts/ipfs-release.sh reproduce v<version> ipfs-build
```

It prints the CID, and writes `ipfs-build/forge-web.cid`, `ipfs-build/forge-web.car` and `ipfs-build/site.tar` (the files themselves). It takes a few minutes. The script:

- runs the tag's own copy of itself, so the tag is built with the pins and network its release used, whichever checkout you start from;
- takes `git archive` of the tag's commit, so nothing from your checkout (local changes, `node_modules`, `.next`) gets in;
- builds it in the Node image pinned by digest (`NODE_IMAGE`), with pnpm pinned by integrity (`PNPM_INTEGRITY`) and every dependency by `forge-web/pnpm-lock.yaml`;
- clears the environment, so the build sees only what the script sets: the commit, the network, `SOURCE_DATE_EPOCH` (the commit's time, which dates the files in `site.tar`; the CID records no times) and fixed values for `CI`, the locale and the time zone;
- computes the CID with the kubo image pinned by digest (`KUBO_IMAGE`), in a throwaway offline repository set up with IPIP-499's `unixfs-v1-2025` import profile, with the flags in `IPFS_ADD_FLAGS` (CIDv1, raw leaves, SHA-256, 1 MiB chunks).

Read the script before you run it: it is short, and it is what you are trusting.

What makes the build reproducible, in `forge-web/next.config.js`: the Next.js build id is the commit (Next's default is random), module ids are hashed into a range wide enough that none collide (webpack's default settles collisions in an order that varies between runs), entry chunks are named by the hash of their final bytes (Next's default name hashes webpack's internal state, which varies under load), and nothing reads the clock. The release workflow builds every tag on an x86_64 and an arm64 runner and refuses to publish unless both give the same CID (`.github/workflows/web-ipfs.yml`), and every pull request that touches the web app runs the same check.

**Without Docker.** In a checkout of the tag, `cd forge-web && pnpm install --frozen-lockfile && FORGE_BUILD_COMMIT=$(git rev-parse HEAD) NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=sakura pnpm build:ipfs` builds the same site with your own Node. The result matches only if your Node and pnpm are the pinned versions and your environment adds nothing, so a mismatch there is not evidence of anything. Use the script for the real check. To get a CID for a directory you built, `forge-web/scripts/ipfs-release.sh cid forge-web/out` (still needs Docker, for the pinned kubo), or, on a kubo of the pinned version, a repository initialised with `ipfs init --profile=unixfs-v1-2025` and `ipfs add` with the flags in `IPFS_ADD_FLAGS`.

---

## Step 3: compare with the GitHub release

```sh
gh release download v<version> --repo PastaPastaPasta/dash-forge \
  --pattern 'forge-web-*' --pattern SHA256SUMS
cat forge-web-<version>.cid                           # the release's CID
sha256sum --check --ignore-missing SHA256SUMS         # the files are the ones listed
gh attestation verify forge-web-<version>.car --repo PastaPastaPasta/dash-forge
cmp forge-web-<version>.car ipfs-build/forge-web.car  # your rebuild: byte-identical
```

- The `.cid` file, the release notes and your `ipfs-build/forge-web.cid` must be the same CID.
- The CAR from the release and the one you built must be identical, byte for byte.
- `gh attestation verify` checks the Sigstore provenance: the CAR was produced by this repository's `release.yml` at that tag. It does not rely on any key of ours.

---

## Step 4: compare with the Forge release on chain

Forge's own repository is mirrored on Forge, and each release is recorded there too, as a Forge `release` document for the same tag. It lists `forge-web-<version>.car` and `forge-web-<version>.cid` among its assets, each with its SHA-256, and its notes name the CID. The document is written with the maintainer's Platform identity and read back with a Platform proof, so it does not depend on GitHub at all.

```sh
dg --devnet-name sakura --json release list <owner>/dash-forge   # each asset's sha256
dg --devnet-name sakura release download <owner>/dash-forge v<version> \
  --asset forge-web-<version>.cid --output forge-release.cid
cat forge-release.cid
sha256sum ipfs-build/forge-web.car                    # must equal the CAR's listed sha256
```

`<owner>` is the maintainer identity that mirrors this repository on Forge (the README names it once the mirror is published). Use `--network mainnet` in place of `--devnet-name sakura` once Forge is on mainnet.

- `dg release download` accepts only bytes that hash to the SHA-256 in the proof-checked release document ([`E504`](../errors.md#e504) otherwise), so `forge-release.cid` is the CID the maintainer recorded.
- The web app shows the same on the repository's **Releases** page: each asset with the start of its SHA-256 (the whole digest on hover), downloaded and checked in the browser.

---

## Check a deployed copy: `dg verify-app`

Every build of the web app lists its files with their SHA-256 in `forge-manifest.json`, at the site's root. `dg verify-app` fetches every listed file from a site and checks each one:

```sh
dg verify-app https://forge.dashhq.org
```

```
Site:      https://forge.dashhq.org/
Build:     commit 0f605099596192a525f99c6cbafab4e54b29cee4 (devnet-sakura, host build)
Manifest:  attested by PastaPastaPasta/dash-forge's CI (`gh attestation verify --repo PastaPastaPasta/dash-forge` on the manifest checks the signature)
Files:     174 of 174 match
```

The site could rewrite its own manifest, so `dg` trusts it only when it is published elsewhere:

- **By default**, it asks GitHub for a build provenance attestation of the served manifest's SHA-256 from this repository's CI. The Pages deploy (`pages.yml`) attests each build's manifest, and every release attests `forge-web-<version>.manifest.json` through `SHA256SUMS`. To check the attestation's Sigstore signature yourself, download the manifest and run `gh attestation verify forge-manifest.json --repo PastaPastaPasta/dash-forge`.
- **With `--manifest <file>`**, it checks against a manifest you got yourself. The strongest is a release's manifest from the Forge release on chain: `dg release download <owner>/dash-forge v<version> --asset forge-web-<version>.manifest.json --output manifest.json`, then `dg verify-app <url> --manifest manifest.json`.

Any build this repository ever published passes, an older one included. To require the build you expect, add `--commit <sha>` (7 characters or more).

It fails (exit 5, [`E504`](../errors.md#e504)) when the site has no manifest, when GitHub has no attestation for it, when it is not the `--commit` you named, or when any listed file can't be fetched, is missing or differs, and it names each one. It asks for each file as a browser does, so a host that changes pages only for browsers (an injected analytics script) fails the check. `--json` gives the counts and the lists. Set `GITHUB_TOKEN` to lift GitHub's anonymous rate limit. The nightly workflow runs it against forge.dashhq.org.

**In the app.** When you unlock a private repository (or manage your encryption key in Settings), the app makes the same lookup for its own manifest. If GitHub has no attestation for it, a note says the copy isn't a published build. Unpublished code could read what you unlock. The note is a check for mistakes and unofficial copies, not a defence: a malicious build can leave it out. `dg verify-app` checks a site from outside.

**What it checks.** The files this run was served, not what someone else gets: a host can serve different bytes to different visitors. Files the site serves beyond the manifest are not checked (the Pages deploy keeps the previous two builds' chunks for open tabs), but the pages and scripts the manifest lists load only each other.

---

## What this proves, and what it does not

**It proves** that the files in your browser are, byte for byte, what the tagged source builds into, if you loaded them through your own node and the CIDs match. Two parties vouch for the CID independently of your rebuild: GitHub Actions (Sigstore attestation) and the maintainer's identity on Platform (a signed release document).

**It does not prove** that the source is safe. It tells you which source you are running, so a review of that tag applies to the app you loaded. Read the diff between tags, or trust someone who did.

Also:

- **Public gateways are not checked.** A gateway you do not run could serve different bytes under the right CID. Pin the CAR on your own node, or rebuild and serve `site.tar` yourself.
- **The build's network is fixed.** A release built for devnet sakura reads sakura. Proofs from Platform are still checked in the browser against the quorum keys, whatever the build ([Check that Forge isn't lying to you](verify-forge.md)).
- **A new release changes the CID.** Every release build embeds its commit (the footer), so no two commits share a CID.
- **Short links are for ordinary hosts.** A short URL such as `/<owner>/<name>/issues/12` opens through the build's `404.html`, which IPFS gateways do not serve for a missing path. So the IPFS build's **Copy link**, permalinks and address bar give the canonical routes (`/repo/?owner=…&name=…`) instead, which open from any gateway.

---

## For maintainers: publishing the Forge release

The GitHub release is automatic (`release.yml`). The Forge release is not: writing it needs the maintainer's Platform identity key, and no Forge key is ever stored in CI. After the GitHub release is published, the owner runs, from a checkout of the repository:

```sh
v=<version>
gh release download "v$v" --repo PastaPastaPasta/dash-forge --pattern 'forge-web-*' --pattern SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
forge-web/scripts/ipfs-release.sh reproduce "v$v" ipfs-build
cmp "forge-web-$v.car" ipfs-build/forge-web.car            # never record a build you did not reproduce
cid=$(cat "forge-web-$v.cid")
dg --devnet-name sakura release create <owner>/dash-forge --tag "v$v" --name "Dash Forge v$v" \
  --notes "Web app on IPFS: $cid (forge-web-$v.car; verify: docs/guides/verify-the-app.md)" \
  --asset "forge-web-$v.car" --asset "forge-web-$v.cid" --asset "forge-web-$v.manifest.json" --storage <profile>
ipfs dag import "forge-web-$v.car"                          # optional: pin the app on your own node
```

`dg release create` uploads each file to your storage, checks the copies, and records `{name, sha256, sizeBytes, uris}` for each in the release's `assets`. Release assets are external-only, so name an S3 or IPFS storage profile with `--storage` ([Bring your own storage](bring-your-own-storage.md)); without it, `dg` uses the `dash.storage` of the repository you run it in, and a checkout of the GitHub repository has none, so it refuses before anything is written. The CAR is about 30 MB (mostly the Platform SDK's wasm). An IPFS profile stores it as one file, which is not the same as pinning the site: `ipfs dag import` does that.

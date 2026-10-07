# Check that Forge isn't lying to you

Forge is built so that you do not have to trust any server: not the web host, not the Platform node you talk to, not the bucket or gateway that serves the bytes. This page shows what that rests on, where it still rests on trust, and how to check it yourself.

1. [What is checked, and against what](#what-is-checked-and-against-what)
2. [The one trusted input: quorum keys](#the-one-trusted-input-quorum-keys)
3. [The Verification card](#the-verification-card)
4. [Verify a repository yourself](#verify-a-repository-yourself)
5. [The third-party verification script](#the-third-party-verification-script)
6. [Run your own copy of the web app](#run-your-own-copy-of-the-web-app)

---

## What is checked, and against what

A clone or a page view involves three kinds of data. Each is checked differently:

| Data | Comes from | Checked by |
|---|---|---|
| **Platform documents**: ref updates, pack manifests, issues, PRs, members | A Dash Platform node (DAPI) | A **proof**: a Merkle proof signed by the Platform validator quorum. The client checks the proof against the quorum's public key. A node that returns false or incomplete data cannot produce a valid proof. |
| **Pack bytes** | Your bucket, an IPFS gateway, an HTTPS mirror, or Platform chunks | The **SHA-256** in the proof-checked manifest. Bytes that do not match are refused ([`E504`](../errors.md#e504)), and the reader tries the next copy. |
| **Git objects**: commits, trees, files | Unpacked from those bytes | Their **git id**, which is a hash of their content. Git checks every object it receives, and the web app re-hashes every object it shows. |

The chain runs: quorum key → proof → ref tip and pack SHA-256 → pack bytes → git objects. A lying bucket can make a pack **unavailable**, but it cannot make you accept wrong code. A lying node can refuse to answer, but it cannot forge a proof.

Two things are **rules**, not proofs, and every client applies them identically:

- **Which tip wins.** A branch's tip is folded from its ref-update log (the `FORGE_RULES_V2` fold). If two pushes raced, the ref shows as *diverged*, and the web app says so.
- **Who counts.** Whether an approval was made by someone with the right role on the PR's current head, and whether a merge's commit was a tip of the base branch (a plain update to a protected branch does not count). Consensus already checks membership when a close, merge or other state change is written; the rules decide which approvals count and when a PR shows as merged.
- **What is well-formed.** Documents that break the rules, such as a ref name that does not hash to its indexed key, are hidden from lists and counted as hidden.

The Rust and TypeScript clients share more than 200 conformance vectors (`forge-contracts/vectors/`), so the CLI and the web app reach the same answer from the same documents.

---

## The one trusted input: quorum keys

A proof is only as good as the quorum public key it is checked against. Today, **both the CLI and the web app fetch those keys over HTTPS from one endpoint** per network:

| Network | Quorum key endpoint |
|---|---|
| testnet | `https://quorums.testnet.networks.dash.org` |
| mainnet | `https://quorums.mainnet.networks.dash.org` |
| devnet sakura | `https://quorums.sakura.networks.dash.org` |

Whoever controls that endpoint could hand out a key of their own and vouch for false data. So Forge is **trust-minimized, not trustless**. `dg doctor` prints the endpoint in use on its `target` line. You can [choose another](#point-the-tools-at-another-key-source).

### The web app cross-checks the keys with a second source

On every repository page the web app fetches the quorum list again from that endpoint, and also asks a random Platform node for its list (DAPI's `getCurrentQuorumsInfo`, trying up to three nodes until one answers). It compares the keys quorum by quorum:

| Outcome | What the **Chain data** row shows |
|---|---|
| Both sources answered, and every quorum the endpoint lists is in the node's list with the identical key | **Verified**, naming both sources and how many quorums agreed |
| A quorum has a different key in each source, or is listed twice | **Failed**: "Do not rely on this page", with the quorum hashes. Use the CLI against a node you run |
| No node answered, or none is configured for this network | **Partly verified**: "Only one key source answered" |
| The node's list lacks a quorum the endpoint lists, even after one retry (usually a rotation between the two reads), or the endpoint did not answer | **Partly verified**: "The keys could not be compared with a second source", with the reason |

The card says plainly that the app compared a fresh fetch of the key list: it cannot inspect the copy the SDK itself holds. The DAPI node lists come from `forge-contracts/deployments/<network>.json`.

The CLI does not cross-check yet: `dg` and `git-remote-dash` trust the endpoint. **Coming soon:** quorum verification over SPV in the CLI, so that it needs no key endpoint at all.

### Cross-check the quorum keys yourself

The endpoint serves the current validator quorums as JSON:

```sh
curl -s https://quorums.testnet.networks.dash.org/quorums \
  | jq -r '.data[] | "\(.height)  \(.quorum_hash)  \(.key)"' | head
```

Each line is a quorum's block height, its quorum hash and its BLS public key. To check them without trusting the endpoint, ask a **Dash Core full node you run yourself** (testnet: `dashd -testnet`) for the same quorums:

```sh
dash-cli -testnet quorum list
dash-cli -testnet quorum info <llmq type> <quorum_hash>    # compare "quorumPublicKey"
```

Use Platform's validator quorum type: `llmq_25_67` (type 6) on testnet, `llmq_100_67` (type 4) on mainnet. If every key the endpoint serves matches your node, proofs checked against that endpoint are as trustworthy as your own node.

### Point the tools at another key source

If the default endpoint is down or blocked where you are, every read stops: nothing can be checked without quorum keys. Point the tools at another quorum service, on any network:

- **Web app:** Settings → **Quorum service**. The app keeps it in this browser only and reloads to use it. Repository pages still compare its keys with a Platform node's.
- **`dg` and `git-remote-dash`:** `--quorum-url <url>` for one command, or `DASH_FORGE_QUORUM_URL`, or `git config dash.quorumUrl`. `dg` passes the service to every `git` it runs, and a clone made with `--quorum-url` keeps it in its own config. A setting that names no network applies to whichever network a command uses, so set it in the repository's config (`git config --local`) or next to `DASH_FORGE_NETWORK`. Another network's service fails safe: no proof checks against its keys, so every read stops.
- **The web app** checks a typed service before saving it: it must list quorums, and when a Platform node answers, the keys must match the node's and be this network's.
- **A self-built web app:** `NEXT_PUBLIC_QUORUM_URL` sets a devnet's default at build time.

On testnet and mainnet the URL must be `https://`. The service must answer `GET <url>/quorums` and `GET <url>/previous` the way Dash's does: run [Dash's quorum list server](https://github.com/dashpay/quorum-list-server) next to a Dash Core node you trust.

**Why not ask Platform nodes directly?** The Platform SDK takes quorum keys from a quorum service and nowhere else. In the CLI, `rs-sdk-trusted-context-provider` (`TrustedHttpContextProvider::new_with_url`) is the only key source Forge can use without a Core node. In the browser, evo-sdk's trusted mode fetches keys only through `WasmTrustedContext.prefetch*WithUrl`, and its untrusted mode checks no proofs at all. DAPI's `getCurrentQuorumsInfo` does list the current keys, unproved, and the web app uses it only as the second source for the cross-check above, never as a replacement.

---

## The Verification card

Every repository page has a **Verification** card at the top of the right-hand rail (under the content on a phone, still first). Its states come from checks that actually ran in your browser this session, never from a constant. Collapsed, it is one line, for example `Verified · refs by proof · 6 objects by hash · from Platform`. The headline reads **Checking…** until the chain check has finished, so it is never green early.

Opened, it has four rows:

| Row | What it says |
|---|---|
| **Chain data** | Whether this connection checks proofs, where the quorum keys came from, and whether a [second source](#the-web-app-cross-checks-the-keys-with-a-second-source) agreed with them. |
| **Branch tip** | The branch, the commit it points at, who signed that update and when, folded by `FORGE_RULES_V2` from the proof-checked update log. A diverged ref is amber and lists every candidate. |
| **File contents** | How many objects read this session were re-hashed and matched their git id, how many whole packs matched the SHA-256 in their manifest, and whether any pack could not be fetched. |
| **Where the bytes came from** | Platform, a bucket or an IPFS gateway, and which configured places were not tried. A source gives availability, not authenticity. |

Each row, and the card as a whole, shows one of five states, always as an icon and a word, never by colour alone. The card shows the most serious state among its rows.

| State | Meaning |
|---|---|
| **Verified** | The check ran and passed for everything this page relied on. |
| **Partly verified** | It passed, but not for the whole answer: only one quorum-key source answered, a diverged ref is shown provisionally, or a pack could not be fetched. |
| **Not checked yet** | Nothing has been checked, for example no file has been read yet. |
| **Couldn't verify** | The check could not run: a connection that does not check proofs, or objects shown without the hash check. |
| **Failed** | The check ran and the data was wrong: a quorum key disagreed, an object did not match its git id, or a pack did not match its manifest. Those bytes are refused and never shown. The **Where the bytes came from** row also fails when no storage place answered at all. |

The card's footer always says how far to trust the page itself: *"This app is served by GitHub Pages. If you don't trust that, pin the IPFS build or use the CLI, which needs no website."* See [Run your own copy of the web app](#run-your-own-copy-of-the-web-app).

**When storage does not answer**, the repository page shows a card instead of a spinner. It lists each place it tried and why each failed (`timed out`, `not found on 3 gateways`, `missing`), with **Try again** and **Add a gateway**, and shows members the `dg reseed <owner>/<name> --from-local` command that restores a lost copy from any clone ([Bring your own storage](bring-your-own-storage.md#restoring-a-lost-copy)).

**Release assets** are checked the same way: the web app streams a download through SHA-256 and saves it only if it matches the release's recorded hash. `dg release download` does the same.

---

## Verify a repository yourself

With only `git`, `dg` and `git-remote-dash`, you can check a repository end to end.

**1. Read the raw ref history from Platform:**

```sh
DASH_FORGE_KEY=<any key source> git-remote-dash --dump-refs <owner id> <repo>   # reads only; signs nothing
```

```
--- refUpdate: 2 docs ---
  ref="refs/heads/main" new=8f3e2a1… prev=0000000… force=false createdAt=1758… id=…
  ref="refs/heads/main" new=c41d9e0… prev=8f3e2a1… force=false createdAt=1758… id=…
--- protectedRefUpdate: 0 docs ---
```

Each line is one signed, append-only, non-deletable ref update. Follow `prev` → `new` in `createdAt` order to get the branch tip.

**2. Read the pack manifests, and probe every copy:**

```sh
dg storage status <owner>/<repo>
dg --json storage status <owner>/<repo> | jq '.packs[] | {packHash, sizeBytes, storageTier}'
```

`packHash` is the SHA-256 that every copy of the pack must match. `storage status` also checks that each recorded copy answers. It sends a `HEAD` request to each bucket URL and IPFS gateway, and reports the Platform copy from its manifest. That checks availability, not hashes. Step 3 checks the bytes.

**3. Clone, and make git check every object:**

```sh
git clone dash://<owner>/<repo> verify && cd verify
git fsck --full --strict                          # re-hashes every object
git verify-pack -v .git/objects/pack/*.pack >/dev/null && echo "pack OK"
git rev-parse main                                # must equal the tip from step 1
git rev-list --objects --missing=print main | grep -c '^?'   # 0 = nothing withheld
```

If the tip from step 1 equals `git rev-parse main`, and `fsck` passes, you hold exactly the history the owner signed on Platform. No server was trusted for any of it, except the quorum key endpoint described above.

**4. Compare with another source.** For a mirror, `git ls-remote https://github.com/<o>/<r> refs/heads/main` must show the same id.

**5. Check a plain-git gateway.** A [forge-gateway](../hosting/forge-gateway.md) serves `git clone https://<gateway>/<owner>/<repo>.git` for tools that only speak git. Check it before you depend on it:

```sh
dg verify-mirror https://<gateway>/<owner>/<repo>.git
```

```
https://git.forge.dashhq.org/alice/project.git  G6D3…/project
  match     8f3e2a1c40a1  refs/heads/main  (the proved tip)
  stale     c41d9e0b7f22  refs/heads/dev   (an earlier tip; the ref moved after the mirror's snapshot)
  manifest: snapshot at Platform height 51234 (3 blocks behind the chain tip)
stale: 1 match, 1 stale, 0 mismatch
```

It lists what the gateway serves, folds the refs from Platform with proofs, and checks the gateway's `forge-manifest.json` (the `refUpdate` behind each ref, and the block its snapshot reflects). `stale` is a gateway that has not refreshed yet. `MISMATCH` is a tip the ref never had, a ref Platform does not have, or a claim Platform does not back: the command exits non-zero ([`E504`](../errors.md#e504)), and you should clone with `dash://`. `--strict` fails on `stale` too. The web app's clone box has a **verify** link that runs the same comparison for the branches and tags the page proved.

---

## The third-party verification script

The CLI end-to-end suite has a scenario that automates steps 1–3 above (the comparison with another source in step 4 stays manual): [`e2e/cli/scenarios/06-third-party-verify.sh`](../../e2e/cli/scenarios/06-third-party-verify.sh). It:

1. reads the raw `refUpdate` documents and folds the chain to a tip, failing on a broken `prev` link;
2. reads the raw `packManifest` documents and checks that every `packHash` is a SHA-256;
3. clones, then runs `git fsck --strict` and `git verify-pack`;
4. checks that the clone's tip equals the raw on-chain tip, re-hashes the tip commit and its tree by hand, and checks that no reachable object is missing.

It runs in the nightly against devnet sakura (once its contracts are registered). It is written against the suite's own fixture repository and identities (`e2e/cli/config.sh`). To use it on another repository, copy the steps. Each is a plain `git`, `dg` or `git-remote-dash` command.

---

## Run your own copy of the web app

forge.dashhq.org is served by **GitHub Pages**. If you don't trust GitHub, or the domain goes away, you can run the same app yourself. It is a static site: HTML, JavaScript and WebAssembly, with no backend.

**Build it from source:**

```sh
git clone https://github.com/PastaPastaPasta/dash-forge && cd dash-forge/forge-web
pnpm install --frozen-lockfile
pnpm build                         # writes the static site to forge-web/out/
npx serve out                      # or any static file server
```

Choose the network at build time: `NEXT_PUBLIC_NETWORK=testnet|mainnet|devnet`, plus `NEXT_PUBLIC_DEVNET_NAME=sakura` for a devnet. The hosted app is built from master by `.github/workflows/pages.yml`, which uses `NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=sakura`, the network Forge targets (its RC2 registration is in progress); a build for a network without one shows "not deployed". Contract ids come from `forge-contracts/deployments/`.

**Host it anywhere static:** another static host, your own server, or IPFS. For IPFS, build the IPFS variant, which finds its base path when it loads:

```sh
pnpm build:ipfs                      # instead of pnpm build
ipfs add -r --cid-version 1 out/     # the last line's CID is the site root
```

Open it through a **subdomain** gateway (`http://<cid>.ipfs.localhost:8080/` on your own kubo node, `https://<cid>.ipfs.<gateway>/` on a public one) or a **path** gateway (`https://<gateway>/ipfs/<cid>/`). The plain `pnpm build` loads its assets from `/`, so it works on a subdomain gateway but not a path gateway. Any other host that serves the app under a sub-path: build with `NEXT_PUBLIC_BASE_PATH=/<sub-path>`.

**Or use a release's IPFS build.** Every release publishes the web app as a CAR file and a CID, built reproducibly from the tag, and the maintainer records them on Forge too. Pin it with `ipfs dag import`, and check it against the tag: [Verify the app you loaded](verify-the-app.md).

The app talks only to Platform nodes, the quorum key endpoint, IPFS gateways, and wherever each repository's packs are stored. Your copy works exactly like the hosted one.

Two more things make a copy of your own practical:

- **Short links** such as `/<owner>/<name>/issues/12` are rewritten to the app's canonical routes by a small script in the build's `404.html`, so any static host that serves `404.html` for unknown paths (GitHub Pages does) supports them. Once a public repository's page has loaded, the address bar shows its short link, so the link people copy from it is short too. IPFS gateways do not serve `404.html`, so the IPFS build copies canonical links and keeps them in the address bar.
- **Your own IPFS gateways**: **Settings → Your IPFS gateways** (or **Add a gateway** on a repository whose storage did not answer) adds gateways that are tried before the built-in list. They are saved in this browser only.

The footer of every page says which commit the app was built from, and the CID when it was loaded from IPFS. [Verify the app you loaded](verify-the-app.md) shows how to rebuild that CID from the tag and compare it with the GitHub release and the Forge release on chain. Releases publish this build from v0.1.0 on; building it yourself from a commit you have read remains the strongest check.

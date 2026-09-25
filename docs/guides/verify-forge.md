# Check that Forge isn't lying to you

Forge is built so that you do not have to trust any server: not the web host, not the Platform node you talk to, not the bucket or gateway that serves the bytes. This page shows what that rests on, where it still rests on trust, and how to check it yourself.

1. [What is checked, and against what](#what-is-checked-and-against-what)
2. [The one trusted input: quorum keys](#the-one-trusted-input-quorum-keys)
3. [Verify a repository yourself](#verify-a-repository-yourself)
4. [The third-party verification script](#the-third-party-verification-script)
5. [Run your own copy of the web app](#run-your-own-copy-of-the-web-app)
6. [What the Assay panel means](#what-the-assay-panel-means)

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

- **Which tip wins.** A branch's tip is folded from its ref-update log (the `FORGE_RULES` fold). If two pushes raced, the ref shows as *diverged*, and the web app says so.
- **Who counts.** Whether a close, merge or approval was made by someone with the right role. On v1 this is reconstructed from token history. On forge-v2, consensus checks membership when the document is written.

The Rust and TypeScript clients share 70+ conformance vectors (`forge-contracts/vectors/`), so the CLI and the web app reach the same answer from the same documents.

---

## The one trusted input: quorum keys

A proof is only as good as the quorum public key it is checked against. Today, **both the CLI and the web app fetch those keys over HTTPS from one endpoint** per network:

| Network | Quorum key endpoint |
|---|---|
| testnet | `https://quorums.testnet.networks.dash.org` |
| mainnet | `https://quorums.mainnet.networks.dash.org` |
| devnet moutai | `https://quorums.moutai.networks.dash.org` |

Whoever controls that endpoint could hand out a key of their own and vouch for false data. So Forge is **trust-minimized, not trustless**. The web app's Assay panel says this in its footer and names the endpoint. On a devnet, `dg doctor` prints the endpoint on its `target` line. On testnet and mainnet the tools use the endpoint in the table above, which is built into the Platform SDK.

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

**Coming soon:** the web app cross-checks two independent key sources and shows *Partly verified* when only one answers. `dg` will verify quorums over SPV so that it needs no key endpoint at all.

### Point the tools at another key source

On a devnet you can choose the endpoint:

- `dg` and `git-remote-dash`: `DASH_FORGE_QUORUM_URL`, or `git config dash.quorumUrl`;
- a self-built web app: `NEXT_PUBLIC_QUORUM_URL`.

On testnet and mainnet, the SDK's built-in endpoint is used.

---

## Verify a repository yourself

With only `git`, `dg` and `git-remote-dash`, you can check a repository end to end.

**1. Read the raw ref history from Platform:**

```sh
DASH_FORGE_KEY=<your identity file> git-remote-dash --dump-refs <owner id> <repo>
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

---

## The third-party verification script

The CLI end-to-end suite has a scenario that does exactly the steps above, automatically: [`e2e/cli/scenarios/06-third-party-verify.sh`](../../e2e/cli/scenarios/06-third-party-verify.sh). It:

1. reads the raw `refUpdate` documents and folds the chain to a tip, failing on a broken `prev` link;
2. reads the raw `packManifest` documents and checks that every `packHash` is a SHA-256;
3. clones, then runs `git fsck --strict` and `git verify-pack`;
4. checks that the clone's tip equals the raw on-chain tip, re-hashes the tip commit and its tree by hand, and checks that no reachable object is missing.

It runs in the nightly against testnet. It is written against the suite's own fixture repository and identities (`e2e/cli/config.sh`). To use it on another repository, copy the steps. Each is a plain `git`, `dg` or `git-remote-dash` command.

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

Choose the network at build time: `NEXT_PUBLIC_NETWORK=testnet|mainnet|devnet`, plus `NEXT_PUBLIC_DEVNET_NAME=moutai` for a devnet. Contract ids come from `forge-contracts/deployments/`.

**Host it anywhere static:** another static host, your own server, or IPFS:

```sh
ipfs add -r --cid-version 1 out/     # the last line's CID is the site root
```

Open it through a **subdomain** gateway, which serves the site at the root of its own origin: `https://<cid>.ipfs.dweb.link/`, or `http://<cid>.ipfs.localhost:8080/` on your own kubo node. Path gateways (`https://<gateway>/ipfs/<cid>/`) do not work, because the build loads its assets from `/`. The same applies to any host that serves the app under a sub-path: build with `NEXT_PUBLIC_BASE_PATH=/<sub-path>`.

The app talks only to Platform nodes, the quorum key endpoint, IPFS gateways, and wherever each repository's packs are stored. Your copy works exactly like the hosted one.

**Coming soon:** an official IPFS build published with each release, reproducible, with its hash recorded on-chain, so you can check that the app you loaded is the released one. Until then, building it yourself from a commit you have read is the way to be sure.

---

## What the Assay panel means

Every repository page has an **Assay** card in the right-hand rail. Its states come from checks that actually ran in your browser this session, never from a constant.

The card has four rows:

| Row | What it says |
|---|---|
| **01 Platform proofs** | Whether this connection checks proofs, and where it got the quorum keys. |
| **02 Refs** | Whether the branch tip was folded from the proof-checked ref log. It turns *partial* if the ref is diverged. |
| **03 Content hashes** | How many objects read this session were re-hashed and matched their git id, and whether any pack could not be fetched. |
| **04 Byte source** | Where the bytes came from (Platform, a bucket, an IPFS gateway). A source gives availability, not authenticity. |

Each row, and the card as a whole, shows one of five states. The card shows the most serious state among its rows, in this order: failed, unverified, partial, verified. It shows *pending* only while every row is still pending.

| State | Color | Meaning |
|---|---|---|
| **verified** | green | The check ran and passed. |
| **partial** | amber | Some of it passed, and some could not be checked or is incomplete: a diverged ref, packs that could not be fetched, some objects shown without a check. |
| **unverified** | amber | The check did not run. For example, the connection is not proof-checking. |
| **pending** | grey | Nothing has been checked yet, for example no files read yet. |
| **failed** | red | The check ran and the data was wrong: an object did not match its git id, or a pack did not match its manifest. Those bytes are refused and never shown. |

**Coming soon:** plain-language row names (*Chain data*, *Branch tip*, *File contents*, *Where the bytes came from*) and the card title **Verification**.

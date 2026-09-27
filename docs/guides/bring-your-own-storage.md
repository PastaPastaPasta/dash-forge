# Bring your own storage

With Dash Forge, `git push` can keep your pack bytes in storage **you** own, such as an S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3, MinIO) or an IPFS node. Only the small, signed pieces go on Dash Platform: the `packManifest`, which records where the pack lives plus its SHA-256, and the ref updates. The Forge project runs none of this storage. Every copy of your data is either on your own storage or on Platform.

Readers never trust your bucket. A clone accepts only bytes that hash to the SHA-256 in the on-chain manifest. When a copy is missing or wrong, the reader tries the next copy and falls back to Platform chunks if they exist. So losing a copy costs availability, never integrity.

This guide covers:

1. [How it fits together](#how-it-fits-together)
   - [The quick way: `dg storage add` asks](#the-quick-way-dg-storage-add-asks)
   - [In the browser: the storage wizard](#in-the-browser-the-storage-wizard)
2. [Cloudflare R2](#cloudflare-r2)
3. [Backblaze B2](#backblaze-b2)
4. [AWS S3](#aws-s3)
5. [MinIO (self-hosted)](#minio-self-hosted)
6. [IPFS: your own kubo node](#ipfs-your-own-kubo-node)
7. [IPFS: kubo + a pinning service](#ipfs-kubo--a-pinning-service)
8. [Choosing where a repo pushes](#choosing-where-a-repo-pushes)
9. [Cost guard](#cost-guard)
10. [Reading: gateways and fallbacks](#reading-gateways-and-fallbacks)
11. [Troubleshooting](#troubleshooting)

---

## How it fits together

| Piece | Where it lives | Who can see it |
|---|---|---|
| Storage **profiles** (endpoint, bucket, public URL, *references* to secrets) | `~/.config/dash-forge/storage.toml` (override with `DASH_FORGE_STORAGE_CONFIG`) | only you |
| **Secrets** (S3 secret key, pinning token, …) | environment variables or your OS keychain | only you (and, on macOS, any program running as you: see below) |
| A repo's **storage policy**: which profiles, how many copies | git config (`dash.storage`, `dash.replicas`) | only you |
| Pack bytes | your bucket / IPFS node (and/or Platform chunks) | public, if you give the bucket a public URL |
| Manifest: pack SHA-256, public URLs, CID | Dash Platform | everyone |

> **What becomes public.** The manifest records, on-chain and forever:
> - the public URL of every copy;
> - the `s3://<bucket>/<prefix>/packs/<sha256>.pack` locator of every S3 copy. This discloses the **bucket name and key prefix**, even for a private bucket with no `--public-url`.
>
> It never records the endpoint or any credential. If the bucket name itself is sensitive, give the profile a `--public-url` (a CDN or custom domain that hides the bucket) and treat the bucket name as public anyway. `dg storage advertise` publishes only the https public read bases.

Secrets are **never** written to `storage.toml`, to the chain, or to logs. A keychain entry is protected at rest and from other users; on macOS `dg` reads it through Apple's `security` tool, so any program running as you can read it without a prompt, like an `env:` variable in your shell. Give Forge a key scoped to the one bucket. `storage.toml` holds only references like `env:R2_SECRET_ACCESS_KEY` or `keychain:dash-forge/r2-main`. If you paste a literal secret into it, `dg` refuses to load the file.

A push works like this:

1. The helper builds the pack exactly as before.
2. It prints what is pushed and where it goes, before anything is paid for:
   ```
   dash: alice/project ← main (8f3e2a1, 312 objects, 1.2 MiB)
   dash: storage      → r2-main, kubo (need 2 of 2) · Platform stores manifest + refs only
   ```
3. It uploads to every target **in parallel**. The object keys are content-addressed (`packs/<sha256>.pack`, or the CID for IPFS), so a re-push is idempotent. Each target gets a line as soon as its copy is stored and verified (`dash: r2-main      ████████████████ 1.2 MiB  verified   0.4 s`), or a `✗` line naming the failure.
4. It **verifies each copy by reading it back**. Packs up to 16 MiB get a full GET plus SHA-256. Larger packs get a size check plus byte-exact head and tail ranges. The store also verified the whole body on upload (S3 checks `x-amz-content-sha256`; IPFS checks that kubo's CID matches a local re-derivation).
5. If fewer than `dash.replicas` targets confirm, **the push fails before anything is written to Platform**: no manifest, no ref. The error ([E502](../errors.md#e502)) names each failing target.
6. Otherwise it prints what Platform writes (`dash: platform     manifest 2 · refUpdate 1     est 0.000373 DASH`), writes the manifest with every confirmed URI, then the refs. It also publishes the browse-index fragment to the same targets. If an earlier push already recorded this exact pack, the helper first checks that at least one copy that manifest records is readable and hash-matches. If none is, it refuses to update any ref ([E507](../errors.md#e507)).
7. It ends with what Platform charged, measured as the identity's balance change (`≈`), or the estimate when the balance has not moved yet: `dash: done · Platform charged ≈0.00029 DASH · remaining 0.4809 DASH · https://forge.dashhq.org/repo?owner=…&name=…`. With `-q` this line and its balance read are skipped.

`git push --dry-run` builds the pack, prints the plan, target and Platform-estimate lines, then stops. With `GIT_DASH_JSON=1` each line is a JSON event instead (`{"event":"plan",…}`).

`git push -q` silences the progress lines; errors are always printed.

### The quick way: `dg storage add` asks

Run `dg storage add` with no arguments in a terminal. It asks for each value, with a one-line hint on where to find it, stores a pasted secret in your OS keychain, saves the profile, and runs the same checks as `dg storage test`:

```
$ dg storage add
? Profile name › r2-main
? Kind › 1) S3-compatible (Cloudflare R2, Backblaze B2, AWS S3, MinIO)
? Provider › 1) Cloudflare R2   (region auto, path-style; recommended: free egress)
? Account id › 7c1…
? Bucket › forge
? Public URL (r2.dev or custom domain) › https://pub-9a1.r2.dev
? Access key id › …
? Secret access key — how do you want to store it? › 1) paste it now; dg stores it in the macOS Keychain (recommended)
? Secret access key ›                  (input is hidden)
Testing r2-main …
  [ OK ] put            wrote probe/… (signed PUT)
  [ OK ] get            read back identical bytes (signed GET)
  [ OK ] public read    anonymous GET https://pub-9a1.r2.dev/probe/… OK
  [FAIL] browser CORS   preflight: Access-Control-Allow-Headers does not include Range
  [ OK ] delete         probe removed
  → Cloudflare dashboard → R2 → forge → Settings → CORS Policy → Add CORS policy, paste: …
    then run `dg storage test r2-main`
  note: git push and clone work without CORS; the web app cannot read this storage until it passes
Saved ~/.config/dash-forge/storage.toml (secret stored as keychain:dash-forge/r2-main)
Equivalent: dg storage add r2-main --kind s3 --endpoint https://7c1….r2.cloudflarestorage.com --region auto --bucket forge --public-url https://pub-9a1.r2.dev --access-key-id … --secret-access-key keychain:dash-forge/r2-main
Use it in a repo: dg storage use r2-main
? Make r2-main the default storage for new repos (and any repo without its own dash.storage)? [Y/n]
```

- The answers map one to one onto the flags in the provider sections below, and the `Equivalent:` line is a command you can re-run (in CI, on another machine) without the questions.
- The secret can be **pasted** (read without echo and written to the macOS Keychain, Windows Credential Manager or the Secret Service keyring under service `dash-forge`, account = the profile name), taken from an **environment variable** (`env:NAME`), or an entry **already in the keychain** (`keychain:<service>/<account>`). It is never written to `storage.toml`, printed or logged.
- The presets fill in what each provider needs: R2 builds the endpoint from your account id and uses region `auto`; B2 builds `s3.<region>.backblazeb2.com`; AWS uses virtual-hosted addressing; MinIO and other stores ask for the endpoint.
- Accepting the last question sets `git config --global dash.storage <name>`, which `dg repo create` / `dg init` and every repository without its own `dash.storage` then use.
- With `--json`, `--yes`, or no terminal, nothing is asked: `dg storage add` without a name fails with [E201](../errors.md#e201) and tells you to pass the flags.

Keychain entries you created by hand (`security add-generic-password -s dash-forge -a <name> -w`, or `secret-tool store … service dash-forge account <name>`) keep resolving: a `keychain:` reference is looked up through the OS credential store first and the command-line tool second.

### In the browser: the storage wizard

The web app has the same setup at **Settings → Storage** (`/settings/storage`) on forge.dashhq.org. It is what the browser uses when it uploads to your storage itself, for example a release's assets; `git push` keeps using `dg`'s profiles.

- **Providers:** Cloudflare R2 (recommended: free egress), Backblaze B2, AWS S3, MinIO or other S3, IPFS (your kubo node), an IPFS pinning service, and Dash Platform last (permanent, about 0.28 DASH/MiB). Each field has a "where to find this" hint.
- **A live test from the page**, so it checks exactly what the browser will do, CORS included. S3: signed PUT, signed GET, anonymous GET through the public URL, a ranged read, a CORS preflight for PUT, then the probe is deleted. IPFS: the kubo API, add with a CID check and pin, the gateway re-read, the public gateway, the pinning service, then unpin. A failing CORS row shows a copy-paste fix for your provider, filled in with your bucket and this app's origin; the browser needs PUT allowed from the app's origin, where the CLI needs no CORS at all.
- **Credentials stay in this browser**, sealed in the same encrypted vault as your [limited key](identity-and-keys.md#the-browser-vault-and-its-limits), and are never sent anywhere else or written on chain. Lock the vault and they are unreadable.
- **Replication:** one place, every chosen place, or Platform as a costed fallback that asks first. A repository's **Settings → Your browser pushes** overrides the default for that repository.
- **Only public https addresses are recorded on chain.** The wizard can reach a MinIO or kubo on `localhost` for testing, but it refuses to record a loopback, private or plain-http URL, and readers skip such URLs even if a manifest names one.
- **kubo's RPC API is its admin interface.** The fix block creates a Forge token limited to add, pin and version calls (after an owner token, so you do not lock yourself out) rather than opening the whole API to the page.

**macOS asks once per program.** macOS lets the program that created a keychain item read it silently. The first time `git-remote-dash` reads a secret that `dg` stored, macOS asks whether to allow it. Choose **Always Allow**. A rebuilt or reinstalled binary can ask again. Over SSH nobody can answer, so the read fails: use an `env:` reference on machines you only reach that way. `DASH_FORGE_NO_KEYCHAIN=1` stops `dg` from offering or writing the keychain; `keychain:` references you wrote yourself are still read.

---

## Cloudflare R2

R2 has no egress fees, which makes it the cheapest way to serve clones.

1. **Create a bucket.** In the Cloudflare dashboard, open R2 → Create bucket, for example `forge`.
2. **Make it publicly readable.** Open the bucket → Settings → Public access, then either enable the **R2.dev subdomain** (you get `https://pub-<hash>.r2.dev`) or connect a custom domain. That URL is your `--public-url`.
3. **Create an API token.** Go to R2 → Manage R2 API Tokens → Create API token with **Object Read & Write**, scoped to this bucket. Note the *Access Key ID*, the *Secret Access Key*, and the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.
4. **Store the secret** in your keychain (macOS shown; on Linux use `secret-tool store --label r2 service dash-forge account r2-main`):
   ```sh
   security add-generic-password -s dash-forge -a r2-main -w   # prompts for the secret
   ```
5. **Configure CORS** so the web app can read packs. Open the bucket → Settings → CORS Policy → Add CORS policy, and paste:
   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["Range"],
       "ExposeHeaders": ["Content-Range", "Content-Length", "ETag"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```
6. **Add and test the profile:**
   ```sh
   dg storage add r2-main --kind s3 \
     --endpoint https://<account-id>.r2.cloudflarestorage.com \
     --region auto --bucket forge \
     --public-url https://pub-<hash>.r2.dev \
     --access-key-id <access-key-id> \
     --secret-access-key keychain:dash-forge/r2-main
   dg storage test r2-main
   ```
   `dg storage test` writes a probe object with a signed PUT, reads it back with a signed GET, reads it anonymously through the public URL, checks the CORS preflight for `Range`, and then deletes the probe. If CORS or public access is missing, it prints the fix.

R2 wants `region = auto` and path-style addressing (the default).

## Backblaze B2

1. **Create the bucket** with Files in bucket set to **Public**, or later run `b2 bucket update <bucket> allPublic`.
2. **Create an application key** under App Keys → Add a New Application Key, restricted to the bucket with Read and Write. The *keyID* is the access key id and the *applicationKey* is the secret.
3. **Find the S3 endpoint.** The bucket page shows it, for example `https://s3.us-west-004.backblazeb2.com`, and the region is the middle part (`us-west-004`).
4. **Public URL:** `https://s3.us-west-004.backblazeb2.com/<bucket>` (path-style) works for public buckets, and so does a friendly URL or a CDN in front of it.
5. **CORS.** Save the following as `cors.json`, then run `b2 bucket update --cors-rules "$(cat cors.json)" <bucket> allPublic`:
   ```json
   [
     {
       "corsRuleName": "dashForgeRead",
       "allowedOrigins": ["*"],
       "allowedOperations": ["s3_get", "s3_head", "b2_download_file_by_name"],
       "allowedHeaders": ["range"],
       "exposeHeaders": ["content-range", "content-length", "etag"],
       "maxAgeSeconds": 86400
     }
   ]
   ```
6. **Add the profile:**
   ```sh
   export B2_SECRET=…   # or put it in the keychain
   dg storage add b2 --kind s3 \
     --endpoint https://s3.us-west-004.backblazeb2.com --region us-west-004 \
     --bucket <bucket> --public-url https://s3.us-west-004.backblazeb2.com/<bucket> \
     --access-key-id <keyID> --secret-access-key env:B2_SECRET
   dg storage test b2
   ```

## AWS S3

1. **Create the bucket**, for example `my-forge-packs` in `us-east-1`.
2. **Allow public reads** of the objects. Either turn off Block Public Access for this bucket and add a bucket policy like the one below, or put CloudFront in front and use the CloudFront URL as `--public-url`:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow", "Principal": "*",
       "Action": "s3:GetObject",
       "Resource": "arn:aws:s3:::my-forge-packs/*"
     }]
   }
   ```
3. **Create an IAM user or role** limited to `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on `arn:aws:s3:::my-forge-packs/*`. Temporary STS credentials work too: add `--session-token env:AWS_SESSION_TOKEN`.
4. **CORS.** Save the following as `cors.json` and run `aws s3api put-bucket-cors --bucket my-forge-packs --cors-configuration file://cors.json`:
   ```json
   {
     "CORSRules": [{
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["Range"],
       "ExposeHeaders": ["Content-Range", "Content-Length", "ETag"],
       "MaxAgeSeconds": 86400
     }]
   }
   ```
5. **Add the profile.** AWS prefers virtual-hosted addressing; path-style also works in most regions.
   ```sh
   dg storage add aws --kind s3 \
     --endpoint https://s3.us-east-1.amazonaws.com --region us-east-1 \
     --bucket my-forge-packs --virtual-hosted \
     --public-url https://my-forge-packs.s3.us-east-1.amazonaws.com \
     --access-key-id env:AWS_ACCESS_KEY_ID --secret-access-key env:AWS_SECRET_ACCESS_KEY
   dg storage test aws
   ```
   A bucket name that contains dots cannot use virtual-hosted addressing over TLS, and `dg` will say so.

## MinIO (self-hosted)

MinIO answers CORS for every origin by default (`MINIO_API_CORS_ALLOW_ORIGIN`). Make the bucket publicly readable but not publicly writable:

```sh
mc mb myminio/forge
mc anonymous set download myminio/forge
dg storage add minio --kind s3 --endpoint https://minio.example.org \
  --bucket forge --public-url https://minio.example.org/forge \
  --access-key-id <user> --secret-access-key env:MINIO_SECRET
dg storage test minio
```

The repo's `infra/docker-compose.yml` runs a local MinIO whose `forge-byo` bucket has this exact shape: signed writes (`minioadmin` / `minioadmin`) and anonymous reads. `make storage-it` and `make storage-e2e` test against it.

## IPFS: your own kubo node

Dash Forge adds content with fixed import parameters: CIDv1, raw leaves, a 256 KiB fixed-size chunker, sha2-256, a balanced layout with 174 links per node, and pinning on. It then **re-derives the CID locally** and refuses the upload if kubo returns a different one. So the CID in the manifest is a second, independent integrity check.

```sh
dg storage add kubo --kind ipfs-kubo \
  --api http://127.0.0.1:5001 \
  --gateway http://127.0.0.1:8080 \
  --public-gateway https://ipfs.example.org   # optional: your node's public gateway
dg storage test kubo
```

- `--gateway` is where the helper re-reads the upload to verify it. Without it, verification relies on the CID match plus the pin check alone.
- `--public-gateway` also records `https://…/ipfs/<cid>` in the manifest, which browsers can use directly, and every reader tries that gateway first. **Set it for any repo stored only on IPFS.** Without it, readers depend on the shared public gateways finding your node on the IPFS network, and a node at home behind NAT usually cannot be found: clones fail and the web page cannot show the code. `dg storage test` warns when no shared gateway could fetch its probe from your node, and `dg doctor` checks every gateway you rely on.
- If the RPC API sits behind auth (kubo `API.Authorizations`, or a reverse proxy), add `--api-auth env:KUBO_AUTH`. It must hold the full `Authorization` header value, for example `Basic dXNlcjpwYXNz`.
- CORS: kubo's gateway sends `Access-Control-Allow-Origin: *` by default. If you changed that:
  ```sh
  ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
  ipfs config --json Gateway.HTTPHeaders.Access-Control-Expose-Headers '["Content-Range", "Content-Length", "ETag"]'
  ```

A pin on a laptop that is usually offline makes a poor replica. Pair it with a bucket, or with a pinning service.

## IPFS: kubo + a pinning service

This kind adds the content through your kubo node, then asks any [IPFS Pinning Service API](https://ipfs.github.io/pinning-services-api-spec/) endpoint to pin the CID, passing your node's addresses as `origins`. The copy counts only once the service reports `pinned`. If the service already has a pin for that CID, the helper reuses it.

```sh
dg storage add pins --kind ipfs-pinning-service \
  --api http://127.0.0.1:5001 --gateway http://127.0.0.1:8080 \
  --pinning-endpoint https://<service>/psa \
  --pinning-token keychain:dash-forge/pins \
  --pin-timeout-secs 300
dg storage test pins
```

The service must be able to fetch the content from your node, so the node needs to be publicly dialable while the pin completes. Otherwise the push times out on that target and says so. (This PR tested the pinning client only against a scripted local server, not a real service. See PRD 04's as-built notes.)

---

## Choosing where a repo pushes

Run this inside the repo:

```sh
dg storage use r2-main,kubo               # both must confirm (N = 2)
dg storage use r2-main,kubo --replicas 1  # either one is enough
dg storage use r2-main --platform-fallback  # if R2 fails, pay for Platform chunks instead
dg storage use r2-main,platform           # keep an on-chain copy as well
dg storage use platform                   # back to the default
```

These commands write git config, and you can also set it by hand:

| key | meaning |
|---|---|
| `dash.storage` | Comma-separated profile names. `platform` is built in. **Unset means Platform only**, exactly as before. |
| `dash.replicas` | N. The push fails unless N targets confirm. Default: every listed target. |
| `dash.platformFallback` | When the external targets cannot reach N, store the pack on Platform instead. The costed fallback is also subject to the cost guard. |
| `remote.<name>.dashStorage`, `…dashReplicas`, `…dashPlatformFallback` | Per-remote overrides. |

When Platform is one of the targets, the manifest records `storage = 0`, `chunkCount > 0`, and **also** lists every external URI. Platform-reading clients, including today's web app, read the chunks. CLI readers race the external copies first. With only external targets, the manifest records `storage = 1`, `chunkCount = 0`, and the URIs.

To let readers (and the web app) know where this repo's packs live, advertise the policy's public read bases in the on-chain `config.backend`. This is one small config write:

```sh
dg storage advertise <owner>/<repo>
```

A **new** repository needs none of this: `dg repo create --push --storage r2-main` and `dg init --storage r2-main` write the advertised mode and read bases into the repository's first config, set `dash.storage` (and `dash.replicas` when you pass `--replicas`) in the repository's own git config, and push. Without `--storage` they use `dash.storage` from git config (this repository's, then your global one), then your only profile if you have exactly one. With none of those they stop **before creating anything** ([E508](../errors.md#e508)) and quote what Platform storage would cost for this repository; pass `--storage platform` to accept that price.

## Cost guard

Every push prints its Platform estimate. You can also make it stop and ask:

```sh
git config dash.costWarnThreshold 0.01   # DASH
git config dash.confirm auto             # auto (default): ask only above the threshold
                                         # always: ask before every paid push
                                         # never: print and go
                                         # refuse: never ask; above the threshold, fail
                                         #   (for unattended callers, e.g. forge-import)
```

Git owns the helper's stdin and stdout, so the question goes to `/dev/tty`. Without a terminal (CI, GUI clients), a push that needs confirmation fails with a message telling you to use `git -c dash.confirm=never push …` or to raise the threshold. It never assumes yes.

## Reading: gateways and fallbacks

Every clone, fetch, repack and reseed reads each pack like this:

1. It tries every `https://` URL the manifest recorded (public bucket URLs, public gateway URLs).
2. For each recorded `s3://bucket/key` where you have a profile for that bucket, it tries a signed GET. This covers private buckets. The secrets are resolved only when this step is actually reached. If several profiles name the same bucket (on different endpoints), each is tried in turn. Keys containing `.`, `..` or empty segments are never signed.
3. It tries `ipfs://<cid>` on the repo's **own** public gateways first (the `…/ipfs/` URLs its pushes recorded and its advertised read URLs), then on **every gateway in your list**, two at a time.
4. Only then does it fall back to Platform chunks, if the manifest has any.

A candidate wins only when its bytes hash to the manifest's SHA-256. Limits:
- a body larger than the manifest's `sizeBytes` is refused;
- each candidate's whole transfer gets `max(120 s, size ÷ 1 MiB/s)`, so a 2 GiB pack gets about 34 minutes. A host that stalls outright is cut off sooner, after 120 s with no bytes;
- when Platform chunks exist, no new external candidate is started after `max(90 s, half that deadline)`, and the reader falls back to the chunks. A transfer already in progress is not abandoned.

The default gateway list lives in one place, [`forge-contracts/config/storage-defaults.json`](../../forge-contracts/config/storage-defaults.json), with the date it was last verified. `git-remote-dash`, `dg` and the web app all embed it; in the web app, **Settings → Your IPFS gateways** adds gateways tried before it. It is deliberately short: public gateways come and go (ipfs.io and dweb.link stopped serving on 2026-09-21), and every dead entry costs a timeout. Override it for the CLI in `storage.toml`:

```toml
[read]
ipfs_gateways = ["http://127.0.0.1:8080", "https://ipfs.filebase.io"]
```

`dg doctor` probes every gateway in the list (and each IPFS profile's public gateway) and flags the dead ones. When no gateway can serve a repo, the web app says which gateways failed and offers to add one, instead of loading forever.

`dg storage status <owner>/<repo>` probes every copy of every pack: each recorded URL, and each CID on each gateway.

## Restoring a lost copy

A pack's manifest is immutable. It permanently records the pack's SHA-256 and the URIs its copies were stored at. When every one of those copies is lost (the bucket was emptied, the kubo node wiped, the pinning service dropped it), the pack cannot be read, and neither can any clone that needs it. That situation is reported as `already recorded at …, none reachable`, or as a warning when a fetch skips the pack.

Storage keys are content-addressed:
- S3: `<prefix>/packs/<sha256>.pack`;
- IPFS: the CID, which is derived from the bytes.

So **re-uploading the same bytes through the same profile recreates the exact URI the manifest already records**, and every reader finds it again. `dg reseed --from-local` does this from a local clone:

```sh
cd my-repo                        # a clone that has the pack
dg reseed <owner>/<repo> --from-local            # every unreadable pack, to this repo's dash.storage targets
dg reseed <owner>/<repo> --from-local --pack <sha256> --profile r2-main
```

The command looks for the pack's exact bytes in two places:
- `.git/dash/packs/<sha256>.pack`: `git-remote-dash` keeps a copy there of every pack it stores on external storage only. This covers the pusher's own clone, including a push that was interrupted before its refs landed.
- `.git/objects/pack/pack-*.pack`: any clone that fetched the pack holds its exact bytes.

It verifies the SHA-256, uploads to the targets (at least `dash.replicas` must confirm), and reports which recorded copies are readable again. Copies it stored at **new** locations can't be added to the immutable manifest, and the forge-v2 contracts have no document type to announce them yet, so they are only printed. Re-upload through the pack's original profile to make the recorded copy readable again.

Plain `dg reseed --profile <name>` (without `--from-local`) re-uploads packs that are still readable to an additional target. It downloads them first, so it can't restore a pack whose copies are all gone.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `push failed: storage policy not met (1 of 2 targets confirmed) [E502]` | A target failed; the `cause:` line names it. Nothing was written to Platform. Run `dg storage test <name>` and push again (confirmed copies are content-addressed and not re-uploaded), lower `dash.replicas`, or set `dash.platformFallback=true`. |
| `S3 PUT … 403 (access denied — check the credentials, the region, …)` | Wrong key or secret, wrong `--region` (R2 needs `auto`), or the key cannot write this bucket. |
| `S3 … 301/307 (redirected …)` | The bucket is in a different region, or needs virtual-hosted addressing (`--virtual-hosted`). |
| `secret env:X is not set` | Export the variable in the environment that runs `git` and `dg`, or switch to a `keychain:` reference. |
| `kubo returned CID … but these bytes derive to …` | The node ignored the pinned import parameters (a very old kubo, or a proxy rewriting the request). Upgrade kubo. |
| `pinning service request … still queued` | The service cannot reach your node. Make it dialable or raise `--pin-timeout-secs`. |
| `dg storage test`: `browser CORS` FAIL | Paste the printed provider CORS configuration. The CLI works without CORS, but the web app does not. |
| `No terminal to confirm on` | See [Cost guard](#cost-guard). |
| `pack … already recorded at …, none reachable` | An earlier push already recorded this exact pack, but none of its copies can be read now. This push stored nothing and updated no ref. Restore the copy: see [Restoring a lost copy](#restoring-a-lost-copy). |
| `note: an earlier interrupted push left Platform chunks …` | A Platform upload was interrupted and you then pushed the same pack to external storage only. Those chunks still hold a refundable deposit. Re-push with `platform` in `dash.storage` to use them, or reclaim them at teardown. The journal that names them is kept. |

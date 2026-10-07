# Bring your own storage

With Dash Forge, `git push` can keep your pack bytes in storage **you** own, such as an S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3, Storj, or a store on your own NAS) or an IPFS node. Only the small, signed pieces go on Dash Platform: the `packManifest`, which records where the pack lives plus its SHA-256, and the ref updates. The Forge project runs none of this storage. Every copy of your data is either on your own storage or on Platform.

Readers never trust your bucket. A clone accepts only bytes that hash to the SHA-256 in the on-chain manifest. When a copy is missing or wrong, the reader tries the next copy and falls back to Platform chunks if they exist. So losing a copy costs availability, never integrity.

This guide covers:

1. [How it fits together](#how-it-fits-together)
   - [The quick way: `dg storage add` asks](#the-quick-way-dg-storage-add-asks)
   - [In the browser: the storage wizard](#in-the-browser-the-storage-wizard)
2. [Cloudflare R2](#cloudflare-r2)
3. [Backblaze B2](#backblaze-b2)
4. [AWS S3](#aws-s3)
5. [Self-hosted S3: Garage, RustFS, MinIO](#self-hosted-s3-garage-rustfs-minio) (step by step on a NAS: [Storage on your home NAS](home-nas-storage.md))
6. [Storj](#storj)
7. [IPFS: your own kubo node](#ipfs-your-own-kubo-node)
8. [IPFS: kubo + a pinning service](#ipfs-kubo--a-pinning-service)
9. [Choosing where a repo pushes](#choosing-where-a-repo-pushes)
10. [Public addresses](#public-addresses)
11. [CORS header names](#cors-header-names)
12. [Cost guard](#cost-guard)
13. [Reading: gateways and fallbacks](#reading-gateways-and-fallbacks)
14. [Restoring a lost copy](#restoring-a-lost-copy)
15. [Troubleshooting](#troubleshooting)

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
   dash: storage      → r2-main, kubo (need 2 of 2) · Platform stores manifest + refs only, est 0.0032 DASH
   ```
3. It uploads to every target **in parallel**. The object keys are content-addressed (`packs/<sha256>.pack`, or the CID for IPFS), so a re-push is idempotent. Each target gets a line as soon as its copy is stored and verified (`dash: r2-main      ████████████████ 1.2 MiB  verified   0.4 s`), or a `✗` line naming the failure.
4. It **verifies each copy by reading it back**. Packs up to 16 MiB get a full GET plus SHA-256. Larger packs get a size check plus byte-exact head and tail ranges. The store also verified the whole body on upload (S3 checks `x-amz-content-sha256`; IPFS checks that kubo's CID matches a local re-derivation).
5. If fewer than `dash.replicas` targets confirm, **the push fails before anything is written to Platform**: no manifest, no ref. The error ([E502](../errors.md#e502)) names each failing target.
6. Otherwise it prints what Platform writes (`dash: platform     manifest 2 · refUpdate 1     est 0.0032 DASH`), writes the manifest with every confirmed URI, then the refs. It also publishes the browse-index fragment to the same targets. If an earlier push already recorded this exact pack, the helper first checks that at least one copy that manifest records is readable and hash-matches. If none is, it refuses to update any ref ([E507](../errors.md#e507)).
7. It ends with what Platform charged, measured as the identity's balance change (`≈`), or the estimate when the balance has not moved yet: `dash: done · Platform charged ≈0.0028 DASH · remaining 0.4786 DASH · https://forge.dashhq.org/repo?owner=…&name=…`. With `-q` this line and its balance read are skipped.

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
? Public URL (your custom domain, or r2.dev) › https://files.example.org
? Access key id › …
? Secret access key — how do you want to store it? › 1) paste it now; dg stores it in the macOS Keychain (recommended)
? Secret access key ›                  (input is hidden)
Testing r2-main …
  [ OK ] put            wrote probe/… (signed PUT)
  [ OK ] get            read back identical bytes (signed GET)
  [ OK ] public read    anonymous GET https://files.example.org/probe/… OK
  [FAIL] browser CORS   the CORS preflight from https://forge.dashhq.org answered 403 Forbidden — allow the `Range` request header for the web app's origin
  [ OK ] delete         probe removed
  → Cloudflare dashboard → R2 → forge → Settings → CORS Policy → Add CORS policy, paste: …
    then run `dg storage test r2-main`
  note: git push and clone work without CORS; the web app cannot read this storage until it passes
Saved ~/.config/dash-forge/storage.toml (secret stored as keychain:dash-forge/r2-main)
Equivalent: dg storage add r2-main --kind s3 --endpoint https://7c1….r2.cloudflarestorage.com --region auto --bucket forge --public-url https://files.example.org --access-key-id … --secret-access-key keychain:dash-forge/r2-main
Use it in a repo: dg storage use r2-main
? Make r2-main the default storage for new repos (and any repo without its own dash.storage)? [Y/n]
```

- The answers map one to one onto the flags in the provider sections below, and the `Equivalent:` line is a command you can re-run (in CI, on another machine) without the questions.
- The secret can be **pasted** (read without echo and written to the macOS Keychain, Windows Credential Manager or the Secret Service keyring under service `dash-forge`, account = the profile name), taken from an **environment variable** (`env:NAME`), or an entry **already in the keychain** (`keychain:<service>/<account>`). It is never written to `storage.toml`, printed or logged. `dg storage remove <name>` deletes the profile's own `keychain:dash-forge/<name>` entry, where a pasted secret goes, unless another profile in the same `storage.toml` still names it, and says what it deleted. Any other entry the profile named (under another service, or under another profile's name) is left in place and listed, since it may be a secret you stored yourself.
- The presets fill in what each provider needs: R2 builds the endpoint from your account id and uses region `auto`; B2 builds `s3.<region>.backblazeb2.com`; AWS uses virtual-hosted addressing; MinIO and other stores ask for the endpoint.
- Accepting the last question sets `git config --global dash.storage <name>`, which `dg repo create` / `dg init` and every repository without its own `dash.storage` then use.
- With `--json`, `--yes`, or no terminal, nothing is asked: `dg storage add` without a name fails with [E201](../errors.md#e201) and tells you to pass the flags.

Keychain entries you created by hand (`security add-generic-password -s dash-forge -a <name> -w`, or `secret-tool store … service dash-forge account <name>`) keep resolving: a `keychain:` reference is looked up through the OS credential store first and the command-line tool second.

### In the browser: the storage wizard

The web app has the same setup at **Settings → Storage** (`/settings/storage`) on forge.dashhq.org. It is what the browser uses when it uploads to your storage itself: a merge's pack, a commit to a pull request's branch (applying suggestions, "Update branch"), and a release's assets. `git push` keeps using `dg`'s profiles.

- **Providers:** Cloudflare R2 (recommended: free egress), Backblaze B2, AWS S3, Garage / RustFS / other S3, IPFS (your kubo node), an IPFS pinning service, and Dash Platform last (permanent, about 0.33 DASH/MiB; see [Costs](costs.md)). Each field has a "where to find this" hint.
- **A live test from the page**, so it checks exactly what the browser will do, CORS included. S3: signed PUT, signed GET, anonymous GET through the public URL, a ranged read, a CORS preflight for PUT, then the probe is deleted. IPFS: the kubo API, add with a CID check and pin, the gateway re-read, the public gateway, the pinning service, then unpin. A failing CORS row shows a copy-paste fix for your provider, filled in with your bucket and this app's origin; the browser needs PUT allowed from the app's origin, where the CLI needs no CORS at all.
- **Credentials stay in this browser**, sealed in the same encrypted vault as your [limited key](identity-and-keys.md#the-browser-vault-and-its-limits), and are never sent anywhere else or written on chain. Lock the vault and they are unreadable.
- **Replication:** one place, every chosen place, or Platform as a costed fallback that asks first. A repository's **Settings → Your browser pushes** overrides the default for that repository.
- **Only public https addresses are recorded on chain.** The wizard can reach a MinIO or kubo on `localhost` for testing, but it refuses to record a loopback, private or plain-http URL, and readers skip such URLs even if a manifest names one.
- **kubo's RPC API is its admin interface.** The fix block creates a Forge token limited to add, pin and version calls (after an owner token, so you do not lock yourself out) rather than opening the whole API to the page.

**macOS: no dialog for what Forge stored.** `dg` writes the keychain, and `dg`, `git-remote-dash` and `forge-import` all read it, through Apple's `/usr/bin/security` tool, so they read what `dg` stored with no dialog, also after an upgrade or a rebuild. Entries you add with `security add-generic-password`, as in this guide, work the same way. An entry another program created (Keychain Access, say) can make macOS show an access dialog: the read prints a notice after a few seconds and waits up to 120 s for an answer. Over SSH no dialog can be answered, so the read fails: use an `env:` reference on machines you only reach that way. `DASH_FORGE_NO_KEYCHAIN=1` stops `dg` from offering or writing the keychain; `keychain:` references you wrote yourself are still read.

---

## Cloudflare R2

> **Not yet verified live.** This section follows Cloudflare's documentation. It has not been run end to end with an R2 account: Forge's S3 storage has been tested only against self-hosted stores (RustFS, MinIO and Garage).

R2 has no egress fees, which makes it the cheapest way to serve clones.

1. **Create a bucket.** In the Cloudflare dashboard, open R2 → Create bucket, for example `forge`.
2. **Make it publicly readable.** Open the bucket → Settings → **Custom Domains** and connect a domain of yours; that URL is your `--public-url`. The **R2.dev subdomain** (`https://pub-<hash>.r2.dev`) also works, but Cloudflare rate-limits it and recommends it for development only, and the URL is recorded on chain forever.
3. **Create an API token.** Go to R2 → Manage R2 API Tokens → Create API token with **Object Read & Write**, scoped to this bucket. Note the *Access Key ID*, the *Secret Access Key*, and the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.
4. **Store the secret** in your keychain (macOS shown; on Linux use `secret-tool store --label r2 service dash-forge account r2-main`):
   ```sh
   security add-generic-password -s dash-forge -a r2-main -w   # prompts for the secret
   ```
5. **Configure CORS** so the web app can read packs, and push to the bucket from the browser. Open the bucket → Settings → CORS Policy → Add CORS policy, and paste:
   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["range"],
       "ExposeHeaders": ["Content-Range", "Content-Length", "ETag"],
       "MaxAgeSeconds": 86400
     },
     {
       "AllowedOrigins": ["https://forge.dashhq.org"],
       "AllowedMethods": ["PUT", "GET", "HEAD", "DELETE"],
       "AllowedHeaders": ["authorization", "content-type", "range", "x-amz-content-sha256", "x-amz-date", "x-amz-security-token"],
       "ExposeHeaders": ["Content-Range", "Content-Length", "ETag"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```
   The first rule lets any browser read the (public) packs. The second lets the web app at `https://forge.dashhq.org` push, merge and upload release assets with your key; leave it out if you only push from the CLI. Header names are lowercase on purpose (see [CORS header names](#cors-header-names)).
6. **Add and test the profile:**
   ```sh
   dg storage add r2-main --kind s3 \
     --endpoint https://<account-id>.r2.cloudflarestorage.com \
     --region auto --bucket forge \
     --public-url https://files.example.org \
     --access-key-id <access-key-id> \
     --secret-access-key keychain:dash-forge/r2-main
   dg storage test r2-main
   ```
   `dg storage test` writes a probe object with a signed PUT, reads it back with a signed GET, reads it anonymously through the public URL, checks the CORS preflight for `Range`, and then deletes the probe. If CORS or public access is missing, it prints the fix.

R2 wants `region = auto` and path-style addressing (the default).

## Backblaze B2

> **Not yet verified live.** This section follows Backblaze's documentation. It has not been run end to end with a B2 account: Forge's S3 storage has been tested only against self-hosted stores (RustFS, MinIO and Garage).

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
     },
     {
       "corsRuleName": "dashForgeWrite",
       "allowedOrigins": ["https://forge.dashhq.org"],
       "allowedOperations": ["s3_put", "s3_get", "s3_head", "s3_delete"],
       "allowedHeaders": ["authorization", "content-type", "range", "x-amz-content-sha256", "x-amz-date", "x-amz-security-token"],
       "exposeHeaders": ["content-range", "content-length", "etag"],
       "maxAgeSeconds": 86400
     }
   ]
   ```
   Setting CORS needs a key with `writeBuckets`, which a key restricted to one bucket cannot have: run it with an unrestricted key, and give Forge the restricted one.
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

> **Not yet verified live.** This section follows AWS's documentation. It has not been run end to end with an AWS account: Forge's S3 storage has been tested only against self-hosted stores (RustFS, MinIO and Garage).

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
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
       "Resource": "arn:aws:s3:::my-forge-packs/*"
     }]
   }
   ```
   `s3:ListBucket` is not needed. Without it AWS answers a check for a pack that is not there yet with `403` instead of `404` ([HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html)), and Forge then simply uploads the pack.
4. **CORS.** Save the following as `cors.json` and run `aws s3api put-bucket-cors --bucket my-forge-packs --cors-configuration file://cors.json`:
   ```json
   {
     "CORSRules": [
       {
         "AllowedOrigins": ["*"],
         "AllowedMethods": ["GET", "HEAD"],
         "AllowedHeaders": ["range"],
         "ExposeHeaders": ["Content-Range", "Content-Length", "ETag"],
         "MaxAgeSeconds": 86400
       },
       {
         "AllowedOrigins": ["https://forge.dashhq.org"],
         "AllowedMethods": ["PUT", "GET", "HEAD", "DELETE"],
         "AllowedHeaders": ["authorization", "content-type", "range", "x-amz-content-sha256", "x-amz-date", "x-amz-security-token"],
         "ExposeHeaders": ["Content-Range", "Content-Length", "ETag"],
         "MaxAgeSeconds": 86400
       }
     ]
   }
   ```
   The second rule is only for pushing from the web app; see the R2 section.
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

## Self-hosted S3: Garage, RustFS, MinIO

> **Tested in Docker on a developer Mac only.** On 2026-09-28 RustFS, Garage and the last MinIO community image passed `dg storage test`, and RustFS and Garage also stored real packs that a clone then read. Nothing was run on NAS hardware; [Storage on your home NAS](home-nas-storage.md) says which of its steps were run.

[Storage on your home NAS](home-nas-storage.md) walks through all of this on a Synology, a TrueNAS SCALE or a Linux box: Docker Compose, a Cloudflare Tunnel for a public https address, a key limited to one bucket, and a second copy for when the NAS is off.

The MinIO community edition is archived and its images (`minio/minio`, `minio/mc`) no longer pull, so for a new server use [Garage](https://garagehq.deuxfleurs.fr/) or [RustFS](https://github.com/rustfs/rustfs). Both take the CORS document from the AWS section through the S3 API:

```sh
aws --endpoint-url https://s3.example.org s3api put-bucket-cors --bucket forge --cors-configuration file://cors.json
```

- **Garage** serves anonymous reads only on its web endpoint (port 3902), not on the S3 API. Allow website access (`garage bucket website --allow forge`) and give the bucket an alias equal to the public hostname (`garage bucket alias forge files.example.org`). The public URL is that hostname **without** a `/forge` path, and the region is `garage`. Garage applies the bucket's CORS to the web endpoint too, and it compares `AllowedHeaders` case-sensitively, so keep the lowercase names.
- **RustFS** reads are anonymous once a bucket policy allows `s3:GetObject` (the AWS section's policy works); the public URL is `<endpoint>/<bucket>`. Its container runs as uid `10001`, so a bind-mounted data directory must belong to that user.
- **MinIO** has no per-bucket CORS: it answers every origin unless `mc admin config set <alias> api cors_allow_origin=…` restricted it. Make the bucket publicly readable but not publicly writable with `mc anonymous set download <alias>/forge`.

```sh
dg storage add garage --kind s3 --endpoint https://s3.example.org --region garage \
  --bucket forge --public-url https://files.example.org \
  --access-key-id <key id> --secret-access-key env:GARAGE_SECRET
dg storage test garage
```

**The public URL is recorded on chain forever**, with every pack, and everyone who clones reads it. Use a stable public https name on your own domain: a named Cloudflare Tunnel or a reverse proxy with TLS ([how, on a NAS](home-nas-storage.md#create-the-tunnel)). `dg storage add`, `dg storage test` and `dg doctor` warn, and `git push` refuses, when it is loopback, a LAN address, `.local`, plain http, or a temporary tunnel (`*.trycloudflare.com`, Tailscale Funnel's `*.ts.net`); see [Public addresses](#public-addresses).

The repo's `infra/docker-compose.yml` runs a local S3 store (RustFS, since the `minio/minio` image no longer pulls) whose `forge-byo` bucket has this exact shape: signed writes (`minioadmin` / `minioadmin`) and anonymous reads. `make storage-it` and `make storage-e2e` test against it.

## Storj

> **Not yet verified live.** This section follows Storj's documentation (linked below) and an unauthenticated check of Storj's CORS answers on 2026-09-28. It has not been run end to end with Storj credentials. Storj has no free tier, only a 30-day trial ([Storj pricing](https://storj.dev/dcs/pricing)).

Storj has two front doors, and Forge uses both:

- **Writes** go through its S3-compatible gateway, `https://gateway.storjshare.io` ([Storj: S3 gateway](https://storj.dev/dcs/api/s3/s3-compatible-gateway)). The gateway refuses anonymous reads (`AccessDenied`), so it can't be the public URL.
- **Reads** go through **linksharing**, which serves objects publicly at `https://link.storjshare.io/raw/<access key>/<bucket>/<key>` ([Storj: uplink share](https://storj.dev/dcs/api/uplink-cli/share-command)). The `/raw/` path returns the object's bytes; `/s/` is a preview page, which Forge can't use.

1. **Create a bucket**, for example `forge`, in the Storj console.
2. **Create S3 credentials for writing.** Go to **Access Keys → New Access Key**, type **S3 Credentials**, then **Advanced**. Allow **Read**, **Write** and **Delete**. Forge never lists, so List is not needed. Choose **Select Buckets → forge**, set an expiration if you like, and click **Create Access** ([Storj: access](https://storj.dev/dcs/access)). Keep the access key and the secret key.
3. **Create a read-only public share for the bucket** with the [uplink CLI](https://storj.dev/dcs/api/uplink-cli):
   ```sh
   uplink share --url --readonly --not-after=none sj://forge/
   ```
   `--url` registers a public access and prints a URL such as `https://link.storjshare.io/s/<access key>/forge/`. Your public URL is the same with `/raw/` in place of `/s/`, and no trailing slash: `https://link.storjshare.io/raw/<access key>/forge`. This access key is public by design: it can only read and list `forge`. Add `--disallow-lists` to stop listing too.

   The public URL is recorded on chain with every pack, and revoking that share breaks it for every pack already pushed. For a URL you control, serve linksharing on your own domain instead: `uplink share --dns files.example.org --readonly --not-after=none sj://forge/` prints the CNAME and TXT records to add ([Storj: custom domains](https://storj.dev/dcs/code/static-site-hosting/custom-domains)). Your public URL is then `https://files.example.org`. Storj serves https on a custom domain only on a Pro account, or with Cloudflare's proxy in front.
4. **CORS: nothing to configure, and nothing you can configure.** The gateway refuses `PutBucketCors` ([Storj: S3 compatibility](https://storj.dev/dcs/api/s3/s3-compatibility)) and answers every origin itself ([Storj: CORS](https://storj.dev/dcs/buckets/cors)). On 2026-09-28 the gateway allowed a PUT preflight from `https://forge.dashhq.org` with the SigV4 headers, and linksharing allowed any origin for `GET` and `HEAD` with any header. Linksharing sends no `Access-Control-Expose-Headers`. The web app doesn't need it, so `dg storage test` shows a warning there, not a failure ([CORS header names](#cors-header-names)).
5. **Add and test the profile:**
   ```sh
   export STORJ_SECRET=…   # or put it in the keychain
   dg storage add storj --kind s3 \
     --endpoint https://gateway.storjshare.io --region us-east-1 \
     --bucket forge --public-url https://link.storjshare.io/raw/<access key>/forge \
     --access-key-id <S3 access key> --secret-access-key env:STORJ_SECRET
   dg storage test storj
   ```
   The gateway routes each request to the instance nearest you. Storj doesn't document a required region value: its own examples use `eu1`, its integration guides accept any value, and `us-east-1` (the `dg storage add` default for other S3 stores) is used here. If the signed PUT fails with a region error, re-add the profile with the region the error names.

Storj bills storage and egress separately, and counts every object under 50 KB as 50 KB ([Storj pricing](https://storj.dev/dcs/pricing/simplified)). Small packs of small pushes each count as 50 KB.

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
- CORS: kubo's gateway sends `Access-Control-Allow-Origin: *` by default, and allows the `Range` header. If you changed that:
  ```sh
  ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
  ```

A pin on a laptop that is usually offline makes a poor replica. Pair it with a bucket, or with a pinning service.

## IPFS: kubo + a pinning service

> **Not yet verified live.** The pinning client has been tested only against a scripted local server, not a real service ([PRD 04](../prd/04-storage-adapters.md)). The services below are listed from their own documentation.

This kind adds the content through your kubo node, then asks any [IPFS Pinning Service API](https://ipfs.github.io/pinning-services-api-spec/) endpoint to pin the CID, passing your node's addresses as `origins`. The copy counts only once the service reports `pinned`. If the service already has a pin for that CID, the helper reuses it.

These services document a Pinning Service API endpoint:

| Service | `--pinning-endpoint` | `--pinning-token` | `--public-gateway` |
|---|---|---|---|
| [Pinata](https://docs.pinata.cloud/api-reference/pinning-service-api) | `https://api.pinata.cloud/psa` | the JWT shown once when you create an API key | your dedicated gateway, `https://<name>.mypinata.cloud`. By default it serves only CIDs pinned to your account ([Pinata: dedicated gateways](https://docs.pinata.cloud/gateways/dedicated-ipfs-gateways)) |
| [Filebase](https://filebase.com/docs/ipfs/pinning-service-api) | `https://api.filebase.io/v1/ipfs` | a token for one bucket, from **Access Keys** in the console; pins go to that bucket | a dedicated gateway, `https://<name>.myfilebase.com`, public (any CID) or private (your pins only) ([Filebase: dedicated gateways](https://filebase.com/docs/ipfs/gateways/managing-dedicated-gateways)) |
| [4EVERLAND](https://docs.4everland.org/storage/4ever-pin/pinning-services-api) | `https://api.4everland.dev` | the access token on the **4EVER Pin** page | the public gateway `https://4everland.io`, limited to 300 requests a minute ([4EVERLAND: IPFS gateway](https://docs.4everland.org/gateways/ipfs-gateway)) |

Store the token in your keychain (macOS shown) and add the profile:

```sh
security add-generic-password -s dash-forge -a pins -w   # prompts for the token
dg storage add pins --kind ipfs-pinning-service \
  --api http://127.0.0.1:5001 --gateway http://127.0.0.1:8080 \
  --pinning-endpoint https://api.pinata.cloud/psa \
  --pinning-token keychain:dash-forge/pins \
  --public-gateway https://<name>.mypinata.cloud
dg storage test pins
```

- **Use the service's own gateway as `--public-gateway`.** The manifest then records `https://<gateway>/ipfs/<cid>`, and every reader tries it first. The service holds the pin, so its gateway can serve the pack when your own node is off. The shared public gateways may not find it at all.
- **The service fetches the content from your node**, so the node needs to be publicly dialable while the pin completes.
- **The pin timeout is 120 s** by default: the helper asks the service every 2 s whether the pin is `pinned`. A large pack, or a busy service, can take longer: raise it with `--pin-timeout-secs 600`. When it runs out, that copy counts as failed, and the push says so.

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

**A policy applies to packs pushed after you set it.** A pack's manifest is permanent, so packs already pushed keep the copies they were stored with. Inside a repository with a `dash://` remote, `dg storage use` counts the packs with fewer copies than the new policy asks for and prints the command that stores them again as one consolidated pack; `dg doctor` reports them too:

```sh
dg repack <owner>/<repo> --profile r2-main,kubo   # one new pack on both; every listed target must confirm; asks first
dg repack <owner>/<repo> --profile r2-main,platform   # `platform` is a target too
```

`dg repack` downloads every pack and writes one consolidated pack that supersedes them. It costs one pack upload and one browse-index upload per listed target (Platform chunks at the Platform rate when `platform` is listed), plus two small manifest writes. A manifest can name at most 32 packs it supersedes; with more live packs, `dg repack` says how many it could not name, and running it again names the next ones. It stops with nothing written if a push lands while it runs. (`dg reseed --profile <p>` copies each pack separately instead, but records the new copy as your own manifest only for packs you have not recorded yet, so it cannot add a copy to packs you pushed yourself.)

These commands write git config, and you can also set it by hand:

| key | meaning |
|---|---|
| `dash.storage` | Comma-separated profile names. `platform` is built in. **Unset means Platform only**, exactly as before. |
| `dash.replicas` | N. The push fails unless N targets confirm. Default: every listed target. |
| `dash.platformFallback` | When the external targets cannot reach N, store the pack on Platform instead. The costed fallback is also subject to the cost guard. |
| `dash.allowPrivateUri` | Record a profile's non-public read address anyway (see [Public addresses](#public-addresses)). |
| `remote.<name>.dashStorage`, `…dashReplicas`, `…dashPlatformFallback`, `…dashAllowPrivateUri` | Per-remote overrides. |

When Platform is one of the targets, the manifest records `storage = 0`, `chunkCount > 0`, and **also** lists every external URI. Platform-reading clients, including today's web app, read the chunks. CLI readers race the external copies first. With only external targets, the manifest records `storage = 1`, `chunkCount = 0`, and the URIs.

To let readers (and the web app) know where this repo's packs live, advertise the policy's public read bases in the on-chain `config.backend`. This is one small config write:

```sh
dg storage advertise <owner>/<repo>
```

A **new** repository needs none of this: `dg repo create --push --storage r2-main` and `dg init --storage r2-main` write the advertised mode and read bases into the repository's first config, set `dash.storage` (and `dash.replicas` when you pass `--replicas`) in the repository's own git config, and push. Without `--storage` they use `dash.storage` from git config (this repository's, then your global one), then your only profile if you have exactly one. With none of those they stop **before creating anything** ([E508](../errors.md#e508)) and quote what Platform storage would cost for this repository; pass `--storage platform` to accept that price.

## Public addresses

Every push records each copy's read address (an S3 profile's `--public-url`, an IPFS profile's `--public-gateway`) in its manifest, **on chain, forever**. Everyone who clones or browses reads it. So it must be a public https URL that will keep working:

| Address | What happens |
|---|---|
| Loopback, LAN (`10/8`, `172.16/12`, `192.168/16`, CGNAT `100.64/10`, link-local, IPv6 ULA and link-local), `.local`, `.localhost`, `.internal` | Nobody else can read it. `git push` refuses ([E501](../errors.md#e501)) before anything is built, uploaded or paid for. |
| Plain `http://` | The web app refuses to read it (the CLI still does). `git push` refuses. |
| A Cloudflare quick tunnel (`*.trycloudflare.com`) | Its random name changes every time the tunnel restarts. `git push` refuses. Use a named tunnel on your own domain. |
| Tailscale Funnel (`*.ts.net`) | Stops working when the machine or tailnet is renamed or Funnel is switched off. `git push` refuses. |
| `*.r2.dev` | Works, but Cloudflare rate-limits it and does not recommend it for production. A warning only; connect a custom domain for real repositories. |

`dg storage add`, `dg storage test` and `dg doctor` print these warnings. To record such an address anyway (a local test, a LAN-only mirror), use one of:

```sh
git push -o allow-private-uri origin main          # this push only
git config dash.allowPrivateUri true               # this repository
dg storage add minio-lan … --allow-private-uri     # this profile (allow_private_uri = true in storage.toml)
dg init --storage minio-lan --allow-private-uri    # dg init / dg repo create --push
```

`dg init --allow-private-uri` also sets `dash.allowPrivateUri true` in the repository's git config when one of its storage profiles needs it, so later plain `git push`es go to the same place.

The web app refuses the same loopback, private and plain-http addresses and warns about temporary tunnels; `forge-contracts/fixtures/public-urls.json` holds the cases both test.

## CORS header names

Browsers send the request headers of a preflight in lowercase (`Access-Control-Request-Headers: range`), and some stores compare `AllowedHeaders` case-sensitively: Garage refuses a `range` preflight for `"AllowedHeaders": ["Range"]`. So every document in this guide lists lowercase names, which work on AWS, R2, B2, Garage and RustFS alike.

The web app does not need `Content-Range` in `Access-Control-Expose-Headers` (it slices ranged reads itself), so `dg storage test` only warns when a store does not expose it (Storj linksharing sends no `Access-Control-Expose-Headers` at all).

## Cost guard

Every push prints its Platform estimate. You can also make it stop and ask:

```sh
git config dash.costWarnThreshold 0.05   # DASH (dg doctor --fix sets this)
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
- a body larger than the manifest's `sizeBytes` is refused. A manifest with no size (`sizeBytes` 0) gets 256 MiB;
- each candidate's whole transfer gets `max(120 s, size ÷ 1 MiB/s)`, so a 2 GiB pack gets about 34 minutes. A host that stalls outright is cut off sooner, after 120 s with no bytes;
- when Platform chunks exist, no new external candidate is started after `max(90 s, half that deadline)`, and the reader falls back to the chunks. A transfer already in progress is not abandoned;
- the whole read ends after twice the candidate deadline (4 minutes for a small pack), however many copies are left.

The default gateway list lives in one place, [`forge-contracts/config/storage-defaults.json`](../../forge-contracts/config/storage-defaults.json), with the date it was last verified. `git-remote-dash`, `dg` and the web app all embed it; in the web app, **Settings → Your IPFS gateways** adds gateways tried before it. It is deliberately short: public gateways come and go (ipfs.io and dweb.link stopped serving on 2026-09-21), and every dead entry costs a timeout. Override it for the CLI in `storage.toml`:

```toml
[read]
ipfs_gateways = ["http://127.0.0.1:8080", "https://ipfs.filebase.io"]
```

`dg doctor` probes every gateway in the list (and each IPFS profile's public gateway) and flags the dead ones. When no gateway can serve a repo, the web app says which gateways failed and offers to add one, instead of loading forever.

`dg storage status <owner>/<repo>` probes every copy of every pack: each recorded URL, and each CID on each gateway. A recorded URL on plain http, this machine or a private network is listed with the reason and not contacted, unless it is on an origin you configured.

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

Plain `dg reseed --profile <name>` (without `--from-local`) re-uploads packs that are still readable to an additional target. It downloads them first, so it can't restore a pack whose copies are all gone. It is for maintainers and writers only, because the new copy is recorded as your own pack manifest, and it refuses anyone else before uploading. For a pack you already recorded, it reports whether the upload re-created an address a recorded copy names; if not, the copy is not recorded, and `dg repack --profile <name>` is the way to record your packs at a new address.

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
| `push not started: storage profile "x" would record a non-public public_url on chain [E501]` | The profile's public address is loopback, LAN, plain http or a temporary tunnel. Give it a public https address, or see [Public addresses](#public-addresses) to record it anyway. |
| `No terminal to confirm on` | See [Cost guard](#cost-guard). |
| `pack … already recorded at …, none reachable` | An earlier push already recorded this exact pack, but none of its copies can be read now. This push stored nothing and updated no ref. Restore the copy: see [Restoring a lost copy](#restoring-a-lost-copy). |
| `note: an earlier interrupted push left Platform chunks …` | A Platform upload was interrupted and you then pushed the same pack to external storage only. Those chunks still hold a refundable deposit. Re-push with `platform` in `dash.storage` to use them, or reclaim them at teardown. The journal that names them is kept. |

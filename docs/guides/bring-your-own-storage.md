# Bring your own storage

With Dash Forge, `git push` can keep your pack bytes in storage **you** own, such as an S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3, MinIO) or an IPFS node. Only the small, signed pieces go on Dash Platform: the `packManifest`, which records where the pack lives plus its SHA-256, and the ref updates. The Forge project runs none of this storage. Every copy of your data is either on your own storage or on Platform.

Readers never trust your bucket. A clone accepts only bytes that hash to the SHA-256 in the on-chain manifest. When a copy is missing or wrong, the reader tries the next copy and falls back to Platform chunks if they exist. So losing a copy costs availability, never integrity.

This guide covers:

1. [How it fits together](#how-it-fits-together)
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
| **Secrets** (S3 secret key, pinning token, …) | environment variables or your OS keychain | only you |
| A repo's **storage policy**: which profiles, how many copies | git config (`dash.storage`, `dash.replicas`) | only you |
| Pack bytes | your bucket / IPFS node (and/or Platform chunks) | public, if you give the bucket a public URL |
| Manifest: pack SHA-256, public URLs, CID | Dash Platform | everyone |

Secrets are **never** written to `storage.toml`, to the chain, or to logs. `storage.toml` holds only references like `env:R2_SECRET_ACCESS_KEY` or `keychain:dash-forge/r2-main`. If you paste a literal secret into it, `dg` refuses to load the file.

A push works like this:

1. The helper builds the pack exactly as before.
2. It prints what goes where, and what Platform will charge:
   `dash: pack 1.2 MiB → r2-main, kubo (need 2 of 2); Platform: manifest + refs only, est. 0.000373 DASH`
3. It uploads to every target **in parallel**. The object keys are content-addressed (`packs/<sha256>.pack`, or the CID for IPFS), so a re-push is idempotent.
4. It **verifies each copy by reading it back**. Packs up to 16 MiB get a full GET plus SHA-256. Larger packs get a size check plus byte-exact head and tail ranges. The store also verified the whole body on upload (S3 checks `x-amz-content-sha256`; IPFS checks that kubo's CID matches a local re-derivation).
5. If fewer than `dash.replicas` targets confirm, **the push fails before anything is written to Platform**: no manifest, no ref. The error names each failing target.
6. Otherwise it writes the manifest with every confirmed URI, then the refs. It also publishes the browse-index fragment to the same targets.

Use `git push -v` (or anything louder than `-q`) to see the helper's `dash:` lines.

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
- `--public-gateway` also records `https://…/ipfs/<cid>` in the manifest, which browsers can use directly. Readers already race `ipfs://<cid>` across the public gateway list (see [Reading](#reading-gateways-and-fallbacks)), but content that only your node holds is only reachable through a gateway that can reach your node.
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

## Cost guard

Every push prints its Platform estimate. You can also make it stop and ask:

```sh
git config dash.costWarnThreshold 0.01   # DASH
git config dash.confirm auto             # auto (default): ask only above the threshold
                                         # always: ask before every paid push
                                         # never: print and go
```

Git owns the helper's stdin and stdout, so the question goes to `/dev/tty`. Without a terminal (CI, GUI clients), a push that needs confirmation fails with a message telling you to use `git -c dash.confirm=never push …` or to raise the threshold. It never assumes yes.

## Reading: gateways and fallbacks

Every clone, fetch, repack and reseed reads each pack like this:

1. It tries every `https://` URL the manifest recorded (public bucket URLs, public gateway URLs).
2. For each recorded `s3://bucket/key` where you have a profile for that bucket, it tries a signed GET. This covers private buckets.
3. It tries `ipfs://<cid>` on **every gateway in your list**, two at a time.
4. Only then does it fall back to Platform chunks, if the manifest has any.

A candidate wins only when its bytes hash to the manifest's SHA-256. The default gateway list lives in one place, [`forge-contracts/config/storage-defaults.json`](../../forge-contracts/config/storage-defaults.json). `git-remote-dash` and `dg` embed it, and the web app is meant to import the same file when its storage settings land. Override it in `storage.toml`:

```toml
[read]
ipfs_gateways = ["http://127.0.0.1:8080", "https://ipfs.io", "https://dweb.link"]
```

`dg storage status <owner>/<repo>` probes every copy of every pack: each recorded URL, and each CID on each gateway.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `storage policy not met: 1 of 2 required target(s) confirmed; <name>: …` | A target failed. Nothing was written to Platform. Fix the target and push again (confirmed copies are content-addressed and not re-uploaded), lower `dash.replicas`, or set `dash.platformFallback=true`. |
| `S3 PUT … 403 (access denied — check the credentials, the region, …)` | Wrong key or secret, wrong `--region` (R2 needs `auto`), or the key cannot write this bucket. |
| `S3 … 301/307 (redirected …)` | The bucket is in a different region, or needs virtual-hosted addressing (`--virtual-hosted`). |
| `secret env:X is not set` | Export the variable in the environment that runs `git` and `dg`, or switch to a `keychain:` reference. |
| `kubo returned CID … but these bytes derive to …` | The node ignored the pinned import parameters (a very old kubo, or a proxy rewriting the request). Upgrade kubo. |
| `pinning service request … still queued` | The service cannot reach your node. Make it dialable or raise `--pin-timeout-secs`. |
| `dg storage test`: `browser CORS` FAIL | Paste the printed provider CORS configuration. The CLI works without CORS, but the web app does not. |
| `No terminal to confirm on` | See [Cost guard](#cost-guard). |

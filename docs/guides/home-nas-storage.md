# Storage on your home NAS

A NAS or server you already own can hold your pack bytes, so a push costs only the small Platform writes (the manifest and the ref updates) and nobody bills you for storage. This guide runs an S3-compatible store, [RustFS](https://github.com/rustfs/rustfs) or [Garage](https://garagehq.deuxfleurs.fr/), in Docker Compose on any Linux machine that runs Docker, amd64 or arm64, and connects it to `dg`.

Two facts decide most of the choices below:

- **Every push records the store's public URL on chain, forever**, and everyone who clones or browses reads from it. It must be a public https hostname on a domain you own. LAN addresses, plain http and temporary tunnel names (`*.trycloudflare.com`, `*.ts.net`) are refused ([Public addresses](bring-your-own-storage.md#public-addresses)).
- **A repository is only as available as its copies.** When the NAS is off, a pack stored only there can't be read. Keep a second copy somewhere else ([below](#when-the-nas-is-offline)).

Readers never trust the NAS: a clone accepts only bytes that hash to the SHA-256 on chain, so a broken NAS costs availability, never integrity.

Want IPFS instead, with no domain needed? [Run your own backend](self-host-backend.md) sets up a node on the same kind of machine with one command.

1. [Choose a store](#choose-a-store)
2. [Run the store](#run-the-store)
3. [Give it a public https address](#give-it-a-public-https-address)
4. [A bucket, a key for that bucket only, public reads and CORS](#a-bucket-a-key-for-that-bucket-only-public-reads-and-cors)
5. [Connect it to `dg`](#connect-it-to-dg)
6. [When the NAS is offline](#when-the-nas-is-offline)
7. [Backups](#backups)
8. [Troubleshooting](#troubleshooting)

Replace every `<…>` placeholder, and `example.org`, with your own values. For an IPFS node instead, see [Run your own IPFS node](run-your-own-ipfs-node.md).

---

## Choose a store

| Store | Use it when | Public hostnames | Profile values |
|---|---|---|---|
| **RustFS** (Apache-2.0) | the simplest setup: one container, one hostname | `s3.example.org` → port 9000 | region `us-east-1`, public URL `https://s3.example.org/forge` |
| **Garage** (AGPL) | a small store that can grow to several nodes | `files.example.org` → port 3902 (the web endpoint, for anonymous reads) | region `garage`, public URL `https://files.example.org` |

## Run the store

Make a directory for the stack on a data volume. It holds `compose.yaml`, any secrets (`chmod 600` them), and the data. Then run `docker compose up -d`. `restart: unless-stopped` brings the stack back after a reboot.

### RustFS

`.env`:

```sh
RUSTFS_ROOT_SECRET=<a long random string, e.g. the output of: openssl rand -hex 20>
```

`compose.yaml`:

```yaml
services:
  rustfs:
    image: rustfs/rustfs:1.0.0
    restart: unless-stopped
    environment:
      RUSTFS_ACCESS_KEY: forge-admin                 # the admin user, for setup only
      RUSTFS_SECRET_KEY: ${RUSTFS_ROOT_SECRET:?set RUSTFS_ROOT_SECRET in .env}
    volumes:
      - ./data:/data
    ports:
      - "9000:9000"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:9000/health/ready"]
      interval: 10s
      retries: 12
```

**The RustFS container runs as user `10001`, so its data directory must belong to that user.** Before the first start: `mkdir -p data && sudo chown -R 10001:10001 data`. `docker compose up -d --wait` returns once it is healthy.

Never leave the admin secret at RustFS's default (`rustfsadmin`). The admin key is only for the setup commands below; `dg` gets its own key.

### Garage

`garage.toml`:

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret_file = "/etc/garage.rpc_secret"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"

[s3_web]
bind_addr = "[::]:3902"
root_domain = ".web.garage.localhost"
index = "index.html"
```

Create the RPC secret once: `openssl rand -hex 32 > rpc_secret && chmod 600 rpc_secret`.

`compose.yaml`:

```yaml
services:
  garage:
    image: dxflrs/garage:v2.4.1
    restart: unless-stopped
    volumes:
      - ./garage.toml:/etc/garage.toml:ro
      - ./rpc_secret:/etc/garage.rpc_secret:ro
      - ./meta:/var/lib/garage/meta
      - ./data:/var/lib/garage/data
    ports:
      - "3900:3900"            # S3 API, for writes
      - "3902:3902"            # web endpoint, for anonymous reads
```

Once it is running, give the node its storage role (the capacity is how much of the disk Garage may use):

```sh
docker compose exec garage /garage status                 # note the node id
docker compose exec garage /garage layout assign -z home -c 500G <node id>
docker compose exec garage /garage layout apply --version 1
```

## Give it a public https address

Put a reverse proxy with a certificate, or a tunnel you control, in front of the store, and route your hostname to it:

| Store | Hostname | Route to |
|---|---|---|
| RustFS | `s3.example.org` | port 9000 |
| Garage | `files.example.org` | port 3902 |

The proxy must pass the `Host` header through (Garage picks the bucket by it), allow anonymous requests, and answer CORS preflights from the store. Don't put a login page (such as Cloudflare Access) in front of it: every clone and browser read is anonymous.

Check it from anywhere:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://s3.example.org/forge/nothing-here   # 404 from the store, not a proxy error page
```

---

## A bucket, a key for that bucket only, public reads and CORS

Run these on the NAS, or from your computer against its LAN address (`http://nas.local:9000` below). You need the AWS CLI for the bucket policy and CORS.

Save the CORS document as `cors.json`. It is the one in [Bring your own storage](bring-your-own-storage.md#an-s3-compatible-bucket), with lowercase header names ([why](bring-your-own-storage.md#cors-header-names)):

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

The first rule lets any browser read packs. The second lets the web app at `https://forge.dashhq.org` upload with your key (release assets, browser merges); leave it out if you only push from the CLI. On testnet, use `https://testnet-forge.dashhq.org` there instead.

### RustFS

Use RustFS's own CLI, [`rc`](https://github.com/rustfs/cli/releases) (download the archive for your system and check it against the `.sha256` file beside it):

```sh
rc alias set nas http://nas.local:9000 forge-admin <RUSTFS_ROOT_SECRET>
rc mb nas/forge
```

A policy that can write, read and delete objects in `forge`, and nothing else. Save it as `forge-rw.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": ["arn:aws:s3:::forge/*"]
  }]
}
```

```sh
rc admin policy create nas/ forge-rw forge-rw.json
rc admin user add nas/ forge <a new long random secret>        # this is the key dg will use
rc admin policy attach nas/ forge-rw --user forge
```

Anonymous reads of objects, but not of the bucket listing. Save as `public-read.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::forge/*"
  }]
}
```

```sh
export AWS_ACCESS_KEY_ID=forge-admin AWS_SECRET_ACCESS_KEY=<RUSTFS_ROOT_SECRET> AWS_DEFAULT_REGION=us-east-1
aws --endpoint-url http://nas.local:9000 s3api put-bucket-policy --bucket forge --policy file://public-read.json
aws --endpoint-url http://nas.local:9000 s3api put-bucket-cors --bucket forge --cors-configuration file://cors.json
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

Use this policy rather than `rc anonymous set download`, which also lets anyone list the bucket.

### Garage

```sh
g() { docker compose exec garage /garage "$@"; }
g bucket create forge
g key create forge-key                         # prints the Key ID and Secret key: this is the key dg will use
g bucket allow --read --write forge --key forge-key
g bucket website --allow forge                 # anonymous reads on the web endpoint
g bucket alias forge files.example.org         # the web endpoint serves this bucket for that hostname
```

`forge-key` can read and write objects in `forge` only, so it can't change the bucket's CORS. Make a separate owner key for that, use it once, then delete it:

```sh
g key create forge-admin
g bucket allow --owner forge --key forge-admin
AWS_ACCESS_KEY_ID=<forge-admin key id> AWS_SECRET_ACCESS_KEY=<forge-admin secret> AWS_DEFAULT_REGION=garage \
  aws --endpoint-url http://nas.local:3900 s3api put-bucket-cors --bucket forge --cors-configuration file://cors.json
g key delete --yes forge-admin
```

---

## Connect it to `dg`

Add the profile with the key that can only touch the bucket, then test it. The endpoint, where `dg` writes, is never recorded on chain, so it can be the NAS's LAN address; only the public URL is recorded:

```sh
export NAS_SECRET=<the forge key's secret>     # or store it in your OS keychain and use keychain:dash-forge/nas
dg storage add nas --kind s3 \
  --endpoint http://nas.local:9000 --region us-east-1 \
  --bucket forge --public-url https://s3.example.org/forge \
  --access-key-id forge --secret-access-key env:NAS_SECRET
dg storage test nas
```

For Garage: `--endpoint http://nas.local:3900 --region garage --public-url https://files.example.org`, and the Key ID from `g key create` as `--access-key-id`.

```
Testing storage profile "nas" (s3):
  [ OK ] credentials    resolved (SigV4 signing)
  [ OK ] put            wrote probe/dg-storage-test-….txt (signed PUT)
  [ OK ] get            read back identical bytes (signed GET)
  [ OK ] public read    anonymous GET https://s3.example.org/forge/probe/dg-storage-test-….txt OK
  [ OK ] browser CORS   GET + Range preflight allowed, Content-Range exposed
  [ OK ] delete         probe removed
```

Every row must be `OK` ([Troubleshooting](#troubleshooting) says what each failure means). `git push` and `git clone` work without CORS, but the web app can't show the code without it.

Then use it:

```sh
dg storage use nas              # inside a repository: its next pushes go to the NAS
dg storage use nas --global     # every repository without its own dash.storage
dg init --storage nas           # a new repository: create, configure and push in one step
```

The push prints where the pack went and what Platform charged:

```
dash: stored pack 7b246a46c436 (201.0 KiB, 4 objects)
dash: pack 7b246a46c436 (201.0 KiB) stored on nas (1 verified)
dash: updated main → 2ca4b79
dash: done · Platform charged ≈0.0054 DASH · remaining 0.9900 DASH · https://testnet-forge.dashhq.org/<owner>/nas-demo
```

**The same profile also takes CI logs.** `dg ci report <owner>/<repo> --sha <commit> --name build --status completed --conclusion success --log build.log --storage nas` (see [CI and check runs](ci.md)) uploads a run's log to this bucket.

---

## When the NAS is offline

**With the NAS as the only copy**, every pack stored only there is unreadable until it is back:

- `git clone` stops with [E503](../errors.md#e503) and names the copies it tried.
- `dg storage status <owner>/<repo>` marks each copy `[DOWN]`.
- Your own pushes stop before anything is paid for ([E502](../errors.md#e502)): no manifest, no ref.

Nothing is lost: when the NAS comes back, every clone works again.

**With a second copy**, readers don't notice: a clone reads the other copy and warns that one is unavailable. Add a second profile (another store, or `platform`) and list both:

```sh
dg storage use nas,second
```

That covers new pushes. To give the packs already pushed a second copy too, run `dg repack <owner>/<repo> --profile nas,second` while the NAS is up: it writes one consolidated pack to both. A repository that is still a single pack can't be repacked ([E204](../errors.md#e204)): push once more, then run the repack while the NAS is up. Afterwards, `dg storage status <owner>/<repo>` should show an `OK` copy of every pack off the NAS.

Run `dg storage status <owner>/<repo>` after any change: it probes every recorded copy of every pack.

## Backups

The second copy keeps the repository **readable**. A backup of the NAS protects the **bytes**:

- **RAID is not a backup.** Snapshot the volume the store lives on and copy it off the machine.
- **A copy made outside `dg` is a backup, not a replica.** Readers try only the URLs each pack's manifest recorded at push time. A bucket you fill with another tool is invisible to them until you restore from it.
- **Restoring is copying the objects back.** Object keys are content-addressed (`packs/<sha256>.pack`), so putting the same bytes back under the same key makes every recorded URL work again. You can also restore from any clone with `dg reseed <owner>/<repo> --from-local` ([Restoring a lost copy](bring-your-own-storage.md#restoring-a-lost-copy)).
- Also back up `storage.toml` (`~/.config/dash-forge/`) and the store's config (`.env`, `garage.toml`, `rpc_secret`), and keep the secrets in a password manager.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| The RustFS container restarts with a permission error on `/data` | The data directory isn't owned by uid `10001`: `sudo chown -R 10001:10001 data`. |
| `push not started: … would record a non-public public_url on chain [E501]` | The public URL is a LAN address, plain http, or a temporary tunnel name. Use your own hostname. |
| `dg storage test`: `public read` FAIL | RustFS: the `public-read.json` policy is missing. Garage: `bucket website --allow` or the alias to the public hostname is missing, or the public URL has a `/forge` path it shouldn't have. Or the proxy has no route for the hostname. |
| `dg storage test`: `browser CORS` FAIL | `cors.json` was not applied. On Garage only an owner key can set it (the read-write key gets `AccessDenied … Operation is not allowed for this key`). |
| `dg storage test`: `put` fails with `failed to lookup address information` | The endpoint's hostname doesn't resolve. |
| `git clone` fails with E503 while the NAS is off | A pack whose only copy is on the NAS. Bring it back, and [add a second copy](#when-the-nas-is-offline). |
| A login page instead of the object | An access gate protects the hostname. Remove it from the read hostname. |

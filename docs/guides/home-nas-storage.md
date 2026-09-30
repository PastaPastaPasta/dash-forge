# Storage on your home NAS

A NAS you already own can hold your pack bytes, so a push costs only the small Platform writes (the manifest and the ref updates) and nobody bills you for storage. This guide runs an S3-compatible store in Docker on a Synology, a TrueNAS SCALE or any Linux box, puts it on a public https address with a Cloudflare Tunnel, and connects it to `dg`. It also covers a kubo (IPFS) node on the NAS.

Two facts decide most of the choices below:

- **Every push records the store's public URL on chain, forever**, and everyone who clones or browses reads from it. It must be a public https hostname on a domain you own. LAN addresses, plain http, quick tunnels and Tailscale Funnel names are refused ([Public addresses](bring-your-own-storage.md#public-addresses)).
- **A repository is only as available as its copies.** When the NAS is off, a pack stored only there can't be read. Keep a second copy somewhere else ([below](#when-the-nas-is-offline)).

Readers never trust the NAS: a clone accepts only bytes that hash to the SHA-256 on chain, so a broken NAS costs availability, never integrity.

1. [What you will build](#what-you-will-build)
2. [Choose a store](#choose-a-store)
3. [Create the tunnel](#create-the-tunnel)
4. [Run the store](#run-the-store): [RustFS](#rustfs), [Garage](#garage); on [Synology](#on-a-synology), [TrueNAS SCALE](#on-truenas-scale) or [Linux](#on-a-linux-box)
5. [A bucket, a key for that bucket only, public reads and CORS](#a-bucket-a-key-for-that-bucket-only-public-reads-and-cors)
6. [Connect it to `dg`](#connect-it-to-dg)
7. [When the NAS is offline](#when-the-nas-is-offline)
8. [Backups](#backups)
9. [IPFS: kubo on the NAS](#ipfs-kubo-on-the-nas)
10. [Troubleshooting](#troubleshooting)

Replace every `<…>` placeholder, and `example.org`, with your own values.

---

## What you will build

```
                        ┌──────────────────────── your NAS ────────────────────────┐
 git push ──(LAN or ───▶│  S3 store (RustFS or Garage)  ◀── cloudflared (outbound) │
  tunnel)               └──────────────────────────────────────────┬───────────────┘
                                                                   │  no open ports
 git clone / web app ──▶ https://s3.example.org ──── Cloudflare ───┘
                        (the public URL recorded on chain)
```

- The store keeps packs in one bucket, `forge`.
- `cloudflared` runs next to it and makes an **outbound** connection to Cloudflare, so you open no port on your router. Cloudflare serves your hostname with a valid certificate and forwards it to the store.
- `dg` signs uploads with a key that can write only that bucket. Anyone can read objects anonymously; nobody can list, write or delete without the key.

## Choose a store

| Store | Use it when | Hostnames | Profile values |
|---|---|---|---|
| [**RustFS**](https://github.com/rustfs/rustfs) (Apache-2.0) | the simplest setup: one container, one hostname | `s3.example.org` → port 9000 | endpoint `https://s3.example.org`, region `us-east-1`, public URL `https://s3.example.org/forge` |
| [**Garage**](https://garagehq.deuxfleurs.fr/) (AGPL) | a mature, small store that can grow to several nodes | `s3.example.org` → port 3900 (the S3 API, for writes); `files.example.org` → port 3902 (the web endpoint, for anonymous reads) | endpoint `https://s3.example.org`, region `garage`, public URL `https://files.example.org` (no `/forge`: Garage picks the bucket from the hostname) |
| **MinIO** | you already run it | as RustFS | as RustFS |

The MinIO community edition is archived, and its images (`minio/minio`, `minio/mc`) no longer pull from Docker Hub ([minio/minio](https://github.com/minio/minio)). Don't start a new server on it.

## Create the tunnel

Do this first: the compose files below start the tunnel connector, and it needs the tunnel's token. You need a domain whose DNS is on Cloudflare (a free plan is enough).

1. In the Cloudflare dashboard, open **Networking → Tunnels → Create a tunnel**, choose **Cloudflared**, and name it (`nas`). The install command it shows ends in `--token <long value>`: copy that value. Don't run the command itself, because the `cloudflared` container is the connector ([Cloudflare: create a tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)).
2. Add a **published application** route for each hostname in the table above. The service is the container's name on the compose network, over plain http (Cloudflare adds TLS at its edge):

   | Store | Hostname | Service |
   |---|---|---|
   | RustFS | `s3.example.org` | `http://rustfs:9000` |
   | Garage | `s3.example.org` | `http://garage:3900` |
   | Garage | `files.example.org` | `http://garage:3902` |

The tunnel shows **Healthy** once the store's stack is running (next section).

- **Don't put Cloudflare Access (Zero Trust login) in front of the read hostname.** Access denies anonymous requests and CORS preflights, and every clone and browser read is anonymous.
- **Upload size.** Cloudflare limits a proxied request body to 100 MB on the Free and Pro plans ([Cloudflare: 413](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/)). Forge uploads each pack in a single PUT. Reads have no such limit. If a large first push fails with `413`, push over the LAN ([Pushing from home](#pushing-from-home)).
- **Tailscale Funnel** names (`*.ts.net`) can't be the public URL, but Funnel works for the **endpoint** you push to when away from home: the endpoint is never recorded on chain.
- **Without a tunnel,** a reverse proxy with a certificate on port 443 works too. On a Synology: a Let's Encrypt certificate (**Control Panel → Security → Certificate**) and a rule at **Control Panel → Login Portal → Advanced → Reverse Proxy** from `https://s3.example.org:443` to `http://localhost:9000` ([Synology: reverse proxy](https://kb.synology.com/en-global/DSM/help/DSM/AdminCenter/system_login_portal_advanced?version=7)). On Linux: Caddy, `s3.example.org { reverse_proxy 127.0.0.1:9000 }`. This needs a public IP address (many home connections are behind CGNAT) and, if it changes, a dynamic DNS name.

## Run the store

Make a directory for the stack on a data volume. It holds `compose.yaml`, a `.env` file with the secrets (`chmod 600 .env`), and the data.

### RustFS

`.env`:

```sh
RUSTFS_ROOT_SECRET=<a long random string, e.g. the output of: openssl rand -hex 20>
TUNNEL_TOKEN=<the token from "Create the tunnel">
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
      - "9000:9000"            # S3 API on your LAN (for setup, and for pushing from home)
    healthcheck:
      test: ["CMD", "curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:9000/health/ready"]
      interval: 10s
      retries: 12

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN:?set TUNNEL_TOKEN in .env}
    depends_on:
      rustfs:
        condition: service_healthy
```

**The RustFS container runs as user `10001`, so its data directory must belong to that user** ([RustFS docs](https://docs.rustfs.com/en/installation/container/docker)): `mkdir -p data && sudo chown -R 10001:10001 data`, before the first start. The platform sections below show where to run it.

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

Create the RPC secret once: `openssl rand -hex 32 > rpc_secret && chmod 600 rpc_secret`. `.env` holds only `TUNNEL_TOKEN`.

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
      - "3900:3900"            # S3 API on your LAN
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN:?set TUNNEL_TOKEN in .env}
```

Once it is running, give the node its storage role (the capacity is how much of the disk Garage may use):

```sh
docker compose exec garage /garage status                 # note the node id
docker compose exec garage /garage layout assign -z home -c 500G <node id>
docker compose exec garage /garage layout apply --version 1
```

### On a Synology

DSM 7.2 and later, with **Container Manager** installed from Package Center.

1. In File Station, create `docker/forge-storage` on your data volume (for example `/volume1/docker/forge-storage`), and put the files from above in it.
2. For RustFS, create `data` and give it to user `10001`. Turn on SSH (**Control Panel → Terminal & SNMP → Enable SSH service**), log in, and run the `chown` above in `/volume1/docker/forge-storage`. Turn SSH off again afterwards if you don't use it.
3. **Container Manager → Project → Create**. Name it `forge-storage`, set the path to `/volume1/docker/forge-storage`, choose "Use existing docker-compose.yml", and finish. The project starts both containers ([Synology: Project](https://kb.synology.com/en-global/DSM/help/ContainerManager/docker_project?version=7)). If a container complains that a variable is not set, the project did not read `.env`: write the values into `compose.yaml` directly, and keep the file readable only by administrators.

### On TrueNAS SCALE

TrueNAS SCALE 24.10 and later run apps on Docker.

1. Create a dataset for the store, for example `tank/apps/forge-storage` (mounted at `/mnt/tank/apps/forge-storage`). For RustFS, run the `chown` above on its `data` directory from the TrueNAS shell.
2. **Apps → Discover Apps → ⋮ → Install via YAML** ([TrueNAS docs](https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/installcustomappscreens/)). Name it `forge-storage` and paste the compose file with **absolute** paths (`/mnt/tank/apps/forge-storage/data:/data`, and the same for Garage's files). There is no `.env` beside it, so write the secret and the tunnel token into the YAML.
3. TrueNAS's community catalog also carries RustFS, Garage and cloudflared apps ([truenas/apps](https://github.com/truenas/apps/tree/master/ix-dev/community)); the settings are the same, entered in the app forms.

### On a Linux box

Any machine with Docker Engine and the compose plugin:

```sh
mkdir -p ~/forge-storage && cd ~/forge-storage
# write compose.yaml and .env (and garage.toml + rpc_secret for Garage); chown data for RustFS
docker compose up -d
docker compose ps                                    # both containers running (rustfs "healthy")
```

`restart: unless-stopped` brings the stack back after a reboot.

**Check it from anywhere** once the tunnel shows Healthy:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://s3.example.org/forge/nothing-here   # 403 or 404, not a Cloudflare error page
```

---

## A bucket, a key for that bucket only, public reads and CORS

Run these from your computer against the NAS's LAN address (`http://nas.local:9000` below), or on the NAS itself.

Save the CORS document once as `cors.json`. It is the one [Bring your own storage](bring-your-own-storage.md#aws-s3) uses, with lowercase header names ([why](bring-your-own-storage.md#cors-header-names)):

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

The first rule lets any browser read packs. The second lets the web app at `https://forge.dashhq.org` upload with your key (release assets, browser merges); leave it out if you only push from the CLI.

### RustFS

Use RustFS's own CLI, [`rc`](https://github.com/rustfs/cli/releases) (download the archive for your system and check it against the `.sha256` file beside it), plus the AWS CLI for the bucket policy and CORS:

```sh
rc alias set nas http://nas.local:9000 forge-admin <RUSTFS_ROOT_SECRET>
rc mb nas/forge
```

A policy that can write, read and delete objects in `forge`, and nothing else (no listing, no other bucket, no bucket settings). Save it as `forge-rw.json`:

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

Prefer this policy to `rc anonymous set download` (or MinIO's `mc anonymous set download`): that preset also lets anyone list the bucket. `rc bucket cors set` expects its own document format, not the S3 one above, so set CORS through the S3 API as shown.

### Garage

```sh
g() { docker compose exec garage /garage "$@"; }
g bucket create forge
g key create forge-key                         # prints the Key ID and Secret key: this is the key dg will use
g bucket allow --read --write forge --key forge-key
g bucket website --allow forge                 # anonymous reads on the web endpoint
g bucket alias forge files.example.org         # the web endpoint serves this bucket for that hostname
```

`forge-key` can read and write objects in `forge` only. It isn't the bucket's owner, so it can't change the bucket's settings, CORS included. Make a separate owner key for that, use it once, then delete it:

```sh
g key create forge-admin
g bucket allow --owner forge --key forge-admin
AWS_ACCESS_KEY_ID=<forge-admin key id> AWS_SECRET_ACCESS_KEY=<forge-admin secret> AWS_DEFAULT_REGION=garage \
  aws --endpoint-url http://nas.local:3900 s3api put-bucket-cors --bucket forge --cors-configuration file://cors.json
g key delete --yes forge-admin
```

Garage applies the bucket's CORS on the web endpoint too. It has no bucket policies: anonymous reads come only from the web endpoint, and the S3 API refuses them.

### MinIO (an existing server)

```sh
mc alias set nas http://nas.local:9000 <root user> <root password>
mc mb nas/forge
mc admin policy create nas forge-rw forge-rw.json         # the policy from the RustFS section
mc admin user add nas forge <a new long random secret>
mc admin policy attach nas forge-rw --user forge
mc anonymous set download nas/forge                       # public reads (this preset also allows listing)
```

MinIO has no per-bucket CORS. It answers every origin unless `MINIO_API_CORS_ALLOW_ORIGIN` (or `mc admin config set nas api cors_allow_origin=…`) restricts it.

---

## Connect it to `dg`

Add the profile with the key that can only touch the bucket, using the values from [the table](#choose-a-store) (`dg storage add` with no arguments asks for the same values), then test it:

```sh
security add-generic-password -s dash-forge -a nas -w      # macOS: paste the forge key's secret
dg storage add nas --kind s3 \
  --endpoint https://s3.example.org --region us-east-1 \
  --bucket forge --public-url https://s3.example.org/forge \
  --access-key-id forge --secret-access-key keychain:dash-forge/nas
dg storage test nas
```

On Linux, store the secret with `secret-tool store --label nas service dash-forge account nas`, or use an `env:` reference.

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
dash: 5NGj…/nas-demo ← main (864183b, 5 objects, 448 B)
dash: storage      → nas · Platform stores manifest + refs only, est 0.0032 DASH
dash: nas          ████████████████ 448 B  verified   0.7 s
dash: platform     manifest 2 · refUpdate 1     est 0.0032 DASH
dash: done · Platform charged ≈0.0028 DASH · remaining 0.9938 DASH · https://forge.dashhq.org/repo?owner=5NGj…&name=nas-demo
```

**The same profile also takes CI logs.** `dg ci report --log build.log --storage nas` (see [CI and check runs](ci.md)) uploads a run's log to this bucket and records its `https://s3.example.org/forge/...` URL on chain. Nothing extra to set up: the tunnel or reverse-proxy TLS you put in front of the store for pushes is exactly what a self-hosted CI runner needs too, since the web app (served over https) refuses to fetch a plain-http log.

### Pushing from home

The endpoint, where `dg` writes, is never recorded on chain; only the public URL is. So a profile can write to the NAS over your LAN, which is faster and avoids the tunnel's upload limit, while readers use the public hostname:

```sh
dg storage add nas-lan --kind s3 --endpoint http://nas.local:9000 --region us-east-1 \
  --bucket forge --public-url https://s3.example.org/forge \
  --access-key-id forge --secret-access-key keychain:dash-forge/nas
```

Both profiles store the same objects under the same keys, so a repository can switch between them with `dg storage use` at any time. Only a machine on your LAN can use `nas-lan`.

---

## When the NAS is offline

**With the NAS as the only copy**, every pack stored only there is unreadable until it is back:

- `git clone` fails with `fatal: remote did not send all necessary objects`.
- The web app shows what other copies it can read, and warns: *"2 packs could not be fetched from their storage; some objects may be missing"*.
- `dg storage status <owner>/<repo>` marks each copy `[DOWN]`.
- Your own pushes stop before anything is paid for ([E502](../errors.md#e502)).

Nothing is lost: when the NAS comes back, every clone works again.

**With a second copy**, readers don't notice. Add a second profile and list both:

```sh
dg storage use nas,r2-main
```

[Cloudflare R2](bring-your-own-storage.md#cloudflare-r2) has no egress fees and a free tier; [Backblaze B2](bring-your-own-storage.md#backblaze-b2), [Storj](bring-your-own-storage.md#storj) or [an IPFS pinning service](bring-your-own-storage.md#ipfs-kubo--a-pinning-service) work too. By default a push needs both copies to confirm; `--replicas 1` lets a push through while the NAS is off, with one copy. A new policy applies only to packs pushed after you set it, so copy the older ones over once with `dg repack <owner>/<repo> --profile nas,r2-main`. [Choosing where a repo pushes](bring-your-own-storage.md#choosing-where-a-repo-pushes) covers both.

Run `dg storage status <owner>/<repo>` after any change: it probes every recorded copy of every pack.

## Backups

The second copy keeps the repository **readable**. A backup of the NAS protects the **bytes**:

- **RAID is not a backup.** Snapshot the dataset or shared folder the store lives on (a Btrfs snapshot on Synology, a ZFS snapshot task on TrueNAS), and copy it off the machine (Hyper Backup, a replication task, or `rclone sync`).
- **A copy made outside `dg` is a backup, not a replica.** Readers try only the URLs each pack's manifest recorded at push time. A bucket you fill with `rclone` or another tool is invisible to them until you restore from it.
- **Restoring is copying the objects back.** Object keys are content-addressed (`packs/<sha256>.pack`), so putting the same bytes back under the same key makes every recorded URL work again. You can also restore from any clone with `dg reseed <owner>/<repo> --from-local` ([Restoring a lost copy](bring-your-own-storage.md#restoring-a-lost-copy)).
- Also back up `storage.toml` (`~/.config/dash-forge/`) and the store's config (`.env`, `garage.toml`, `rpc_secret`), and keep the secrets in a password manager.

---

## IPFS: kubo on the NAS

A kubo node on the NAS stores packs by CID, and a public gateway serves them. Two cautions:

- **kubo's RPC API (port 5001) is its admin interface.** Never publish it beyond the machine. Only its gateway (port 8080) goes on the public hostname.
- **A home node is usually behind NAT**, so the shared public gateways can't find your content ([the NAT caveat](bring-your-own-storage.md#ipfs-your-own-kubo-node)). Give the profile your **own** public gateway, which every reader tries first, and keep a second copy with a pinning service.

`init.d/001-forge.sh` (`chmod +x` it) makes the public gateway serve only what this node stores, so it can't be used to fetch arbitrary content through your connection:

```sh
#!/bin/sh
ipfs config --json Gateway.NoFetch true
```

`compose.yaml` (route `ipfs.example.org` to `http://kubo:8080` in the tunnel):

```yaml
services:
  kubo:
    image: ipfs/kubo:v0.43.1
    restart: unless-stopped
    environment:
      IPFS_PROFILE: server
    volumes:
      - ./ipfs:/data/ipfs
      - ./init.d:/container-init.d:ro
    ports:
      - "4001:4001"             # swarm: forward it on your router so other nodes can dial you
      - "4001:4001/udp"
      - "127.0.0.1:5001:5001"   # RPC API: this machine only
      - "127.0.0.1:8080:8080"   # gateway: this machine (the tunnel publishes it)
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN:?set TUNNEL_TOKEN in .env}
```

Then, on the NAS (the RPC API listens only there):

```sh
dg storage add kubo --kind ipfs-kubo \
  --api http://127.0.0.1:5001 --gateway http://127.0.0.1:8080 \
  --public-gateway https://ipfs.example.org
dg storage test kubo
```

```
  [ OK ] kubo api       kubo 0.43.1 at http://127.0.0.1:5001
  [ OK ] add + pin      ipfs://bafkrei… (CIDv1 raw-leaves, matches the local derivation, pinned)
  [ OK ] gateway        GET http://127.0.0.1:8080/ipfs/bafkrei… OK
  [ OK ] public gateway anonymous GET https://ipfs.example.org/ipfs/bafkrei… OK
  [ OK ] browser CORS   GET + Range preflight allowed, Content-Range exposed
  [ OK ] cleanup        probe unpinned
```

To push from another computer, reach the RPC API through an SSH tunnel (`ssh -L 5001:127.0.0.1:5001 nas`) rather than publishing it, or put it behind auth and use `--api-auth` ([IPFS: your own kubo node](bring-your-own-storage.md#ipfs-your-own-kubo-node)).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `docker compose up` stops with `set TUNNEL_TOKEN in .env` | [Create the tunnel](#create-the-tunnel) first and put its token in `.env`. |
| The RustFS container restarts with a permission error on `/data` | The data directory isn't owned by uid `10001`: `sudo chown -R 10001:10001 data`. |
| `push not started: … would record a non-public public_url on chain [E501]` | The public URL is a LAN address, plain http, a quick tunnel or a `ts.net` name. Use your own hostname through a named tunnel or a reverse proxy. |
| `dg storage test`: `public read` FAIL | RustFS: the `public-read.json` policy is missing. Garage: `bucket website --allow` or the alias to the public hostname is missing, or the public URL has a `/forge` path it shouldn't have. Or the tunnel has no route for that hostname. |
| `dg storage test`: `browser CORS` FAIL | `cors.json` was not applied. On Garage only an owner key can set it (the read-write key gets `AccessDenied … Operation is not allowed for this key`). |
| `dg storage test`: `put` fails with `failed to lookup address information` | The hostname doesn't resolve yet. A new tunnel route can take a minute to appear in DNS. |
| A large push fails with HTTP `413` | Cloudflare's upload limit on proxied requests (100 MB on Free and Pro). Push over the LAN with a [`nas-lan` profile](#pushing-from-home). |
| Clones fail with `remote did not send all necessary objects` while the NAS is off | A pack whose only copy is on the NAS. Bring it back, and [add a second copy](#when-the-nas-is-offline). |
| A Cloudflare login page instead of the object | Cloudflare Access protects the hostname. Remove it from the read hostname. |

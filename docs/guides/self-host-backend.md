# Run your own backend

One command turns a Linux machine with Docker (a server, a PC, or a NAS you can SSH into) into storage that your repositories push to. Pushes then cost only the small Platform writes, and nobody bills you for storage.

```sh
curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/backend.sh | sudo sh
```

At the end it prints the exact `dg` commands to connect it. Read [the script](../../backend.sh) before you pipe it to a shell; it is written to be read.

On a Mac or a Windows PC, use [`dg ipfs up`](run-your-own-ipfs-node.md) instead. It sets up the same kind of node for your user.

1. [What you get](#what-you-get)
2. [Connect dg](#connect-dg)
3. [An https address and the web app](#an-https-address-and-the-web-app)
4. [Being reachable](#being-reachable)
5. [Day to day](#day-to-day)
6. [What it lets in](#what-it-lets-in)
7. [Troubleshooting](#troubleshooting)

---

## What you get

Two containers, both on the host's network, so IPv4 and IPv6 both work:

| | What it does | Required |
|---|---|---|
| **kubo** (IPFS, 0.43.1) | Stores your packs, pinned. It tells the IPFS network it has them, so the public gateways that Forge readers use can fetch them from your node. It gets a `libp2p.direct` certificate (AutoTLS), so browsers can dial it over secure WebSockets. Its own API and gateway listen on loopback only. | yes |
| **Caddy** (2.11.7) | The only HTTP way in. Port 5001 is the push API and port 8080 is the read gateway, both for clients on private networks. With `--domain`, Caddy also serves both at `https://<domain>` with a Let's Encrypt certificate. | yes |

Why IPFS: a push records a content address (`ipfs://<cid>`) on Platform, not your machine's address. Any IPFS gateway can serve those bytes, and every reader checks them against the SHA-256 recorded on Platform. So a node with no domain name works. An https name (`--domain`) is optional: it lets the web app use the node, and gives readers your own gateway to try first.

Not included: the [git-over-HTTPS gateway](../hosting/forge-gateway.md), which lets plain `git clone https://…` work without `git-remote-dash`. Repositories don't need it.

The command does this, and is safe to run again:

1. Installs Docker with Docker's own script if Docker is missing and it runs as root. Otherwise it asks you to install it.
2. Writes everything into `~/forge-backend`, owned by the user who ran `sudo` (or `/opt/forge-backend` when run as root directly):

   | File | What it is |
   |---|---|
   | `compose.yaml`, `Caddyfile`, `init.d/` | Generated on every run from your settings |
   | `settings.env` | Your settings, no secrets. A re-run without options keeps them |
   | `secrets.env` | kubo's two tokens, mode 0600 |
   | `forge-auth` | `Bearer <token>`, the value `dg` needs, mode 0600. It is never printed |
   | `ipfs/`, `caddy/` | The node's data, and Caddy's certificates |

3. Pulls the two images, pinned by digest, and starts them. They restart after a reboot.
4. If `ufw` is active, opens the swarm port (TCP and UDP 4001) to everyone, ports 5001 and 8080 to private networks, and with `--domain` ports 80 and 443. `ufw` is the only firewall it configures: open the same ports in any other.
5. Checks the node through its public ports. A call without the token must be refused, a non-Forge call must be refused, and a test file must go in, come back out of the gateway, and be unpinned.
6. Prints the addresses, the peer id, whether it is reachable, and what to run next.

A second run keeps the tokens and the data. It rewrites the files and restarts the containers only if something changed.

### Options

Pass options after `sh -s --`, for example `… | sudo sh -s -- --domain ipfs.example.org`.

| Option | What it does |
|---|---|
| `--domain <host>` | Also serve `https://<host>`. Its DNS must point at this machine, and ports 80 and 443 must reach it. `--domain none` removes it. |
| `--email <addr>` | Contact address for Let's Encrypt. |
| `--origin <https://host>` | Allow another Forge web app to use the node. `https://forge.dashhq.org` and `https://testnet-forge.dashhq.org` are always allowed. Repeat it for more; `--origin none` forgets the extra ones. |
| `--api-port`, `--gateway-port`, `--swarm-port` | Change 5001, 8080 or 4001. |
| `--listen all\|local` | Who may use the plain-http ports 5001 and 8080: clients with private addresses (`all`, the default), or this machine only (`local`). A client with a public address gets 403, so the token never crosses the internet in clear text. From outside your network, use `--domain`. |
| `--rotate-token` | Replace the Forge token. Connect `dg` again afterwards. |
| `--dir <path>` | Keep everything somewhere else: a new or empty directory. |
| `--no-start` | Write the files, start nothing. |

## Connect dg

The script prints these lines with your own addresses filled in. Run them on the computer you push from:

```sh
export FORGE_BACKEND_AUTH="$(ssh you@192.168.1.20 cat /home/you/forge-backend/forge-auth)"
dg storage add forge-backend --kind ipfs-kubo --api http://192.168.1.20:5001 --gateway http://192.168.1.20:8080 --api-auth env:FORGE_BACKEND_AUTH
dg storage test forge-backend && dg storage use forge-backend --global
```

```
  [ OK ] kubo api       kubo 0.43.1 at http://192.168.1.20:5001
  [ OK ] add + pin      ipfs://bafkrei… (CIDv1 raw-leaves, matches the local derivation, pinned)
  [ OK ] gateway        GET http://192.168.1.20:8080/ipfs/bafkrei… OK
  [ OK ] shared gateway https://ipfs.filebase.io fetched the probe from this node (no public_gateway is set)
```

`FORGE_BACKEND_AUTH` must be set wherever you push: the profile stores only its name, never the token.

Your next `git push` or `dg init` stores its packs on the node:

```
dash: storage      → forge-backend · Platform stores manifest + refs only, est 0.0077 DASH
dash: forge-backend ████████████████ 301.3 KiB  verified   0.1 s
```

Anyone can then clone the repository. `git-remote-dash` reads the packs through public IPFS gateways, which fetch them from your node.

## An https address and the web app

With a host name whose DNS points at the machine (an A record for its IPv4 address and an AAAA record for its IPv6 address: Caddy and kubo listen on both), and ports 80 and 443 open to it over both:

```sh
curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/backend.sh | sudo sh -s -- --domain ipfs.example.org
```

```
  [ OK ] https://ipfs.example.org serves it with a valid certificate
```

`dg` then uses `https://ipfs.example.org` for the API and the gateway, from anywhere. Pushes also record it as the repository's public gateway, which readers try first. The printed `dg storage add` line includes `--public-gateway`.

In the web app, open **Settings → Storage → IPFS (kubo) → Set it up by hand**. Enter `https://ipfs.example.org` as the kubo RPC API, the gateway and the public gateway, and paste the contents of `forge-auth` as the API Authorization header. The web app needs the https address: a page served over https can't call a plain-http node on your network.

## Being reachable

Other nodes and the public gateways must be able to dial your node to fetch from it. Forward TCP and UDP 4001 on your router to the machine. The script's output shows what the node found:

```
  Browser dialing  WSS with a libp2p.direct certificate (AutoTLS)
  Public addresses ip4 203.0.113.7 ip6 2001:db8::7
```

If it says `none yet`, nobody outside your network can fetch from you: forward the port for IPv4, and allow it in the router's IPv6 firewall too. If browser dialing says `not yet`, the certificate comes a few minutes after the node becomes reachable. Run the status command again later.

Your bytes are safe on your disk either way. Keep a second copy elsewhere too (`dg storage use forge-backend,nas`, see [Bring your own storage](bring-your-own-storage.md#choosing-where-a-repo-pushes)): when this machine is off, packs stored only here can't be read.

## Day to day

```sh
curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/backend.sh | sudo sh -s -- status
```

shows the containers, the addresses, reachability, the bytes stored, and the connect commands again.

| Command (after `sh -s --`) | What it does |
|---|---|
| *(none)* | Set up, update or repair. Safe to run again. |
| `status` | What runs and how to connect. |
| `down` | Stop both containers. Data, tokens and settings stay. Run the script again to start them. |
| `--rotate-token` | A new Forge token. Update `FORGE_BACKEND_AUTH` and the web profile afterwards. |

Run your own kubo commands with the owner token, inside the container: `cd ~/forge-backend && sudo docker compose exec kubo sh -c 'ipfs --api-auth "bearer:$OWNER_TOKEN" repo stat'`.

To upgrade, run the command again: a newer script pins newer images. To remove everything, run `down`, then delete the directory.

## What it lets in

- **Plain http (5001 and 8080)** answers clients with private addresses only (loopback, 10/8, 172.16/12, 192.168/16, 100.64/10, link-local, and IPv6 ULA and link-local). Everyone else gets 403. The https name has no such limit.
- **The push API (5001)** passes only the six calls Forge makes: `add`, `pin/add`, `pin/ls`, `pin/rm`, `id` and `version`, plus the browser's preflight (`OPTIONS`) from an allowed Forge address. Everything else is 404. kubo checks the token, which allows only those calls. A request without it is refused. The owner token, which can do everything, never leaves the machine.
- **The gateway (8080)** answers `GET`, `HEAD` and `OPTIONS` for `/ipfs/<cid>`, only for content this node stores. It won't fetch other people's content through your connection.
- **Browsers** may call the API only from the allowed Forge addresses.
- **Tokens** are in `secrets.env` and `forge-auth`, mode 0600, never printed. The containers get them as environment variables, which `docker inspect` shows to anyone who can run Docker, and kubo's start-up and `status` pass them to `ipfs` commands inside the container, where root on the host can see them in the process list.

## Troubleshooting

| What you see | Fix |
|---|---|
| `this user cannot use Docker` | Run the same command with `sudo`. |
| `Docker Compose is missing` | Install the Docker Compose plugin, then run the script again. |
| `only private networks may use plain http here` (403) | You are calling the plain-http port from a public address. Use the https name (`--domain`), or an SSH tunnel. |
| `TCP port 5001 is already in use` (or another port) | Stop what uses it, or choose other ports with `--api-port`, `--gateway-port` or `--swarm-port`. |
| `--domain needs ports 80 and 443` | Free them, or run without `--domain`. |
| `https://… did not answer from this machine` | Check that the name's DNS points at this machine and that ports 80 and 443 reach it. Read `sudo docker compose -p forge-backend logs caddy` in the directory. |
| `the node did not answer within 3 minutes` | Read the logs it prints. |
| `dg storage test` fails `kubo api` with 403 | The token is wrong or old. Fetch `forge-auth` again. |
| `Public addresses none yet` | Forward TCP and UDP 4001 to the machine. |

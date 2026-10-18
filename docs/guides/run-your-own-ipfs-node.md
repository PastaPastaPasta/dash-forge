# Run your own IPFS node

One command, `dg ipfs up`, sets up an IPFS node (kubo) on your computer, starts it at login, connects it to the Forge web app, and saves a storage profile so `dg` can push to it. The same node can also keep a copy of someone else's repository: `dg ipfs pin owner/name`.

Neither costs any DASH. Your node stores bytes on your own disk, and nothing in this guide writes to Platform.

1. [One command](#one-command)
2. [Connect the web app](#connect-the-web-app)
3. [Use it for your pushes](#use-it-for-your-pushes)
4. [Day to day: status, origins, stop](#day-to-day-status-origins-stop)
5. [What the node lets in](#what-the-node-lets-in)
6. [Being reachable](#being-reachable)
7. [Pin someone else's repo](#pin-someone-elses-repo)
8. [Troubleshooting](#troubleshooting)

You need `dg` ([Installing](../INSTALL.md)), the system `tar` command, and a network connection for the first run.

---

## One command

```sh
dg ipfs up
```

It does this, in order:

1. **Gets kubo 0.43.1.** It downloads the release archive from `github.com/ipfs/kubo`, checks its SHA-512 against the value built into `dg`, and unpacks only the `ipfs` program. A checksum mismatch stops with `nothing was installed`.
2. **Configures it.** Kubo gets a repo of its own (separate from any `~/.ipfs`), is moved to internal ports, and gets two access tokens ([what they allow](#what-the-node-lets-in)).
3. **Starts it for your user, and at every login.** It runs under your account, never as root:
   - macOS: a launchd agent, `~/Library/LaunchAgents/org.dashforge.ipfs.plist`.
   - Linux: a systemd user service, `dash-forge-ipfs.service`. A user service stops when you log out. `dg` prints a hint to run `loginctl enable-linger $USER`, or run `dg ipfs up --linger` to have `dg` do it.
   - Windows (best effort): a Task Scheduler task, `DashForgeIPFS`, that runs at logon. If it can't be created, `dg` warns and you run `dg ipfs serve` yourself.
4. **Checks it works.** It adds a small test file through the node, checks the CID, pins it, reads it back and removes it. This is the same check as `dg storage test`.
5. **Saves a storage profile** called `kubo` and puts the node's token in your OS keychain.
6. **Opens the connect page** in your browser. It doesn't, if you pass `--no-open`, if a Linux session has no display, or if you used `--no-service`.

You see:

```
IPFS node ready: kubo 0.43.1, peer 12D3Koo…, starts at login.
  RPC      http://127.0.0.1:5001 (add, pin, unpin, id; allowed websites only)
  Gateway  http://127.0.0.1:8080 (serves only what this node holds)
  CLI      storage profile "kubo" saved — `dg storage use kubo` sends your pushes there.
Connecting the web app… opened https://forge.dashhq.org/settings/storage/#kubo=5001.7KQ2-M9XD-PF4C
Settings → Storage → IPFS (kubo) → Connect with a code: 7KQ2-M9XD-PF4C (valid 10 min).
```

Running it again is safe. It keeps the same kubo, repo and tokens, applies your new options, and restarts the node.

### Your own Forge address

The node only talks to websites on its allow-list. `https://forge.dashhq.org` is always on it. If you run your own copy of the web app ([Run your own copy of the web app](verify-forge.md#run-your-own-copy-of-the-web-app)), add its address:

```sh
dg ipfs up --origin https://forge.example.org
```

The address must be `https://host` (a port is fine), with no path. `dg` refuses shared IPFS gateways such as `ipfs.io` or `dweb.link`, `null` and `*`. For a local development build only, `http://localhost:3000` and `http://127.0.0.1:3000` are accepted, with a warning.

The link `dg` prints still points at forge.dashhq.org. On your own address, open **Settings → Storage** there and use [Connect with a code](#connect-the-web-app).

### Options

| Option | What it does |
|---|---|
| `--origin <https://host>` | Also allow this website. Repeat it for more than one. |
| `--name <name>` | The storage profile's name. The default is `kubo`, or the name this node already has. |
| `--api-port <port>` | The port your browser and `dg` use (default 5001). |
| `--gateway-port <port>` | The read port (default 8080). |
| `--swarm-port <port>` | The TCP and UDP port other IPFS nodes use (default 4001, or the saved port). An explicitly chosen port must be free. Without this flag, `dg` picks a free port if the preferred one is busy. |
| `--rotate-token` | Replace both tokens. The old ones stop working at once, so connect your browsers again with `dg ipfs connect`. |
| `--no-service` | Don't install a login service. `dg` checks the node, then stops it. You start it with `dg ipfs serve` under your own supervisor. |
| `--linger` | Linux: keep the service running when you are logged out. |
| `--no-open` | Print the connect link; don't open a browser. |
| `--json` | Print the result as JSON, including the connect link and code. |

The public API, public gateway, two internal ports and swarm port must all differ. The internal API and gateway prefer 5101 and 8180; if either is busy, `dg` picks a free loopback port. The chosen ports are saved in `node.toml` and reused on later runs while available. If a profile called `kubo` already points somewhere else, `dg` stops and asks for another `--name`.

### Running next to IPFS Desktop

IPFS Desktop and other kubo nodes commonly use public ports 5001/8080 and swarm port 4001. Keep that node running and give Forge different public ports:

```sh
dg ipfs up --name forge-kubo --api-port 5002 --gateway-port 8081
```

Forge uses its own repo and tokens. It selects another swarm port when 4001 is busy, and moves either internal port if needed. To choose the swarm port yourself, add `--swarm-port 4002` (it must be free for both TCP and UDP). `dg ipfs status` shows the selected swarm port and the router-forwarding hint uses that port.

Two managed nodes under one user also need separate data and configuration directories (`XDG_DATA_HOME` and `XDG_CONFIG_HOME`), different public ports, and `--no-service`. Run each `dg ipfs serve` with its matching directory variables; the login-service name is shared.

### Where the files are

Everything is under one directory, `$XDG_DATA_HOME/dash-forge/ipfs`. If `XDG_DATA_HOME` isn't set, that is `~/.local/share/dash-forge/ipfs` on macOS and Linux, and `%LOCALAPPDATA%\dash-forge\ipfs` on Windows.

| File | What it is |
|---|---|
| `bin/ipfs` | The verified kubo program |
| `repo/` | The node's blocks and its identity |
| `node.toml` | Ports, allowed websites, profile name |
| `tokens.toml` | The two access tokens (readable only by you) |
| `follow.toml` | The repositories you follow ([below](#keep-it-up-to-date)) |
| `serve.log` | The node's log. At 5 MiB it is moved to `serve.log.1` and a new one starts |

---

## Connect the web app

Pairing means the web app learns your node's address and a token to use it. The token never goes in a link. The link carries a one-time code instead.

**The link.** `dg ipfs up` opens it for you. The page:

1. reads the code from the address bar and removes it from the URL;
2. asks your node to swap the code for the settings;
3. shows **Connect the IPFS node on this computer?** with the node's kubo version and peer id;
4. saves nothing until you press **Test and save**. You must be signed in, with the browser vault unlocked, because the token is stored with your other storage credentials ([the browser vault](identity-and-keys.md#the-browser-vault-and-its-limits)).

**A code.** If the page didn't open, or you are on your own address, go to **Settings → Storage → IPFS (kubo)**, type the code under **Connect with a code**, and press **Connect**. The code looks like `7KQ2-M9XD-PF4C`. If you changed `--api-port`, open **Advanced** and enter the port too. Get a fresh code at any time:

```sh
dg ipfs connect
```

A code works once, for 10 minutes. Five wrong tries cancel it.

### Browser notes

| Browser | On forge.dashhq.org |
|---|---|
| Chrome, Edge | Works. The first time, it asks to let the site reach apps on your device. Allow it. |
| Firefox | Works after the same kind of prompt. |
| Brave | Works after you allow it. If it doesn't ask, look at the site's permissions. |
| Safari | **Does not work.** Safari doesn't let a secure site reach a node on your computer. The page says so. Use `dg` to push, or connect from another browser. |

If you deny the prompt, the page says the node "is not running, or your browser blocked it". Allow local access for the site in the browser's site settings and connect again.

---

## Use it for your pushes

In the web app, after **Test and save**, the box **Use it for my pushes** adds the node to your storage policy. It is already ticked when this is your first storage profile.

In `dg`:

```sh
dg storage use kubo
```

To keep a second copy elsewhere, list both: `dg storage use r2-main,kubo`. [Choosing where a repo pushes](bring-your-own-storage.md#choosing-where-a-repo-pushes) has the details.

Two cautions, both from [Bring your own storage](bring-your-own-storage.md#ipfs-your-own-kubo-node):

- The profile `dg ipfs up` saves has no public gateway. Other people can read your packs only if they can find your node on the IPFS network ([Being reachable](#being-reachable)). A laptop that is often off is a poor only copy. Keep a bucket or a pinning service as well.

---

## Day to day: status, origins, stop

```sh
dg ipfs status
```

shows the kubo version and peer id, whether the service is running, the bytes stored, the number of recursive pins (every pin on the node, not only Forge's), the allowed websites, the node's swarm port and listen addresses, [reachability](#being-reachable) and the [followed repositories](#keep-it-up-to-date). `--json` gives the same as JSON.

| Command | What it does |
|---|---|
| `dg ipfs connect [--no-open]` | A new connection link and code. |
| `dg ipfs origin add <https://host>` | Allow another website. It restarts the node. |
| `dg ipfs origin remove <https://host>` | Stop allowing a website. `https://forge.dashhq.org` can't be removed. |
| `dg ipfs down` | Stop the node and remove its login service. Your files, tokens and profile stay. `dg ipfs up` starts it again. |
| `dg ipfs down --purge` | The same, then delete the node's directory, its storage profile and its keychain entry. It asks first and says how many bytes it will delete. Everything you pinned goes too. |
| `dg ipfs ipfs -- <args>` | Run the node's own `ipfs` program with the owner token, for example `dg ipfs ipfs -- repo stat`. |

`dg ipfs ipfs` puts the owner token on the command line of the `ipfs` process it starts, so other programs running as you can see it while it runs.

`dg ipfs serve` is what the login service runs. You only run it yourself after `--no-service`.

To upgrade, install a newer `dg` and run `dg ipfs up`. Kubo migrates its repo forward when it starts. Going back to an older kubo isn't supported.

---

## What the node lets in

`dg ipfs up` puts a small guard, built into `dg`, in front of kubo. Kubo's own API can change its config and read your files, so it is not exposed.

- **A scoped token.** The web app and the saved `kubo` profile get a token that can do `add`, `pin/add`, `pin/ls`, `pin/rm` (unpin), `id` and `version`, and nothing else. Kubo enforces it. A second, full-access owner token exists only for `dg ipfs status` and `dg ipfs ipfs`. It is never sent to a browser.
- **Loopback only.** The node listens on `127.0.0.1`, so other computers can't reach it. A request whose `Host` isn't the node's own loopback address is refused, which stops a hostile web page from reaching it by DNS tricks.
- **Allowed websites only.** A browser request with an `Origin` not on the allow-list is refused. Any other path (kubo's admin pages and the rest of its API) returns 404.
- **A read-only gateway.** Port 8080 serves `GET` and `HEAD` for `/ipfs/<cid>` and only for content this node already holds. It will not fetch other people's content for you.
- **A one-time code.** The token is never in a URL, in your history, or on Platform. A link or a code works once and expires after 10 minutes.

Where the tokens are:

| Token | Stored in |
|---|---|
| Scoped | `tokens.toml` (readable only by you); your OS keychain, as the `kubo` profile's credential (if there is no keychain, the profile uses the variable `DASH_FORGE_KUBO_AUTH`, and you set it to the token when you push); and the browser vault, once you connect |
| Owner | `tokens.toml` only |

Other programs running as you can read `tokens.toml`. `dg` trusts your own account, as it does for your identity file. To change the scoped token, run `dg ipfs up --rotate-token` and connect your browsers again.

---

## Being reachable

Other nodes need to dial yours to fetch what you hold. Forward the **TCP and UDP swarm port shown by `dg ipfs status`** on your router to the computer running the node. It defaults to 4001, but can differ when you use `--swarm-port` or another program already holds that port. Kubo also tries to open the port itself through UPnP, which many routers allow.

`dg ipfs status` reports one of two things:

- `public addresses (reachability unverified)`: the node knows a public address for itself. That is a good sign, not a proof that others can connect.
- `private-only`, with a fix such as `forward TCP+UDP 4001 to this machine` (using your selected swarm port): the node only has private addresses, so people outside your network can't find it.

Your bytes are safe on your disk either way. Being unreachable only means other people can't fetch them from you.

---

## Pin someone else's repo

Pinning keeps every stored file of a repository on your node, so the repository survives even if its owner's storage goes away. The files are read from the places the repository recorded them, checked against their hash, and added to your node.

```sh
dg ipfs pin owner/name
```

(`owner/name` can also be the repository id.) The node can be one `dg ipfs up` set up, or any IPFS profile you name with `--profile <name>`. With only one IPFS profile, you can leave it out. A pinning-service profile works too: it asks the service to pin each file's CID.

First see what it would do:

```sh
dg ipfs pin owner/name --dry-run
```

```
40 blobs · 182.0 MiB · 0 not on IPFS · 0 members-only, skipped · … · cost 0 DASH (local disk only)
```

A real run prints a line per file and a summary:

```
[12/40] pack 3f2a91c… 4.1 MiB  pinned (bytes from <host>)
40 blobs: 31 pinned, 9 already, 0 failed · 182.0 MiB on your node · cost 0 DASH
```

Run it again after an interruption and it carries on: files already on your node show as `already`. If any file failed, `dg` exits with an error and says to run the command again. Add `--verbose` to see the IPFS addresses.

**What is pinned.** The packs and release files that the repository's owner, maintainers, writers and bots recorded. A pack that someone else recorded counts only as another place to fetch it from. It never adds a file to your list. Check-run logs and artifacts aren't pinned. A file that has no IPFS address is counted as `not on IPFS` and left alone. If no recorded copy can be read and checked, `dg` asks the IPFS network for the file instead, with a size limit and a 10-minute timeout per file.

**What it costs.** 0 DASH. Pinning writes nothing to Platform and reads are free. It costs disk space on your node, and the `--dry-run` line shows how much.

### Keep it up to date

```sh
dg ipfs pin owner/name --follow
```

pins now and adds the repository to `follow.toml`. Your node's service pins again each time it starts and every 30 minutes, so new pushes follow without a cron job. It needs the node running: the login service, or `dg ipfs serve`.

| Command | What it does |
|---|---|
| `dg ipfs pin owner/name --follow` | Pin now and keep it up to date. |
| `dg ipfs pin owner/name --unfollow` | Stop following. What you pinned stays. |
| `dg ipfs pin --all` | Refresh every followed repository once, now. |
| `dg ipfs status` | List the followed repositories and their last run. |

### From the web app

On a repository's page, **Pin** opens a dialog with the number of files, their size and `cost 0 DASH (uses your disk)`. Pick your node and press **Pin**. The dialog shows the same progress rows as `dg`, and a copyable `dg ipfs pin owner/name --follow` line, because a web page can't keep a node up to date. The button shows when you are signed in (for a private repository, only to members). With no node connected, the dialog shows `dg ipfs up`.

The web app refuses a single file over 512 MiB and says to use `dg ipfs pin` instead.

When you fork a repository in the web app, the dialog has a box, **Also pin its files on my IPFS node**, with the size. It is ticked by default when the total is under 256 MiB. In `dg`, use `dg repo fork owner/name --pin`.

### Privacy

When your node holds a file, it tells the IPFS network. Anyone can then look up that your IP address and peer id hold that file, and so that you hold the repository. `dg` says this the first time you pin a public repository.

Private repositories need more care:

- Only members can pin one. A non-member gets `only members can pin a private repo`. A bot can't either.
- You must agree first. `dg` asks `Your IP address will be listed on IPFS as holding this private repo's (encrypted) files.`, and `--yes` accepts it. The web dialog has a box for it. A public repository's members-only files ask for the same consent.
- The files stay encrypted. Your node holds ciphertext, and only members can read it. Without the key for a members-only file, `dg` skips it and counts it as `members-only, skipped`.
- `--follow` on a private repository remembers your consent so the refresh can run unattended.

---

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| `kubo archive checksum mismatch; nothing was installed` | The download isn't the official kubo 0.43.1. Run `dg ipfs up` again; if it repeats, check your network or proxy. |
| `could not unpack kubo` | The system `tar` command is missing. Install it and retry. |
| `no pinned kubo archive is available for this platform` | `dg ipfs up` supports macOS and Linux on arm64 and amd64, and Windows on amd64. |
| `this profile name belongs to another storage address; choose a new name with --name` | A storage profile called `kubo` already points at a different node. Pick another `--name`. |
| `could not bind the IPFS API port` | Something else uses port 5001 (or 8080). Run `dg ipfs up --api-port <port> --gateway-port <port>`. |
| `the IPFS node did not become ready within 60 seconds` | Read `serve.log` in the node's directory. The selected internal and swarm ports are in `node.toml`; rerun `dg ipfs up` if another program has taken them. |
| `IPFS swarm port <port> is already in use` | Choose a free TCP and UDP port with `--swarm-port`, or omit the flag to let `dg` choose. |
| `the kubo repo is still in use` | A kubo started by hand holds the repo. Stop it and retry. |
| `systemd's user service is unavailable` | Run `dg ipfs up --no-service`, then `dg ipfs serve` under your own supervisor. |
| `could not start the IPFS login service` (macOS) | Run `dg ipfs up --no-service`, then `dg ipfs serve` yourself. |
| Windows: `could not start the logon task` | The task is best effort. Run `dg ipfs serve` yourself. |
| The page says `Safari can't reach a node on this computer from a secure site` | Safari blocks it. Use `dg` to push, or Chrome, Firefox or Brave. |
| `The node is not running, or your browser blocked it` | Run `dg ipfs status`. If it runs, allow the site to reach apps on this device in your browser. |
| `The node blocked this site. Run dg ipfs up --origin …` | The address isn't on the allow-list. Run the command it shows, then connect again. |
| `Wrong code` | Check the code. Five wrong tries cancel it; run `dg ipfs connect`. |
| `This code expired or was already used` | Run `dg ipfs connect` for a new one. |
| The node refuses a push or a pin (HTTP 403) | The token the profile or browser holds is old, or was made by hand without `pin/add`. For `dg`, run `dg ipfs up`: it saves the node's current token to the profile. For a browser, run `dg ipfs connect` and connect again. |
| `choose an IPFS storage profile before pinning` | No IPFS profile, or more than one. Run `dg ipfs up`, or pass `--profile <name>`. |
| `only members can pin a private repo` | Sign in as a member. See [Privacy](#privacy). |
| `some repository files could not be pinned` | Run the same command again. Each failed file is listed with its reason. If no copy can be read, the repository may have lost its stored bytes. |
| `status` says `private-only` | [Forward the TCP and UDP port shown by status](#being-reachable). |

Beyond that: a manual kubo setup, with the preflight proxy a browser needs, is in [Bring your own storage](bring-your-own-storage.md#set-up-kubo-by-hand), and kubo on a NAS is in [Storage on your home NAS](home-nas-storage.md#ipfs-kubo-on-the-nas).

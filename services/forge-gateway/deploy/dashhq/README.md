# dashhq's gateways on pasta1

dashhq runs two [forge-gateway](../../../../docs/hosting/forge-gateway.md) instances on one DigitalOcean droplet (pasta1), behind the Cloudflare proxy:

| Hostname | Network | Loopback port | Compose project |
|---|---|---|---|
| `git-forge.dashhq.org` | mainnet | `127.0.0.1:18081` | `forge-gateway-mainnet` in `~/forge-gateway/mainnet` |
| `testnet-git-forge.dashhq.org` | testnet | `127.0.0.1:18082` | `forge-gateway-testnet` in `~/forge-gateway/testnet` |

They run the release image by digest (`GATEWAY_IMAGE` in `mainnet.env` and `testnet.env`), so the droplet builds nothing. The host's Caddy terminates TLS for both names (an ACME certificate, as Cloudflare's "Full (strict)" mode needs) from its own include file, `/etc/caddy/forge-gateway.caddy`, imported once at the end of `/etc/caddy/Caddyfile`. Other sites on the host (`ipfs.dashhq.org`, `build.thepasta.org`) and kubo are not touched.

The gateways hold no keys and spend nothing. Nothing on the volume needs a backup: every mirror is rebuilt from Platform.

## Files

- `deploy.sh`: `up`, `caddy`, `verify` and `down`, each safe to run again. It downloads the stock `docker-compose.yml`, `docker-compose.override.yml` (the deny list mount) and the network's `.env` from this repository at `FORGE_REV`.
- `mainnet.env`, `testnet.env`: the settings. No secrets.
- `forge-gateway.caddy`: the Caddy snippets. A request that did not come from a Cloudflare address gets `CF-Connecting-IP` set to its real peer, so no client picks its own rate-limit key. On `git-forge.dashhq.org`, a git request for a repository mainnet does not serve answers `404` with the repository's address on `testnet-git-forge.dashhq.org`, because that name served testnet until 2026-11-27.

## Deploy

Run on pasta1 as `pasta` (in the `docker` group). Only `caddy` needs sudo. ufw limits SSH, so batch the steps into one connection. Set `REV` to the commit to deploy.

```sh
REV=<commit>
ssh pasta1 "curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/$REV/services/forge-gateway/deploy/dashhq/deploy.sh -o ~/forge-gateway/deploy.sh --create-dirs \
  && chmod +x ~/forge-gateway/deploy.sh \
  && FORGE_REV=$REV ~/forge-gateway/deploy.sh up mainnet \
  && FORGE_REV=$REV ~/forge-gateway/deploy.sh up testnet \
  && ~/forge-gateway/deploy.sh verify mainnet && ~/forge-gateway/deploy.sh verify testnet"
```

`verify` before Caddy prints `readyz` (it must say `"network":"mainnet"`, or `testnet`) and clones a public repository over loopback (`forg3/dash-forge` on mainnet, `forge-v2-demo` on testnet; `FORGE_SAMPLE_REPO=<owner>/<name>` picks another). The first clone of a repository builds its mirror and can take a few minutes.

Then, once a hostname's DNS points at pasta1 (see below), let Caddy serve it and verify over the droplet's public IPv4 and IPv6:

```sh
# sudo needs Pasta's password: from a 0600 file, over stdin, then delete the file.
ssh pasta1 "sudo -S -p '' env FORGE_REV=$REV bash ~/forge-gateway/deploy.sh caddy testnet && ~/forge-gateway/deploy.sh verify testnet" < "$PASSWORD_FILE"
```

Name only the networks whose DNS already points at pasta1; names enabled earlier stay. `verify` retries the origin clones for a minute while Caddy gets the certificate.

`caddy` keeps a copy of the original Caddyfile as `Caddyfile.bak-pre-forge-gateway`, validates before it reloads, and restores the previous config if Caddy rejects it.

## DNS (Cloudflare, zone dashhq.org)

Caddy gets each certificate by ACME HTTP-01, which needs the name to reach pasta1. So each name first points at pasta1 unproxied, Caddy gets the certificate, and then the record turns proxied. Renewals work through the proxy.

| Name | Before | Step 1 (DNS only) | Step 2 (proxied) |
|---|---|---|---|
| `testnet-git-forge` | none | `A 178.128.228.195`, `AAAA 2604:a880:cad:d0::c40:d001` | the same, proxied |
| `git-forge` | `CNAME 93d75225-….cfargotunnel.com`, proxied (the testnet gateway in CT 181) | delete the CNAME; `A 178.128.228.195`, `AAAA 2604:a880:cad:d0::c40:d001` | the same, proxied |

### Cutover order

Each web build names one gateway (`docs/hosting/forge-gateway.md`, "Show it in the web app"), and a build must never name a gateway of the other network. So the switch goes:

1. `testnet-git-forge`: DNS step 1, `deploy.sh caddy testnet`, `deploy.sh verify testnet` (origin over IPv4 and IPv6).
2. `gh variable set TESTNET_SITE_GATEWAY_URL -R PastaPastaPasta/dash-forge -b https://testnet-git-forge.dashhq.org`, then `gh workflow run pages-testnet.yml -R PastaPastaPasta/dash-forge --ref master`, and wait for the deploy. The testnet site now names the new host.
3. `git-forge`: DNS step 1. The testnet gateway in CT 181 stops being reachable here.
4. `deploy.sh caddy mainnet`, `deploy.sh verify mainnet`.
5. DNS step 2 for both names. Check through Cloudflare over IPv4 and IPv6.
6. `gh variable set PAGES_GATEWAY_URL -R PastaPastaPasta/dash-forge -b https://git-forge.dashhq.org`, then `gh workflow run pages.yml -R PastaPastaPasta/dash-forge --ref master`.

Both Pages workflows run `check-gateway-network.mjs`, so a build whose gateway's `/readyz` names the other network fails instead of deploying.

## The old testnet gateway (CT 181)

Until 2026-11-27 `git-forge.dashhq.org` was the testnet gateway in CT 181 on the R730 (`/opt/forge/gateway`, reached through the dashboard-managed Cloudflare tunnel `93d75225…`). After the DNS switch nothing routes to it. It is left running, untouched; retire it later: `docker compose down` in `/opt/forge/gateway`, then delete the tunnel's `git-forge.dashhq.org` public hostname in the Cloudflare dashboard.

## Upgrade or roll back

Put the new (or previous) digest in `mainnet.env` / `testnet.env` through a PR, then `FORGE_REV=<that commit> ~/forge-gateway/deploy.sh up <network>`. The mirrors on the volume are reused. Check `version.buildSha` in `/readyz`.

## Upkeep

- `forge-gateway.caddy` lists Cloudflare's address ranges. Compare them with https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6 now and then: a request from a new range would have its `CF-Connecting-IP` replaced by the edge's address, so its clients would share one rate-limit key.
- Before the privacy notice in `docs/hosting/forge-gateway.md` is published, make its retention true: the compose file rotates gateway logs by size, and journald (Caddy's error log) keeps entries until its size limit. Set `MaxRetentionSec=14d` in journald and an age limit for the gateway logs, or change the notice.
- Cloudflare cache rules for `/badge/*`, `/feed/*` and `/og/*` should name both hostnames.
- **Certificate renewal behind the proxy.** The first certificates (Let's Encrypt, issued 2026-11-27, valid to 2027-02-25) came while the names were DNS-only. Caddy renews about 30 days before expiry. Behind the proxy, TLS-ALPN-01 cannot work, and Cloudflare answers a plain-HTTP `/.well-known/acme-challenge/` request with a `308` to HTTPS. Let's Encrypt follows that redirect, and Caddy answers HTTP-01 challenges on its HTTPS listener too, while the current certificate is still valid. If a renewal fails anyway (`journalctl -u caddy | grep -i -E 'renew|challenge|obtain'`), turn both names' records DNS-only for a few minutes, `sudo systemctl reload caddy`, wait for the new certificate, and turn them proxied again. An expired origin certificate shows as Cloudflare error `526`. Check about 2027-01-27 that it renewed: `echo | openssl s_client -connect 178.128.228.195:443 -servername git-forge.dashhq.org 2>/dev/null | openssl x509 -noout -enddate`.

## Takedowns

Append to `~/forge-gateway/<network>/deny/deny.txt` (format in [Takedowns](../../../../docs/hosting/forge-gateway.md#takedowns-and-hidden-repositories)); it is re-read within seconds.

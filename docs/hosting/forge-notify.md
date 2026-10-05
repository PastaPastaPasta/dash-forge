# Host forge-notify (email and browser push notifications)

`forge-notify` is an **optional** service that sends Dash Forge notifications by email and Web Push. It covers review requests, assignments, @mentions, activity on threads you take part in, activity on repositories you watch, own or belong to, and releases. Forge works the same without it: the in-browser inbox (`/notifications/`) reads the chain itself whenever Forge is open.

dashhq runs one for forge.dashhq.org. Anyone can run their own from the same image with the same settings. This page covers both.

1. [What the service is trusted for](#what-the-service-is-trusted-for)
2. [What you need](#what-you-need)
3. [Run it](#run-it)
4. [Settings](#settings)
5. [DNS and TLS](#dns-and-tls)
6. [Email deliverability: SPF, DKIM, DMARC](#email-deliverability-spf-dkim-dmarc)
7. [Web Push](#web-push)
8. [Routes](#routes)
9. [What is sent, and when](#what-is-sent-and-when)
10. [Rate limits and abuse controls](#rate-limits-and-abuse-controls)
11. [Monitoring](#monitoring)
12. [Logs](#logs)
13. [Backups and upgrades](#backups-and-upgrades)
14. [Show it in the web app](#show-it-in-the-web-app)
15. [Test it locally](#test-it-locally)
16. [Billing (later)](#billing-later)
17. [Privacy notice (draft)](#privacy-notice-draft)
18. [Checklist for dashhq](#checklist-for-dashhq)

---

## What the service is trusted for

Delivery only. Every notice is a hint that links back to forge-web, which reads the chain again with proofs.

- **No account, no password.** A subscriber proves control of a Forge identity with a request signed by one of its `AUTHENTICATION` keys (unbound, or bound to Forge's contracts or contract group: a key another app holds is refused), read from Platform with proofs (`docs/design/service-auth.md`). The web app signs with the browser's limited key. That signature can never be a state transition.
- **No repository keys.** The service reads public data anonymously. For a **private** repository it reads only public metadata: that a document of some type was written in a repository at some time. If the subscriber opted in, it sends "new activity in a private repository you belong to" with the repository's name and never a title or text. Review requests and assignments in a private repository name the repository and the thread number only.
- **Addresses never go on chain** and are encrypted at rest (AES-256-GCM under a key derived from `FORGE_NOTIFY_DATA_KEY`). A keyed blind index finds "is this address already used" without decrypting.
- **Double opt-in.** Nothing is mailed to an address until someone opens the confirmation link sent to it. The confirmation page needs a button press, so a mail scanner that follows links does not confirm.
- **One-click unsubscribe** (RFC 8058). Every notification and digest carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The token is stateless (identity, epoch and an HMAC), so it needs no login.
- **Export and delete.** A subscriber can download everything the service keeps for their identity (`data.export`) and delete it (`data.delete`) from Settings → Notifications.
- **It is never required.** Turning it off loses only the mail and push. The inbox, every read and every write work without it.

## What you need

| | Minimum | dashhq (forge.dashhq.org) |
|---|---|---|
| Host | 1 vCPU, 512 MiB RAM, Docker | An LXC or VM on the home Proxmox, Docker Compose |
| Disk | 1 GiB for the SQLite store (about 2 KiB per subscriber plus pending digests) | 5 GiB volume |
| Network out | HTTPS to the network's DAPI nodes (port 1443); SMTP submission to your provider (587 or 465); HTTPS to the browsers' push services | as is |
| Network in | HTTPS only, through a TLS proxy | Cloudflare tunnel |
| Domain | One hostname for the API, and a mail domain you can set DNS records on | `notify.forge.dashhq.org` (suggested), mail from `notify@forge.dashhq.org` |
| SMTP | A transactional mail provider (Postmark, Amazon SES, Mailgun, Resend, …) or your own MTA | the owner's choice |
| Contact | An address for abuse and privacy requests | the owner's choice |

The service polls each followed public repository every `FORGE_NOTIFY_POLL_SECS` (15 s by default). Platform load grows with the number of distinct followed repositories, which `FORGE_NOTIFY_MAX_REPOS` caps (2,000 by default), and not with the number of subscribers.

## Run it

Build the image from the repository root (or pull a release image once one is published):

```sh
docker build -f services/forge-notify/Dockerfile \
  --build-arg DASH_FORGE_BUILD_SHA=$(git rev-parse HEAD) -t forge-notify .
```

Make the keys **once** and keep them as secrets:

```sh
cd services/forge-notify
mkdir -p secrets && chmod 700 secrets
docker run --rm forge-notify keys > /dev/shm/notify-keys.env
grep ^FORGE_NOTIFY_DATA_KEY= /dev/shm/notify-keys.env | cut -d= -f2- > secrets/data_key
grep ^FORGE_NOTIFY_VAPID_PRIVATE_KEY= /dev/shm/notify-keys.env | cut -d= -f2- > secrets/vapid_private_key
printf '%s' "$SMTP_PASSWORD" > secrets/smtp_password
chmod 600 secrets/*
grep '^# VAPID public key' /dev/shm/notify-keys.env   # public; also served at /v1/info
shred -u /dev/shm/notify-keys.env
```

- `data_key` encrypts every stored address and push subscription and signs unsubscribe tokens. **Losing it loses every address**: subscribers must sign up again. Leaking it together with the database leaks the addresses.
- `vapid_private_key` signs push requests. Changing it invalidates every browser subscription, because browsers subscribe to the public key.
- To run **email only**, leave `secrets/vapid_private_key` empty and `FORGE_NOTIFY_VAPID_SUBJECT` unset. To run **push only**, leave `FORGE_NOTIFY_SMTP_HOST` unset (`smtp_password` may stay empty). An empty secret file counts as unset.

Write `.env` next to `docker-compose.yml` (every variable is under [Settings](#settings)):

```sh
FORGE_NOTIFY_NETWORK=devnet
FORGE_NOTIFY_DEVNET_NAME=sakura
FORGE_NOTIFY_PUBLIC_URL=https://notify.forge.dashhq.org
FORGE_NOTIFY_WEB_URL=https://forge.dashhq.org
FORGE_NOTIFY_PRIVACY_URL=https://forge.dashhq.org/privacy/notify/
FORGE_NOTIFY_CONTACT=privacy@dashhq.org
FORGE_NOTIFY_SMTP_HOST=smtp.postmarkapp.com
FORGE_NOTIFY_SMTP_USERNAME=<provider token or user>
FORGE_NOTIFY_MAIL_FROM=Dash Forge <notify@forge.dashhq.org>
FORGE_NOTIFY_VAPID_SUBJECT=mailto:privacy@dashhq.org
```

Then:

```sh
docker compose up -d
curl -fsS http://127.0.0.1:8080/readyz     # {"store":true,"watcher":true}
curl -fsS http://127.0.0.1:8080/v1/info
```

The container runs as an unprivileged user (uid 10003) with its store in the `notify-data` volume, and listens on `127.0.0.1:8080` of the host.

## Settings

Every setting is a flag of `forge-notify serve` or the environment variable named here. Secrets are read only from the environment, or from the file a `<NAME>_FILE` variable names (the compose file uses Docker secrets), never from a flag.

| Variable | Default | What |
|---|---|---|
| `FORGE_NOTIFY_NETWORK` | forge-core's default | `mainnet`, `testnet` or `devnet`. Always set it. |
| `FORGE_NOTIFY_DEVNET_NAME` | | The devnet's name (with `devnet`), e.g. `sakura` |
| `FORGE_NOTIFY_DAPI_ADDRESSES` | the network's seeds | Comma-separated DAPI addresses (devnets) |
| `FORGE_NOTIFY_PUBLIC_URL` | (required) | This service's https URL. Mail links (confirm, unsubscribe) use it. |
| `FORGE_NOTIFY_OPERATOR` | the public URL's host | The operator name signed requests must carry, shown to users. The web app signs only for the host it calls, so leave this unset unless you serve other clients. |
| `FORGE_NOTIFY_WEB_URL` | `https://forge.dashhq.org` | The forge-web origin notices link to (with a sub-path deploy's base path) |
| `FORGE_NOTIFY_ALLOWED_ORIGINS` | the web URL's origin | Comma-separated browser origins allowed to call `/v1/*` (CORS) |
| `FORGE_NOTIFY_PRIVACY_URL` | | Your privacy notice (https), linked before anyone subscribes |
| `FORGE_NOTIFY_CONTACT` | | Your contact address, shown in `/v1/info` |
| `FORGE_NOTIFY_DATA_DIR` | `/data` | The SQLite store's directory |
| `FORGE_NOTIFY_LISTEN` | `0.0.0.0:8080` | Listen address (behind the TLS proxy) |
| `FORGE_NOTIFY_DATA_KEY` / `_FILE` | (required, secret) | 32 bytes, base64 (`forge-notify keys`) |
| `FORGE_NOTIFY_SMTP_HOST` | | SMTP server. Unset: no email. |
| `FORGE_NOTIFY_SMTP_PORT` | 587 / 465 / 25 | By `FORGE_NOTIFY_SMTP_TLS` |
| `FORGE_NOTIFY_SMTP_TLS` | `starttls` | `starttls`, `tls`, or `none` (a local relay or a test server only) |
| `FORGE_NOTIFY_SMTP_USERNAME` | | SMTP user |
| `FORGE_NOTIFY_SMTP_PASSWORD` / `_FILE` | | SMTP password (secret) |
| `FORGE_NOTIFY_MAIL_FROM` | (required with SMTP) | The sender, e.g. `Dash Forge <notify@forge.dashhq.org>` |
| `FORGE_NOTIFY_VAPID_PRIVATE_KEY` / `_FILE` | | VAPID key (secret). Push is on when this and the subject are set. |
| `FORGE_NOTIFY_VAPID_SUBJECT` | | `mailto:` or `https:` contact for the push services |
| `FORGE_NOTIFY_PUSH_HOSTS` | FCM, Mozilla, Apple, Windows | Comma-separated push hosts a subscription may point at |
| `FORGE_NOTIFY_POLL_SECS` | 15 | Seconds between polls of the followed public repositories |
| `FORGE_NOTIFY_INDEX_SECS` | 900 | Seconds between rebuilds of each subscriber's followed repositories |
| `FORGE_NOTIFY_ADDRESSED_SECS` | 120 | Seconds between polls of review requests and assignments |
| `FORGE_NOTIFY_DIGEST_HOUR` | 8 | The UTC hour daily digests go out |
| `FORGE_NOTIFY_MAX_SUBSCRIBERS` | 10000 | Subscribers in total |
| `FORGE_NOTIFY_MAX_REPOS_PER_USER` | 50 | Repositories followed per subscriber |
| `FORGE_NOTIFY_MAX_REPOS` | 2000 | Repositories followed in total |
| `FORGE_NOTIFY_DAILY_SEND_BUDGET` | 20000 | Mails (confirmation mails included) and pushes per day, in total |
| `FORGE_NOTIFY_PER_USER_DAILY` | 200 | Instant notices per subscriber per day (more wait for the digest) |
| `FORGE_NOTIFY_PER_IP_PER_MINUTE` | 60 | API requests per minute per client address |
| `FORGE_NOTIFY_TRUST_PROXY` | `none` (`cloudflare` in the compose file) | Where the client address for rate limits comes from: `none` (the socket peer), `cloudflare` (`CF-Connecting-IP`, which Cloudflare overwrites) or `forwarded` (the **last** `X-Forwarded-For` entry, the one your proxy appended) |
| `FORGE_NOTIFY_INSECURE_LOCAL` | `false` | Allow http and loopback URLs and push endpoints. Local tests only. |
| `RUST_LOG` | `info` | Log level |

## DNS and TLS

The service speaks plain HTTP on the host's loopback. Put TLS in front of it:

- **Cloudflare tunnel (dashhq).** Add a public hostname `notify.forge.dashhq.org` → `http://localhost:8080` to the tunnel. Cloudflare sets `CF-Connecting-IP` and overwrites any value a client sends, so keep `FORGE_NOTIFY_TRUST_PROXY=cloudflare`. No inbound port is opened.
- **Caddy or nginx.** An `A`/`AAAA` record for the hostname, a certificate (Caddy gets one by itself), and `reverse_proxy 127.0.0.1:8080`, with `FORGE_NOTIFY_TRUST_PROXY=forwarded`. The service reads only the last `X-Forwarded-For` entry, the one your proxy appends; earlier entries come from the client.

If the host can be reached without the proxy, set `FORGE_NOTIFY_TRUST_PROXY=none`. Otherwise anyone can pick their own rate-limit key.

## Email deliverability: SPF, DKIM, DMARC

Notification mail is only useful if it reaches the inbox. Use a transactional provider, and a sending domain whose DNS you control. The records, for `MAIL_FROM` `notify@forge.dashhq.org`:

| Record | Name | Value |
|---|---|---|
| SPF | `forge.dashhq.org` TXT | `v=spf1 include:<your provider's SPF domain> -all` (the provider documents its include, e.g. `include:spf.mtasv.net` for Postmark or `include:amazonses.com` for SES) |
| DKIM | `<selector>._domainkey.forge.dashhq.org` TXT or CNAME | The key the provider generates for the domain. Providers sign for you, and forge-notify does not sign. |
| DMARC | `_dmarc.forge.dashhq.org` TXT | `v=DMARC1; p=quarantine; rua=mailto:dmarc@dashhq.org; adkim=s; aspf=r` (start with `p=none` for a week, read the reports, then tighten) |
| Return-Path / bounce | as the provider says (often a CNAME like `pm-bounces.forge.dashhq.org`) | Aligns SPF with the From domain |

Then:

- Send from a subdomain (`forge.dashhq.org`), not the apex, so notification reputation stays apart from people's mail.
- Gmail and Yahoo require SPF, DKIM, DMARC and one-click unsubscribe from bulk senders. forge-notify sends `List-Unsubscribe` with `List-Unsubscribe-Post`, plus `Auto-Submitted: auto-generated` (RFC 3834) so autoresponders stay quiet.
- Watch the provider's bounce and complaint dashboard. forge-notify pauses an address after three permanent refusals in a row. The subscriber sees "paused" in Settings and can confirm the address again.
- Test with a seed inbox at the big providers and with `mail-tester.com` before announcing.

## Web Push

Web Push needs no account at any push service. The browser subscribes with the service's VAPID public key (`/v1/info`) and returns an endpoint on its vendor's push service. forge-notify encrypts each message to the browser (RFC 8291, `aes128gcm`) and signs the request with the VAPID key (RFC 8292). The push service sees only the size of the message.

- Endpoints are accepted only on the hosts in `FORGE_NOTIFY_PUSH_HOSTS` (by default those of Chrome and Edge, Firefox, Safari and Windows), over https. A subscription cannot make the service POST to an arbitrary server.
- A subscription the push service reports gone (404 or 410) is deleted.
- The web app registers `notify-sw.js` (`forge-web/public/notify-sw.js`) only when the user turns push on. It shows the notification and opens its link, and it caches and intercepts nothing.
- Safari on iOS delivers Web Push only to a site added to the home screen.

## Routes

| Route | What |
|---|---|
| `GET /healthz` | Liveness: `{"status":"ok"}` (not rate limited) |
| `GET /readyz` | Readiness: the store answers and the watcher started, else 503 (not rate limited) |
| `GET /metrics` | Prometheus text, aggregate counts only |
| `GET /v1/info` | Operator, channels, VAPID public key, privacy link, digest hour, limits |
| `POST /v1/request` | A signed request: `account.get`, `email.set`, `email.remove`, `prefs.set`, `push.add`, `push.remove`, `test.send`, `data.export`, `data.delete` |
| `GET /v1/verify?token=` | The confirmation page (a button) |
| `POST /v1/verify` | Confirm an address |
| `GET /u/{token}` | The unsubscribe page |
| `POST /u/{token}` | One-click unsubscribe (RFC 8058) |

Browsers may call `/v1/*` only from `FORGE_NOTIFY_ALLOWED_ORIGINS`. Every response carries `Cache-Control: no-store`. The pages carry a CSP that allows no script, and `Referrer-Policy: no-referrer`, because their URLs hold tokens.

`services/forge-notify/examples/request.rs` signs a request from an identity file, which helps with scripting and checking a deployment:

```sh
cargo run -p forge-notify --example request -- --url https://notify.forge.dashhq.org \
  --operator notify.forge.dashhq.org --identity-file alice.identity.json --key 1 --action account.get
```

## What is sent, and when

A subscriber chooses topics, channels and timing in Settings → Notifications.

| Topic (default) | Source |
|---|---|
| Participating (on) | Activity on issues and pull requests the subscriber opened, commented on or reviewed |
| Review requested (on), Assigned (on) | Review-request and assignment events addressed to them in **any** repository, through the `addressee` index, every `FORGE_NOTIFY_ADDRESSED_SECS` |
| Mentioned (on) | `@name` (their DPNS label, word-bounded, case-insensitive) or their identity id in a public issue, pull request, comment or review |
| Watching (on) | New issues and pull requests, comments, reviews, closes, reopens and merges in repositories they watch |
| My repositories (on) | Treat repositories they own or are a member of as watched |
| Releases (on) | Releases of those repositories |
| Private activity (off) | "New activity in <repo>" for a private repository they own or are a member of, checked every 5 minutes, with no title or text. It counts pushes, new issues and pull requests, state changes and member events. Comments and reviews have no per-repository index, so they are not seen. |

- **Delivery:** instant, or one daily digest mail at `FORGE_NOTIFY_DIGEST_HOUR` UTC. A digest sends no push. A subscriber with no working address (push only) gets notices as pushes when they happen, even with the digest chosen, up to the daily cap. A digest that cannot go (budget spent, a failed send) keeps its notices for the next one, up to 7 days.
- Nobody is told about their own actions. Each notice reaches an identity once.
- The followed repositories are re-read every `FORGE_NOTIFY_INDEX_SECS` (watch documents, owned repositories, memberships), and right away after a subscriber changes their choices.

## Rate limits and abuse controls

| Control | Default |
|---|---|
| API requests per client address | 60 per minute (`FORGE_NOTIFY_PER_IP_PER_MINUTE`) |
| Request body | 16 KiB; signed request text 8 KiB |
| Signed requests | Fresh time (±300 s), single-use nonce, operator-bound |
| Confirmation mails | 5 a day per identity, and 5 a day per mailbox (`+tags`, and dots in Gmail addresses, count as one); each also counts against the daily send budget |
| Identities per address | 5 |
| Push subscriptions | 10 per identity |
| Test sends | 5 a day per identity |
| Subscribers | 10,000 (`FORGE_NOTIFY_MAX_SUBSCRIBERS`) |
| Followed repositories | 50 per subscriber, 2,000 in total |
| Sends | 200 instant notices per subscriber per day (more wait for the digest; a push-only subscriber gets 200 pushes); 20,000 in total per day, confirmation mails included |
| Bad addresses | Paused after 3 permanent refusals in a row |

A subscriber needs a Platform identity, which costs credits to create. That is the main brake on mass sign-ups. Confirmation mails are capped per address, so nobody can use the service to flood someone else's inbox.

## Monitoring

- **Health:** `GET /healthz` (process up) and `GET /readyz` (store and watcher up). The image has a Docker `HEALTHCHECK` on `/healthz`.
- **Metrics:** `GET /metrics` returns gauges: `forge_notify_subscribers`, `forge_notify_emails_verified`, `forge_notify_emails_paused`, `forge_notify_push_subscriptions`, `forge_notify_followed_repos`, `forge_notify_digest_items`, `forge_notify_sent_today` and `forge_notify_ready`. These are counts only. To keep them private, block `/metrics` at the proxy and scrape over the host network.
- **Alert on:** `/readyz` failing for 5 minutes; `forge_notify_sent_today` near `FORGE_NOTIFY_DAILY_SEND_BUDGET`; a rise in `forge_notify_emails_paused`; the log lines `the daily send budget is used up`, `mail failed` or `addressed poll failed` repeating.
- An outside uptime check (for example, Cloudflare health checks or Uptime Kuma) on `https://notify.forge.dashhq.org/healthz`.

## Logs

Logs go to stdout (`docker compose logs`). They are written to contain **no secrets and no personal data**:

- no addresses, tokens, push endpoints, signatures or keys;
- signed requests are logged by action only (`signed request action=email.set`);
- send failures carry the provider's error, not the recipient;
- the embedded relay logs public repository ids and names.

Client addresses are used in memory for rate limiting and are not logged. Keep `RUST_LOG=info` in production. `debug` adds Platform read detail but still no personal data.

## Backups and upgrades

- **Back up** the `notify-data` volume (one SQLite file, `notify.sqlite3`, in WAL mode). Use `sqlite3 notify.sqlite3 ".backup /backup/notify-$(date +%F).sqlite3"`, or stop the container and copy the files. Daily is enough: a lost day costs pending digests and a few re-confirmations.
- **Keep the data key out of those backups** and store it separately (a password manager or a secret store). The backup is useless without the key, and the key is harmless without the backup.
- **Retention:** sent marks 14 days, participation 180 days, digest items 7 days, pending confirmations 48 hours, nonces 10 minutes, quota counters until the next day. All of this is purged daily.
- **Upgrade:** rebuild or pull the image, then `docker compose up -d`. The store's tables are created on start if missing. The review-request and assignment cursors are stored, so those are neither repeated nor lost across a restart. Repository activity is polled from the moment the service starts, so activity written while it was down is not sent (the in-browser inbox still shows it).

## Show it in the web app

The web app shows **Settings → Notifications → Email and push** only when its build names a service:

```sh
NEXT_PUBLIC_NOTIFY_URL=https://notify.forge.dashhq.org pnpm build
```

For forge.dashhq.org, the Pages workflow (`.github/workflows/pages.yml`) reads it from the repository variable `PAGES_NOTIFY_URL` (Settings → Secrets and variables → Actions → Variables). Set it, then deploy: **Actions → Deploy forge-web to Pages → Run workflow** on master (or push to master). Delete it and deploy again to hide the section. A value that is not an `https://` URL (other than a loopback `http://` test service) is ignored.

Without the variable, the section and its code stay out of the page. The web app signs requests for the host in that URL, so the service's operator name must be that host (the default when `FORGE_NOTIFY_OPERATOR` is unset). The service must allow the web app's origin (`FORGE_NOTIFY_ALLOWED_ORIGINS`, which defaults to `FORGE_NOTIFY_WEB_URL`'s origin). A build served from IPFS gateways has a different origin on each gateway. List the ones you support, or accept that those builds can't reach the service. Every other part of Forge still works.

## Test it locally

Mailpit catches mail, and a stub receives push:

```sh
docker run -d --name notify-mailpit -p 127.0.0.1:18025:8025 -p 127.0.0.1:11025:1025 axllent/mailpit
eval "$(forge-notify keys | grep '^FORGE')"    # local test keys only
FORGE_NOTIFY_NETWORK=devnet FORGE_NOTIFY_DEVNET_NAME=sakura \
FORGE_NOTIFY_PUBLIC_URL=http://127.0.0.1:18200 FORGE_NOTIFY_LISTEN=127.0.0.1:18200 \
FORGE_NOTIFY_OPERATOR=notify.local FORGE_NOTIFY_ALLOWED_ORIGINS=http://127.0.0.1:4400 \
FORGE_NOTIFY_DATA_DIR=/tmp/notify-data FORGE_NOTIFY_INSECURE_LOCAL=true \
FORGE_NOTIFY_SMTP_HOST=127.0.0.1 FORGE_NOTIFY_SMTP_PORT=11025 FORGE_NOTIFY_SMTP_TLS=none \
FORGE_NOTIFY_MAIL_FROM='Dash Forge local <notify@example.org>' \
FORGE_NOTIFY_VAPID_SUBJECT=mailto:ops@example.org \
forge-notify serve
```

Then sign up with `examples/request.rs` (`email.set`), open the confirmation link from Mailpit (`http://127.0.0.1:18025`), and write an issue that @mentions the identity from another identity with `dg`. The automated tests (`cargo test -p forge-notify`) cover the same path offline with a stub chain, mailer and push service.

## Billing (later)

The MVP is free, within the rate limits above. Billing is designed but not built:

- **Prepaid credits to a service identity.** A subscriber transfers credits (`IdentityCreditTransfer`) to the operator's identity. The service reads the transfer from Platform with proofs and adds sends to the subscriber's quota. No card or account is needed, and the payment can be checked on chain.
- **Free tier** for review requests, assignments and mentions, and paid volume for watched-repository activity.
- This needs a spike first: how the service attributes a transfer to a subscriber (a memo is not available on credit transfers, so a per-subscriber deposit identity or a signed claim of the transfer id is needed), refunds, and what happens when credit runs out.

## Privacy notice (draft)

> **Dash Forge notifications (forge-notify), operated by <operator>.**
>
> **What this is.** An optional service that emails you, or sends push notifications to your browser, about activity on Dash Forge. Dash Forge works without it.
>
> **What we keep.** Your Dash Platform identity id; your email address, encrypted, and whether you confirmed it; your browsers' push subscriptions, encrypted, and a label such as "Firefox on macOS"; the choices you make in Settings → Notifications; the list of repositories we follow for you (worked out from public Platform data); and, for a short time, which notices we already sent you, notices waiting for your digest (7 days), and the threads you took part in (180 days). We keep no password and no account.
>
> **What we read.** Public data on Dash Platform, the same data anyone can read. For a private repository we read only public metadata, so we can tell you "new activity" if you ask, never what it is.
>
> **What we never do.** Put your address on chain; sell or share your data; track opens or clicks (mails are plain text with no tracking pixel, and links go straight to Forge); send anything but notifications you chose.
>
> **Who processes it.** Our mail provider <provider> delivers email. Your browser's vendor (Google, Mozilla, Apple or Microsoft) delivers push messages, encrypted so that only your browser can read them.
>
> **Where.** On a server operated by <operator> in <country>. Our mail provider may process mail in <regions>.
>
> **Your choices.** Unsubscribe from any mail with one click. Download everything we keep, or delete it, from Settings → Notifications. Deleting stops all notifications at once. Only a count of today's confirmation mails for your identity stays until the next day, so deleting cannot be used to send more. Contact: <contact>.
>
> **Logs.** Our server logs contain no addresses or tokens. Network addresses are used for rate limiting in memory and are not stored.
>
> **Changes.** We will announce changes to this notice in the app before they apply.

## Checklist for dashhq

1. **Choose the hostname:** `notify.forge.dashhq.org` (or another), plus a mail sending domain, for example `forge.dashhq.org`.
2. **Choose an SMTP provider** and verify the sending domain there. Add the SPF, DKIM, DMARC and bounce records it gives you.
3. **Host:** an LXC or VM on the home Proxmox with Docker, 1 vCPU, 512 MiB RAM and 5 GiB of disk.
4. **Secrets:** run `forge-notify keys` once and store `data_key` and `vapid_private_key` in the password manager. Put the SMTP password in `secrets/smtp_password`.
5. **Cloudflare tunnel:** route `notify.forge.dashhq.org` to `http://localhost:8080`.
6. **`.env`:** as in [Run it](#run-it), with the privacy notice URL and contact.
7. **Publish the privacy notice** (the draft above, completed) at the URL in `FORGE_NOTIFY_PRIVACY_URL`.
8. **Web app:** set the repository variable `PAGES_NOTIFY_URL` to `https://notify.forge.dashhq.org` and deploy ([Show it in the web app](#show-it-in-the-web-app)).
9. **Backups:** a daily `sqlite3 .backup` of the volume, stored apart from the data key.
10. **Monitoring:** an uptime check on `/healthz`, and the alerts in [Monitoring](#monitoring).
11. **Smoke test:** sign up from the web app, confirm the mail, send a test from Settings, turn on push in a browser, @mention yourself from a second identity, and unsubscribe from the mail's link.

# forge-notify

Optional email and Web Push notifications for Dash Forge identities: review requests, assignments, @mentions, activity on threads you take part in and on repositories you watch, own or belong to, and releases.

- Subscribers prove control of a Forge identity with a signed request (`docs/design/service-auth.md`), with no account or password.
- Addresses are confirmed by mail (double opt-in), encrypted at rest and never put on chain. Every mail has one-click unsubscribe (RFC 8058).
- For private repositories it reads public metadata only and says "new activity", never a title.
- It is a hint, never an authority: Forge works the same without it.

Run and host it: [`docs/hosting/forge-notify.md`](../../docs/hosting/forge-notify.md) (settings, DNS, SPF/DKIM/DMARC, backups, monitoring, privacy notice draft). The web app shows its settings under Settings → Notifications when built with `NEXT_PUBLIC_NOTIFY_URL`.

```sh
cargo test -p forge-notify                       # unit + offline integration tests
docker build -f services/forge-notify/Dockerfile -t forge-notify .
docker run --rm forge-notify keys                # a data key and a VAPID key pair
```

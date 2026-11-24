# Hosting the web app

The web app is a static export (`forge-web/out`). forge.dashhq.org is deployed by `.github/workflows/pages.yml` to GitHub Pages, behind Cloudflare. GitHub Pages sets its own headers and cannot be configured. Cloudflare in front of it can override them. These are the settings to apply there, and what each fixes: caching and compression (sections 1 to 4), and the security headers and CAA records that protect the keys people unlock in the app (sections 7 and 8).

## What is served today (measured 2026-09-29)

| Asset | Encoding | Cache-Control |
|---|---|---|
| HTML (`/repo/` …) | br | `max-age=600` |
| `/_next/static/chunks/*.js` | br or gzip | `max-age=14400` (4 h) or `max-age=600` |
| `/_next/static/wasm/wasm_sdk_bg.<hash>.wasm` (23.4 MB) | br 7.19 MB / gzip 8.18 MB | `max-age=600`, `cf-cache-status: DYNAMIC` |

Two consequences:
- **The wasm is not cached at the edge.** `DYNAMIC` means Cloudflare does not cache `.wasm` by default, so every cold visitor pulls it from GitHub Pages.
- **Browsers revalidate after 10 minutes** everything under `/_next/static/`. Those files have content hashes in their names and never change.

On a slow link (400 ms, 50 KB/s) that is over 90 s before the app is usable (L-54).

## Settings for the Cloudflare zone of forge.dashhq.org

### 1. Cache the hashed build output forever

Every file under `/_next/static/` has a content hash in its name (Next's `[contenthash]`, and `static/wasm/[name].[contenthash:16].wasm`), so a changed file always has a new name.

Rules → **Cache Rules** → Create rule:
- **When:** URI Path starts with `/_next/static/`
- **Cache eligibility:** Eligible for cache
- **Edge TTL:** Ignore cache-control header and use this TTL → 1 year, with a **Status Code TTL** for `400`–`599` → No cache. Without the status override a path requested before a deploy published it would stay a cached 404 for a year.
- **Browser TTL:** Override origin → 1 year

Rules → **Transform Rules** → Modify Response Header → Create rule:
- **When:** URI Path starts with `/_next/static/` **and** Response status code (`http.response.code`) equals `200`
- **Set static:** `Cache-Control` = `public, max-age=31536000, immutable`

The second rule matters because the browser TTL override alone does not add `immutable`. Without it, a reload revalidates every chunk. The status condition keeps `immutable` off a 404 and off Cloudflare's own error pages, which response header rules also reach. Header rules run after the cache decision, so they change what the browser keeps, not what the edge caches.

Cloudflare lists `http.response.code` as a response field, and says response fields are readable in the response-header phase, but availability "depends on the exact Cloudflare feature and your plan". If the expression builder does not offer it for this rule, leave the Transform Rule out. Browsers then get the 1-year browser TTL without `immutable`: a reload revalidates, but a normal navigation still reads the cache.

### 2. Cache the wasm at the edge

The Cache Rule above also covers the wasm: the path matches, and "Eligible for cache" overrides Cloudflare's extension list, which excludes `.wasm`. Verify it with:

```sh
curl -sI -H 'Accept-Encoding: br' https://forge.dashhq.org/_next/static/wasm/<file>.wasm | grep -i -E 'cf-cache-status|cache-control|content-encoding'
```

Expect `cf-cache-status: HIT` on a second request, `content-encoding: br`, and the immutable Cache-Control.

### 3. Compression

Cloudflare compresses what it serves by default (Brotli, falling back to gzip), and `application/wasm` is among the types it compresses: the measurements above show `br` served. To choose the algorithms explicitly, use **Rules → Compression Rules** (the older Speed → Optimization toggle is superseded by them):
- **When:** URI Path starts with `/_next/static/`
- **Then:** Custom, in this order: Zstandard, Brotli, Auto. `Auto` must be last: a list with no algorithm the browser accepts sends the response uncompressed.

Verify what a current browser gets (it offers all of them):

```sh
curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip, deflate, br, zstd' https://forge.dashhq.org/_next/static/wasm/<file>.wasm | grep -i -E 'content-encoding|cf-cache-status'
```

Cloudflare asks the origin for gzip or Brotli only and recompresses at the edge, so zstd needs no origin support.

- **Brotli sizes:** Cloudflare's on-the-fly brotli gives 7.19 MB for the wasm. A precompressed brotli-11 file is 5.2 MB, but Cloudflare does not serve precompressed files from a GitHub Pages origin.
- **To go below 7.19 MB,** host the static assets somewhere that serves `.br` files, for example Cloudflare Pages or R2 with `Content-Encoding: br` set on upload. That is a hosting change, not a setting.

### 4. HTML stays short-lived

Leave HTML (`/`, `/repo/…`) at the origin's `max-age=600`, or shorter. A deploy changes which hashed chunks the HTML names. Old chunks stay available for two generations (`pages.yml` merges them), so a stale HTML page still loads.

### 5. Headers the app needs (already provided)

The app sets its CSP in a `<meta>` tag. COOP and COEP are not required: the SDK runs without threads.

Its `connect-src` allows `https:`, which covers the organizations relay at `https://multisig.dashhq.org` that testnet and devnet builds poll. Mainnet builds have no organization features and never contact the relay. A host that sends its own stricter `Content-Security-Policy` header must allow that origin on non-mainnet sites.

A host may still send them. If it does, use these values on every response, since a stricter COEP stops the app loading cross-origin images:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless`

The security headers in section 7 are a separate matter: every host should send those.

`next.config.js` `headers()` does the same in development.

### 6. Cloudflare Web Analytics: the page carries the beacon

forge.dashhq.org uses Cloudflare Web Analytics, which is cookieless (see [Privacy](#privacy-the-hosted-site-counts-visits)). The beacon is part of the build, and the zone's automatic setup also stays on (the owner's choice), so Cloudflare injects a second copy into every page.

**Why the build carries it.** Automatic setup inserts its beacon `<script>` before `</body>` in every HTML response, with a `data-cf-beacon` config that tells it to report to the zone's own `/cdn-cgi/rum`. On its own, that collected nothing: the page CSP allows no script it did not name, so it refused the injected one. The build's copy is the one that runs and that the CSP names. Other Cloudflare features that rewrite HTML (Rocket Loader, Email Address Obfuscation, the old Auto Minify) must stay off. The inline scripts are allowed by their exact bytes, so a rewritten script no longer matches its hash, the page does not start, and `dg verify-app` reports the changed file.

**What the build does.** With `NEXT_PUBLIC_CF_BEACON_TOKEN` set to the site token (public: it is in every page), every page ends with the beacon, pinned to one version with its SRI hash. The page CSP's `script-src` allows that exact URL and nothing else from Cloudflare (`forge-web/lib/cf-beacon.ts`). The report needs a `Referer`, so the host's `Referrer-Policy` must not be `no-referrer` (section 7 uses `strict-origin`). The tag carries the token alone, like the snippet Cloudflare gives for manual installation, so it reports to `https://cloudflareinsights.com/cdn-cgi/rum` (which `connect-src https:` already allows). With the variable unset, there is no beacon and no CSP entry. That is the default for self-hosted builds, and the IPFS build refuses the variable. `pages.yml` sets it for this repository; a fork's deploy sets `PAGES_CF_BEACON_TOKEN` or gets none. To move to a newer beacon, copy `src` and `integrity` from the tag Cloudflare injects into `lib/cf-beacon.ts`. If Cloudflare retires the pinned URL, the beacon stops loading and the app is unaffected, so look at the dashboard now and then: numbers that stop mean the pin needs updating.

**The injected copy counts nothing twice.** While the injected tag names the same URL as the build's, the browser loads and runs that module once, and the beacon reads the first `data-cf-beacon` on the page, which is the build's. When Cloudflare moves its injection to a newer version, the CSP refuses that URL, which leaves a console message and nothing else. The beacon also returns early when a copy already ran on the page (`load: "single"`). In Chromium against the live site (2026-11-20), the page with both tags fetched the beacon once and sent one page-view report. With the injected URL changed to another version, the CSP refused it and the build's beacon still sent one report.

**`dg verify-app` and the injection.** The injected tag changes the bytes of every page the build manifest lists. `dg verify-app` removes exactly that tag and hashes the page again (`without_cf_injected_beacon` in `crates/dg/src/verify_app.rs`). It removes only Cloudflare's own form: a `static.cloudflareinsights.com/beacon.min.js/v…` module script with an SRI hash, directly before `</body>`, whose config has only `version`, `token`, `r` and `spa`, with the same site token as the beacon the build carries, and, when it names the build's own beacon URL, the build's pinned SRI digest. Anything else that differs fails the check as before: another script, attribute, position, token or config (`send` or `forward`, which point reports elsewhere), or a page without the build's own beacon. Its output counts the pages it matched that way (`cfBeaconRemoved` in `--json`). The match is exact on purpose: if Cloudflare changes the tag's form (attribute order, quoting, the trailing newline, a new config key) or the build's tag changes its serialization, verify-app fails again and the code needs the new form. Nothing new gets through in the meantime. The removal also leans on the page CSP allowing only the build's beacon URL, so keep it that narrow.

**The zone setting.** Cloudflare dashboard → **Web Analytics** → the site `forge.dashhq.org`. Either **Enable** (automatic setup, today's setting) or **Enable with JS Snippet installation** works. Not **Disable**: that stops collection. The site token shown there must be the one `pages.yml` builds with. If it differs, set the repository variable `PAGES_CF_BEACON_TOKEN` to it and redeploy. (A `Cache-Control: no-transform` response header also stops the injection, but only as a side effect Cloudflare does not support, and GitHub Pages sets no such header.)

Count the beacons:

```sh
curl -s -H 'Accept: text/html' -H 'User-Agent: Mozilla/5.0' https://forge.dashhq.org/ | grep -o -i '<script[^>]*static\.cloudflareinsights\.com' | wc -l
```

Expect `2` while automatic setup is on (the build's own and Cloudflare's), `1` with snippet installation. `pages.yml` runs the same check after each deploy and prints a notice with the count. `dg verify-app https://forge.dashhq.org` is the full check.

#### Privacy: the hosted site counts visits

The site at forge.dashhq.org loads Cloudflare's Web Analytics script. Cloudflare says it sets no cookies, uses no local storage, and does not fingerprint visitors or follow them by IP address. It reports page views (the path and referrer), the browser, the country and page-load timings to Cloudflare, which already serves every request to the site. The script runs with the page's privileges, which is why it is pinned by its hash: Cloudflare cannot swap in other code without the browser refusing it. Builds you run yourself carry no analytics unless you set `NEXT_PUBLIC_CF_BEACON_TOKEN`, and the IPFS release never does. Blocking `static.cloudflareinsights.com` in your browser changes nothing in the app.

### 7. Security headers

The app keeps keys in the browser, so the page that holds them must not be framed, downgraded to plain HTTP, or reinterpreted. GitHub Pages sends none of these headers today (`curl -sI https://forge.dashhq.org/`, 2026-10-04). The app's `<meta>` CSP cannot carry `frame-ancestors`: browsers ignore it there.

Every setting below is scoped to the host `forge.dashhq.org`. Cloudflare's HSTS and **Always Use HTTPS** switches under SSL/TLS → Edge Certificates apply to the whole `dashhq.org` zone, so leave them alone unless the zone's owner wants that for every subdomain.

**Redirect plain HTTP.** Rules → **Redirect Rules** → Create rule:
- **Rule name:** Forge HTTPS
- **When:** custom filter expression `(http.host eq "forge.dashhq.org" and not ssl)`
- **Then:** Dynamic, expression `concat("https://", http.host, http.request.uri.path)`, status code 301, **Preserve query string** on

**Headers.** Rules → **Transform Rules** → **Modify Response Header** → Create rule:
- **Rule name:** Forge security headers
- **When:** Hostname equals `forge.dashhq.org`
- **Then**, one **Set static** row per header:

| Header | Value | What it stops |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000` | A downgrade to plain HTTP on a hostile network on every visit after the first, for a year after each visit. Only the preload list (below) covers a first visit |
| `X-Content-Type-Options` | `nosniff` | A browser running an uploaded file as script because it guessed its type |
| `Content-Security-Policy` | `frame-ancestors 'none'` | Another site framing the app to trick a click on a write (clickjacking). The browser applies it together with the page's `<meta>` CSP, so nothing else changes |
| `X-Frame-Options` | `DENY` | The same, in browsers without `frame-ancestors` |
| `Referrer-Policy` | `strict-origin` | Repository and issue URLs leaking to the sites that READMEs and comments link to: they get `https://forge.dashhq.org/` at most. Not `no-referrer` here: Cloudflare's Web Analytics endpoint refuses a report without a `Referer` (section 6). A host with no beacon can use `no-referrer`, as the nginx example below does |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()` | An injected script asking for hardware the app never uses. Passkeys stay allowed: the policy names none of the `publickey-credentials-*` features |

`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` are optional; if you add them to this rule, use the values in section 5.

**Check it:**

```sh
curl -sI https://forge.dashhq.org/ | grep -i -E 'strict-transport|content-security|x-frame|referrer-policy|permissions-policy|x-content-type'
curl -sI http://forge.dashhq.org/ | grep -i -E '^(HTTP|location)'   # expect a 301 to https://
```

Expect all six headers, and the plain-HTTP request redirected.

**Preload.** The browsers' HSTS preload list (hstspreload.org) takes only a registrable domain. For Forge that means `dashhq.org` with `includeSubDomains` and `preload`, which makes every subdomain of dashhq.org HTTPS-only in every browser, for good. That is a decision for the owner of dashhq.org. Once every subdomain serves HTTPS, turn on the zone's HSTS (SSL/TLS → Edge Certificates) with includeSubDomains, Preload and a max age of at least a year, then submit `dashhq.org` at hstspreload.org.

### 8. CAA records

CAA records name the certificate authorities allowed to issue a certificate for the domain, so a mis-issued certificate for forge.dashhq.org is harder to get. DNS → Records → Add record, in the `dashhq.org` zone:

| Type | Name | Flags | Tag | CA domain name |
|---|---|---|---|---|
| CAA | `forge` | 0 | Only allow specific hostnames (`issue`) | `letsencrypt.org` |
| CAA | `forge` | 0 | Send violation reports to URL (`iodef`) | `mailto:` and the address that should get reports |

- **`letsencrypt.org`** is the CA GitHub Pages uses for the origin's certificate. Without it, GitHub can't renew the certificate behind Cloudflare.
- **Cloudflare's own CAs** (Let's Encrypt, Google Trust Services, SSL.com and Sectigo) are added for Universal SSL automatically, as soon as the zone has any CAA record. They don't appear in the dashboard, but `dig` shows them ([Cloudflare: Add CAA records](https://developers.cloudflare.com/ssl/edge-certificates/caa-records/)).

To cover every subdomain instead, put the same records on `dashhq.org` itself (Name `@`), if that suits the zone's other hosts.

**Check it:**

```sh
dig +short CAA forge.dashhq.org
```

Expect your records and Cloudflare's. Then confirm Universal SSL still shows **Active** under SSL/TLS → Edge Certificates.

## Pausing the site (operator)

A bug in the web app that corrupts or leaks on write, or a wrong cost, needs "stop writes, keep reading" faster than a code fix. The Pages build has a switch for that, on every network, with no code change. It is the repository variable `PAGES_NOTICE`, read by `.github/workflows/pages.yml` into `NEXT_PUBLIC_PAGES_NOTICE` (`forge-web/lib/pages-notice.ts`).

| `PAGES_NOTICE` | What the site does |
|---|---|
| unset or empty | Nothing. |
| `advisory` | A banner on every page that cannot be dismissed, linking the advisory. Writes stay on. |
| `paused` | The same banner, and every write is refused before anything is signed or paid: each write button says why, and sign-in, identity creation and top-up refuse too. Reading, cloning and verifying keep working. |

Two more variables shape the banner: `PAGES_NOTICE_TEXT` is the reason, a sentence or two of at most 400 characters (it is also what every write button says, after "Writing is paused:"), and `PAGES_NOTICE_URL` is the advisory's `https://` address (default: the repository's security page, `https://github.com/PastaPastaPasta/dash-forge/security`). Any other mode, a text over 400 characters or a URL that is not `https://` fails the build, so a typo cannot leave the site silently unpaused. The devnet-move notice (`PAGES_DEVNET_NOTICE`) is a separate switch; when `PAGES_NOTICE` is set its banner takes the strip.

To pause (about 3 minutes from start to live):

```sh
gh variable set PAGES_NOTICE_TEXT --body "A signing bug is being fixed. Nothing was lost."
gh variable set PAGES_NOTICE_URL --body "https://github.com/PastaPastaPasta/dash-forge/security/advisories/GHSA-xxxx-xxxx-xxxx"
gh variable set PAGES_NOTICE --body paused
gh workflow run pages.yml --ref master
gh run watch
```

To lift it, delete the variable and run the workflow again:

```sh
gh variable delete PAGES_NOTICE
gh variable delete PAGES_NOTICE_TEXT
gh variable delete PAGES_NOTICE_URL
gh workflow run pages.yml --ref master
```

Check the live site afterwards: the banner shows (or is gone), and a write button names the reason (or signs). A tab that was already open learns of the new build within about 12 minutes or when it is focused ("A new version is available", `forge-web/lib/new-build.ts`). It compares the served `forge-manifest.json`'s commit and its `notice` field, so a pause redeployed from the same commit counts as new. Until it reloads, the tab runs the old build, so the pause is not instant for open tabs. Nothing forces them to reload yet.

The switch covers this Pages build only. The IPFS release copies, `dg`, and CI or mirror runners ignore it.

This switch is the lever for a bug in the client, not for a compromised site: a compromised build can ignore its own pause. If forge.dashhq.org itself serves wrong bytes, stop serving it at Cloudflare first (only the zone owner can; no maintenance rule is configured yet), then `gh workflow disable pages.yml`, investigate, fix, re-enable, check the result with `dg verify-app` and announce it. Unpublishing Pages without a replacement leaves nobody a copy to verify against, so do that last.

## Linking the mainnet and testnet sites

Each build reads and writes one network, so the hosted mainnet and testnet builds are two sites: `forge.dashhq.org` (mainnet) and `testnet-forge.dashhq.org` (testnet). Two repository variables, read by `pages.yml` into `NEXT_PUBLIC_MAINNET_SITE_URL` and `NEXT_PUBLIC_TESTNET_SITE_URL` (`forge-web/lib/network-sites.ts`), let each site point at the other:

| Variable | What it adds |
|---|---|
| `PAGES_MAINNET_SITE_URL` | On a testnet or devnet build: an "Open Forge on Mainnet" link on the Networks page and a dismissible "Forge is live on mainnet" banner on every page, both only once the bundled `forge-contracts/deployments/mainnet.json` has Forge's contracts. |
| `PAGES_TESTNET_SITE_URL` | An "Open Forge on Testnet" link on the Networks page of the mainnet and devnet builds, and a "Testnet" link in the mainnet build's footer, while `forge-contracts/deployments/testnet.json` has Forge's contracts. |

Each value is an `https://` origin with no path, such as `https://forge.dashhq.org`; anything else is ignored and the link stays hidden. A build never links to its own network, so every site's deploy can set both. Set them only once each origin serves the build for its network: while forge.dashhq.org still serves the testnet build, `PAGES_MAINNET_SITE_URL=https://forge.dashhq.org` would make the testnet Networks page link to itself (the banner hides itself on that origin).

```sh
gh variable set PAGES_MAINNET_SITE_URL --body https://forge.dashhq.org
gh variable set PAGES_TESTNET_SITE_URL --body https://testnet-forge.dashhq.org
```

## Other static hosts (IPFS gateways, S3, nginx)

The same rules apply:
- the security headers of section 7 on every response;
- `/_next/static/**` → `Cache-Control: public, max-age=31536000, immutable`
- brotli (or gzip) for `.js`, `.css`, `.wasm`
- `application/wasm` as the wasm MIME type, which the browser needs to compile while streaming
- HTML short-lived

Build with `NEXT_PUBLIC_SITE_URL=https://<your host>` so link previews (`og:image`) point at your copy, not forge.dashhq.org, and the wallet sign-in tells users to scan only codes shown on your host. A build under `NEXT_PUBLIC_BASE_PATH` adds that path to it.

For nginx. A self-hosted copy has no analytics beacon unless its build sets `NEXT_PUBLIC_CF_BEACON_TOKEN`; if it does, use `Referrer-Policy: strict-origin` (section 6). `add_header` in a `location` replaces every `add_header` inherited from the `server`, so a location that sets Cache-Control must repeat the other headers the site sends:

```nginx
server {
  # The section 7 headers, plus COOP/COEP (section 5).
  add_header Cross-Origin-Opener-Policy "same-origin" always;
  add_header Cross-Origin-Embedder-Policy "credentialless" always;
  add_header Strict-Transport-Security "max-age=31536000" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Content-Security-Policy "frame-ancestors 'none'" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()" always;

  location /_next/static/ {
    # Repeated here: this location's add_header replaces every one of the server's.
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "credentialless" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Content-Security-Policy "frame-ancestors 'none'" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()" always;
    add_header Cache-Control "public, max-age=31536000, immutable";
    brotli_static on;   # ngx_brotli; serves .br files built next to the originals
    gzip_static on;
  }
}
```

nginx's stock `mime.types` maps `.wasm` to `application/wasm` (added in May 2021, nginx ticket #1606; check your `mime.types` for the line). If it is missing, add `application/wasm wasm;` to that file rather than a `types { … }` block in a `server` or `location`, which would replace the inherited map instead of extending it.

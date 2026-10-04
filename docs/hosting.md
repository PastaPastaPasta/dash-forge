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

A host may still send them. If it does, use these values on every response, since a stricter COEP stops the app loading cross-origin images:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless`

The security headers in section 7 are a separate matter: every host should send those.

`next.config.js` `headers()` does the same in development.

### 6. Cloudflare Web Analytics stays off

A zone proxied by Cloudflare gets Web Analytics' JavaScript beacon injected into every HTML response while automatic setup is on, which is the default. The app's CSP (`script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'`) refuses it, so on every page the console logs `Loading the script 'https://static.cloudflareinsights.com/beacon.min.js/…' violates the following Content Security Policy directive`, and Playwright sees a failed `(csp)` request (QW3-040). Nothing loads, so nothing is collected. But a third-party script the site never asked for is against the point of the site (no server to trust, nothing in the page that phones home), and it keeps the console from being clean.

Do not add `static.cloudflareinsights.com` to the CSP. Turn the injection off instead:

- Cloudflare dashboard → **Web Analytics** → the site `forge.dashhq.org` → **Manage site** → set automatic setup to **Disable**. (Or delete the site there.)
- Not a substitute: a `Cache-Control: no-transform` response header also stops the injection, but only as a side effect that Cloudflare does not support as the way to turn it off, and GitHub Pages sets no such header.

Verify it:

```sh
curl -s -H 'Accept: text/html' -H 'User-Agent: Mozilla/5.0' https://forge.dashhq.org/ | grep -c -i -E 'cloudflareinsights|data-cf-beacon'
```

Expect `0`. `pages.yml` runs the same check after each deploy and prints a warning (it does not fail the deploy) when the beacon is back, so a zone setting that drifts shows up in the workflow run.

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
| `Referrer-Policy` | `no-referrer` | Repository and issue URLs leaking to the sites that READMEs and comments link to |
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

## Other static hosts (IPFS gateways, S3, nginx)

The same rules apply:
- the security headers of section 7 on every response;
- `/_next/static/**` → `Cache-Control: public, max-age=31536000, immutable`
- brotli (or gzip) for `.js`, `.css`, `.wasm`
- `application/wasm` as the wasm MIME type, which the browser needs to compile while streaming
- HTML short-lived

For nginx. `add_header` in a `location` replaces every `add_header` inherited from the `server`, so a location that sets Cache-Control must repeat the other headers the site sends:

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

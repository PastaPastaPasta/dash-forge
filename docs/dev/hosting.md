# Hosting the web app: cache and compression settings

The web app is a static export (`forge-web/out`). forge.dashhq.org is deployed by `.github/workflows/pages.yml` to GitHub Pages, behind Cloudflare. GitHub Pages sets its own headers and cannot be configured. Cloudflare in front of it can override them. These are the settings to apply there, and what each fixes.

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
- **Edge TTL:** Ignore cache-control header and use this TTL → 1 year
- **Browser TTL:** Override origin → 1 year

Rules → **Transform Rules** → Modify Response Header → Create rule:
- **When:** URI Path starts with `/_next/static/`
- **Set static:** `Cache-Control` = `public, max-age=31536000, immutable`

The second rule matters because the browser TTL override alone does not add `immutable`. Without it, a reload revalidates every chunk.

### 2. Cache the wasm at the edge

The Cache Rule above also covers the wasm: the path matches, and "Eligible for cache" overrides Cloudflare's extension list, which excludes `.wasm`. Verify it with:

```sh
curl -sI -H 'Accept-Encoding: br' https://forge.dashhq.org/_next/static/wasm/<file>.wasm | grep -i -E 'cf-cache-status|cache-control|content-encoding'
```

Expect `cf-cache-status: HIT` on a second request, `content-encoding: br`, and the immutable Cache-Control.

### 3. Compression

Speed → Optimization → Content Optimization: **Brotli on**. It is on today. Check that the Cache Rule doesn't disable it: `content-encoding: br` for `.wasm` and `.js`.

`application/wasm` must be in the compressed types. Cloudflare compresses it by default, and the measurements above show br served.

- **Brotli sizes:** Cloudflare's on-the-fly brotli gives 7.19 MB for the wasm. A precompressed brotli-11 file is 5.2 MB, but Cloudflare does not serve precompressed files from a GitHub Pages origin.
- **To go below 7.19 MB,** host the static assets somewhere that serves `.br` files, for example Cloudflare Pages or R2 with `Content-Encoding: br` set on upload. That is a hosting change, not a setting.

### 4. HTML stays short-lived

Leave HTML (`/`, `/repo/…`) at the origin's `max-age=600`, or shorter. A deploy changes which hashed chunks the HTML names. Old chunks stay available for two generations (`pages.yml` merges them), so a stale HTML page still loads.

### 5. Headers the app needs (already provided)

The app sets its CSP in a `<meta>` tag. COOP/COEP are not required on Pages: the SDK runs without threads.

If a future host sets headers, set these on every response:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless`

`next.config.js` `headers()` does the same in development.

## Other static hosts (IPFS gateways, S3, nginx)

The same rules apply:
- `/_next/static/**` → `Cache-Control: public, max-age=31536000, immutable`
- brotli (or gzip) for `.js`, `.css`, `.wasm`
- `application/wasm` as the wasm MIME type, which the browser needs to compile while streaming
- HTML short-lived

For nginx:

```nginx
location /_next/static/ {
  add_header Cache-Control "public, max-age=31536000, immutable";
  brotli_static on;   # ngx_brotli; serve .br files built next to the originals
  gzip_static on;
}
types { application/wasm wasm; }
```

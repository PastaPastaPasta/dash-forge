# Deep links answer 200

A Cloudflare Worker for the hosted sites. GitHub Pages answers a repo's short URL (`/owner/repo/…`) with `404.html` and status 404. This Worker sends it with status 200 instead, and passes everything else through unchanged. Why and how to deploy it: [docs/hosting.md, "Deep links answer 200"](../../docs/hosting.md#9-deep-links-answer-200).

`worker.js` is generated: edit `forge-web/lib/deep-link-worker.ts` (or the shim in `forge-web/lib/short-url.ts`), then run `UPDATE_DEEP_LINK_WORKER=1 npx vitest run lib/deep-link-worker.test.ts` in `forge-web`.

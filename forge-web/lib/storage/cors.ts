/**
 * The exact CORS configuration to paste for each provider (`ux-dx-spec.md` §3.1 step 3),
 * prefilled with the bucket and this app's origin.
 *
 * Two rules, as in forge-core `storage/cors.rs` plus the write half the browser needs:
 *  - **read**, any origin: `GET`/`HEAD` with `Range`, exposing `Content-Range`, `Content-Length`
 *    and `ETag`. The objects are public; every Forge web app (and any mirror of it) reads them.
 *  - **write**, this app's origin only: `PUT`/`GET`/`HEAD`/`DELETE` with the SigV4 headers, so
 *    browser pushes and merges can upload. Listed header by header rather than `x-amz-*`,
 *    because not every provider accepts a wildcard there.
 */

import type { ProviderId } from './profiles'

/** The headers a signed browser request sends that are not CORS-safelisted. */
export const SIGNED_HEADERS = ['authorization', 'content-type', 'range', 'x-amz-content-sha256', 'x-amz-date', 'x-amz-security-token'] as const
const EXPOSE = ['Content-Range', 'Content-Length', 'ETag'] as const

/** A fix: where to apply it, and the text to paste or run. */
export interface CorsFix {
  readonly where: string
  readonly text: string
}

function s3Rules(origin: string): unknown[] {
  return [
    { AllowedOrigins: ['*'], AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['Range'], ExposeHeaders: [...EXPOSE], MaxAgeSeconds: 86400 },
    { AllowedOrigins: [origin], AllowedMethods: ['PUT', 'GET', 'HEAD', 'DELETE'], AllowedHeaders: [...SIGNED_HEADERS], ExposeHeaders: [...EXPOSE], MaxAgeSeconds: 86400 },
  ]
}

/** The CORS fix for `provider`, prefilled with `bucket` and the app `origin`. */
export function corsFix(provider: ProviderId, bucket: string, origin: string): CorsFix {
  const b = bucket || '<bucket>'
  switch (provider) {
    case 'r2':
      return {
        where: `Cloudflare dashboard → R2 → ${b} → Settings → CORS Policy → Add CORS policy. Paste:`,
        text: JSON.stringify(s3Rules(origin), null, 2),
      }
    case 'aws':
      return {
        where: `Save as cors.json, then run: aws s3api put-bucket-cors --bucket ${b} --cors-configuration file://cors.json`,
        text: JSON.stringify({ CORSRules: s3Rules(origin) }, null, 2),
      }
    case 'b2':
      return {
        where: `Save as cors.json, then run: b2 bucket update --cors-rules "$(cat cors.json)" ${b} allPublic`,
        text: JSON.stringify(
          [
            { corsRuleName: 'dashForgeRead', allowedOrigins: ['*'], allowedOperations: ['s3_get', 's3_head', 'b2_download_file_by_name'], allowedHeaders: ['range'], exposeHeaders: EXPOSE.map((h) => h.toLowerCase()), maxAgeSeconds: 86400 },
            { corsRuleName: 'dashForgeWrite', allowedOrigins: [origin], allowedOperations: ['s3_put', 's3_get', 's3_head', 's3_delete'], allowedHeaders: [...SIGNED_HEADERS], exposeHeaders: EXPOSE.map((h) => h.toLowerCase()), maxAgeSeconds: 86400 },
          ],
          null,
          2,
        ),
      }
    case 'minio':
      return {
        where: 'MinIO answers CORS for every origin by default. If it was restricted, allow this app, then make the bucket publicly readable (not writable):',
        text: [`mc admin config set <alias> api cors_allow_origin="${origin}"`, 'mc admin service restart <alias>', `mc anonymous set download <alias>/${b}`].join('\n'),
      }
    case 'kubo':
    case 'pinning':
      return {
        where: 'kubo refuses RPC calls from web pages unless their origin is allowed. Run, then restart the daemon:',
        text: kuboCorsLines(origin),
      }
    case 'platform':
      return { where: 'Dash Platform needs no CORS setup.', text: '' }
  }
}

/** `ipfs config` lines allowing this app to call the RPC API and read the gateway. */
export function kuboCorsLines(origin: string): string {
  return [
    `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["${origin}"]'`,
    `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["POST"]'`,
    `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Headers '["Authorization"]'`,
    `ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Origin '["*"]'`,
    `ipfs config --json Gateway.HTTPHeaders.Access-Control-Expose-Headers '["Content-Range", "Content-Length", "ETag"]'`,
  ].join('\n')
}

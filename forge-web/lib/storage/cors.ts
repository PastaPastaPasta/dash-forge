/**
 * The exact CORS configuration to paste for each provider (`ux-dx-spec.md` §3.1 step 3),
 * prefilled with the bucket and this app's origin.
 *
 * Two rules, the same as forge-core `storage/cors.rs` `s3_cors_rules`:
 *  - **read**, any origin: `GET`/`HEAD` with `range`, exposing `Content-Range`, `Content-Length`
 *    and `ETag`. The objects are public; every Forge web app (and any mirror of it) reads them.
 *  - **write**, this app's origin only: `PUT`/`GET`/`HEAD`/`DELETE` with the SigV4 headers, so
 *    browser pushes and merges can upload. Listed header by header rather than `x-amz-*`,
 *    because not every provider accepts a wildcard there.
 *
 * Header names are lowercase: browsers send `Access-Control-Request-Headers` lowercased, and
 * some stores match `AllowedHeaders` case-sensitively (Garage refuses a `range` preflight for
 * `["Range"]`).
 */

import { FORGE_RPC_PATHS } from './ipfs'
import type { ProviderId } from './profiles'

/** The headers a signed browser request sends that are not CORS-safelisted. */
const SIGNED_HEADERS = ['authorization', 'content-type', 'range', 'x-amz-content-sha256', 'x-amz-date', 'x-amz-security-token'] as const
const EXPOSE = ['Content-Range', 'Content-Length', 'ETag'] as const
const EXPOSE_LOWER = EXPOSE.map((h) => h.toLowerCase())

/** A fix: where to apply it, and the text to paste or run. */
export interface CorsFix {
  readonly where: string
  readonly text: string
}

function s3Rules(origin: string): unknown[] {
  return [
    { AllowedOrigins: ['*'], AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['range'], ExposeHeaders: [...EXPOSE], MaxAgeSeconds: 86400 },
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
        where: `If the endpoint is not the bucket's own region, AWS answers with a redirect the browser cannot follow, which looks like a CORS failure: check the endpoint first (https://s3.<region>.amazonaws.com). Then save as cors.json and run: aws s3api put-bucket-cors --bucket ${b} --cors-configuration file://cors.json`,
        text: JSON.stringify({ CORSRules: s3Rules(origin) }, null, 2),
      }
    case 'b2':
      return {
        where: `Save as cors.json, then run: b2 bucket update --cors-rules "$(cat cors.json)" ${b} allPublic`,
        text: JSON.stringify(
          [
            { corsRuleName: 'dashForgeRead', allowedOrigins: ['*'], allowedOperations: ['s3_get', 's3_head', 'b2_download_file_by_name'], allowedHeaders: ['range'], exposeHeaders: EXPOSE_LOWER, maxAgeSeconds: 86400 },
            { corsRuleName: 'dashForgeWrite', allowedOrigins: [origin], allowedOperations: ['s3_put', 's3_get', 's3_head', 's3_delete'], allowedHeaders: [...SIGNED_HEADERS], exposeHeaders: EXPOSE_LOWER, maxAgeSeconds: 86400 },
          ],
          null,
          2,
        ),
      }
    case 'minio':
      return {
        where: `Garage, RustFS and most S3-compatible stores take this document through the S3 API: save it as cors.json and run aws --endpoint-url <your endpoint> s3api put-bucket-cors --bucket ${b} --cors-configuration file://cors.json (Garage applies it to its web endpoint too). MinIO community edition (archived) has no per-bucket CORS: it answers every origin unless it was restricted; restore that with mc admin config set <alias> api cors_allow_origin="*", then make the bucket publicly readable (not writable) with mc anonymous set download <alias>/${b}.`,
        text: JSON.stringify({ CORSRules: s3Rules(origin) }, null, 2),
      }
    case 'kubo':
    case 'pinning':
      return {
        where:
          'kubo refuses RPC calls from web pages unless their origin is allowed. The RPC API is the node’s admin interface, so give this app a token limited to what Forge calls (below), put that token in the profile’s API Authorization field, and add this origin to the allowed list. Run, then restart the daemon:',
        text: kuboCorsLines(origin),
      }
    case 'platform':
      return { where: 'Dash Platform needs no CORS setup.', text: '' }
  }
}

/**
 * Shell lines that (1) create a kubo API token limited to the paths Forge calls, (2) ADD this
 * app's origin to the RPC API's allowed origins without dropping existing ones (IPFS WebUI's,
 * for instance), and (3) let any origin read the gateway. `jq` merges the list.
 */
export function kuboCorsLines(origin: string): string {
  const paths = JSON.stringify(FORGE_RPC_PATHS)
  return [
    '# 1. Once any API.Authorizations entry exists, kubo refuses EVERY RPC call without a token,',
    '#    your own `ipfs` commands and IPFS WebUI included. So first an owner token with full',
    '#    access (keep it; use it as `ipfs --api-auth bearer:$OWNER <cmd>`), then one for this app',
    '#    that can only add, pin-check, unpin and identify:',
    `OWNER=$(openssl rand -hex 24); TOKEN=$(openssl rand -hex 24)`,
    `ipfs config --json API.Authorizations.owner "{\\"AuthSecret\\": \\"bearer:$OWNER\\", \\"AllowedPaths\\": [\\"/api/v0\\"]}"`,
    `ipfs config --json API.Authorizations.dash-forge "{\\"AuthSecret\\": \\"bearer:$TOKEN\\", \\"AllowedPaths\\": ${paths.replace(/"/g, '\\"')}}"`,
    'echo "Owner token (for your own ipfs CLI): bearer:$OWNER"',
    'echo "API Authorization for the Forge profile: Bearer $TOKEN"',
    '# 2. Allow this app, keeping the origins already allowed (none on a fresh node):',
    `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin "$( (ipfs config API.HTTPHeaders.Access-Control-Allow-Origin 2>/dev/null || echo null) | jq -c '(. // []) + ["${origin}"] | unique')"`,
    `#    (no jq? ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["${origin}"]' replaces the list instead)`,
    `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["POST"]'`,
    `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Headers '["Authorization"]'`,
    '# 3. Let any origin read the gateway (the content is public):',
    `ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Origin '["*"]'`,
    `ipfs config --json Gateway.HTTPHeaders.Access-Control-Expose-Headers '["Content-Range", "Content-Length", "ETag"]'`,
  ].join('\n')
}

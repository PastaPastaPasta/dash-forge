/**
 * The survivability drill's storage fixture (roadmap Phase 1, launch criterion 3): a real S3
 * store (the RustFS fixture, standing in for MinIO) and a real kubo node, as
 * `infra/docker-compose.yml` runs them and `.github/workflows/survivability.yml` starts them as
 * service containers. Shared by the browse drill (`lib/view/survivability.drill.test.ts`) and
 * the web-host spec (`e2e-drill/web-host.spec.ts`).
 *
 * Opt-in (`FORGE_DRILL=1`): the drill deletes buckets and stops the kubo container. Endpoints
 * default to the compose file's; `FORGE_DRILL_S3`, `FORGE_DRILL_KUBO_API`,
 * `FORGE_DRILL_GATEWAY` and `FORGE_DRILL_KUBO_CONTAINER` override them.
 */

import { execFileSync } from 'node:child_process'

import { EMPTY_PAYLOAD_SHA256, amzDate, canonicalQuery, sha256Hex, signRequest } from '../lib/storage/sigv4'

const env = (k: string, d: string): string => process.env[k] || d

/** Whether the drill runs at all. */
export const DRILL_ON = process.env.FORGE_DRILL === '1'

export const S3 = env('FORGE_DRILL_S3', 'http://127.0.0.1:9000')
export const KUBO_API = env('FORGE_DRILL_KUBO_API', 'http://127.0.0.1:5001')
export const GATEWAY = env('FORGE_DRILL_GATEWAY', 'http://127.0.0.1:8081')
export const KUBO_CONTAINER = env('FORGE_DRILL_KUBO_CONTAINER', 'forge-e2e-kubo')

/** The fixture's root key (kept from the MinIO fixture RustFS replaced). */
const KEY = 'minioadmin'

/** A SigV4-signed request to the S3 fixture's API (bucket administration). */
export async function s3Admin(
  method: 'PUT' | 'DELETE' | 'GET',
  path: string,
  query: readonly (readonly [string, string])[] = [],
  body: Uint8Array = new Uint8Array(),
): Promise<Response> {
  const url = new URL(`${S3}${path}`)
  const payloadHash = body.length === 0 ? EMPTY_PAYLOAD_SHA256 : await sha256Hex(body)
  const headers = await signRequest(
    { method, host: url.host, canonicalUri: url.pathname, query, payloadHash, region: 'us-east-1', service: 's3', contentSha256Header: true },
    { accessKeyId: KEY, secretAccessKey: KEY },
    amzDate(),
  )
  const qs = query.length > 0 ? `?${canonicalQuery(query)}` : ''
  return fetch(`${S3}${url.pathname}${qs}`, {
    method,
    headers: new Headers(headers),
    ...(body.length > 0 ? { body: new Blob([body as BlobPart]) } : {}),
  })
}

async function ok(what: string, r: Promise<Response>): Promise<void> {
  const resp = await r
  if (!resp.ok) throw new Error(`${what}: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`)
}

/** A new bucket readable by anyone (a public BYO bucket), named after `scenario`. */
export async function createBucket(scenario: string, cors?: readonly CorsRule[]): Promise<string> {
  const name = `drill-web-${scenario}-${Date.now()}`
  await ok(`create bucket ${name}`, s3Admin('PUT', `/${name}`))
  const policy = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${name}/*`] }],
  }
  await ok('bucket policy', s3Admin('PUT', `/${name}`, [['policy', '']], new TextEncoder().encode(JSON.stringify(policy))))
  if (cors !== undefined) await ok('bucket CORS', s3Admin('PUT', `/${name}`, [['cors', '']], new TextEncoder().encode(corsXml(cors))))
  return name
}

/** Delete `keys`, then the bucket. */
export async function deleteBucket(name: string, keys: readonly string[]): Promise<void> {
  for (const key of keys) await ok(`delete ${key}`, s3Admin('DELETE', `/${name}/${key}`))
  await ok(`delete bucket ${name}`, s3Admin('DELETE', `/${name}`))
}

/** One S3 CORS rule, as the JSON a provider's console takes (`lib/storage/cors.ts`). */
export interface CorsRule {
  readonly AllowedOrigins: readonly string[]
  readonly AllowedMethods: readonly string[]
  readonly AllowedHeaders?: readonly string[]
  readonly ExposeHeaders?: readonly string[]
  readonly MaxAgeSeconds?: number
}

/** The S3 API's XML for `rules` (what `aws s3api put-bucket-cors` sends for the JSON). */
function corsXml(rules: readonly CorsRule[]): string {
  const list = (tag: string, values: readonly string[] | undefined): string => (values ?? []).map((v) => `<${tag}>${v}</${tag}>`).join('')
  const body = rules
    .map(
      (r) =>
        `<CORSRule>${list('AllowedOrigin', r.AllowedOrigins)}${list('AllowedMethod', r.AllowedMethods)}${list('AllowedHeader', r.AllowedHeaders)}${list('ExposeHeader', r.ExposeHeaders)}${
          r.MaxAgeSeconds === undefined ? '' : `<MaxAgeSeconds>${r.MaxAgeSeconds}</MaxAgeSeconds>`
        }</CORSRule>`,
    )
    .join('')
  return `<CORSConfiguration>${body}</CORSConfiguration>`
}

/** Run `docker args…`; its trimmed stdout. */
export function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim()
}

/** Whether `url` answers 2xx within a few seconds. */
export async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).ok
  } catch {
    return false
  }
}

/** Wait until `url` answers (`up`) or stops answering. */
export async function waitFor(url: string, up: boolean, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while ((await answers(url)) !== up) {
    if (Date.now() > until) throw new Error(`${url} did not ${up ? 'come up' : 'go down'} within ${timeoutMs / 1000} s`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** The gateway's liveness URL (the identity CID: served without any content lookup). */
export const GATEWAY_PROBE = `${GATEWAY}/ipfs/bafkqaaa`

/** Stop the kubo container (gateway and API); the returned function starts it again. */
export async function stopKubo(): Promise<() => Promise<void>> {
  docker('stop', '-t', '2', KUBO_CONTAINER)
  await waitFor(GATEWAY_PROBE, false)
  return async () => {
    docker('start', KUBO_CONTAINER)
    await waitFor(GATEWAY_PROBE, true)
  }
}

/** Fail unless the fixture answers (the drill never passes by skipping once asked for). */
export async function requireFixture(): Promise<void> {
  for (const url of [`${S3}/health/ready`, GATEWAY_PROBE]) {
    if (!(await answers(url))) throw new Error(`the survivability drill needs ${url} (make infra-up)`)
  }
}

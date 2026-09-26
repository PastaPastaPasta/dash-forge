/**
 * A minimal S3 client for the browser: signed PUT / GET / HEAD / DELETE of one object, and
 * anonymous reads through the bucket's public URL. Port of the request shapes of forge-core
 * `backends/s3.rs` (path-style or virtual-hosted URLs, the key percent-encoded once, the body
 * hash in `x-amz-content-sha256` so the store verifies the upload server-side).
 *
 * Browser specifics: `fetch` sets `Host` from the URL, so the signed host must be exactly the
 * URL's; `redirect: 'error'` so a signed request is never replayed to another host; and every
 * header the request carries beyond the CORS-safelisted ones (authorization, x-amz-*) needs the
 * bucket's CORS rules to allow it, which the wizard tests before a push depends on it.
 */

import { EMPTY_PAYLOAD_SHA256, amzDate, keyHasBadSegment, sha256Hex, signRequest, uriEncode } from './sigv4'
import type { ProfilePublic, ProfileSecrets } from './profiles'

export type S3Settings = Extract<ProfilePublic, { kind: 's3' }>

/** How long one S3 request may take before it is abandoned. */
export const S3_TIMEOUT_MS = 60_000

/** An S3 request that failed: the operation, the HTTP status (0: no response) and why. */
export class S3Error extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'S3Error'
  }
}

/** The API URL of `key` (path-style: `endpoint/bucket/key`; else `bucket.host/key`). */
export function objectUrl(s: S3Settings, key: string): URL {
  if (keyHasBadSegment(key)) throw new S3Error('url', 0, `object key ${JSON.stringify(key)} has an empty, '.' or '..' segment`)
  const endpoint = new URL(s.endpoint)
  const encoded = uriEncode(key, true)
  const url = s.pathStyle
    ? new URL(`${endpoint.origin}/${s.bucket}/${encoded}`)
    : new URL(`${endpoint.protocol}//${s.bucket}.${endpoint.host}/${encoded}`)
  // What is signed must be what is sent: the parser must keep our encoding verbatim.
  const intended = s.pathStyle ? `/${s.bucket}/${encoded}` : `/${encoded}`
  if (url.pathname !== intended) throw new S3Error('url', 0, 'the request path would differ from the signed one; refusing to sign it')
  return url
}

/** The anonymous public URL of `key`. */
export function publicObjectUrl(s: S3Settings, key: string): string {
  return `${s.publicUrl.replace(/\/+$/, '')}/${uriEncode(key, true)}`
}

/** The `s3://bucket/key` locator a manifest records next to the public URL (CLI read path). */
export function s3Uri(s: S3Settings, key: string): string {
  return `s3://${s.bucket}/${key}`
}

async function send(
  s: S3Settings,
  secrets: ProfileSecrets,
  op: string,
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
  key: string,
  opts: { body?: Uint8Array; contentType?: string; range?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  const url = objectUrl(s, key)
  const payloadHash = opts.body ? await sha256Hex(opts.body) : EMPTY_PAYLOAD_SHA256
  const extra: [string, string][] = []
  if (opts.contentType) extra.push(['content-type', opts.contentType])
  if (opts.range) extra.push(['range', opts.range])
  const headers = new Headers(extra)
  if (!secrets.accessKeyId || !secrets.secretAccessKey) throw new S3Error(op, 0, 'no credentials: add the access key id and secret')
  const signed = await signRequest(
    {
      method,
      host: url.host,
      canonicalUri: url.pathname,
      headers: extra,
      payloadHash,
      region: s.region,
      service: 's3',
      contentSha256Header: true,
    },
    {
      accessKeyId: secrets.accessKeyId,
      secretAccessKey: secrets.secretAccessKey,
      ...(secrets.sessionToken ? { sessionToken: secrets.sessionToken } : {}),
    },
    amzDate(),
  )
  for (const [k, v] of signed) headers.set(k, v)
  const timeout = AbortSignal.timeout(S3_TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  try {
    return await fetch(url, {
      method,
      headers,
      ...(opts.body ? { body: new Uint8Array(opts.body) } : {}),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal,
    })
  } catch (e) {
    // A CORS refusal and a network failure look the same to a page: say which is likely.
    const why = timeout.aborted ? `no answer within ${S3_TIMEOUT_MS / 1000}s` : 'the request was blocked or the host is unreachable (a CORS rule missing for this origin, or the endpoint is down)'
    throw new S3Error(op, 0, `${op} ${url.host}: ${why}${e instanceof Error && !timeout.aborted ? ` (${e.message})` : ''}`)
  }
}

async function failed(op: string, resp: Response): Promise<S3Error> {
  let code = ''
  try {
    const text = (await resp.text()).slice(0, 2000)
    code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1] ?? ''
  } catch {
    /* body unreadable */
  }
  const hint =
    resp.status === 403
      ? ' — check the key, its bucket permissions, the region (R2 wants auto) and the clock'
      : resp.status === 404
        ? ' — check the bucket name and endpoint'
        : resp.status === 301 || resp.status === 307
          ? ' — the bucket lives in another region; set that endpoint'
          : ''
  return new S3Error(op, resp.status, `${op} failed: HTTP ${resp.status}${code ? ` ${code}` : ''}${hint}`)
}

/** Signed PUT of `bytes` at `key`. */
export async function putObject(s: S3Settings, secrets: ProfileSecrets, key: string, bytes: Uint8Array, contentType = 'application/octet-stream', signal?: AbortSignal): Promise<void> {
  const resp = await send(s, secrets, 'signed PUT', 'PUT', key, { body: bytes, contentType, ...(signal ? { signal } : {}) })
  if (!resp.ok) throw await failed('signed PUT', resp)
}

/** Signed GET of `key` (whole object, or a `Range`). */
export async function getObject(s: S3Settings, secrets: ProfileSecrets, key: string, range?: string, signal?: AbortSignal): Promise<Uint8Array> {
  const resp = await send(s, secrets, 'signed GET', 'GET', key, { ...(range ? { range } : {}), ...(signal ? { signal } : {}) })
  if (!resp.ok) throw await failed('signed GET', resp)
  return new Uint8Array(await resp.arrayBuffer())
}

/** Signed HEAD: the object's size, or null when it does not exist. */
export async function headObject(s: S3Settings, secrets: ProfileSecrets, key: string): Promise<number | null> {
  const resp = await send(s, secrets, 'signed HEAD', 'HEAD', key)
  if (resp.status === 404) return null
  if (!resp.ok) throw await failed('signed HEAD', resp)
  const len = Number(resp.headers.get('content-length'))
  return Number.isFinite(len) ? len : 0
}

/** Signed DELETE of `key` (idempotent: a missing object is fine). */
export async function deleteObject(s: S3Settings, secrets: ProfileSecrets, key: string): Promise<void> {
  const resp = await send(s, secrets, 'delete', 'DELETE', key)
  if (!resp.ok && resp.status !== 404) throw await failed('delete', resp)
}

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

import { EMPTY_PAYLOAD_SHA256, amzDate, keyHasBadSegment, plain, sha256Hex, signRequest, uriEncode } from './sigv4'
import type { ProfilePublic, ProfileSecrets } from './profiles'
import { TimeoutError, isHeaderSafe, timedFetch, type TimedResponse } from './util'

export type S3Settings = Extract<ProfilePublic, { kind: 's3' }>

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
  opts: { body?: Uint8Array; bodySha256?: string; contentType?: string; range?: string; signal?: AbortSignal | undefined } = {},
): Promise<TimedResponse> {
  const url = objectUrl(s, key)
  const payloadHash = opts.body ? opts.bodySha256 ?? (await sha256Hex(opts.body)) : EMPTY_PAYLOAD_SHA256
  const extra: [string, string][] = []
  if (opts.contentType) extra.push(['content-type', opts.contentType])
  if (opts.range) extra.push(['range', opts.range])
  if (!secrets.accessKeyId || !secrets.secretAccessKey) throw new S3Error(op, 0, 'no credentials: add the access key id and secret')
  // A header value fetch refuses would be quoted in its error: refuse it here, without echoing it.
  if (![secrets.accessKeyId, secrets.sessionToken ?? ''].every(isHeaderSafe)) {
    throw new S3Error(op, 0, 'the access key id or session token holds characters an HTTP header cannot carry; paste it again')
  }
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
  const headers = new Headers([...extra, ...signed])
  try {
    return await timedFetch(
      url,
      {
        method,
        headers,
        ...(opts.body ? { body: plain(opts.body) } : {}),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      },
      { uploadBytes: opts.body?.length ?? 0, signal: opts.signal },
    )
  } catch (e) {
    if (e instanceof TimeoutError) throw new S3Error(op, 0, `${op} ${url.host}: ${e.message}`)
    // A CORS refusal, a redirect (refused: a signed request is never replayed elsewhere) and a
    // network failure all look the same to a page; the probe tells them apart.
    throw new S3Error(op, 0, `${op} ${url.host}: the request was blocked, redirected or the host is unreachable`)
  }
}

async function failed(op: string, r: TimedResponse): Promise<S3Error> {
  const resp = r.resp
  let code = ''
  try {
    const text = (await r.text()).slice(0, 2000)
    code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1] ?? ''
  } catch {
    /* body unreadable */
  }
  return new S3Error(op, resp.status, `${op} failed: HTTP ${resp.status}${code ? ` ${code}` : ''}${statusHint(resp.status)}`)
}

/** What an S3 error status usually means, as a suffix for the message ('' when nothing useful). */
function statusHint(status: number): string {
  switch (status) {
    case 403:
      return ' — check the key, its bucket permissions, the region (R2 wants auto) and the clock'
    case 404:
      return ' — check the bucket name and endpoint'
    case 301:
    case 307:
      return ' — the bucket lives in another region; set that endpoint'
    default:
      return ''
  }
}

/**
 * An anonymous GET of `key` through the bucket's public URL (what every reader uses), whole or
 * a `Range`: the check that a copy is readable by anyone, not just by the credential holder.
 */
export async function getPublic(s: S3Settings, key: string, range?: string): Promise<{ status: number; bytes: Uint8Array; contentRange: string | null }> {
  const r = await timedFetch(publicObjectUrl(s, key), { credentials: 'omit', cache: 'no-store', ...(range ? { headers: { Range: range } } : {}) })
  return { status: r.resp.status, contentRange: r.resp.headers.get('content-range'), bytes: await r.bytes() }
}

/** Signed PUT of `bytes` at `key`. */
export async function putObject(
  s: S3Settings,
  secrets: ProfileSecrets,
  key: string,
  bytes: Uint8Array,
  contentType = 'application/octet-stream',
  opts: { readonly signal?: AbortSignal; readonly sha256Hex?: string } = {},
): Promise<void> {
  const r = await send(s, secrets, 'signed PUT', 'PUT', key, { body: bytes, contentType, signal: opts.signal, ...(opts.sha256Hex ? { bodySha256: opts.sha256Hex } : {}) })
  if (!r.resp.ok) throw await failed('signed PUT', r)
  await r.bytes()
}

/** Signed GET of `key` (whole object, or a `Range`). */
export async function getObject(s: S3Settings, secrets: ProfileSecrets, key: string, range?: string, signal?: AbortSignal): Promise<Uint8Array> {
  const r = await send(s, secrets, 'signed GET', 'GET', key, { range, signal })
  if (!r.resp.ok) throw await failed('signed GET', r)
  return r.bytes()
}

/** Signed HEAD: the object's size, or null when it does not exist. */
export async function headObject(s: S3Settings, secrets: ProfileSecrets, key: string): Promise<number | null> {
  const r = await send(s, secrets, 'signed HEAD', 'HEAD', key)
  if (!r.resp.ok && r.resp.status !== 404) throw await failed('signed HEAD', r)
  r.discard()
  if (r.resp.status === 404) return null
  const len = Number(r.resp.headers.get('content-length'))
  return Number.isFinite(len) ? len : 0
}

/** Signed DELETE of `key` (idempotent: a missing object is fine). */
export async function deleteObject(s: S3Settings, secrets: ProfileSecrets, key: string): Promise<void> {
  const r = await send(s, secrets, 'delete', 'DELETE', key)
  if (!r.resp.ok && r.resp.status !== 404) throw await failed('delete', r)
  r.discard()
}

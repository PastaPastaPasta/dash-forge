/**
 * AWS Signature Version 4, for S3-compatible buckets (R2, B2, AWS S3, MinIO), on WebCrypto.
 *
 * A port of forge-core `backends/sigv4.rs` and pinned by the same vectors: the AWS SigV4 test
 * suite and the worked examples in the S3 API reference (`sigv4.test.ts`). S3 canonicalization
 * differs from generic SigV4 in one way that matters: the object path is percent-encoded ONCE,
 * keeping `/`, and never normalized. A key with an empty, `.` or `..` segment is refused by the
 * caller, because `fetch` would normalize it after signing and address another object.
 *
 * The secret access key is imported into a non-extractable HMAC `CryptoKey` for the first step
 * of the key derivation and never formatted, logged or returned.
 */

/** SHA-256 of the empty string: the payload hash of a body-less request. */
export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const ALGORITHM = 'AWS4-HMAC-SHA256'
const enc = new TextEncoder()

/** The credentials a request is signed with. */
export interface SigningKeys {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
}

/** A signing timestamp in the two forms SigV4 uses. */
export interface AmzDate {
  /** `YYYYMMDD` (the credential-scope date). */
  readonly date: string
  /** `YYYYMMDDTHHMMSSZ` (the `x-amz-date` value). */
  readonly datetime: string
}

/** The UTC stamp of `ms` since the epoch. */
export function amzDate(ms: number = Date.now()): AmzDate {
  const iso = new Date(ms).toISOString() // 2013-05-24T00:00:00.000Z
  const datetime = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
  return { date: datetime.slice(0, 8), datetime }
}

/**
 * RFC 3986 percent-encoding as SigV4 specifies it: every byte except `A-Z a-z 0-9 - . _ ~`
 * becomes `%XX` (uppercase hex). With `keepSlash`, `/` stays (object-key paths).
 */
export function uriEncode(input: string, keepSlash: boolean): string {
  let out = ''
  for (const b of enc.encode(input)) {
    const c = String.fromCharCode(b)
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) out += c
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** Whether an object key has an empty, `.` or `..` segment (see the module doc). */
export function keyHasBadSegment(key: string): boolean {
  return key === '' || key.split('/').some((s) => s === '' || s === '.' || s === '..')
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of u) s += b.toString(16).padStart(2, '0')
  return s
}

/**
 * `b` as a view WebCrypto and fetch accept (backed by a plain ArrayBuffer), copying only when it
 * is not one already or is a window into a larger buffer: a large asset is not duplicated.
 */
export function plain(b: Uint8Array): Uint8Array<ArrayBuffer> {
  if (b.buffer instanceof ArrayBuffer && b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) return b as Uint8Array<ArrayBuffer>
  return new Uint8Array(b)
}
const buf = plain

/** Lowercase-hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', buf(bytes)))
}

async function hmac(key: Uint8Array | CryptoKey, data: string): Promise<Uint8Array> {
  const k =
    key instanceof Uint8Array
      ? await crypto.subtle.importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      : key
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)))
}

/** The derived signing key: `HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")`. */
async function signingKey(secret: string, date: string, region: string, service: string): Promise<Uint8Array> {
  const root = await crypto.subtle.importKey('raw', enc.encode(`AWS4${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const kDate = await hmac(root, date)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

/**
 * The canonical query: each key and value encoded (slashes too), sorted by encoded key then
 * value, joined with `&`. An empty value keeps its `=`.
 */
export function canonicalQuery(pairs: readonly (readonly [string, string])[]): string {
  return pairs
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

/**
 * Canonical headers and the `SignedHeaders` list: names lowercased, values trimmed with inner
 * whitespace runs collapsed, sorted by name (stable), duplicates joined by `,`.
 */
export function canonicalHeaders(headers: readonly (readonly [string, string])[]): { canonical: string; signed: string } {
  const norm = headers
    .map(([k, v]) => [k.trim().toLowerCase(), v.split(/\s+/).filter((p) => p !== '').join(' ')] as const)
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (a.h[0] < b.h[0] ? -1 : a.h[0] > b.h[0] ? 1 : a.i - b.i))
    .map((x) => x.h)
  const merged: [string, string][] = []
  for (const [k, v] of norm) {
    const last = merged[merged.length - 1]
    if (last && last[0] === k) last[1] = `${last[1]},${v}`
    else merged.push([k, v])
  }
  return {
    canonical: merged.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed: merged.map(([k]) => k).join(';'),
  }
}

/** One request to sign. */
export interface RequestToSign {
  readonly method: string
  /** The `Host` exactly as sent: `host`, or `host:port` for a non-default port. */
  readonly host: string
  /** The already-encoded path ({@link uriEncode} with `keepSlash`). */
  readonly canonicalUri: string
  readonly query?: readonly (readonly [string, string])[]
  /** Extra headers to sign (`range`, `content-type`); the signer adds its own. */
  readonly headers?: readonly (readonly [string, string])[]
  /** Hex SHA-256 of the body, or {@link EMPTY_PAYLOAD_SHA256}. */
  readonly payloadHash: string
  readonly region: string
  readonly service: string
  /** Send and sign `x-amz-content-sha256` (S3 requires it; the generic suite does not). */
  readonly contentSha256Header: boolean
}

/**
 * Sign `req`: the headers to add to the outgoing request, `authorization` last. `host` is
 * signed but not returned; `fetch` derives it from the URL, which must produce `req.host`.
 */
export async function signRequest(req: RequestToSign, keys: SigningKeys, when: AmzDate): Promise<[string, string][]> {
  const added: [string, string][] = [['x-amz-date', when.datetime]]
  if (req.contentSha256Header) added.push(['x-amz-content-sha256', req.payloadHash])
  if (keys.sessionToken) added.push(['x-amz-security-token', keys.sessionToken])
  const all: [string, string][] = [['host', req.host], ...(req.headers ?? []).map(([k, v]) => [k, v] as [string, string]), ...added]
  const { canonical, signed } = canonicalHeaders(all)
  const creq = [req.method, req.canonicalUri, canonicalQuery(req.query ?? []), canonical, signed, req.payloadHash].join('\n')
  const scope = `${when.date}/${req.region}/${req.service}/aws4_request`
  const sts = [ALGORITHM, when.datetime, scope, await sha256Hex(enc.encode(creq))].join('\n')
  const key = await signingKey(keys.secretAccessKey, when.date, req.region, req.service)
  const signature = hex(await hmac(key, sts))
  key.fill(0)
  added.push(['authorization', `${ALGORITHM} Credential=${keys.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`])
  return added
}

/**
 * Storage profiles in the browser (`ux-dx-spec.md` §3.1): the user's own buckets and IPFS
 * nodes, described with the same fields forge-core's `storage.toml` profiles use (camel-cased),
 * so a profile means the same thing on both sides.
 *
 * A profile splits into its public part (endpoint, bucket, public URL: the manifest publishes
 * some of it anyway) and its secrets (access key id, secret key, session token, pinning token,
 * kubo API auth). Only the public part is ever held in plaintext; the secrets are sealed in
 * the vault (`./store`). Nothing here is written on-chain except the public read URLs a push
 * records in its `packManifest`.
 */

import { z } from 'zod'

import { isPublicHttpsUrl } from '../net'
import { isHeaderSafe } from './util'

/** The kinds a profile can be (parity with forge-core `Profile`). */
export type ProfileKind = 's3' | 'ipfs-kubo' | 'ipfs-pinning-service' | 'platform'

/** The provider tiles of the wizard, in the order the spec lists them. */
export type ProviderId = 'r2' | 'b2' | 'aws' | 'minio' | 'kubo' | 'pinning' | 'platform'

/** A profile's public settings. */
export type ProfilePublic =
  | {
      readonly kind: 's3'
      readonly provider: 'r2' | 'b2' | 'aws' | 'minio'
      /** API endpoint origin (`https://<account>.r2.cloudflarestorage.com`). */
      readonly endpoint: string
      readonly region: string
      readonly bucket: string
      /** Path-style addressing (`endpoint/bucket/key`); R2, B2 and MinIO want it. */
      readonly pathStyle: boolean
      /** Public read origin; objects are read at `<publicUrl>/<key>`. */
      readonly publicUrl: string
      /** Key prefix inside the bucket (`forge/`), or ''. */
      readonly prefix: string
    }
  | {
      readonly kind: 'ipfs-kubo' | 'ipfs-pinning-service'
      readonly provider: 'kubo' | 'pinning'
      /** kubo RPC API origin (`http://127.0.0.1:5001`). */
      readonly api: string
      /** A gateway serving this node's content, for the verification re-read. */
      readonly gateway: string
      /** A public https gateway to record next to `ipfs://` (optional). */
      readonly publicGateway: string
      /** Pinning Service API base URL (pinning profiles only). */
      readonly pinningEndpoint: string
    }
  | { readonly kind: 'platform'; readonly provider: 'platform' }

/** The secrets a profile needs, sealed in the vault. */
export interface ProfileSecrets {
  readonly accessKeyId?: string
  readonly secretAccessKey?: string
  readonly sessionToken?: string
  /** The full `Authorization` header value for a kubo RPC API behind auth. */
  readonly apiAuth?: string
  /** A Pinning Service API access token. */
  readonly pinningToken?: string
}

/** A named profile: public settings plus (when unlocked) its secrets. */
export interface StorageProfile {
  readonly name: string
  readonly settings: ProfilePublic
  readonly secrets: ProfileSecrets
}

/** One provider tile: what the form asks for and where to find it. */
export interface ProviderPreset {
  readonly id: ProviderId
  readonly title: string
  readonly blurb: string
  readonly kind: ProfileKind
  /** Defaults the form starts from. */
  readonly defaults: Partial<Record<string, string | boolean>>
  /** Field → "where to find this" hint (with a console link where one exists). */
  readonly hints: Readonly<Record<string, { text: string; href?: string }>>
}

export const PROVIDERS: readonly ProviderPreset[] = [
  {
    id: 'r2',
    title: 'Cloudflare R2',
    blurb: 'recommended: free egress',
    kind: 's3',
    defaults: { region: 'auto', pathStyle: true, endpoint: 'https://<account-id>.r2.cloudflarestorage.com' },
    hints: {
      endpoint: { text: 'R2 → Overview → Account details → S3 API. Use the origin only, without the bucket.', href: 'https://dash.cloudflare.com/?to=/:account/r2/overview' },
      bucket: { text: 'R2 → Create bucket, e.g. forge.' },
      publicUrl: { text: 'Bucket → Settings → Public access: the r2.dev subdomain or your custom domain.' },
      accessKeyId: { text: 'R2 → Manage R2 API Tokens → Create API token (Object Read & Write, this bucket).', href: 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens' },
      region: { text: 'R2 always uses auto.' },
    },
  },
  {
    id: 'b2',
    title: 'Backblaze B2',
    blurb: 'cheap storage, S3 API',
    kind: 's3',
    defaults: { region: 'us-west-004', pathStyle: true, endpoint: 'https://s3.us-west-004.backblazeb2.com' },
    hints: {
      endpoint: { text: 'Buckets → your bucket → Endpoint. The region is its middle part.', href: 'https://secure.backblaze.com/b2_buckets.htm' },
      bucket: { text: 'Create the bucket with Files in bucket: Public.' },
      publicUrl: { text: 'https://s3.<region>.backblazeb2.com/<bucket> works for public buckets.' },
      accessKeyId: { text: 'App Keys → Add a New Application Key (Read and Write, this bucket). keyID is the access key id.', href: 'https://secure.backblaze.com/app_keys.htm' },
    },
  },
  {
    id: 'aws',
    title: 'AWS S3',
    blurb: 'the original',
    kind: 's3',
    defaults: { region: 'us-east-1', pathStyle: false, endpoint: 'https://s3.us-east-1.amazonaws.com' },
    hints: {
      endpoint: { text: 'https://s3.<region>.amazonaws.com for the bucket’s region.', href: 'https://s3.console.aws.amazon.com/s3/buckets' },
      bucket: { text: 'A bucket name with dots needs path-style addressing over TLS.' },
      publicUrl: { text: 'https://<bucket>.s3.<region>.amazonaws.com with a public-read bucket policy, or a CloudFront URL.' },
      accessKeyId: { text: 'IAM → a user or role limited to s3:PutObject, GetObject, DeleteObject on this bucket (s3:ListBucket is not needed).', href: 'https://console.aws.amazon.com/iam/home#/users' },
    },
  },
  {
    id: 'minio',
    title: 'Garage / RustFS / other S3',
    blurb: 'self-hosted or any S3-compatible store',
    kind: 's3',
    defaults: { region: 'us-east-1', pathStyle: true, endpoint: 'https://s3.example.org' },
    hints: {
      endpoint: { text: 'Your server’s S3 API origin (Garage: port 3900 and region garage; local test server: http://127.0.0.1:<port>).' },
      bucket: { text: 'The bucket, publicly readable but not writable (Garage: bucket website --allow; RustFS: an s3:GetObject bucket policy; MinIO: mc anonymous set download).' },
      publicUrl: { text: 'A stable public https name, recorded on chain forever. Usually <endpoint>/<bucket>; Garage: its web endpoint hostname, with no bucket path.' },
      accessKeyId: { text: 'An access key with read and write on the bucket.' },
    },
  },
  {
    id: 'kubo',
    title: 'IPFS (kubo)',
    blurb: 'your own IPFS node',
    kind: 'ipfs-kubo',
    defaults: { api: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080' },
    hints: {
      api: { text: 'The kubo RPC API (Addresses.API). The browser calls it directly, so it needs CORS for this origin.' },
      gateway: { text: 'A gateway serving this node’s content (Addresses.Gateway), used to re-read uploads.' },
      publicGateway: { text: 'Optional: a public https gateway for your node, recorded so browsers can fetch directly.' },
    },
  },
  {
    id: 'pinning',
    title: 'IPFS pinning service',
    blurb: 'kubo + a remote pin',
    kind: 'ipfs-pinning-service',
    defaults: { api: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080' },
    hints: {
      api: { text: 'The kubo node the content is added through; the service fetches it from there.' },
      pinningEndpoint: { text: 'The service’s Pinning Service API base URL (for example Pinata’s https://api.pinata.cloud/psa).', href: 'https://ipfs.github.io/pinning-services-api-spec/' },
      pinningToken: { text: 'An access token from the service’s dashboard.' },
    },
  },
  {
    id: 'platform',
    title: 'Dash Platform',
    blurb: 'permanent, ~0.28 DASH per MiB',
    kind: 'platform',
    defaults: {},
    hints: {},
  },
] as const

/** The preset for `id`. */
export function providerPreset(id: ProviderId): ProviderPreset {
  const p = PROVIDERS.find((x) => x.id === id)
  if (!p) throw new Error(`unknown provider ${id}`)
  return p
}

/** A valid profile name: it becomes part of a policy list, so no commas or whitespace. */
export function validProfileName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name)
}

/** The profile name reserved for on-chain `chunk` storage (forge-core `PLATFORM_PROFILE`). */
export const PLATFORM_PROFILE = 'platform'

/**
 * Where a URL is used:
 *  - `local`: only this browser talks to it (the S3 API endpoint, the kubo API and gateway).
 *    https, or plain http to this machine.
 *  - `published`: recorded on chain, read by everyone (the public URL, the public gateway).
 *    A public https URL only (`lib/net.ts`): a loopback or private address would be a copy only
 *    its uploader can read, and would point every reader's browser at their own local services.
 */
type UrlUse = 'local' | 'published'

/** An http(s) origin or URL with no userinfo, query or fragment (they could smuggle a token). */
function checkUrl(field: string, value: string, use: UrlUse, opts: { originOnly?: boolean } = {}): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `${field} is not a URL`
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `${field} must be an http(s) URL`
  if (url.username || url.password) return `${field} must not carry a user name or password`
  if (url.search || url.hash) return `${field} must not carry a query or fragment`
  if (opts.originOnly && url.pathname !== '/' && url.pathname !== '') return `${field} must be an origin (scheme://host[:port]) with no path`
  // A published URL may point at this machine while testing (a local MinIO): the test runs and
  // its public row fails with the reason ({@link publishProblem}); uploads refuse it.
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    return use === 'published'
      ? `${field} must be https: it is recorded on chain for everyone to read`
      : `${field} must be https (plain http is allowed only for a node on this machine, at 127.0.0.1 or localhost)`
  }
  return null
}

/** Whether a hostname is this machine (the only place a browser may reach over plain http). */
export function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

/** Why a profile's secrets cannot be used, or null (header values must be printable ASCII). */
function secretsProblem(secrets: ProfileSecrets): string | null {
  for (const [field, label] of [
    ['accessKeyId', 'The access key id'],
    ['sessionToken', 'The session token'],
    ['apiAuth', 'The API Authorization value'],
    ['pinningToken', 'The pinning token'],
  ] as const) {
    const v = secrets[field]
    if (v !== undefined && !isHeaderSafe(v)) return `${label} holds characters an HTTP header cannot carry (a stray line break or a non-ASCII character); paste it again`
  }
  return null
}

/** Why a profile is not usable, or null. Parity with forge-core `S3Config::validate`. */
export function profileProblem(p: StorageProfile): string | null {
  if (!validProfileName(p.name)) return "use a name of letters, digits, '.', '_' and '-' (max 64)"
  const s = p.settings
  if (s.kind === 'platform') return null
  if (p.name === PLATFORM_PROFILE) return `the name "${PLATFORM_PROFILE}" is reserved for Dash Platform storage`
  const secrets = secretsProblem(p.secrets)
  if (secrets) return secrets
  if (s.kind === 's3') {
    const e = checkUrl('the endpoint', s.endpoint, 'local', { originOnly: true })
    if (e) return e
    if (!BUCKET.test(s.bucket)) return "the bucket name must be lowercase letters, digits, '-', '.', '_'"
    const host = new URL(s.endpoint).hostname
    if (!s.pathStyle && (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('['))) return 'an IP-address endpoint needs path-style addressing'
    if (!s.pathStyle && s.bucket.includes('.') && s.endpoint.startsWith('https:')) return "a bucket name with '.' breaks TLS for virtual-hosted addressing; use path-style"
    const prefix = s.prefix.replace(/\/+$/, '')
    if (prefix !== '' && prefix.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return "the prefix has an empty, '.' or '..' segment"
    if (s.publicUrl === '') return 'a public URL is needed: browsers read packs anonymously from it'
    const pu = checkUrl('the public URL', s.publicUrl, 'published')
    if (pu) return pu
    if (!p.secrets.accessKeyId || !p.secrets.secretAccessKey) return 'an access key id and secret are needed to sign uploads'
    return null
  }
  const api = checkUrl('the kubo API', s.api, 'local', { originOnly: true })
  if (api) return api
  if (s.gateway !== '') {
    const gw = checkUrl('the gateway', s.gateway, 'local', { originOnly: true })
    if (gw) return gw
    if (new URL(s.gateway).hostname === 'localhost') {
      return 'use http://127.0.0.1:<port> for a local gateway: kubo redirects localhost to <cid>.ipfs.localhost subdomains, which the browser blocks'
    }
  }
  if (s.publicGateway !== '') {
    const pg = checkUrl('the public gateway', s.publicGateway, 'published', { originOnly: true })
    if (pg) return pg
  }
  if (s.kind === 'ipfs-pinning-service') {
    const pe = checkUrl('the pinning endpoint', s.pinningEndpoint, 'local')
    if (pe) return pe
    if (!p.secrets.pinningToken) return 'the pinning service needs an access token'
  }
  return null
}

const BUCKET = /^[a-z0-9._-]{1,63}$/

/**
 * Why this profile's published addresses (the S3 public URL, the IPFS public gateway) cannot
 * be recorded on chain, or null. They are what every reader fetches, so they must be public
 * https: an address on this machine or a private network works only for its uploader, and would
 * point other readers' browsers at their own local services.
 */
export function publishProblem(p: StorageProfile): string | null {
  const s = p.settings
  const published = s.kind === 's3' ? s.publicUrl : s.kind === 'platform' ? '' : s.publicGateway
  if (published === '' || isPublicHttpsUrl(published)) return null
  let host = published
  try {
    host = new URL(published).host
  } catch {
    /* keep the raw value */
  }
  return `${host} is only reachable from this machine or its network, so other people cannot read what is stored there. The public address is recorded on chain for everyone: use a public https URL (a bucket domain, a CDN, or a tunnel).`
}

/** The key prefix normalized: '' or ending in exactly one `/` (parity with forge-core). */
export function normalizedPrefix(prefix: string): string {
  const p = prefix.replace(/^\/+|\/+$/g, '')
  return p === '' ? '' : `${p}/`
}

/** The content-addressed object key of an artifact (`packs/<sha256>.pack`, as the CLI writes). */
export function artifactKey(settings: Extract<ProfilePublic, { kind: 's3' }>, sha256Hex: string): string {
  return `${normalizedPrefix(settings.prefix)}packs/${sha256Hex}.pack`
}

// ---------------------------------------------------------------------------
// Persisted shapes (zod: what comes back from IndexedDB is parsed, not cast)
// ---------------------------------------------------------------------------

const httpString = z.string().max(300)

const s3Schema = z
  .object({
    kind: z.literal('s3'),
    provider: z.enum(['r2', 'b2', 'aws', 'minio']),
    endpoint: httpString,
    region: z.string().regex(/^[a-z0-9-]{1,64}$/),
    bucket: z.string().regex(BUCKET),
    pathStyle: z.boolean(),
    publicUrl: httpString,
    prefix: z.string().max(200),
  })
  .strict()

const ipfsSchema = z
  .object({
    kind: z.enum(['ipfs-kubo', 'ipfs-pinning-service']),
    provider: z.enum(['kubo', 'pinning']),
    api: httpString,
    gateway: httpString,
    publicGateway: httpString,
    pinningEndpoint: httpString,
  })
  .strict()
  // The kind and the tile must agree: a kubo tile is never a pinning profile, and back.
  .refine((v) => (v.kind === 'ipfs-kubo') === (v.provider === 'kubo'), 'the IPFS kind and provider disagree')

const platformSchema = z.object({ kind: z.literal('platform'), provider: z.literal('platform') }).strict()

export const profilePublicSchema = z.union([s3Schema, ipfsSchema, platformSchema])

const headerValue = (max: number) => z.string().max(max).refine(isHeaderSafe).optional()

export const profileSecretsSchema = z
  .object({
    accessKeyId: headerValue(256),
    secretAccessKey: z.string().max(512).optional(),
    sessionToken: headerValue(4096),
    apiAuth: headerValue(1024),
    pinningToken: headerValue(4096),
  })
  .strict()

/** A repo's (or the default) browser-push storage policy. */
export interface StoragePolicy {
  /** Profile names, in order. Empty: no storage configured. */
  readonly targets: readonly string[]
  /** Copies that must confirm (1..targets). */
  readonly replicas: number
  /** Store on Platform when the targets cannot confirm `replicas` (asks, with the price, first). */
  readonly platformFallback: boolean
}

export const policySchema = z.object({
  targets: z.array(z.string().max(64)).max(8),
  replicas: z.number().int().min(1).max(8),
  platformFallback: z.boolean(),
})

/** The replication choices of the wizard (§3.1 step 4). */
export type ReplicationChoice = 'one' | 'all' | 'fallback'

/** A policy for `targets` under a replication choice. */
export function policyFor(targets: readonly string[], choice: ReplicationChoice): StoragePolicy {
  return {
    targets: [...targets],
    replicas: choice === 'all' ? Math.max(1, targets.length) : 1,
    platformFallback: choice === 'fallback',
  }
}

/** `policy` with the profile `from` renamed to `to` (a renamed profile keeps its place). */
export function renameInPolicy(policy: StoragePolicy, from: string, to: string): StoragePolicy {
  return { ...policy, targets: policy.targets.map((t) => (t === from ? to : t)) }
}

/** Which replication choice a policy corresponds to (for the radio). */
export function choiceOf(policy: StoragePolicy): ReplicationChoice {
  if (policy.platformFallback) return 'fallback'
  return policy.replicas > 1 && policy.replicas >= policy.targets.length ? 'all' : 'one'
}

/**
 * The optional forge-gateway (`docs/hosting/forge-gateway.md`): a read-only plain-git mirror of
 * public repositories, so `git clone https://…` works without git-remote-dash. Configured per
 * build with `NEXT_PUBLIC_GATEWAY_URL` (and `NEXT_PUBLIC_GATEWAY_LABEL`, default "dashhq
 * gateway"); with no URL the clone box shows no HTTPS row.
 *
 * A gateway is a hint, never an authority: git objects are content-addressed, so what a reader
 * trusts it for is which tips it serves and how fresh they are. {@link verifyGateway} checks that
 * in the browser: it reads the refs the gateway actually serves (`info/refs`, the smart-HTTP ref
 * advertisement) and its `forge-manifest.json` (the Platform time its snapshot reflects), and
 * compares them with the refs this page proved from Platform. `dg verify-mirror` is the full
 * check (it also knows every tip a ref ever had).
 */

/** A configured gateway. */
export interface GatewayConfig {
  /** The base URL, no trailing slash. */
  readonly url: string
  /** Who runs it, as the clone box names it ("via dashhq gateway"). */
  readonly label: string
}

/** The gateway `env` configures, or `null` (none, or not an http(s) URL). */
export function gatewayConfig(env: { readonly url?: string; readonly label?: string }): GatewayConfig | null {
  const raw = env.url?.trim() ?? ''
  if (raw === '') return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') return null
  const label = env.label?.trim()
  return { url: `${u.origin}${u.pathname}`.replace(/\/+$/, ''), label: label !== undefined && label !== '' ? label : 'dashhq gateway' }
}

// `process.env.NEXT_PUBLIC_*` must be written out literally: Next inlines each at build time.
/** This build's gateway, if any. */
export const GATEWAY: GatewayConfig | null = gatewayConfig({
  url: process.env.NEXT_PUBLIC_GATEWAY_URL,
  label: process.env.NEXT_PUBLIC_GATEWAY_LABEL,
})

/** `https://<gateway>/<owner>/<name>.git`. */
export function gatewayCloneUrl(g: GatewayConfig, owner: string, name: string): string {
  return `${g.url}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`
}

/**
 * The refs a smart-HTTP ref advertisement (`info/refs?service=git-upload-pack`, protocol v0)
 * names, by name: `HEAD` and peeled tags (`^{}`) are left out, as Platform records neither.
 */
export function parseAdvertisement(body: Uint8Array): Map<string, string> {
  const dec = new TextDecoder()
  const refs = new Map<string, string>()
  let i = 0
  while (i + 4 <= body.length) {
    const hex = dec.decode(body.subarray(i, i + 4))
    const len = /^[0-9a-f]{4}$/i.test(hex) ? parseInt(hex, 16) : NaN
    if (Number.isNaN(len) || (len > 0 && len < 4) || i + Math.max(len, 4) > body.length) throw new Error('not a git ref advertisement')
    if (len === 0) {
      i += 4
      continue
    }
    const line = dec.decode(body.subarray(i + 4, i + len)).replace(/\n$/, '')
    i += len
    if (line.startsWith('#')) continue
    const [main] = line.split('\0')
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(main ?? '')
    if (m === null) continue
    const [, oid, name] = m
    if (oid === undefined || name === undefined || name === 'HEAD' || name.endsWith('^{}')) continue
    refs.set(name, oid)
  }
  return refs
}

/** A ref as this page proved it from Platform. */
export interface ProvedRef {
  readonly name: string
  readonly oid: string
  /** When its tip was set (ms), when known. */
  readonly changedAt: number | null
  /**
   * Every tip a valid update of this ref ever set (`mergeBaseTips(…).historical`): what an
   * older snapshot can serve. A served oid outside it is a mismatch, whatever the manifest says.
   */
  readonly tipsEver: readonly string[]
}

export type MirrorVerdict = 'match' | 'stale' | 'mismatch'

export interface MirrorRefCheck {
  readonly name: string
  readonly served: string | null
  readonly proved: string | null
  readonly verdict: MirrorVerdict
  readonly why: string
}

const RANK: Record<MirrorVerdict, number> = { match: 0, stale: 1, mismatch: 2 }

/**
 * Compare what a mirror serves with the proved refs. `asOfMs` is the Platform time its manifest
 * says its snapshot reflects (`null`: no manifest). A served tip is only ever `stale` when it is
 * one the ref validly had ({@link ProvedRef.tipsEver}): the manifest is the mirror's own claim,
 * so it can excuse lag, never a forged tip. Only refs `inScope` are judged (this page proves
 * branches and tags). Parity: forge-core `mirror::compare`.
 */
export function compareMirror(
  served: ReadonlyMap<string, string>,
  proved: readonly ProvedRef[],
  asOfMs: number | null,
  inScope: (name: string) => boolean,
): { verdict: MirrorVerdict; refs: MirrorRefCheck[] } {
  const byName = new Map(proved.map((p) => [p.name, p]))
  const names = [...new Set([...[...served.keys()].filter(inScope), ...proved.map((p) => p.name)])].sort()
  const movedSince = (p: ProvedRef): boolean => asOfMs === null || p.changedAt === null || p.changedAt > asOfMs
  const refs = names.map((name): MirrorRefCheck => {
    const s = served.get(name) ?? null
    const p = byName.get(name)
    const proved = p?.oid ?? null
    if (s !== null && s === proved) return { name, served: s, proved, verdict: 'match', why: 'the proved tip' }
    if (s !== null && p !== undefined) {
      if (!p.tipsEver.includes(s)) return { name, served: s, proved, verdict: 'mismatch', why: 'a tip no valid update of this ref ever set' }
      return movedSince(p)
        ? { name, served: s, proved, verdict: 'stale', why: 'an earlier tip; the ref moved after the mirror’s snapshot' }
        : { name, served: s, proved, verdict: 'mismatch', why: 'an earlier tip, though the mirror’s snapshot is newer than the ref' }
    }
    if (s !== null) return { name, served: s, proved, verdict: 'mismatch', why: 'not a ref of this repository on Platform' }
    return p !== undefined && movedSince(p)
      ? { name, served: s, proved, verdict: 'stale', why: 'not mirrored yet' }
      : { name, served: s, proved, verdict: 'mismatch', why: 'omitted, though the mirror’s snapshot is newer than the ref' }
  })
  const verdict = refs.reduce<MirrorVerdict>((v, r) => (RANK[r.verdict] > RANK[v] ? r.verdict : v), 'match')
  return { verdict, refs }
}

/** What a gateway's manifest says about its snapshot (`forge-core::mirror::Manifest`). */
export interface ManifestSummary {
  readonly platformHeight: number
  readonly platformTimeMs: number
  readonly fetchedAtMs: number
}

export interface GatewayCheck {
  readonly verdict: MirrorVerdict
  readonly refs: readonly MirrorRefCheck[]
  readonly manifest: ManifestSummary | null
  /** What the manifest claims that this page cannot back (another repository or network). */
  readonly problems: readonly string[]
}

/** The page's branches and tags (what it proved) are the refs judged. */
export const BRANCHES_AND_TAGS = (name: string): boolean => name.startsWith('refs/heads/') || name.startsWith('refs/tags/')

/**
 * Check the gateway's mirror at `cloneUrl` against `proved`. Throws when the gateway cannot be
 * read (it is down, or refuses this origin): the caller says so, and dash:// is unaffected.
 */
export async function verifyGateway(
  cloneUrl: string,
  proved: readonly ProvedRef[],
  expect: { readonly repoId: string; readonly network: string },
  opts: { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal; readonly inScope?: (name: string) => boolean } = {},
): Promise<GatewayCheck> {
  const f = opts.fetchImpl ?? fetch
  const advert = await f(`${cloneUrl}/info/refs?service=git-upload-pack`, { signal: opts.signal, cache: 'no-store' })
  if (!advert.ok) throw new Error(`the gateway answered HTTP ${advert.status}`)
  const served = parseAdvertisement(new Uint8Array(await advert.arrayBuffer()))
  let manifest: ManifestSummary | null = null
  const problems: string[] = []
  try {
    const r = await f(`${cloneUrl}/forge-manifest.json`, { signal: opts.signal, cache: 'no-store' })
    if (r.ok) {
      const m = (await r.json()) as Record<string, unknown>
      if (m['repoId'] !== expect.repoId) problems.push(`its manifest names repository ${String(m['repoId'])}`)
      if (m['network'] !== expect.network) problems.push(`its manifest is for network ${String(m['network'])}`)
      const num = (k: string): number => (typeof m[k] === 'number' ? (m[k] as number) : 0)
      manifest = { platformHeight: num('platformHeight'), platformTimeMs: num('platformTimeMs'), fetchedAtMs: num('fetchedAtMs') }
    }
  } catch (e) {
    if (opts.signal?.aborted === true) throw e
    /* no manifest: staleness is judged without it */
  }
  const c = compareMirror(served, proved, manifest?.platformTimeMs ?? null, opts.inScope ?? BRANCHES_AND_TAGS)
  return { verdict: problems.length > 0 ? 'mismatch' : c.verdict, refs: c.refs, manifest, problems }
}

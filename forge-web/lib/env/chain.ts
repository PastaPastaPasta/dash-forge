/**
 * Authorization, the snapshot chain and fork detection (D24), and the removal checklist. The
 * Rust twin is `crates/forge-core/src/env/chain.rs`, whose module docs give the steps; the
 * `env_snapshot__*` vectors hold the two equal.
 */

import { compareStrings as cmp, membersKey, type Snapshot } from './format'

/** One kind-8 `packManifest`, as the chain reads it. */
export interface SnapshotRef {
  /** The manifest document id (base58). */
  readonly id: string
  /** `$ownerId` (base58). */
  readonly ownerId: string
  /** `packHash`, lowercase hex. */
  readonly packHash: string
  /** `supersedes`, lowercase hex. */
  readonly supersedes: readonly string[]
  /** `$createdAtBlockHeight`: what orders snapshots and links. */
  readonly height: number
}

export type IgnoredReason = 'notAMaintainer' | 'duplicate'
export type EnvStateKind = 'current' | 'unreadable' | 'conflict'

export interface Ignored {
  readonly id: string
  readonly reason: IgnoredReason
}

/** One environment this reader can name. */
export interface EnvState {
  readonly env: string
  /** `current` (one readable head), `unreadable` (one head that does not open here) or `conflict`. */
  readonly state: EnvStateKind
  /** The heads' document ids, oldest first. */
  readonly heads: readonly string[]
  /** Every snapshot's document id, oldest first. */
  readonly snapshots: readonly string[]
  /**
   * Ignored manifests (by people who are not maintainers now) that name a head from a higher
   * block: never used; readers warn about them.
   */
  readonly ignoredNewer: readonly string[]
}

/** An environment none of whose snapshots open for this reader: counted, never named. */
export interface HiddenEnv {
  readonly heads: readonly string[]
  readonly snapshots: readonly string[]
}

export interface Resolution {
  readonly ignored: readonly Ignored[]
  readonly environments: readonly EnvState[]
  readonly hidden: readonly HiddenEnv[]
}

/**
 * D24, strictly. Only a current maintainer's snapshot counts; every other manifest is ignored and
 * none of its links is read. A link counts only between counted snapshots, strictly back in block
 * height, and within one environment. `envOf`: the environment a counted snapshot (by `packHash`)
 * opened to, `null` when it did not open. The Rust module docs give the steps.
 */
export function resolveSnapshots(
  maintainers: ReadonlySet<string>,
  manifests: readonly SnapshotRef[],
  envOf: (packHash: string) => string | null,
): Resolution {
  const order = [...manifests].sort((a, b) => a.height - b.height || cmp(a.id, b.id))
  const nodes = new Map<string, SnapshotRef>()
  const others: SnapshotRef[] = []
  const ignored: Ignored[] = []
  for (const m of order) {
    if (!maintainers.has(m.ownerId)) {
      ignored.push({ id: m.id, reason: 'notAMaintainer' })
      others.push(m)
    } else if (nodes.has(m.packHash)) {
      ignored.push({ id: m.id, reason: 'duplicate' })
    } else {
      nodes.set(m.packHash, m)
    }
  }
  const node = (h: string) => nodes.get(h) as SnapshotRef
  const edges = new Set<string>()
  const edge = (t: string, s: string) => `${t}>${s}`
  for (const [h, t] of nodes) {
    for (const s of t.supersedes) {
      if (!nodes.has(s) || node(s).height >= t.height) continue
      const a = envOf(h)
      const b = envOf(s)
      if (a !== null && b !== null && a !== b) continue
      edges.add(edge(h, s))
    }
  }

  const parent = new Map<string, string>([...nodes.keys()].map((h) => [h, h]))
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r) as string
    parent.set(x, r)
    return r
  }
  for (const e of edges) {
    const [a, b] = e.split('>') as [string, string]
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb)
  }
  const comps = new Map<string, string[]>()
  for (const h of nodes.keys()) {
    const r = find(h)
    comps.set(r, [...(comps.get(r) ?? []), h])
  }

  const byKey = (a: string, b: string) => node(a).height - node(b).height || cmp(node(a).id, node(b).id)
  const ids = (hs: Iterable<string>) => [...hs].sort(byKey).map((h) => node(h).id)
  const headsOf = (group: ReadonlySet<string>): string[] =>
    [...group].filter((n) => ![...group].some((t) => edges.has(edge(t, n)))).sort(byKey)
  const newer = (heads: readonly string[]): string[] =>
    others
      .filter((m) => heads.some((h) => m.supersedes.includes(h) && m.height > node(h).height && m.packHash !== h))
      .map((m) => m.id)
      .sort(cmp)

  const envs = new Map<string, Set<string>>()
  const hidden: string[][] = []
  for (const members of comps.values()) {
    const names = [...new Set(members.map(envOf).filter((e): e is string => e !== null))].sort(cmp)
    if (names.length === 0) hidden.push(members)
    for (const name of names) {
      const set = envs.get(name) ?? new Set<string>()
      for (const h of members) {
        const e = envOf(h)
        if (e === null || e === name) set.add(h)
      }
      envs.set(name, set)
    }
  }
  const environments: EnvState[] = [...envs.keys()].sort(cmp).map((env) => {
    const group = envs.get(env) as Set<string>
    const heads = headsOf(group)
    let state: EnvStateKind = 'conflict'
    if (heads.length === 1) state = envOf(heads[0] as string) !== null ? 'current' : 'unreadable'
    return { env, state, heads: ids(heads), snapshots: ids(group), ignoredNewer: newer(heads) }
  })
  const minKey = (g: readonly string[]) => [...g].sort(byKey)[0] as string
  const hiddenOut: HiddenEnv[] = hidden
    .sort((a, b) => byKey(minKey(a), minKey(b)))
    .map((g) => ({ heads: ids(headsOf(new Set(g))), snapshots: ids(g) }))
  return { ignored, environments, hidden: hiddenOut }
}

/** The most `packHash`es one `supersedes` holds (the contract's 1,024 bytes). */
export const MAX_SUPERSEDES = 32

/**
 * What a new snapshot names in `supersedes`: the environment's heads, then the newest snapshot of
 * each other author, then the rest, newest first, at most 32 (`env_snapshot__window`).
 */
export function supersedesWindow(snapshots: readonly SnapshotRef[], heads: readonly string[]): string[] {
  const newestFirst = (a: SnapshotRef, b: SnapshotRef) => b.height - a.height || cmp(b.id, a.id)
  const out = snapshots.filter((s) => heads.includes(s.id)).sort(newestFirst)
  const rest = snapshots.filter((s) => !heads.includes(s.id)).sort(newestFirst)
  const authors = new Set(out.map((s) => s.ownerId))
  const taken = new Set(out.map((s) => s.id))
  for (const s of rest) {
    if (!authors.has(s.ownerId)) {
      authors.add(s.ownerId)
      taken.add(s.id)
      out.push(s)
    }
  }
  for (const s of rest) if (!taken.has(s.id)) out.push(s)
  return out.slice(0, MAX_SUPERSEDES).map((s) => s.packHash)
}

/** Environments whose heads or state differ between two resolutions (a membership change's dry run). */
export function changedEnvironments(before: Resolution, after: Resolution): { changed: string[]; vanished: string[]; appeared: string[] } {
  const byName = (r: Resolution) => new Map(r.environments.map((e) => [e.env, e]))
  const a = byName(after)
  const b = byName(before)
  const changed: string[] = []
  const vanished: string[] = []
  for (const e of before.environments) {
    const x = a.get(e.env)
    if (x === undefined) vanished.push(e.env)
    else if (x.state !== e.state || x.heads.join() !== e.heads.join()) changed.push(e.env)
  }
  return { changed, vanished, appeared: after.environments.filter((e) => !b.has(e.env)).map((e) => e.env) }
}

/** One environment's readable snapshots, as the removal checklist reads them. */
export interface EnvHistory {
  readonly env: string
  readonly heads: readonly Snapshot[]
  readonly snapshots: readonly Snapshot[]
}

export interface Exposure {
  readonly env: string
  /** The names of current values they could read, sorted. */
  readonly names: readonly string[]
  /**
   * They held the members key and the environment has an old-format Members snapshot, which
   * handed over every past value too.
   */
  readonly oldFormat: boolean
}

/**
 * The removal checklist: for `removed` (base58), who held the members key when
 * `heldMembersKey`, the current value names they could read in each environment: a name of a
 * readable head whose current value appears in a snapshot they could open (a snapshot whose `to`
 * lists them, or an old-format Members snapshot when they held the members key).
 */
export function exposureOf(envs: readonly EnvHistory[], removed: string, heldMembersKey: boolean): Exposure[] {
  const out: Exposure[] = []
  const could = (s: Snapshot) => (membersKey(s) && heldMembersKey) || s.to.includes(removed)
  for (const e of envs) {
    const names = new Set<string>()
    for (const head of e.heads) {
      for (const [name, v] of head.vars) {
        if (e.snapshots.some((s) => s.vars.get(name)?.value === v.value && could(s))) names.add(name)
      }
    }
    if (names.size > 0) {
      out.push({
        env: e.env,
        names: [...names].sort(cmp),
        oldFormat: heldMembersKey && e.snapshots.some(membersKey),
      })
    }
  }
  return out.sort((a, b) => cmp(a.env, b.env))
}

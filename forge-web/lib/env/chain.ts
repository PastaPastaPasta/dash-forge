/**
 * Authorization, the snapshot chain and fork detection (D24), and the removal checklist. The
 * Rust twin is `crates/forge-core/src/env/chain.rs`, whose module docs give the steps; the
 * `env_snapshot__*` vectors hold the two equal.
 */

import type { Audience, Snapshot } from './format'

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

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

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
    const state: EnvStateKind = heads.length === 1 ? (envOf(heads[0] as string) !== null ? 'current' : 'unreadable') : 'conflict'
    return { env, state, heads: ids(heads), snapshots: ids(group), ignoredNewer: newer(heads) }
  })
  const minKey = (g: readonly string[]) => [...g].sort(byKey)[0] as string
  const hiddenOut: HiddenEnv[] = hidden
    .sort((a, b) => byKey(minKey(a), minKey(b)))
    .map((g) => ({ heads: ids(headsOf(new Set(g))), snapshots: ids(g) }))
  return { ignored, environments, hidden: hiddenOut }
}

/** One environment's readable snapshots, as the removal checklist reads them. */
export interface EnvHistory {
  readonly env: string
  readonly heads: readonly Snapshot[]
  readonly snapshots: readonly Snapshot[]
}

export interface Exposure {
  readonly env: string
  readonly audience: Audience
  readonly names: readonly string[]
}

/**
 * The removal checklist: for `removed` (base58), who held the members key when
 * `heldMembersKey`, the current value names they could read in each environment: a name of a
 * readable head whose current value appears in a snapshot they could open (any Members snapshot
 * when they held the members key; a Maintainers snapshot that lists them).
 */
export function exposureOf(envs: readonly EnvHistory[], removed: string, heldMembersKey: boolean): Exposure[] {
  const out: Exposure[] = []
  for (const e of envs) {
    const names = new Set<string>()
    for (const head of e.heads) {
      for (const [name, v] of head.vars) {
        const seen = e.snapshots.some(
          (s) =>
            s.vars.get(name)?.value === v.value &&
            (s.audience === 'members' ? heldMembersKey : s.to.includes(removed)),
        )
        if (seen) names.add(name)
      }
    }
    const last = e.heads[e.heads.length - 1]
    if (names.size > 0 && last !== undefined) out.push({ env: e.env, audience: last.audience, names: [...names].sort(cmp) })
  }
  return out.sort((a, b) => cmp(a.env, b.env))
}

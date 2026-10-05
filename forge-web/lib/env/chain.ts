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
  /** `$createdAt` (ms). */
  readonly createdAt: number
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
 * Resolve `manifests` (kind 8 only) against the current `maintainers` (base58) and `envOf`: the
 * environment an authorized snapshot (by `packHash`) opened to, `null` when it did not open.
 */
export function resolveSnapshots(
  maintainers: ReadonlySet<string>,
  manifests: readonly SnapshotRef[],
  envOf: (packHash: string) => string | null,
): Resolution {
  const order = [...manifests].sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id))
  const nodes = new Map<string, SnapshotRef>()
  const passthrough = new Map<string, string[]>()
  const ignored: Ignored[] = []
  for (const m of order) {
    if (!maintainers.has(m.ownerId)) {
      ignored.push({ id: m.id, reason: 'notAMaintainer' })
      passthrough.set(m.packHash, [...(passthrough.get(m.packHash) ?? []), ...m.supersedes])
    } else if (nodes.has(m.packHash)) {
      ignored.push({ id: m.id, reason: 'duplicate' })
    } else {
      nodes.set(m.packHash, m)
    }
  }

  const targets = (t: SnapshotRef): string[] => {
    const out: string[] = []
    const seen = new Set([t.packHash])
    const todo = [...t.supersedes]
    while (todo.length > 0) {
      const h = todo.shift() as string
      if (seen.has(h)) continue
      seen.add(h)
      if (nodes.has(h)) out.push(h)
      else todo.push(...(passthrough.get(h) ?? []))
    }
    return out
  }
  const edges = new Set<string>()
  const edge = (t: string, s: string) => `${t}>${s}`
  for (const [h, t] of nodes) {
    for (const s of targets(t)) {
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

  const byKey = (a: string, b: string) => {
    const x = nodes.get(a) as SnapshotRef
    const y = nodes.get(b) as SnapshotRef
    return x.createdAt - y.createdAt || cmp(x.id, y.id)
  }
  const ids = (hs: Iterable<string>) => [...hs].sort(byKey).map((h) => (nodes.get(h) as SnapshotRef).id)
  const headsOf = (group: ReadonlySet<string>): [string[], boolean] => {
    const heads = [...group].filter((n) => ![...group].some((t) => edges.has(edge(t, n))))
    const any = heads.length > 0
    return [(any ? heads : [...group]).sort(byKey), any]
  }

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
    const [heads, any] = headsOf(group)
    const state: EnvStateKind =
      heads.length === 1 && any ? (envOf(heads[0] as string) !== null ? 'current' : 'unreadable') : 'conflict'
    return { env, state, heads: ids(heads), snapshots: ids(group) }
  })
  const minKey = (g: readonly string[]) => [...g].sort(byKey)[0] as string
  const hiddenOut: HiddenEnv[] = hidden
    .sort((a, b) => byKey(minKey(a), minKey(b)))
    .map((g) => ({ heads: ids(headsOf(new Set(g))[0]), snapshots: ids(g) }))
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

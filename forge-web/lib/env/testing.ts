/**
 * INTERNAL, TEST-ONLY: how the `env_snapshot__*` vectors write a snapshot as JSON and read one
 * back, the twin of `snapshot_from` and `snapshot_json` in
 * `crates/forge-core/src/env/conformance.rs`. Imported by the conformance tests only.
 */

import type { Audience, EnvVar, Group, Snapshot } from './format'

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type Obj = { [k: string]: Json }

const o = (j: Json | undefined): Obj => j as Obj
const arr = (j: Json | undefined): Json[] => j as Json[]
const str = (j: Json | undefined): string => j as string

/** The strings of an optional JSON array (none when absent). */
const strings = (j: Json | undefined): string[] => (j === undefined ? [] : arr(j).map(str))

/**
 * A vector's snapshot JSON (version 1 when `v` is absent). `plain`: `vars` maps names to bare
 * values (the exposure vectors) instead of `{type, value, note}`.
 */
export function snapshotFromVector(v: Obj, plain = false): Snapshot {
  const version = v.v === undefined ? 1 : (v.v as 1 | 2)
  const audience: Audience =
    version === 1
      ? { group: str(v.audience) as Group, also: [] }
      : { group: o(v.audience).group === null ? null : (str(o(v.audience).group) as Group), also: strings(o(v.audience).also) }
  const vars = new Map<string, EnvVar>()
  for (const [k, e] of Object.entries(o(v.vars))) {
    vars.set(k, plain ? { type: 'secret', value: str(e), note: '' } : { type: str(o(e).type) as EnvVar['type'], value: str(o(e).value), note: str(o(e).note ?? '') })
  }
  return {
    version,
    env: v.env === undefined ? 'x' : str(v.env),
    audience,
    id: v.id === undefined ? null : str(v.id),
    generatedAt: v.generatedAt === undefined ? 0 : (v.generatedAt as number),
    ...(v.savedFor === undefined ? {} : { savedFor: str(v.savedFor) }),
    to: strings(v.to),
    toKeys: v.toKeys === undefined ? [] : arr(v.toKeys).map((k) => k as number),
    markedChanged: strings(v.markedChanged),
    vars,
  }
}

/** A snapshot as the vectors write it: version 2 always carries `id`, `to`, `toKeys` and `markedChanged`. */
export function snapshotJson(snap: Snapshot): Obj {
  const vars: Obj = {}
  for (const [k, v] of snap.vars) Object.defineProperty(vars, k, { value: { type: v.type, value: v.value, note: v.note }, enumerable: true })
  const out: Obj = { v: snap.version, env: snap.env, generatedAt: snap.generatedAt, vars }
  if (snap.version === 1) {
    const oldFormat = snap.audience.group === 'members'
    out.audience = oldFormat ? 'members' : 'maintainers'
    if (!oldFormat) out.to = [...snap.to]
  } else {
    out.audience = { group: snap.audience.group, also: [...snap.audience.also] }
    out.id = snap.id
    out.to = [...snap.to]
    out.toKeys = [...snap.toKeys]
    out.markedChanged = [...snap.markedChanged]
  }
  if (snap.savedFor !== undefined) out.savedFor = snap.savedFor
  return out
}

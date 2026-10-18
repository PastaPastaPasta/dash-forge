/** Pure plan for keeping private-era branches as ordinary members-only branches after conversion. */

import { compareStrings } from '../rules/oid'

export type Keep =
  | { readonly status: 'push'; readonly target: string }
  | { readonly status: 'kept'; readonly as: string }
  | { readonly status: 'public' | 'tag' }
  | { readonly status: 'notKept'; readonly reason: string }

export interface KeepPlan {
  readonly name: string
  readonly tip: string
  readonly keep: Keep
}

/** Full live refs and real tips. Narrower branches reserve names but never count as kept for all members. */
export async function planKeep(
  allEra: ReadonlyMap<string, string>,
  below: ReadonlyMap<string, string>,
  publicRefs: ReadonlyMap<string, string>,
  members: ReadonlyMap<string, string>,
  defaultRef: string,
  isAncestor: (ancestor: string, tip: string) => boolean | Promise<boolean>,
  reserved: ReadonlySet<string> = new Set(),
): Promise<KeepPlan[]> {
  const taken = new Set([...allEra.keys(), ...below.keys(), ...publicRefs.keys(), ...members.keys(), ...reserved, defaultRef])
  const out: KeepPlan[] = []
  for (const [name, tip] of [...allEra].sort(([a], [b]) => compareStrings(a, b))) {
    if (below.get(name) === tip) continue
    if (!name.startsWith('refs/heads/')) {
      out.push({ name, tip, keep: { status: 'tag' } })
      continue
    }
    let keep: Keep | undefined
    for (const p of publicRefs.values()) {
      if (await isAncestor(tip, p)) {
        keep = { status: 'public' }
        break
      }
    }
    if (keep === undefined) {
      for (const [as, m] of [...members].sort(([a], [b]) => compareStrings(a, b))) {
        if (await isAncestor(tip, m)) {
          keep = { status: 'kept', as }
          break
        }
      }
    }
    if (keep === undefined) {
      let target = name
      const occupied = publicRefs.has(name) || below.has(name) || members.has(name) || reserved.has(name) || name === defaultRef
      const overlaps = [...publicRefs.keys(), ...below.keys(), ...members.keys(), ...reserved].some((n) => n.startsWith(`${name}/`) || name.startsWith(`${n}/`))
      if (occupied || overlaps) {
        const base = `refs/heads/members/${name.slice('refs/heads/'.length)}`
        const parent = [...taken].sort(compareStrings).find((n) => base.startsWith(`${n}/`))
        if (parent !== undefined) {
          out.push({ name, tip, keep: { status: 'notKept', reason: `members-only alias is blocked by branch ${parent.slice('refs/heads/'.length)}` } })
          continue
        }
        target = base
        let suffix = 2
        while ([...taken].some((n) => n === target || n.startsWith(`${target}/`) || target.startsWith(`${n}/`))) target = `${base}-${suffix++}`
      }
      taken.add(target)
      keep = { status: 'push', target }
    }
    out.push({ name, tip, keep })
  }
  return out
}

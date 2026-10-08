/**
 * Environment snapshots: the artifact (canonical JSON padded to 512-byte buckets), names, and
 * audiences. The Rust twin is `crates/forge-core/src/env/format.rs` (normative description in
 * `crates/forge-core/src/env/mod.rs`); the `env_snapshot__*` vectors hold the two equal
 * (`conformance.test.ts`).
 *
 * Version 2 is what every writer makes from revision 4 on: an explicit audience, the
 * environment's id, and the recipients (`to`, with the key id of each slot). Version 1 (phase 1)
 * is read only: a Members snapshot under the members key (the "old format") or a Maintainers
 * snapshot to at most 16 people. A version-1 snapshot reads as the group of its word with
 * nobody added.
 */

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { MAX_ARTIFACT_RECIPIENTS } from '../private'

/** Snapshots are padded to a multiple of this many bytes. */
export const BUCKET = 512
/** The largest snapshot (24 buckets): it, its header and its tag always fit one Platform chunk. */
export const MAX_SNAPSHOT = 12_288
/** At most this many people receive a snapshot, the writer included (the artifact letter's limit). */
export const MAX_RECIPIENTS = MAX_ARTIFACT_RECIPIENTS
/** A version-1 Maintainers snapshot went to at most this many people (the letter limit of phase 1). */
export const MAX_RECIPIENTS_V1 = 16

/** A role group an environment can be for. Groups resolve at write time and never include bots. */
export type Group = 'maintainers' | 'writers' | 'members'
export type VarType = 'secret' | 'variable'

/** Who can read an environment: a group, a group plus people, or specific people (`group` null). */
export interface Audience {
  readonly group: Group | null
  /** People added to the group, or the people of a Specific-people environment (base58, ascending, none twice). */
  readonly also: readonly string[]
}

const GROUP_LABEL: Readonly<Record<Group, string>> = {
  maintainers: 'Maintainers',
  writers: 'Writers and maintainers',
  members: 'All members',
}

/** The product name of a group, as every line says it. */
export function groupLabel(g: Group): string {
  return GROUP_LABEL[g]
}

/** How a person is told: "Maintainers", "Writers and maintainers + 1 more", "Specific people (3)". */
export function audienceLabel(a: Audience): string {
  if (a.group === null) return `Specific people (${a.also.length})`
  return a.also.length === 0 ? GROUP_LABEL[a.group] : `${GROUP_LABEL[a.group]} + ${a.also.length} more`
}

/** One entry. */
export interface EnvVar {
  readonly value: string
  readonly type: VarType
  /** Empty when none. */
  readonly note: string
}

/** One environment as one snapshot holds it. */
export interface Snapshot {
  /** The artifact version: 2 for everything written from revision 4 on; 1 (phase 1) is read only. */
  readonly version: 1 | 2
  readonly env: string
  /** Who can read it. A version-1 snapshot reads as the group of its word, with nobody added. */
  readonly audience: Audience
  /** The environment's random id as 32 lowercase hex digits, fixed at its first save (version 2; `null` for version 1). */
  readonly id: string | null
  /** When the writer made it (ms). */
  readonly generatedAt: number
  /** Set when a maintainer saved a removed maintainer's values again for them (base58). */
  readonly savedFor?: string
  /** The recipients in slot order (base58), the writer first, as listed by the writer; empty for an old-format Members snapshot. */
  readonly to: readonly string[]
  /** The ENCRYPTION key id each recipient's slot was sealed to, in `to` order (version 2; empty for version 1). */
  readonly toKeys: readonly number[]
  /** Names whose values held in old-format snapshots were changed at their source (version 2; sorted; usually empty). */
  readonly markedChanged: readonly string[]
  /** The entries by name (a `Map`: a name like `__proto__` is just a name). */
  readonly vars: ReadonlyMap<string, EnvVar>
}

/**
 * Whether this is an old-format Members snapshot: version 1, under the members key (a DFPK 0x01
 * file), readable by everyone who joins later.
 */
export function membersKey(s: Snapshot): boolean {
  return s.version === 1 && s.audience.group === 'members'
}

/**
 * What every snapshot of an old-format Members environment carries (DESIGN §10): its values are
 * readable by anyone who joins later.
 */
export const OLD_FORMAT_SENTENCE =
  "Saved in the old format: anyone who joins later can read the values saved this way. Save it again, then change those values where they're used."
/**
 * The same, once the latest version is saved again but earlier ones are still in the old format
 * and their values are not all marked changed.
 */
export const OLD_FORMAT_HISTORY_SENTENCE =
  "Earlier versions were saved in the old format: anyone who joins later can read the values saved that way. Change them where they're used, then mark them changed."
/** The sentence every environment carries. */
export const ACCESS_SENTENCE = 'Access is granted, not logged.'

const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** Plain `<` order, not `localeCompare`: every name sorted here is ASCII, so it matches the Rust twin. */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

export function validEnvName(name: string): boolean {
  return ENV_NAME.test(name)
}

export function validVarName(name: string): boolean {
  return VAR_NAME.test(name)
}

/** No lone surrogate (the canonical bytes are UTF-8; Rust and Python cannot hold one). */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false
    }
  }
  return true
}

function canonicalId(id: string): boolean {
  try {
    return base58Encode(decodeIdentifier(id)) === id
  } catch {
    return false
  }
}

const HEX32 = /^[0-9a-f]{32}$/

/** Whether `ids` are canonical identity ids, none twice. */
function distinctIds(ids: readonly string[]): boolean {
  return ids.every((t, i) => canonicalId(t) && !ids.slice(0, i).includes(t))
}

/** Whether `names` are strictly ascending (so each once) in plain `<` order. */
function ascending(names: readonly string[]): boolean {
  return names.every((n, i) => i === 0 || (names[i - 1] as string) < n)
}

/** Why a snapshot breaks a rule a reader would refuse, or `null`. */
export function snapshotProblem(s: Snapshot): string | null {
  if (!validEnvName(s.env)) return `${JSON.stringify(s.env)} is not an environment name`
  if (!Number.isSafeInteger(s.generatedAt) || s.generatedAt < 0) return 'generatedAt is out of range'
  if (s.savedFor !== undefined && !canonicalId(s.savedFor)) return `${JSON.stringify(s.savedFor)} is not an identity id`
  for (const [name, v] of s.vars) {
    if (!validVarName(name)) return `${JSON.stringify(name)} is not a variable name`
    if (v.type !== 'secret' && v.type !== 'variable') return `${name} has an unknown type`
    if (!wellFormed(v.value) || !wellFormed(v.note)) return `${name} is not valid text`
  }
  if (s.version === 1) return problemV1(s)
  if (s.version === 2) return problemV2(s)
  return 'unknown version'
}

function problemV1(s: Snapshot): string | null {
  if (s.id !== null || s.toKeys.length > 0 || s.markedChanged.length > 0 || s.audience.also.length > 0) {
    return 'a version-1 snapshot has no id, keys, marks or added people'
  }
  if (s.audience.group === 'members') return s.to.length === 0 ? null : 'an old-format Members snapshot lists no recipients'
  if (s.audience.group === 'maintainers') {
    if (s.to.length === 0 || s.to.length > MAX_RECIPIENTS_V1 || !distinctIds(s.to)) {
      return `a version-1 Maintainers snapshot goes to 1 to ${MAX_RECIPIENTS_V1} different people`
    }
    return null
  }
  return 'a version-1 snapshot is for Members or Maintainers'
}

function problemV2(s: Snapshot): string | null {
  if (s.id === null || !HEX32.test(s.id)) return "a snapshot needs the environment's id"
  const also = s.audience.also
  if (s.audience.group !== null && s.audience.group !== 'maintainers' && s.audience.group !== 'writers' && s.audience.group !== 'members') {
    return 'unknown audience'
  }
  if (also.length > MAX_RECIPIENTS || !also.every(canonicalId) || !ascending(also)) {
    return 'the people added are not identity ids in order, each once'
  }
  if (s.audience.group === null && also.length === 0) return 'a Specific-people environment names someone'
  if (s.to.length === 0 || s.to.length > MAX_RECIPIENTS || !distinctIds(s.to)) {
    return `an environment goes to 1 to ${MAX_RECIPIENTS} different people, not ${s.to.length}`
  }
  if (s.toKeys.length !== s.to.length || !s.toKeys.every((k) => Number.isInteger(k) && k >= 0 && k <= 0xffff_ffff)) {
    return 'one key per recipient'
  }
  if (!s.markedChanged.every(validVarName) || !ascending(s.markedChanged)) {
    return 'the names marked changed are not variable names in order, each once'
  }
  return null
}

/** The canonical JSON (sorted keys, no whitespace; `note` left out when empty), as the Rust twin writes it. */
function canonical(s: Snapshot): string {
  const str = (x: string) => JSON.stringify(x)
  const strs = (xs: readonly string[]) => `[${xs.map(str).join(',')}]`
  let out = '{"audience":'
  if (s.version === 1) {
    out += str(s.audience.group === 'maintainers' ? 'maintainers' : 'members')
  } else {
    out += `{"also":${strs(s.audience.also)},"group":${s.audience.group === null ? 'null' : str(s.audience.group)}}`
  }
  out += `,"env":${str(s.env)},"generatedAt":${s.generatedAt}`
  if (s.id !== null) out += `,"id":${str(s.id)}`
  if (s.markedChanged.length > 0) out += `,"markedChanged":${strs(s.markedChanged)}`
  if (s.savedFor !== undefined) out += `,"savedFor":${str(s.savedFor)}`
  if (s.version === 2 || s.audience.group === 'maintainers') out += `,"to":${strs(s.to)}`
  if (s.version === 2) out += `,"toKeys":[${s.toKeys.join(',')}]`
  const names = [...s.vars.keys()].sort(compareStrings)
  const entries = names.map((n) => {
    const v = s.vars.get(n) as EnvVar
    const note = v.note === '' ? '' : `"note":${str(v.note)},`
    return `${str(n)}:{${note}"type":${str(v.type)},"value":${str(v.value)}}`
  })
  return `${out},"v":${s.version},"vars":{${entries.join(',')}}}`
}

export class SnapshotTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`the environment is ${bytes} bytes once encoded; at most ${MAX_SNAPSHOT} fit one snapshot`)
    this.name = 'SnapshotTooLargeError'
  }
}

/** The artifact plaintext: the canonical JSON padded with spaces to a multiple of 512 bytes. */
export function encodeSnapshot(s: Snapshot): Uint8Array {
  const problem = snapshotProblem(s)
  if (problem !== null) throw new RangeError(problem)
  const raw = new TextEncoder().encode(canonical(s))
  const size = Math.max(BUCKET, Math.ceil(raw.length / BUCKET) * BUCKET)
  if (size > MAX_SNAPSHOT) throw new SnapshotTooLargeError(raw.length)
  const out = new Uint8Array(size).fill(0x20)
  out.set(raw)
  return out
}

const V1_KEYS = ['audience', 'env', 'generatedAt', 'savedFor', 'to', 'v', 'vars']
const V2_KEYS = ['id', 'markedChanged', 'toKeys']
const VAR_KEYS = new Set(['note', 'type', 'value'])

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function stringsOf(x: unknown): string[] | null {
  return Array.isArray(x) && x.every((t) => typeof t === 'string') ? (x as string[]) : null
}

function isGroup(x: unknown): x is Group {
  return x === 'maintainers' || x === 'writers' || x === 'members'
}

function fromJson(obj: unknown): Snapshot | null {
  if (!isObject(obj) || (obj.v !== 1 && obj.v !== 2)) return null
  const version = obj.v
  const known = new Set(version === 2 ? [...V1_KEYS, ...V2_KEYS] : V1_KEYS)
  if (Object.keys(obj).some((k) => !known.has(k))) return null
  const { env, generatedAt, vars } = obj
  if (typeof env !== 'string' || typeof generatedAt !== 'number' || !isObject(vars)) return null
  let audience: Audience
  let id: string | null = null
  let toKeys: number[] = []
  let markedChanged: string[] = []
  if (version === 1) {
    if (obj.audience !== 'members' && obj.audience !== 'maintainers') return null
    audience = { group: obj.audience, also: [] }
  } else {
    const a = obj.audience
    if (!isObject(a) || Object.keys(a).length !== 2 || !('group' in a) || !('also' in a)) return null
    if (a.group !== null && !isGroup(a.group)) return null
    const also = stringsOf(a.also)
    if (also === null) return null
    audience = { group: a.group, also }
    if (typeof obj.id !== 'string' || !HEX32.test(obj.id)) return null
    id = obj.id
    if (!Array.isArray(obj.toKeys) || obj.toKeys.some((k) => typeof k !== 'number' || !Number.isInteger(k) || k < 0 || k > 0xffff_ffff)) return null
    toKeys = obj.toKeys as number[]
    if ('markedChanged' in obj) {
      const m = stringsOf(obj.markedChanged)
      if (m === null || m.length === 0) return null
      markedChanged = m
    }
  }
  let to: string[] = []
  if ('to' in obj) {
    const t = stringsOf(obj.to)
    if (t === null) return null
    to = t
  }
  const out = new Map<string, EnvVar>()
  for (const [name, e] of Object.entries(vars)) {
    if (!isObject(e) || Object.keys(e).some((k) => !VAR_KEYS.has(k))) return null
    const { type, value } = e
    const note = 'note' in e ? e.note : ''
    if ((type !== 'secret' && type !== 'variable') || typeof value !== 'string' || typeof note !== 'string') return null
    out.set(name, { type, value, note })
  }
  if ('savedFor' in obj && typeof obj.savedFor !== 'string') return null
  const s: Snapshot = {
    version,
    env,
    audience,
    id,
    generatedAt,
    ...(typeof obj.savedFor === 'string' ? { savedFor: obj.savedFor } : {}),
    to,
    toKeys,
    markedChanged,
    vars: out,
  }
  return snapshotProblem(s) === null ? s : null
}

/**
 * Read an artifact plaintext: a bucket length, spaces as padding, a valid version-1 or version-2 object and
 * exactly the bytes {@link encodeSnapshot} makes of it. `null` is malformed.
 */
export function decodeSnapshot(pt: Uint8Array): Snapshot | null {
  if (pt.length === 0 || pt.length > MAX_SNAPSHOT || pt.length % BUCKET !== 0) return null
  let end = pt.length
  while (end > 0 && pt[end - 1] === 0x20) end--
  if (end === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pt.subarray(0, end)))
  } catch {
    return null
  }
  const s = fromJson(parsed)
  if (s === null) return null
  let again: Uint8Array
  try {
    again = encodeSnapshot(s)
  } catch {
    return null
  }
  if (again.length !== pt.length || again.some((b, i) => b !== pt[i])) return null
  return s
}

export type Change = 'added' | 'changed' | 'removed'

/** The entries that differ from `before` to `after`, by name (names only). */
export function diffSnapshots(before: Snapshot | null, after: Snapshot): Array<readonly [string, Change]> {
  const old = before?.vars ?? new Map<string, EnvVar>()
  const out: Array<readonly [string, Change]> = []
  for (const [name, v] of after.vars) {
    const o = old.get(name)
    if (o === undefined) out.push([name, 'added'])
    else if (o.value !== v.value || o.type !== v.type || o.note !== v.note) out.push([name, 'changed'])
  }
  for (const name of old.keys()) if (!after.vars.has(name)) out.push([name, 'removed'])
  return out.sort((a, b) => compareStrings(a[0], b[0]))
}

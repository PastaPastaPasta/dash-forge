/**
 * Environment snapshots: the artifact (canonical JSON padded to 512-byte buckets), names, and
 * the default-audience rule. The Rust twin is `crates/forge-core/src/env/format.rs` (normative
 * description in `crates/forge-core/src/env/mod.rs`); the `env_snapshot__*` vectors hold the two
 * equal (`conformance.test.ts`).
 */

import { base58Encode, decodeIdentifier } from '../auth/base58'

/** Snapshots are padded to a multiple of this many bytes. */
export const BUCKET = 512
/** The largest snapshot (24 buckets): it, its header and its tag always fit one Platform chunk. */
export const MAX_SNAPSHOT = 12_288
/** At most this many people receive a Maintainers snapshot, the writer included. */
export const MAX_RECIPIENTS = 16

export type Audience = 'members' | 'maintainers'
export type VarType = 'secret' | 'variable'

/** One entry. */
export interface EnvVar {
  readonly value: string
  readonly type: VarType
  /** Empty when none. */
  readonly note: string
}

/** One environment as one snapshot holds it. */
export interface Snapshot {
  readonly env: string
  readonly audience: Audience
  /** When the writer made it (ms). */
  readonly generatedAt: number
  /** Maintainers only: the recipients in slot order (base58), the writer first; empty for Members. */
  readonly to: readonly string[]
  /** The entries by name (a `Map`: a name like `__proto__` is just a name). */
  readonly vars: ReadonlyMap<string, EnvVar>
}

/**
 * The one rule for an environment's default audience (owner question 3): these names,
 * case-insensitively, default to Maintainers; every other name to Members. A trailing `*`
 * matches any rest. Same list as Rust's `env::MAINTAINERS_BY_DEFAULT`.
 */
export const MAINTAINERS_BY_DEFAULT: readonly string[] = ['production', 'prod*', 'staging', 'release*']

/** The default audience of an environment named `name`. */
export function defaultAudience(name: string): Audience {
  const n = name.toLowerCase()
  const hit = MAINTAINERS_BY_DEFAULT.some((p) => (p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p))
  return hit ? 'maintainers' : 'members'
}

/** The sentence every Members environment carries (DESIGN §10, security review M2). */
export const MEMBERS_SENTENCE =
  'Readers, CI runners made members, and future members can read every value stored here, including past values.'
/** The sentence every environment carries. */
export const ACCESS_SENTENCE = 'Access is granted, not logged.'

const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_SAFE = Number.MAX_SAFE_INTEGER

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

/** Why a snapshot breaks a rule a reader would refuse, or `null`. */
export function snapshotProblem(s: Snapshot): string | null {
  if (!validEnvName(s.env)) return `${JSON.stringify(s.env)} is not an environment name`
  if (!Number.isSafeInteger(s.generatedAt) || s.generatedAt < 0 || s.generatedAt > MAX_SAFE) return 'generatedAt is out of range'
  for (const [name, v] of s.vars) {
    if (!validVarName(name)) return `${JSON.stringify(name)} is not a variable name`
    if (v.type !== 'secret' && v.type !== 'variable') return `${name} has an unknown type`
    if (!wellFormed(v.value) || !wellFormed(v.note)) return `${name} is not valid text`
  }
  if (s.audience === 'members') return s.to.length === 0 ? null : 'a Members snapshot lists no recipients'
  if (s.audience !== 'maintainers') return 'unknown audience'
  if (s.to.length === 0 || s.to.length > MAX_RECIPIENTS) return `a Maintainers snapshot goes to 1 to ${MAX_RECIPIENTS} people`
  const seen = new Set<string>()
  for (const t of s.to) {
    if (!canonicalId(t) || seen.has(t)) return `${JSON.stringify(t)} is not a recipient identity id, or is listed twice`
    seen.add(t)
  }
  return null
}

/** The canonical JSON (sorted keys, no whitespace; `note` left out when empty; `to` for Maintainers only). */
function canonical(s: Snapshot): string {
  const str = (x: string) => JSON.stringify(x)
  let out = `{"audience":${str(s.audience)},"env":${str(s.env)},"generatedAt":${s.generatedAt}`
  if (s.audience === 'maintainers') out += `,"to":[${s.to.map(str).join(',')}]`
  const names = [...s.vars.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const entries = names.map((n) => {
    const v = s.vars.get(n) as EnvVar
    const note = v.note === '' ? '' : `"note":${str(v.note)},`
    return `${str(n)}:{${note}"type":${str(v.type)},"value":${str(v.value)}}`
  })
  return `${out},"v":1,"vars":{${entries.join(',')}}}`
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

const TOP_KEYS = new Set(['audience', 'env', 'generatedAt', 'to', 'v', 'vars'])
const VAR_KEYS = new Set(['note', 'type', 'value'])

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function fromJson(obj: unknown): Snapshot | null {
  if (!isObject(obj) || Object.keys(obj).some((k) => !TOP_KEYS.has(k)) || obj.v !== 1) return null
  const { audience, env, generatedAt, vars } = obj
  if (audience !== 'members' && audience !== 'maintainers') return null
  if (typeof env !== 'string' || typeof generatedAt !== 'number' || !isObject(vars)) return null
  let to: string[] = []
  if (audience === 'maintainers') {
    if (!Array.isArray(obj.to) || obj.to.some((t) => typeof t !== 'string')) return null
    to = obj.to as string[]
  } else if ('to' in obj) {
    return null
  }
  const out = new Map<string, EnvVar>()
  for (const [name, e] of Object.entries(vars)) {
    if (!isObject(e) || Object.keys(e).some((k) => !VAR_KEYS.has(k))) return null
    const { type, value } = e
    const note = 'note' in e ? e.note : ''
    if ((type !== 'secret' && type !== 'variable') || typeof value !== 'string' || typeof note !== 'string') return null
    out.set(name, { type, value, note })
  }
  const s: Snapshot = { env, audience, generatedAt, to, vars: out }
  return snapshotProblem(s) === null ? s : null
}

/**
 * Read an artifact plaintext: a bucket length, spaces as padding, a valid version-1 object and
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
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

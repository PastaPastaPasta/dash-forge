/**
 * Signed-commit badges (P1-7): who signed a git commit, judged against the signing keys
 * identities list in their `profile.pubkeys` (`docs/contracts/forge-v2.md` §2). The Rust half is
 * `forge_core::rules::signature`; the `pubkey_entry` and `commit_signature` vectors hold them
 * equal.
 *
 * **Key entries** (`profile.pubkeys`, at most 4 of at most 300 bytes):
 * - `ssh-ed25519 <base64> [comment]`: an OpenSSH public key line. Other SSH key types are read
 *   (their fingerprint shows) but never verify.
 * - `gpg:<FINGERPRINT> <base64>`: an OpenPGP key's signing (sub)key as one public-key or
 *   public-subkey packet, whose fingerprint must be FINGERPRINT (40 hex, v4; 64 hex, v6). Ed25519
 *   (EdDSA, algorithms 22 and 27) and ECDSA on P-256/384/521 verify; an RSA key does not fit in
 *   300 bytes. `gpg:<FINGERPRINT>` alone names a key it does not publish, so it never verifies.
 *
 * **A commit's verdict** ({@link verifyCommitSignature}): the signature git stores in the `gpgsig`
 * header (`gpgsig-sha256` in a SHA-256 repository) over the object without its signature headers,
 * exactly as `git verify-commit` reads it. Verified needs a signature that checks against a key
 * listed by exactly one of the candidate identities (a repository's owner and members); the same
 * key on two identities' profiles is ambiguous, and nobody's. SSH signatures must be in git's
 * `git` namespace. Only SHA-256/384/512 and SHA3-256/512 digests and binary-document OpenPGP
 * signatures are accepted. Nothing here proves an identity holds the key it lists: Verified means
 * "signed with a key this identity publishes", as GitHub's means for a key on an account.
 *
 * Verification runs in well-vetted libraries: OpenPGP.js for OpenPGP, `@noble/curves` for the
 * Ed25519 of an SSH signature (whose `sshsig` envelope is parsed here, per OpenSSH's
 * PROTOCOL.sshsig). OpenPGP.js is loaded only when a page has an OpenPGP signature to check.
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'

/** Who may have signed: an identity and its `profile.pubkeys`. */
export interface Signer {
  readonly identity: string
  readonly pubkeys: readonly string[]
}

/** How an entry of `profile.pubkeys` reads (what the `pubkey_entry` vectors pin). */
export interface PubkeyEntryView {
  readonly kind: 'ssh' | 'openpgp' | 'invalid'
  /** `SHA256:<base64>` (SSH) or the uppercase hex fingerprint (OpenPGP); null when invalid. */
  readonly fingerprint: string | null
  /** Whether a signature can be checked against it. */
  readonly verifiable: boolean
}

export type SignatureFormat = 'ssh' | 'openpgp' | 'x509' | 'unknown'
export type UnverifiedReason = 'unknown_key' | 'ambiguous_key' | 'bad_signature' | 'unsupported' | 'malformed'

/** A signed commit's verdict (what the `commit_signature` vectors pin). */
export interface SignatureVerdict {
  readonly status: 'verified' | 'unverified'
  /** Why it is unverified; null when verified. */
  readonly reason: UnverifiedReason | null
  readonly format: SignatureFormat
  /** The signing key: `SHA256:…` (SSH), the issuer fingerprint or key id in hex (OpenPGP). */
  readonly key: string | null
  /** The identity whose profile lists the key, when exactly one does. */
  readonly signer: string | null
}

// ---------------------------------------------------------------------------------------------
// The signature git stores
// ---------------------------------------------------------------------------------------------

const enc = new TextEncoder()
const startsWith = (b: Uint8Array, at: number, s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false
  return true
}

/**
 * A commit's signature and the bytes it signs, as git's `parse_buffer_signed_by_header` splits
 * them: the header named for the repository's hash (`gpgsig`, or `gpgsig-sha256`) and its
 * continuation lines are the signature (each line without its leading space); every signature
 * header, of either hash, is left out of the payload; the message after the blank line is kept
 * whole. Null for an unsigned commit.
 */
export function splitSignedCommit(bytes: Uint8Array, sha256Repo = false): { payload: Uint8Array; signature: string } | null {
  const header = sha256Repo ? 'gpgsig-sha256' : 'gpgsig'
  const payload: number[] = []
  const signature: number[] = []
  let inSignature = false
  let otherSignature = false
  let saw = false
  let line = 0
  while (line < bytes.length) {
    let next = bytes.indexOf(0x0a, line)
    next = next === -1 ? bytes.length : next + 1
    let sig = -1
    if (inSignature && bytes[line] === 0x20) sig = line + 1
    else if (startsWith(bytes, line, header) && bytes[line + header.length] === 0x20) {
      sig = line + header.length + 1
      otherSignature = false
    } else if (startsWith(bytes, line, 'gpgsig')) otherSignature = true
    else if (otherSignature && bytes[line] !== 0x20) otherSignature = false
    if (sig !== -1) {
      for (let i = sig; i < next; i++) signature.push(bytes[i] as number)
      saw = true
      inSignature = true
    } else {
      // The blank line ends the header: the message is copied whole.
      if (bytes[line] === 0x0a) next = bytes.length
      if (!otherSignature) for (let i = line; i < next; i++) payload.push(bytes[i] as number)
      inSignature = false
    }
    line = next
  }
  if (!saw) return null
  return { payload: Uint8Array.from(payload), signature: new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(signature)) }
}

/** The lines that open a signature block, as git's `get_format_by_sig` knows them. */
const SIGNATURE_STARTS = ['-----BEGIN PGP SIGNATURE-----', '-----BEGIN PGP MESSAGE-----', '-----BEGIN SIGNED MESSAGE-----', '-----BEGIN SSH SIGNATURE-----']

/**
 * An annotated tag's signature and the bytes it signs, as git's `parse_signed_buffer` splits
 * them: the signature starts at the last line that opens a signature block and runs to the end;
 * the payload is everything before it. Null for an unsigned tag.
 */
export function splitSignedTag(bytes: Uint8Array): { payload: Uint8Array; signature: string } | null {
  let found = -1
  let line = 0
  while (line < bytes.length) {
    if (SIGNATURE_STARTS.some((p) => startsWith(bytes, line, p))) found = line
    const next = bytes.indexOf(0x0a, line)
    line = next === -1 ? bytes.length : next + 1
  }
  if (found === -1) return null
  return { payload: bytes.slice(0, found), signature: new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(found)) }
}

// ---------------------------------------------------------------------------------------------
// Bytes, base64, SSH wire strings
// ---------------------------------------------------------------------------------------------

const B64 = /^[A-Za-z0-9+/]*={0,2}$/

/** Strict base64 (padding as written); null when it is not base64. */
function b64(s: string): Uint8Array | null {
  if (!B64.test(s) || s.length % 4 !== 0) return null
  try {
    const bin = atob(s)
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

const toB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** OpenSSH's fingerprint: `SHA256:` and the unpadded base64 of the key blob's SHA-256. */
export function sshFingerprint(blob: Uint8Array): string {
  return `SHA256:${toB64(sha256(blob)).replace(/=+$/, '')}`
}

/** A reader of SSH wire `string`s and `uint32`s; throws on a short buffer. */
class Wire {
  private at = 0
  private readonly b: Uint8Array
  constructor(b: Uint8Array) {
    this.b = b
  }
  u32(): number {
    if (this.at + 4 > this.b.length) throw new Error('short')
    const v = ((this.b[this.at] as number) << 24) | ((this.b[this.at + 1] as number) << 16) | ((this.b[this.at + 2] as number) << 8) | (this.b[this.at + 3] as number)
    this.at += 4
    return v >>> 0
  }
  bytes(n: number): Uint8Array {
    if (this.at + n > this.b.length) throw new Error('short')
    const out = this.b.subarray(this.at, this.at + n)
    this.at += n
    return out
  }
  string(): Uint8Array {
    return this.bytes(this.u32())
  }
  text(): string {
    return new TextDecoder().decode(this.string())
  }
  get done(): boolean {
    return this.at === this.b.length
  }
}

const wireString = (b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + b.length)
  new DataView(out.buffer).setUint32(0, b.length)
  out.set(b, 4)
  return out
}

/** An `ssh-ed25519` key blob's 32-byte key, or null for any other blob. */
function ed25519Key(blob: Uint8Array): Uint8Array | null {
  try {
    const w = new Wire(blob)
    if (w.text() !== 'ssh-ed25519') return null
    const key = w.string()
    return key.length === 32 && w.done ? key : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Key entries
// ---------------------------------------------------------------------------------------------

/** An entry, parsed. */
type ParsedEntry =
  | { readonly kind: 'ssh'; readonly blob: Uint8Array; readonly fingerprint: string; readonly verifiable: boolean }
  | { readonly kind: 'openpgp'; readonly fingerprint: string; readonly packet: Uint8Array | null; readonly verifiable: boolean }
  | { readonly kind: 'invalid' }

const SSH_TYPE = /^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)$/
const FPR = /^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$/
/** OpenPGP public-key algorithms that verify here: ECDSA, EdDSA (legacy), Ed25519. */
const PGP_ALGOS: ReadonlySet<number> = new Set([19, 22, 27])
/** ECDSA curves that verify here (OpenPGP.js names). */
const PGP_CURVES: ReadonlySet<string> = new Set(['nistP256', 'nistP384', 'nistP521'])

type OpenPgp = typeof import('openpgp')
let openpgpLoad: Promise<OpenPgp> | null = null
/** OpenPGP.js, loaded on first use (a page with no OpenPGP signature never loads it). */
function openpgp(): Promise<OpenPgp> {
  openpgpLoad ??= import('openpgp')
  return openpgpLoad
}

/** The one public-key or public-subkey packet `bytes` holds, or null. */
async function readKeyPacket(bytes: Uint8Array) {
  const pgp = await openpgp()
  try {
    const list = await pgp.PacketList.fromBinary(bytes, {
      [pgp.enums.packet.publicKey]: pgp.PublicKeyPacket,
      [pgp.enums.packet.publicSubkey]: pgp.PublicSubkeyPacket,
    } as never)
    const [only, ...rest] = list
    // A packet OpenPGP.js could not parse (an unknown algorithm) comes back as another class.
    const isKey = only instanceof pgp.PublicKeyPacket || only instanceof pgp.PublicSubkeyPacket
    return isKey && rest.length === 0 ? (only as InstanceType<OpenPgp['PublicKeyPacket']>) : null
  } catch {
    return null
  }
}

/** An entry, parsed; anything that fails to parse is invalid (never a thrown error). */
async function parseEntry(entry: string): Promise<ParsedEntry> {
  try {
    return await parseEntryUnsafe(entry)
  } catch {
    return { kind: 'invalid' }
  }
}

async function parseEntryUnsafe(entry: string): Promise<ParsedEntry> {
  if (entry.startsWith('gpg:')) {
    const [fpr, data, ...more] = entry.slice(4).split(' ')
    if (fpr === undefined || !FPR.test(fpr) || more.length > 0) return { kind: 'invalid' }
    const fingerprint = fpr.toUpperCase()
    if (data === undefined) return { kind: 'openpgp', fingerprint, packet: null, verifiable: false }
    const bytes = b64(data)
    const key = bytes === null ? null : await readKeyPacket(bytes)
    if (key === null || key.getFingerprint().toUpperCase() !== fingerprint) return { kind: 'invalid' }
    const curve = (key.publicParams as { oid?: { getName(): string } }).oid?.getName()
    const verifiable = PGP_ALGOS.has(key.algorithm) && (key.algorithm !== 19 || (curve !== undefined && PGP_CURVES.has(curve)))
    return { kind: 'openpgp', fingerprint, packet: bytes, verifiable }
  }
  const [type, data] = entry.split(' ')
  if (type === undefined || data === undefined || !SSH_TYPE.test(type)) return { kind: 'invalid' }
  const blob = b64(data)
  if (blob === null) return { kind: 'invalid' }
  let named: string
  try {
    named = new Wire(blob).text()
  } catch {
    return { kind: 'invalid' }
  }
  if (named !== type) return { kind: 'invalid' }
  return { kind: 'ssh', blob, fingerprint: sshFingerprint(blob), verifiable: ed25519Key(blob) !== null }
}

/** How a `profile.pubkeys` entry reads: what the `pubkey_entry` vectors pin. */
export async function readPubkeyEntry(entry: string): Promise<PubkeyEntryView> {
  const p = await parseEntry(entry)
  return p.kind === 'invalid' ? { kind: 'invalid', fingerprint: null, verifiable: false } : { kind: p.kind, fingerprint: p.fingerprint, verifiable: p.verifiable }
}

// ---------------------------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------------------------

const verdict = (format: SignatureFormat, key: string | null, reason: UnverifiedReason | null, signer: string | null = null): SignatureVerdict => ({
  status: reason === null ? 'verified' : 'unverified',
  reason,
  format,
  key,
  signer,
})

/** The verdict once the signature checked against a key `owners` list: one owner is the signer. */
function byOwners(format: SignatureFormat, key: string, owners: ReadonlySet<string>): SignatureVerdict {
  if (owners.size === 0) return verdict(format, key, 'unknown_key')
  if (owners.size > 1) return verdict(format, key, 'ambiguous_key')
  return verdict(format, key, null, [...owners][0] as string)
}

/** The base64 body of an ASCII-armored block, or null. */
function armorBody(armored: string, label: string): Uint8Array | null {
  const lines = armored.replace(/\r/g, '').split('\n').map((l) => l.trim())
  const begin = lines.indexOf(`-----BEGIN ${label}-----`)
  const end = lines.indexOf(`-----END ${label}-----`)
  if (begin === -1 || end <= begin) return null
  return b64(lines.slice(begin + 1, end).join(''))
}

async function verifySsh(armored: string, payload: Uint8Array, entries: Entries): Promise<SignatureVerdict> {
  const body = armorBody(armored, 'SSH SIGNATURE')
  if (body === null) return verdict('ssh', null, 'malformed')
  let publicKey: Uint8Array, namespace: string, reserved: Uint8Array, hashAlg: string, sigBlob: Uint8Array
  try {
    const w = new Wire(body)
    if (new TextDecoder().decode(w.bytes(6)) !== 'SSHSIG' || w.u32() !== 1) return verdict('ssh', null, 'malformed')
    publicKey = w.string()
    namespace = w.text()
    reserved = w.string()
    hashAlg = w.text()
    sigBlob = w.string()
    if (!w.done) return verdict('ssh', null, 'malformed')
  } catch {
    return verdict('ssh', null, 'malformed')
  }
  const key = sshFingerprint(publicKey)
  if (namespace !== 'git') return verdict('ssh', key, 'bad_signature')
  const hash = hashAlg === 'sha512' ? sha512 : hashAlg === 'sha256' ? sha256 : null
  const raw = ed25519Key(publicKey)
  let sig: Uint8Array
  try {
    const w = new Wire(sigBlob)
    const type = w.text()
    sig = w.string()
    if (!w.done || (raw !== null && (type !== 'ssh-ed25519' || sig.length !== 64))) return verdict('ssh', key, 'malformed')
  } catch {
    return verdict('ssh', key, 'malformed')
  }
  if (hash === null || raw === null) return verdict('ssh', key, 'unsupported')
  // PROTOCOL.sshsig: the signed blob is the magic, the namespace, the reserved string, the hash
  // algorithm and the digest of the message, each but the magic as an SSH string.
  const signed = new Uint8Array([
    ...enc.encode('SSHSIG'),
    ...wireString(enc.encode(namespace)),
    ...wireString(reserved),
    ...wireString(enc.encode(hashAlg)),
    ...wireString(hash(payload)),
  ])
  let ok = false
  try {
    ok = ed25519.verify(sig, signed, raw, { zip215: false })
  } catch {
    ok = false
  }
  if (!ok) return verdict('ssh', key, 'bad_signature')
  const owners = new Set(entries.filter(([, e]) => e.kind === 'ssh' && e.verifiable && eq(e.blob, publicKey)).map(([id]) => id))
  return byOwners('ssh', key, owners)
}

/** OpenPGP hash algorithms accepted: SHA2-256/384/512, SHA3-256/512. */
const PGP_HASHES: ReadonlySet<number> = new Set([8, 9, 10, 12, 14])

async function verifyOpenPgp(armored: string, payload: Uint8Array, entries: Entries): Promise<SignatureVerdict> {
  const pgp = await openpgp()
  let sig: InstanceType<OpenPgp['SignaturePacket']>
  try {
    const parsed = await pgp.readSignature({ armoredSignature: armored })
    const [only, ...rest] = parsed.packets
    if (only === undefined || rest.length > 0) return verdict('openpgp', null, 'malformed')
    sig = only
  } catch {
    return verdict('openpgp', null, 'malformed')
  }
  const fpr = sig.issuerFingerprint ? hex(sig.issuerFingerprint) : null
  const idHex = sig.issuerKeyID.toHex().toUpperCase()
  const keyId = /^0*$/.test(idHex) ? null : idHex
  const key = fpr ?? keyId
  // A signature that names no issuer names no key to check it with.
  if (key === null) return verdict('openpgp', null, 'malformed')
  if (sig.signatureType !== pgp.enums.signature.binary || sig.hashAlgorithm === null || !PGP_HASHES.has(sig.hashAlgorithm)) {
    return verdict('openpgp', key, 'unsupported')
  }
  // The entries whose key the signature names, by its fingerprint, else its key id.
  const matches = entries.filter(([, e]) => {
    if (e.kind !== 'openpgp' || !e.verifiable) return false
    if (fpr !== null) return e.fingerprint === fpr
    return keyId !== null && e.fingerprint.length === 40 && e.fingerprint.endsWith(keyId)
  })
  const first = matches[0]?.[1]
  if (first === undefined || first.kind !== 'openpgp' || first.packet === null) return verdict('openpgp', key, 'unknown_key')
  const keyPacket = await readKeyPacket(first.packet)
  if (keyPacket === null) return verdict('openpgp', key, 'unknown_key')
  const literal = new pgp.LiteralDataPacket()
  ;(literal as unknown as { setBytes(b: Uint8Array, f: number): void }).setBytes(payload, pgp.enums.literal.binary)
  try {
    await sig.verify(keyPacket, pgp.enums.signature.binary, literal, null as unknown as Date)
  } catch {
    return verdict('openpgp', key, 'bad_signature')
  }
  return byOwners('openpgp', key, new Set(matches.map(([id]) => id)))
}

type Entries = readonly (readonly [string, ParsedEntry])[]

/** Each signer set's entries, parsed once however many commits are checked against it. */
const parsedSigners = new WeakMap<readonly Signer[], Promise<Entries>>()

function entriesOf(signers: readonly Signer[]): Promise<Entries> {
  let parsed = parsedSigners.get(signers)
  if (parsed === undefined) {
    parsed = Promise.all(signers.flatMap((s) => s.pubkeys.map(async (k) => [s.identity, await parseEntry(k)] as const)))
    parsedSigners.set(signers, parsed)
  }
  return parsed
}

/**
 * The verdict on a commit (its raw object bytes) against `signers` (in any order), or null for an
 * unsigned commit. `sha256Repo`: the repository's objects are SHA-256 (`gpgsig-sha256`). Pass the
 * same `signers` array for a page's commits: its entries are parsed once.
 */
export async function verifyCommitSignature(bytes: Uint8Array, signers: readonly Signer[], sha256Repo = false): Promise<SignatureVerdict | null> {
  const split = splitSignedCommit(bytes, sha256Repo)
  return split === null ? null : verifySplit(split, signers)
}

/**
 * The verdict on an annotated tag (its raw object bytes) against `signers`, or null for an
 * unsigned tag: the same keys and rules as {@link verifyCommitSignature}, over the tag object
 * without its trailing signature, exactly as `git verify-tag` reads it.
 */
export async function verifyTagSignature(bytes: Uint8Array, signers: readonly Signer[]): Promise<SignatureVerdict | null> {
  const split = splitSignedTag(bytes)
  return split === null ? null : verifySplit(split, signers)
}

/** The verdict on `split.signature` over `split.payload`. */
async function verifySplit(split: { payload: Uint8Array; signature: string }, signers: readonly Signer[]): Promise<SignatureVerdict> {
  const entries = await entriesOf(signers)
  const first = split.signature.split('\n', 1)[0]?.trim() ?? ''
  try {
    if (first === '-----BEGIN SSH SIGNATURE-----') return await verifySsh(split.signature, split.payload, entries)
    if (first === '-----BEGIN PGP SIGNATURE-----') return await verifyOpenPgp(split.signature, split.payload, entries)
  } catch {
    // A signature a library chokes on (not one it refuses) could not be read.
    return verdict(first.includes('SSH') ? 'ssh' : 'openpgp', null, 'malformed')
  }
  if (first === '-----BEGIN SIGNED MESSAGE-----') return verdict('x509', null, 'unsupported')
  return verdict('unknown', null, 'malformed')
}

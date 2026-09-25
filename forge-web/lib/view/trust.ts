/**
 * Trust-state derivation (view glue) — what the assay panel may claim, computed from checks
 * that actually ran.
 *
 * Roadmap invariant 4: a "verified" badge comes from a check that passed. Each link of the
 * chain gets one of five states:
 *
 *  - `verified`   — the check ran and passed for everything this page relied on.
 *  - `partial`    — it passed, but what is shown is not the whole answer (a diverged ref
 *                   shown by its provisional head; some objects read without a hash check).
 *  - `unverified` — the data was shown without the check (e.g. a non-trusted connection).
 *  - `pending`    — nothing has been checked yet (still connecting; no file bytes read).
 *  - `failed`     — the check ran and failed; the read was refused.
 *
 * Pure: callers pass the connection, the ref being attested and the session's
 * {@link ContentChecks}; no SDK, no React.
 */

import { NETWORKS, QUORUM_KEY_ENDPOINT, type Network } from '../constants'
import type { RefState } from '../rules'
import type { ContentChecks } from './content-checks'

export type TrustState = 'verified' | 'partial' | 'unverified' | 'pending' | 'failed'

/** One link of the chain: its state plus the sentence that justifies it. */
export interface TrustLink {
  readonly state: TrustState
  /** Short chip text (`proof`, `3 objects`, `diverged`). */
  readonly summary: string
  /** The honest one-paragraph explanation shown when the panel is open. */
  readonly detail: string
}

export interface TrustReport {
  readonly network: Network
  /** How the network is named in copy: its key, so a devnet reads `devnet-moutai`. */
  readonly networkLabel: string
  /** The HTTPS endpoint the quorum public keys come from (the trust anchor). */
  readonly quorumEndpoint: string
  /** Its host, for display. */
  readonly quorumHost: string
  readonly proofs: TrustLink
  readonly refs: TrustLink
  readonly content: TrustLink
  readonly source: TrustLink
  /** The panel's headline: the most severe link (see {@link worstOf}). */
  readonly overall: TrustState
}

/** Whether the Platform connection proof-checks its reads. */
export type ConnectionTrust = 'connecting' | 'trusted' | 'untrusted'

export interface TrustInputs {
  readonly network: Network
  readonly connection: ConnectionTrust
  /**
   * The ref this page attests: its folded state, or `missing` when the selected name matches
   * no ref. The ref reads themselves are the proof-read `refUpdate` log.
   */
  readonly tip: RefState | 'missing'
  readonly checks: ContentChecks
  /** The repo config's backend label — what the owner declared, not what served bytes. */
  readonly configuredBackend: string
}

/**
 * Severity order for the headline. `pending` ranks below `verified` so a page that has only
 * read refs so far (nothing to hash yet) reads as verified for what it showed, while any
 * weaker link — partial, unverified, failed — always wins.
 */
const SEVERITY: Readonly<Record<TrustState, number>> = {
  pending: 0,
  verified: 1,
  partial: 2,
  unverified: 3,
  failed: 4,
}

/** The most severe of a set of link states (`pending` only when every link is pending). */
export function worstOf(states: readonly TrustState[]): TrustState {
  let worst: TrustState = 'pending'
  for (const s of states) if (SEVERITY[s] > SEVERITY[worst]) worst = s
  return worst
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** `was` / `were` agreeing with `n`. */
function was(n: number): string {
  return n === 1 ? 'was' : 'were'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function deriveProofs(network: Network, connection: ConnectionTrust, endpoint: string): TrustLink {
  // The full key, so a devnet reads `devnet-moutai` rather than a bare `devnet`.
  const label = NETWORKS[network].key
  switch (connection) {
    case 'connecting':
      return {
        state: 'pending',
        summary: 'connecting',
        detail: `Connecting to ${label}. Nothing has been read or checked yet.`,
      }
    case 'untrusted':
      return {
        state: 'unverified',
        summary: 'off',
        detail:
          'This connection does not check proofs, so Platform reads are shown as the node returned them.',
      }
    case 'trusted':
      return {
        state: 'verified',
        summary: 'proof',
        detail: `This connection runs in trusted mode, which checks Platform reads against proofs signed by the ${label} quorum, using quorum public keys fetched from ${hostOf(endpoint)}.`,
      }
  }
}

function deriveRefs(input: TrustInputs): TrustLink {
  if (input.connection === 'connecting') {
    return { state: 'pending', summary: 'pending', detail: 'Refs have not been read yet.' }
  }
  if (input.connection === 'untrusted') {
    return {
      state: 'unverified',
      summary: 'unchecked',
      detail:
        'The tip was folded from the refUpdate log by FORGE_RULES_V1, but the log itself was read without proofs.',
    }
  }
  const tip = input.tip
  if (tip === 'missing') {
    return {
      state: 'verified',
      summary: 'proof',
      detail: 'No ref by this name exists in the proof-checked refUpdate log.',
    }
  }
  switch (tip.state) {
    case 'unborn':
      return {
        state: 'verified',
        summary: 'proof',
        detail: 'The proof-checked refUpdate log has no live commit for this ref.',
      }
    case 'diverged':
      return {
        state: 'partial',
        summary: 'diverged',
        detail: `${plural(tip.heads.length, 'concurrent push', 'concurrent pushes')} left this ref diverged. Each head is proof-checked, but no rule picks a winner yet: the page shows the newest head provisionally.`,
      }
    case 'resolved':
      return {
        state: 'verified',
        summary: 'proof',
        detail:
          'The tip was folded by FORGE_RULES_V1 from the proof-checked, append-only refUpdate log.',
      }
  }
}

function deriveContent(checks: ContentChecks): TrustLink {
  const link = deriveReadContent(checks)
  const missing = checks.unavailablePacks.length
  if (missing === 0 || link.state === 'failed') return link
  // Everything shown passed its check, but the answer is incomplete: objects only the
  // skipped packs hold cannot be shown at all. That is at best `partial`, never `verified`
  // — and never `pending` either, since the skip is known before any object is read.
  const note = `${plural(missing, 'pack')} could not be fetched from ${missing === 1 ? 'its' : 'their'} storage, so some objects may be missing.`
  return {
    state: link.state === 'unverified' ? 'unverified' : 'partial',
    summary: `${missing} ${missing === 1 ? 'pack' : 'packs'} missing`,
    detail: `${note} ${link.detail}`,
  }
}

/** The content link from what was read, before accounting for packs that were skipped. */
function deriveReadContent(checks: ContentChecks): TrustLink {
  const failed = checks.objectsFailed + checks.packsFailed
  if (failed > 0) {
    const parts: string[] = []
    if (checks.objectsFailed > 0) parts.push(`${plural(checks.objectsFailed, 'object')} did not hash to the git id requested`)
    if (checks.packsFailed > 0) parts.push(`${plural(checks.packsFailed, 'pack')} did not match ${checks.packsFailed === 1 ? 'its' : 'their'} manifest`)
    return {
      state: 'failed',
      summary: `${failed} failed`,
      detail: `${parts.join('; ')}. Those reads were refused and nothing from them is shown.`,
    }
  }

  const checked = checks.objectsVerified + checks.packsVerified
  if (checked === 0 && checks.objectsUnchecked === 0) {
    return {
      state: 'pending',
      summary: 'none read',
      detail:
        'No file contents have been read from this repo yet this session. Every object that is read will be re-hashed and compared with its git id before it is shown.',
    }
  }

  const packs =
    checks.packsVerified > 0
      ? ` ${plural(checks.packsVerified, 'pack')} downloaded whole matched the sha256 in ${checks.packsVerified === 1 ? 'its' : 'their'} proof-checked manifest.`
      : ''
  if (checks.objectsUnchecked > 0) {
    return {
      state: checked > 0 ? 'partial' : 'unverified',
      summary: `${checks.objectsUnchecked} unchecked`,
      detail: `${plural(checks.objectsUnchecked, 'object')} ${was(checks.objectsUnchecked)} shown without a hash check; ${plural(checks.objectsVerified, 'object')} matched ${checks.objectsVerified === 1 ? 'its' : 'their'} git id.${packs}`,
    }
  }
  return {
    state: 'verified',
    summary: plural(checks.objectsVerified, 'object'),
    detail: `${plural(checks.objectsVerified, 'object')} read this session ${was(checks.objectsVerified)} re-hashed and matched the git id (SHA-1) ${checks.objectsVerified === 1 ? 'it was' : 'they were'} requested by.${packs}`,
  }
}

function deriveSource(input: TrustInputs, content: TrustLink): TrustLink {
  const sources = input.checks.sources
  if (sources.length === 0) {
    return {
      state: 'pending',
      summary: input.configuredBackend,
      detail: `No bytes fetched yet. The owner's configured backend is ${input.configuredBackend}; readers follow each pack's own manifest, wherever it points.`,
    }
  }
  return {
    // A source is only ever as good as the content check on what it served.
    state: content.state,
    summary: sources.length === 1 ? (sources[0] as string) : `${sources.length} sources`,
    detail: `Bytes came from ${sources.join(', ')}. Sources provide availability, not authenticity: bytes are trusted only if they pass the hash check above.`,
  }
}

/** Derive the whole chain from the checks that actually ran. */
export function deriveTrust(input: TrustInputs): TrustReport {
  const quorumEndpoint = QUORUM_KEY_ENDPOINT[input.network]
  const proofs = deriveProofs(input.network, input.connection, quorumEndpoint)
  const refs = deriveRefs(input)
  const content = deriveContent(input.checks)
  const source = deriveSource(input, content)
  return {
    network: input.network,
    networkLabel: NETWORKS[input.network].key,
    quorumEndpoint,
    quorumHost: hostOf(quorumEndpoint),
    proofs,
    refs,
    content,
    source,
    overall: worstOf([proofs.state, refs.state, content.state, source.state]),
  }
}

/** The proofs link alone — for surfaces (the landing page) that attest no repo. */
export function deriveConnectionTrust(network: Network, connection: ConnectionTrust): TrustLink {
  return deriveProofs(network, connection, QUORUM_KEY_ENDPOINT[network])
}

/** Map the SDK hook's flags to a {@link ConnectionTrust}. */
export function connectionTrust(ready: boolean, trusted: boolean): ConnectionTrust {
  if (!ready) return 'connecting'
  return trusted ? 'trusted' : 'untrusted'
}

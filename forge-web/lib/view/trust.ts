/**
 * Trust-state derivation (view glue): what the Verification card may claim, computed from
 * checks that actually ran (`ux-dx-spec.md` §6).
 *
 * Roadmap invariant 4: a green state comes from a check that passed. Each of the card's four
 * rows (chain data, branch tip, file contents, where the bytes came from) gets one of five
 * states. The identifiers are kept from the old "assay" panel; the UI words are:
 *
 *  - `verified`   **Verified**: the check ran and passed for everything this page relied on.
 *  - `partial`    **Partly verified**: it passed, but not for the whole answer (one quorum-key
 *                 source, a diverged ref shown provisionally, a pack that could not be fetched).
 *  - `pending`    **Not checked yet** (the headline reads **Checking…** while the chain check
 *                 is still running): nothing has been checked.
 *  - `unverified` **Couldn't verify**: the check could not run (a connection that does not
 *                 check proofs, storage that did not answer).
 *  - `failed`     **Failed**: the check ran and the data was wrong.
 *
 * Pure: callers pass the connection, the quorum cross-check outcome, the attested ref and the
 * session's {@link ContentChecks}; no SDK, no React.
 */

import { NETWORKS, QUORUM_KEY_ENDPOINT, type Network } from '../constants'
import type { RefHead, RefState } from '../rules'
import { viewSources, type ContentChecks } from './content-checks'
import { ROTATION_REASON, type QuorumCrossCheck } from './quorum-check'
import { plural, shortOid, timeAgo, urlHost } from './format'
import { readGateways } from './storage-status'

export type TrustState = 'verified' | 'partial' | 'unverified' | 'pending' | 'failed'

/** The UI word for each state (`ux-dx-spec.md` §6.1). */
export const TRUST_LABEL: Readonly<Record<TrustState, string>> = {
  verified: 'Verified',
  partial: 'Partly verified',
  unverified: "Couldn't verify",
  pending: 'Not checked yet',
  failed: 'Failed',
}

/** The card's four rows, in order. */
export type TrustRow = 'chain' | 'tip' | 'content' | 'source'

/** Each row's title on the card and in the failure banner (`ux-dx-spec.md` §6.2). */
export const TRUST_ROW_TITLE: Readonly<Record<TrustRow, string>> = {
  chain: 'Chain data',
  tip: 'Branch tip',
  content: 'File contents',
  source: 'Where the bytes came from',
}

/** One row of the card: its state plus the sentence that justifies it. */
export interface TrustLink {
  readonly state: TrustState
  /** The plain sentence shown when the card is open. */
  readonly detail: string
  /** Small type under the sentence: how the check was done. */
  readonly note?: string
  /** The row is still running its check (headline reads "Checking…"). */
  readonly checking?: boolean
}

/** The branch-tip row, with the facts the card renders (authors resolve to names there). */
export interface TipLink extends TrustLink {
  /** The short ref name (`main`, `v1.0`). */
  readonly name: string
  /** The signed update(s) at the tip: one when resolved, every candidate when diverged. */
  readonly heads: readonly RefHead[]
}

export interface TrustReport {
  readonly network: Network
  /** How the network is named in copy: its key, so a devnet reads `devnet-moutai`. */
  readonly networkLabel: string
  /** The HTTPS endpoint the quorum public keys come from (the trust anchor). */
  readonly quorumEndpoint: string
  /** Its host, for display. */
  readonly quorumHost: string
  readonly chain: TrustLink
  readonly tip: TipLink
  readonly content: TrustLink
  readonly source: TrustLink
  /** The card's headline: the most severe row (see {@link overallOf}). */
  readonly overall: TrustState
  /** The collapsed line: `Verified · refs by proof · 214 objects checked this session · from r2.dev`. */
  readonly summary: string
}

/**
 * Whether the Platform connection proof-checks its reads. `offline`: a trusted connection
 * exists but Platform is unreachable now, so what the page shows was checked earlier and is
 * not being re-checked. `clock`: the device clock is too far off the network's, so the SDK
 * refuses every answer as stale (QW2-018): nothing new is read or checked.
 */
export type ConnectionTrust = 'connecting' | 'trusted' | 'untrusted' | 'offline' | 'clock'

export interface TrustInputs {
  readonly network: Network
  readonly connection: ConnectionTrust
  /** The quorum-key cross-check, or undefined while it runs. */
  readonly quorum?: QuorumCrossCheck
  /** The short name of the ref this page attests (`main`). */
  readonly refName?: string
  /**
   * Its folded state, `missing` when the selected name matches no ref, or a commit pinned by
   * id (a permalink). A pinned commit that is a ref's proven tip carries that ref (`at`): the
   * ref vouches for it as it would on the branch's own page ({@link pinnedAt}).
   */
  readonly tip: RefState | 'missing' | { readonly pinned: string; readonly at?: { readonly name: string; readonly state: RefState } }
  readonly checks: ContentChecks
  /** The repo config's backend label: what the owner declared, not what served bytes. */
  readonly configuredBackend: string
  /** The config's declared storage URIs (hosts not tried are listed as such). */
  readonly configuredUris?: readonly string[]
  /** The IPFS gateways this repo's reads try ({@link readGatewaysFor}); default: the reader's. */
  readonly gateways?: readonly string[]
}

/**
 * Severity order. `pending` ranks below `verified` so a page that has only read refs so far
 * (nothing to hash yet) reads as verified for what it showed, while any weaker row wins.
 */
const SEVERITY: Readonly<Record<TrustState, number>> = {
  pending: 0,
  verified: 1,
  partial: 2,
  unverified: 3,
  failed: 4,
}

/** The most severe of a set of states (`pending` only when every one is pending). */
export function worstOf(states: readonly TrustState[]): TrustState {
  let worst: TrustState = 'pending'
  for (const s of states) if (SEVERITY[s] > SEVERITY[worst]) worst = s
  return worst
}

function deriveChain(
  network: Network,
  connection: ConnectionTrust,
  endpoint: string,
  quorum: QuorumCrossCheck | undefined,
): TrustLink {
  // The full key, so a devnet reads `devnet-moutai` rather than a bare `devnet`.
  const label = NETWORKS[network].key
  const host = urlHost(endpoint)
  if (connection === 'connecting') {
    return { state: 'pending', checking: true, detail: `Connecting to Dash ${label}. Nothing has been read or checked yet.` }
  }
  if (connection === 'untrusted') {
    return {
      state: 'unverified',
      detail: 'This connection does not check proofs, so Platform data is shown as the node returned it.',
    }
  }
  // A known key mismatch stays a failure whatever the connection's state.
  if (connection === 'clock' && quorum?.state !== 'mismatch') {
    return {
      state: 'unverified',
      detail: `This device's clock is too far off the Dash network's, so every answer from ${label} is refused as stale. Nothing new can be read or checked until the clock is right.`,
      note: "Each Platform answer carries the time its block was made, and the SDK refuses one too far from this device's clock. Set the clock to update automatically, then try again.",
    }
  }
  if (connection === 'offline' && quorum?.state !== 'mismatch') {
    return {
      state: 'partial',
      detail: `Can't reach Dash ${label} right now. What this page shows was proven earlier in this tab and is not being re-checked.`,
      note: `Proofs were checked against quorum keys fetched from ${host}. Nothing new is read until the connection comes back.`,
    }
  }
  const proven = `Refs, issues and members were proven against Dash ${label}.`
  const refetch =
    "This app fetched the key list again to compare; it cannot inspect the copy the SDK holds."
  if (quorum === undefined) {
    return {
      state: 'pending',
      checking: true,
      detail: proven,
      note: `Proofs are checked against quorum keys fetched from ${host}. Comparing those keys with a second source…`,
    }
  }
  switch (quorum.state) {
    case 'agreed':
      return {
        state: 'verified',
        detail: proven,
        note: `Proofs are checked against quorum keys fetched from ${quorum.primary} and ${quorum.secondary} (a DAPI node); both agreed on every one of the ${plural(quorum.overlap, 'quorum')} used. ${refetch}`,
      }
    case 'single':
      return {
        state: 'partial',
        detail: `${proven} Only one key source answered.`,
        note:
          quorum.reason === 'no-second-source'
            ? `Proofs are checked against quorum keys fetched from ${quorum.primary}. No second source is configured for this network, so nothing independent confirmed those keys.`
            : `Proofs are checked against quorum keys fetched from ${quorum.primary}. None of the DAPI nodes asked for a second copy answered.`,
      }
    case 'mismatch':
      return {
        state: 'failed',
        detail: `The quorum keys this app checks proofs against do not match a second source for ${plural(quorum.quorums.length, 'quorum')}. Do not rely on this page.`,
        note: `${quorum.primary} and ${quorum.secondary} (a DAPI node) returned different keys for ${quorum.quorums.map((q) => shortOid(q, 12)).join(', ')}. Use the CLI against a node you run.`,
      }
    case 'unavailable':
      return {
        state: 'partial',
        detail: `${proven} The keys could not be compared with a second source.`,
        note: `Proofs are checked against quorum keys fetched from ${host}. The comparison couldn't run: ${quorum.reason}.${quorum.reason === ROTATION_REASON ? ' It is tried again in a minute or two while this page is open.' : ''}`,
      }
  }
}

function newest(heads: readonly RefHead[]): RefHead | undefined {
  return [...heads].sort((a, b) => b.createdAt - a.createdAt)[0]
}

function deriveTip(input: TrustInputs): TipLink {
  const tip = deriveTipNow(input)
  // The tip's proof was checked against quorum keys a second source disputes (chain data
  // Failed): that proof shows nothing, so the tip is not verified, even in part (QW-009).
  // A commit pinned by id relies on no ref, so its row stands; one vouched for by a ref's tip
  // does rely on that ref's proof.
  const pinned = input.tip !== 'missing' && 'pinned' in input.tip && input.tip.at === undefined
  if (input.quorum?.state === 'mismatch' && !pinned && (tip.state === 'verified' || tip.state === 'partial')) {
    return {
      ...tip,
      state: 'unverified',
      note: 'Not verified: a second source disagrees with the quorum keys used to check this proof. See Chain data.',
    }
  }
  // Offline: the tip was proven when it was read, but a newer push may exist.
  return input.connection === 'offline' && tip.state === 'verified' ? { ...tip, state: 'partial' } : tip
}

function deriveTipNow(input: TrustInputs): TipLink {
  const name = input.refName ?? ''
  const shown = name === '' ? 'This ref' : `\`${name}\``
  const tip = input.tip
  if (tip !== 'missing' && 'pinned' in tip) {
    const at = tip.at
    // The permalink of a ref's tip (`y` on a branch page): that ref's proof vouches for it
    // (QW3-043: "Partly verified" for the proven tip of master). Folded like the ref itself.
    if (at !== undefined && at.state.state === 'resolved' && at.state.oid === tip.pinned) {
      const ref = deriveTipNow({ ...input, refName: at.name, tip: at.state })
      return {
        ...ref,
        name: shortOid(tip.pinned),
        detail: `Commit \`${shortOid(tip.pinned)}\`, opened by its id, is the tip of \`${at.name}\`. ${ref.detail}`,
      }
    }
    return {
      name: shortOid(tip.pinned),
      heads: [],
      state: 'partial',
      detail: `Commit \`${shortOid(tip.pinned)}\`, opened by its id. Its files are verified, but no branch or tag was checked to point at it.`,
    }
  }
  const heads: readonly RefHead[] =
    tip === 'missing' || tip.state === 'unborn'
      ? []
      : tip.state === 'resolved'
        ? [{ id: '', oid: tip.oid, author: tip.author, createdAt: tip.createdAt }]
        : tip.heads
  const base = { name, heads }
  if (input.connection === 'connecting') {
    return { ...base, state: 'pending', checking: true, detail: 'Refs have not been read yet.' }
  }
  const signed = (h: RefHead): string =>
    `${shown} = \`${shortOid(h.oid)}\`, the latest signed update by ${shortOid(h.author, 8)}, ${timeAgo(h.createdAt)}.`
  if (input.connection === 'clock' && heads.length === 0) {
    // Nothing read yet (or an unborn ref): say why, not "has no commit".
    return { ...base, state: 'unverified', detail: `${shown} could not be read while this device's clock is off.` }
  }
  if (input.connection === 'untrusted' || input.connection === 'clock') {
    const h = newest(heads)
    return {
      ...base,
      state: 'unverified',
      detail: h ? signed(h) : `${shown} has no commit.`,
      note:
        input.connection === 'clock'
          ? "From the history read earlier. It won't be re-read while this device's clock is off."
          : 'From history that was read without proofs.',
    }
  }
  const note =
    input.connection === 'offline'
      ? 'From the history read earlier in this tab. It will be re-checked when Platform is reachable.'
      : "Built from the repo's update history, checked against Platform proofs."
  if (tip === 'missing') {
    return { ...base, state: 'verified', detail: `No ref named ${shown} exists.`, note }
  }
  switch (tip.state) {
    case 'unborn':
      return { ...base, state: 'verified', detail: `${shown} points at no commit.`, note }
    case 'diverged':
      return {
        ...base,
        state: 'partial',
        detail: `${shown} diverged: ${plural(tip.heads.length, 'concurrent push', 'concurrent pushes')}, each signed. No rule picks a winner yet; this page shows the newest.`,
        note,
      }
    case 'resolved':
      return { ...base, state: 'verified', detail: signed(heads[0] as RefHead), note }
  }
}

function deriveContent(checks: ContentChecks): TrustLink {
  const link = deriveReadContent(checks)
  const missing = checks.unavailablePacks.length
  if (missing === 0 || link.state === 'failed') return link
  // Everything shown passed its check, but the answer is incomplete: objects only the skipped
  // packs hold cannot be shown at all. That is at best `partial`, never `verified`, and never
  // `pending` either, since the skip is known before any object is read.
  const corrupt = checks.corruptMirrorPacks.length
  const bad =
    corrupt > 0
      ? ` A mirror served bad data (bytes that fail the manifest sha256) for ${plural(corrupt, 'pack')}; it was refused.`
      : ''
  if (link.state === 'pending') {
    // Nothing checked yet, so not even partly verified (QW3-044: "Partly verified" over "No file
    // contents have been read yet"). The packs still reachable may verify what the page reads.
    return {
      state: 'pending',
      detail: `${plural(missing, 'pack')} could not be fetched from ${missing === 1 ? 'its' : 'their'} storage, so some files may be missing.${bad} ${link.detail}`,
    }
  }
  return {
    state: link.state === 'unverified' ? 'unverified' : 'partial',
    detail: `${plural(missing, 'pack')} could not be fetched from ${missing === 1 ? 'its' : 'their'} storage, so some files may be missing.${bad} ${link.detail}`,
    ...(link.note ? { note: link.note } : {}),
  }
}

/** The content row from what was read, before accounting for packs that were skipped. */
function deriveReadContent(checks: ContentChecks): TrustLink {
  const packs =
    checks.packsVerified > 0
      ? `${plural(checks.packsVerified, 'pack')} downloaded whole matched ${checks.packsVerified === 1 ? 'its' : 'their'} verified checksum.`
      : undefined
  const failed = checks.objectsFailed + checks.packsFailed
  if (failed > 0) {
    const parts: string[] = []
    if (checks.objectsFailed > 0) {
      const total = checks.objectsFailed + checks.objectsVerified + checks.objectsUnchecked
      parts.push(`${checks.objectsFailed.toLocaleString('en-US')} of ${plural(total, 'object')} did not match their git hash`)
    }
    if (checks.packsFailed > 0) parts.push(`${plural(checks.packsFailed, 'pack')} did not match ${checks.packsFailed === 1 ? 'its' : 'their'} manifest`)
    return { state: 'failed', detail: `${parts.join('; ')}. Nothing from them is shown.` }
  }

  const checked = checks.objectsVerified + checks.packsVerified
  if (checked === 0 && checks.objectsUnchecked === 0) {
    return {
      state: 'pending',
      detail: 'No file contents have been read yet. Each object is re-hashed and compared with its git id before it is shown.',
    }
  }
  const total = checks.objectsVerified + checks.objectsUnchecked
  if (checks.objectsUnchecked > 0) {
    return {
      state: checked > 0 ? 'partial' : 'unverified',
      detail: `${checks.objectsVerified.toLocaleString('en-US')} of ${plural(total, 'object')} read this session matched their git hash; ${checks.objectsUnchecked} ${checks.objectsUnchecked === 1 ? 'was' : 'were'} shown without the check.`,
      ...(packs ? { note: packs } : {}),
    }
  }
  return {
    state: 'verified',
    detail: `${checks.objectsVerified.toLocaleString('en-US')} of ${plural(total, 'object')} read this session matched their git hash.`,
    ...(packs ? { note: packs } : {}),
  }
}

/** A source name as the card says it. */
function sourceName(source: string): string {
  if (source === 'platform') return 'Dash Platform (permanent)'
  if (source === 'browser cache') return "this browser's cache (verified when saved)"
  return source
}

function deriveSource(input: TrustInputs, content: TrustLink): TrustLink {
  const { sources, unreachable, fellBackFrom, mirroredPacks } = input.checks
  const gatewayHosts = new Set((input.gateways ?? readGateways()).map(urlHost))
  const tried = new Set(sources.map((s) => (gatewayHosts.has(s) ? 'ipfs' : s)))
  const notTried = [...new Set((input.configuredUris ?? []).map(urlHost))].filter((h) => h !== '' && !tried.has(h))
  // A recorded copy that failed while another served: named, but nothing is missing, so the
  // row's state is the content check's.
  const fellBack = fellBackFrom.length > 0 ? ` Unavailable, another copy served instead: ${fellBackFrom.join(', ')}.` : ''
  const alsoRecorded = notTried.length > 0 ? ` Also recorded: ${notTried.map((h) => `${h} (not tried)`).join(', ')}.` : ''
  // Packs no recorded copy served: a pack mirror anyone may delete is all that holds them.
  const n = mirroredPacks.length
  const mirrored =
    n > 0
      ? ` No recorded copy of ${n === 1 ? 'a pack' : `${n} packs`} answered, so a mirror someone else recorded served ${n === 1 ? 'it' : 'them'}. Ask a maintainer to store ${n === 1 ? 'it' : 'them'} again.`
      : ''
  const also = fellBack + mirrored + alsoRecorded
  const failedPlaces = unreachable.length > 0 ? `Didn't answer: ${unreachable.join(', ')}.` : undefined
  if (sources.length === 0) {
    if (failedPlaces !== undefined) {
      // Nothing was served at all: the places this repo stores its files are down. That is an
      // availability problem, not a failed check: nothing arrived, so nothing was found wrong
      // (bad bytes are the content row's `failed`). "Couldn't verify", never a red Failed.
      return {
        state: 'unverified',
        detail: `No storage answered, so no file could be fetched to check. ${failedPlaces}`,
        note: 'Storage provides availability, not authenticity: bytes are shown only if they pass the hash check above.',
      }
    }
    return {
      state: 'pending',
      detail: `Nothing fetched yet. The owner's configured storage is ${input.configuredBackend}.${also}`,
    }
  }
  return {
    // A source is only ever as good as the content check on what it served.
    state: failedPlaces !== undefined && content.state === 'verified' ? 'partial' : content.state,
    detail: `${sources.map(sourceName).join(', ')}.${also}${failedPlaces ? ` ${failedPlaces}` : ''}`,
    note: 'Storage provides availability, not authenticity: bytes are shown only if they pass the hash check above.',
  }
}

/** The headline: "Checking…" while the chain check runs, else the worst row. */
function overallOf(chain: TrustLink, rows: readonly TrustLink[]): TrustState {
  if (chain.checking) return 'pending'
  return worstOf(rows.map((r) => r.state))
}

function summaryOf(overall: TrustState, chain: TrustLink, checks: ContentChecks): string {
  if (chain.checking) return 'Checking…'
  const parts = [TRUST_LABEL[overall]]
  if (chain.state === 'verified' || chain.state === 'partial') parts.push('refs by proof')
  // A tally of this tab's reads, not a property of the repo: it grows as the viewer browses (L-81).
  if (checks.objectsVerified > 0) parts.push(`${plural(checks.objectsVerified, 'object')} checked this session`)
  // The places that served THIS view's objects: the session's first source named Platform for
  // a file an S3 mirror served (L-18).
  const served = viewSources(checks)
  if (served.length > 0) parts.push(`from ${served.map((s) => (s === 'platform' ? 'Platform' : s)).join(', ')}`)
  return parts.join(' · ')
}

/** Derive the whole card from the checks that actually ran. */
export function deriveTrust(input: TrustInputs): TrustReport {
  const quorumEndpoint = QUORUM_KEY_ENDPOINT[input.network]
  const chain = deriveChain(input.network, input.connection, quorumEndpoint, input.quorum)
  const tip = deriveTip(input)
  const content = deriveContent(input.checks)
  const source = deriveSource(input, content)
  const overall = overallOf(chain, [chain, tip, content, source])
  return {
    network: input.network,
    networkLabel: NETWORKS[input.network].key,
    quorumEndpoint,
    quorumHost: urlHost(quorumEndpoint),
    chain,
    tip,
    content,
    source,
    overall,
    summary:
      input.connection === 'offline'
        ? `${TRUST_LABEL[overall]} · Not re-checked · Platform unreachable`
        : input.connection === 'clock'
          ? `${TRUST_LABEL[overall]} · Device clock is off`
          : summaryOf(overall, chain, input.checks),
  }
}

/** A row whose check ran and found the data wrong: what the failure banner lists. */
export interface TrustFailure {
  readonly row: TrustRow
  readonly title: string
  readonly detail: string
  readonly note?: string
}

/**
 * The card's Failed rows, in card order, for the banner a page leads with (QW-004): a failure
 * must not sit only in the rail. `rows` limits it to the rows a surface owns. The app shell
 * already heads every page with a chain-data failure, so a repo page passes the other rows.
 */
export function failedRows(report: TrustReport, rows: readonly TrustRow[] = ['chain', 'tip', 'content', 'source']): TrustFailure[] {
  return rows
    .map((row) => ({ row, link: report[row] }))
    .filter(({ link }) => link.state === 'failed')
    .map(({ row, link }) => ({ row, title: TRUST_ROW_TITLE[row], detail: link.detail, ...(link.note ? { note: link.note } : {}) }))
}

/** The chain row alone, for surfaces (the landing page) that attest no repo. */
export function deriveConnectionTrust(
  network: Network,
  connection: ConnectionTrust,
  quorum?: QuorumCrossCheck,
): TrustLink {
  return deriveChain(network, connection, QUORUM_KEY_ENDPOINT[network], quorum)
}

/**
 * Map the SDK hook's flags to a {@link ConnectionTrust}. `unreachable`: the service's status
 * is `error` (Platform cannot be reached now), which degrades a trusted connection.
 * `clockOff`: a read was refused for the device clock (`lib/sdk/clock-skew.ts`), whether or
 * not a connection came up: that is the reason nothing reads, not the network.
 */
export function connectionTrust(ready: boolean, trusted: boolean, unreachable = false, clockOff = false): ConnectionTrust {
  // A connection that checks no proofs says so first: the clock does not change that.
  if (ready && !trusted) return 'untrusted'
  if (clockOff) return 'clock'
  if (!ready) return 'connecting'
  return unreachable ? 'offline' : 'trusted'
}

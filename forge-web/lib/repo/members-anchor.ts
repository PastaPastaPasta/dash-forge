/**
 * What the anchor `config` of a key epoch carries (DESIGN D1, §4.1; `private-repos.md` §5.3, §17;
 * parity: forge-core `keyring::anchor_content`, pinned by the `mixed_anchor__*` vectors). Pure.
 *
 * - A **private** repo's anchor repeats its settings: the default branch and protected patterns
 *   sealed, `backend` and `archived` in plaintext.
 * - A **public** repo's members key ("turn on members-only content") carries `vis: "public"` and
 *   none of the settings, whatever they are: an empty TLV at epoch 0, and above it only the chain
 *   link. Rotations and re-anchors carry nothing forward, so an anchor can never be read as the
 *   repo's settings (they stay in its plaintext configs, which the git plane reads).
 */

import { EpochKeys, sealDoc, encodeSealOffMarker, type SealOffMarker, type DocFields } from '../private'
import type { Visibility } from '../rules/v2'

/** A repo's current settings, as the anchor writer is given them. */
export interface AnchorSettings {
  /** Short branch name. */
  readonly defaultBranch: string
  readonly protectedPatterns: readonly string[]
  /** The plaintext `backend` object. */
  readonly backend: unknown
  readonly archived: boolean
}

/** The chain link of an epoch `e ≥ 1` (§5.3). Its keys are secrets: the caller wipes them. */
export interface ChainLink {
  readonly prevEpoch: number
  readonly prevEpochKey?: Uint8Array
  readonly skipEpochKey?: Uint8Array
  readonly burned?: boolean
}

/** What an anchor carries: its `vis`, its sealed fields, and the plaintext properties beside `enc`. */
export interface AnchorContent {
  readonly vis: Visibility
  readonly fields: DocFields
  /** `backend`, `archived` (a private repo's only). */
  readonly plaintext: Readonly<Record<string, unknown>>
}

/** The anchor `config` of an epoch of a `visibility` repo, given its current `settings` and chain `link` (null: epoch 0). */
export function anchorContent(visibility: Visibility, settings: AnchorSettings, link: ChainLink | null, sealOff?: SealOffMarker): AnchorContent {
  const base: DocFields =
    visibility === 'private' ? { defaultBranch: settings.defaultBranch, protectedPatterns: [...settings.protectedPatterns], ...(sealOff !== undefined ? { sealOff: encodeSealOffMarker(sealOff) } : {}) } : {}
  const plaintext: Record<string, unknown> = visibility === 'private' ? { backend: settings.backend, archived: settings.archived } : {}
  const fields: DocFields =
    link === null
      ? base
      : {
          ...base,
          prevEpoch: link.prevEpoch,
          ...(link.prevEpochKey !== undefined ? { prevEpochKey: link.prevEpochKey } : {}),
          ...(link.skipEpochKey !== undefined ? { skipEpochKey: link.skipEpochKey } : {}),
          ...(link.burned === true ? { burned: true as const } : {}),
        }
  return { vis: visibility, fields, plaintext }
}

/** Dry-seal settings with the maximum chain link before a conversion posts any wraps. */
export async function drySealOffAnchor(repoId: Uint8Array, owner: Uint8Array, settings: AnchorSettings, marker: SealOffMarker): Promise<void> {
  const raw = new Uint8Array(32)
  const keys = await EpochKeys.import(repoId, marker.boundaryEpoch, raw)
  const content = anchorContent('private', settings, { prevEpoch: marker.boundaryEpoch - 1, prevEpochKey: raw, skipEpochKey: raw }, marker)
  try {
    await sealDoc(keys, { type: 'config', ownerId: owner, epoch: marker.boundaryEpoch }, content.fields, { anchor: true })
  } finally { raw.fill(0) }
}

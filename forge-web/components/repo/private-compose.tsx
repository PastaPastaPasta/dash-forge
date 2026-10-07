'use client'

/**
 * Whether this browser can write sealed content (an issue, comment, PR or review) to a private
 * repo, and what to say when it cannot (`docs/security/private-repos.md` §5.3, §9): only a
 * member holding the current key, while the epoch is writable (not burned, no non-member
 * holding it). The seal itself happens in `lib/repo/private-writes.ts` on every write.
 */

import type { RepoRef } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import { SEALED_TEXT_LIMIT, sealedTextUse, writeBlockReason, type SealedKind } from '@/lib/repo/private-writes'
import { previewCreate, previewCredits, sumPreviews, type CostPreview, type FirstWrite } from '@/lib/sdk'
import { fieldEstimate, isLongBody, longBodyCredits } from '@/lib/repo/long-body'
import { utf8Bytes } from '@/lib/rules/long-body'
import { PAD_BUCKET, pads } from '@/lib/private'
import { admissionFor, estimateBytesCredits } from '@/lib/sdk/cost'
import { BODY_LIMIT, TITLE_LIMIT, textUse, type TextLimit } from '@/lib/view/text-limits'
import { TextCounter } from '@/components/ui/text-counter'
import { LongComposeNote, type LongCompose } from '@/components/repo/long-body'

/** For a public repo: always null. For a private one: null when sealed writes can go ahead, else why not. */
export function privateComposeBlock(home: RepoHome): string | null {
  return privateWriteBlock(home.repo, home.private)
}

/** {@link privateComposeBlock} from a repo and its private access (components without a home). */
export function privateWriteBlock(repo: RepoRef, access: RepoHome['private']): string | null {
  if (repo.visibility !== 'private') return null
  if (access?.access === 'no-key') return 'Add your encryption key to this browser (Settings → Private repos) to write to this private repo.'
  if (access?.access === 'locked') return 'Unlock to write to this private repo.'
  if (access?.access !== 'member') return 'Only members can write to a private repo.'
  return writeBlockReason(access.session.resolution)
}

/** The note shown in place of a composer on a private repo that cannot be written to. */
export function PrivateComposeNote({ reason }: { reason: string }): JSX.Element {
  return (
    <p className="text-dense text-anvil-500 dark:text-anvil-400" data-testid="private-compose-note">
      {reason}
    </p>
  )
}

/**
 * What a new document costs: on a private repo its text is stored sealed (`enc`: the text, 3
 * bytes of framing per field, and a 29-byte frame), priced as such; public ones as they are. An
 * `event` is sealed only when it carries a value (a label, assignee or milestone).
 */
export function composeCost(
  repo: RepoRef,
  kind: SealedKind | 'event',
  input: Readonly<Record<string, unknown>>,
  first: FirstWrite = {},
  /** A public repo's members-only text is stored encrypted too (DESIGN §4.1): priced so. */
  audience: 'public' | 'members' = 'public',
): CostPreview {
  // A body over its field is priced as the field it is written as, plus its artifact
  // (forge-v2.md §6.3: `longBodyField`).
  const body = input['body']
  const long = kind !== 'event' && typeof body === 'string' && isLongBody(repo, kind, body, input)
  const data = long ? { ...input, body: fieldEstimate(repo, kind, body, input) } : input
  const extra = long ? previewCredits(longBodyCredits(repo, utf8Bytes(body))) : null
  const doc = composeDocCost(repo, kind, data, first, audience)
  return extra === null ? doc : sumPreviews([doc, extra])
}

/**
 * A members-only (`enc` v0x03) document's framing (§4.1): version (1), nonce (12), the key
 * commitment `COMMIT_obj` (32) and the AES-GCM tag (16), 61 bytes in all.
 */
const MEMBERS_FRAME = 1 + 12 + 32 + 16
/** A TLV record's header: its tag (1) and length (2). The padding record has one too. */
const RECORD_HEADER = 3

/**
 * The `enc` bytes of a members-only `kind` whose sealed fields hold `used` bytes in `fields`
 * records: the records, the padding record that ends the TLV on a multiple of 64 bytes (D28: an
 * issue, PR, comment or review), and the framing (`sealMembersDoc`'s length).
 */
export function membersEncBytes(kind: SealedKind | 'event', used: number, fields: number): number {
  const records = used + RECORD_HEADER * fields
  const tlv = pads(kind) ? Math.ceil((records + RECORD_HEADER) / PAD_BUCKET) * PAD_BUCKET : records
  return tlv + MEMBERS_FRAME
}

function composeDocCost(
  repo: RepoRef,
  kind: SealedKind | 'event',
  data: Readonly<Record<string, unknown>>,
  first: FirstWrite,
  audience: 'public' | 'members',
): CostPreview {
  const { used, fields, props } = sealedTextUse(kind, data)
  const members = repo.visibility === 'public' && audience === 'members'
  if ((repo.visibility !== 'private' && !members) || (fields === 0 && kind === 'event')) return previewCreate(kind, data, first)
  const bind = Object.fromEntries(Object.entries(data).filter(([k]) => !props.includes(k)))
  const sealedBytes = members ? membersEncBytes(kind, used, fields) : used + 3 * fields + 29
  const credits = estimateBytesCredits(kind, sealedBytes, bind, first)
  return previewCredits(credits, admissionFor(kind, sealedBytes, credits))
}

/**
 * Whether a composer's text cannot be stored (D-049): on a private repo the sealed text limit,
 * else the contract's own (`body` 5,120 bytes and characters, `title` 1,024 bytes / 256
 * characters). A composer disables its submit on it, so nothing over-long is signed.
 */
export function composeTooLong(repo: RepoRef, kind: SealedKind, data: Readonly<Record<string, unknown>>, long?: LongCompose): boolean {
  // a body over the field that this viewer may store whole (`useLongCompose`) is written so; the
  // title still has its own limit
  if (long?.long) return long.problem !== null || (repo.visibility !== 'private' && typeof data['title'] === 'string' && textUse(data['title'], TITLE_LIMIT).over)
  if (repo.visibility === 'private') {
    const { used, limit } = sealedTextUse(kind, data)
    return limit !== null && used > limit
  }
  const over = (v: unknown, limit: TextLimit): boolean => typeof v === 'string' && textUse(v, limit).over
  return over(data['body'], BODY_LIMIT) || over(data['title'], TITLE_LIMIT)
}

/**
 * The public composer's live byte counter for a body (private repos show {@link SealedLimit}); a
 * text over the field (`long`, `useLongCompose`) shows where its whole text goes instead.
 */
export function BodyCounter({ repo, text, field = 'text', long }: { repo: RepoRef; text: string; field?: string; long?: LongCompose }): JSX.Element | null {
  if (long?.long) return <LongComposeNote compose={long} text={text} />
  if (repo.visibility === 'private') return null
  return <TextCounter text={text} limit={BODY_LIMIT} field={field} />
}

/**
 * The composer line §4.3 asks for on a private repo: the combined size limit of the sealed text,
 * and how much of it is used. Null on a public repo.
 */
export function SealedLimit({ repo, kind, text, long }: { repo: RepoRef; kind: SealedKind; text: string; long?: LongCompose }): JSX.Element | null {
  // a body over the field says so in its BodyCounter (`long`) instead
  if (repo.visibility !== 'private' || long?.long) return null
  const used = new TextEncoder().encode(text).length
  const limit = SEALED_TEXT_LIMIT[kind]
  return (
    <p className={`mt-1 text-[11px] ${used > limit ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400'}`} data-testid="sealed-limit">
      {kind === 'patch' ? 'Title, text and branch names' : kind === 'issue' ? 'Title and text' : kind === 'comment' ? 'Text and file path' : 'Text'} {used} / {limit} bytes
      (encrypted to this repo&apos;s members).
    </p>
  )
}

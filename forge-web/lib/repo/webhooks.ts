/**
 * forge-v2 webhooks in the browser (QW-071): the forge-community `webhook` document, as
 * `crates/forge-core/src/webhooks.rs` reads and writes it (`dg webhook add | list | remove`).
 *
 * A webhook asks a relay identity to POST GitHub-shaped events for one public repo to a URL.
 * Its document is `{repoId, hookId, url, events, relayIdentityId, relayKeyId, senderKeyId,
 * secret, disabled, vis}`:
 *  - only a current maintainer can write one (consensus `ownerRefersTo` → `maintainer`);
 *  - `secret` is the HMAC key the relay signs deliveries with, `encryptedFor` the relay's
 *    ENCRYPTION key from the writer's (so writing one needs the writer's encryption key);
 *  - newest per `(repoId, hookId)` by (`$createdAt`, `$id`) wins, and a newest `disabled`
 *    document stops the hook;
 *  - the URL is public on chain: `https://` to a DNS name, and no query string (where tokens
 *    usually hide) unless the writer says it holds nothing secret;
 *  - public repos only (`vis` is `public`): a relay is not a member of a private repo.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { decodeIdentifier } from '../auth/base58'
import { bytesToHex, hexToBytes } from '../private/bytes'
import {
  createDocumentIdempotent,
  deleteDocumentIdempotent,
  previewCreate,
  queryAllDocuments,
  type CostPreview,
  type PlainDocument,
  type WriteAuth,
} from '../sdk'
import { DOC, asIdentifierString, byteFieldToHex, num, str, stringArray, withVis, type RepoRef } from './contract'

/** The GitHub event names a relay delivers (`dg webhook add --events`). Empty means all. */
export const WEBHOOK_EVENTS = ['push', 'issues', 'pull_request', 'issue_comment', 'pull_request_review', 'release', 'check_run'] as const

/** The schema's `url` cap. */
export const WEBHOOK_URL_MAX = 300

/** forge-community `webhook.url`: `https://`, a DNS name, an optional port, a tail without spaces. */
const URL_PATTERN = /^https:\/\/([A-Za-z0-9-]+[.])+[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9](:[0-9]{1,5})?([/?#][^\s]*)?$/

/** A `webhook` document, decoded (the secret stays encrypted: only the relay can open it). */
export interface WebhookView {
  readonly documentId: string
  /** The maintainer who wrote it. */
  readonly ownerId: string
  readonly createdAt: number
  /** 64 hex characters, stable across the hook's revisions. */
  readonly hookId: string
  readonly url: string
  /** Subscribed events; empty: all. */
  readonly events: readonly string[]
  readonly relayIdentityId: string
  readonly relayKeyId: number
  readonly disabled: boolean
}

function toWebhook(d: PlainDocument): WebhookView {
  return {
    documentId: str(d, '$id'),
    ownerId: asIdentifierString(d['$ownerId']),
    createdAt: num(d, '$createdAt'),
    hookId: byteFieldToHex(d, 'hookId'),
    url: str(d, 'url'),
    events: stringArray(d, 'events') ?? [],
    relayIdentityId: asIdentifierString(d['relayIdentityId']),
    relayKeyId: num(d, 'relayKeyId'),
    disabled: d['disabled'] === true,
  }
}

/** Every `webhook` document of `repo` (its `list` index), oldest first. */
export async function readWebhookDocs(sdk: EvoSDK, repo: RepoRef): Promise<WebhookView[]> {
  const docs = await queryAllDocuments(sdk, {
    dataContractId: repo.forge.community,
    documentTypeName: DOC.webhook,
    where: [['repoId', '==', repo.repoId]],
    orderBy: [['$createdAt', 'asc']],
  })
  return docs.map(toWebhook).filter((h) => h.hookId !== '' && h.documentId !== '')
}

const newer = (a: WebhookView, b: WebhookView): boolean => a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.documentId > b.documentId)

/** The newest document of each hook (forge-core `newest_per_hook`), in hook-id order. */
export function newestPerHook(docs: readonly WebhookView[]): WebhookView[] {
  const by = new Map<string, WebhookView>()
  for (const d of docs) {
    const held = by.get(d.hookId)
    if (held === undefined || newer(d, held)) by.set(d.hookId, d)
  }
  return [...by.values()].sort((a, b) => (a.hookId < b.hookId ? -1 : a.hookId > b.hookId ? 1 : 0))
}

/** The hooks a relay delivers: each hook's newest document, unless that one is disabled. */
export function activeHooks(docs: readonly WebhookView[]): WebhookView[] {
  return newestPerHook(docs).filter((h) => !h.disabled)
}

/**
 * Why `url` cannot be a webhook's (forge-core `check_url_and_events`), or null. A query string
 * is refused unless `allowQuery`: the URL is public on chain.
 */
export function webhookUrlProblem(url: string, allowQuery = false): string | null {
  if (url === '') return 'Enter the URL to deliver to.'
  if (new TextEncoder().encode(url).length > WEBHOOK_URL_MAX) return `A webhook URL is at most ${WEBHOOK_URL_MAX} bytes.`
  if (!url.startsWith('https://')) return 'A webhook URL must be https://.'
  const authority = url.slice('https://'.length).split(/[/?#]/, 1)[0] ?? ''
  if (authority.includes('@')) return 'The URL is public on chain, so it must not carry user:password@. Deliveries are signed with the secret instead.'
  if (!URL_PATTERN.test(url)) return 'Use a DNS name (not an IP address, localhost or a name ending in a dot), an optional port, and no spaces.'
  if (!allowQuery && url.includes('?')) return 'The URL is public on chain, and a query string is where tokens usually hide. Remove it, or confirm it holds nothing secret.'
  return null
}

/**
 * A fresh secret: 32 random bytes as 64 lowercase hex characters (forge-core
 * `generate_secret`). The HMAC key is the string's bytes, so the receiver configures exactly
 * the string shown, as with GitHub's webhook secret.
 */
export function generateWebhookSecret(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const hex = bytesToHex(raw)
  raw.fill(0)
  return hex
}

/** A fresh random hook id (64 hex characters). */
export function randomHookId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * What seals the secret: `seal(plaintext, recipient)` returns the properties the contract's
 * `encryptedFor` names (`secret`, `relayKeyId`, `senderKeyId`), sealed from this browser's
 * encryption key to `recipient`'s highest usable ENCRYPTION key (`lib/auth/encryption-key.ts`
 * `webhookSealer`).
 */
export type SecretSealer = (plaintext: Uint8Array, recipientIdentityId: string) => Promise<Record<string, unknown>>

export interface NewWebhook {
  readonly hookId: string
  readonly url: string
  /** Empty: every event. */
  readonly events: readonly string[]
  readonly relayIdentityId: string
  readonly secret: string
  readonly disabled?: boolean
}

/** The document's plain fields (everything but what the sealer adds). */
function plainFields(repo: RepoRef, input: NewWebhook): Record<string, unknown> {
  return withVis(repo.visibility, DOC.webhook, {
    repoId: decodeIdentifier(repo.repoId),
    hookId: hexToBytes(input.hookId),
    url: input.url,
    ...(input.events.length > 0 ? { events: [...input.events] } : {}),
    relayIdentityId: decodeIdentifier(input.relayIdentityId),
    ...(input.disabled === true ? { disabled: true } : {}),
  })
}

/** The price of one webhook document for `input` (a 64-byte-plaintext ciphertext is 96 bytes). */
export function webhookCost(repo: RepoRef, input: Pick<NewWebhook, 'url' | 'events'>): CostPreview {
  // Sized, not signed: 32-byte placeholders stand in for the ids.
  const id = new Uint8Array(32)
  return previewCreate(
    DOC.webhook,
    withVis(repo.visibility, DOC.webhook, {
      repoId: id,
      hookId: id,
      url: input.url,
      ...(input.events.length > 0 ? { events: [...input.events] } : {}),
      relayIdentityId: id,
      relayKeyId: 0,
      senderKeyId: 0,
      secret: new Uint8Array(96),
    }),
  )
}

/** Write a webhook document (a new hook, or a newer revision of `input.hookId`). */
export async function writeWebhook(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, seal: SecretSealer, input: NewWebhook, intent?: string): Promise<void> {
  if (repo.visibility !== 'public') throw new Error('webhooks are for public repos: a relay is not a member of a private repo')
  const problem = webhookUrlProblem(input.url, true)
  if (problem !== null) throw new Error(problem)
  const plaintext = new TextEncoder().encode(input.secret)
  let sealed: Record<string, unknown>
  try {
    sealed = await seal(plaintext, input.relayIdentityId)
  } finally {
    plaintext.fill(0)
  }
  await createDocumentIdempotent(sdk, auth, {
    contractId: repo.forge.community,
    documentType: DOC.webhook,
    data: { ...plainFields(repo, input), ...sealed },
    // The secret is sealed afresh on each attempt: the content key is the plain fields.
    contentKey: `webhook:${repo.repoId}:${input.hookId}:${input.url}:${input.events.join(',')}:${input.relayIdentityId}:${input.disabled === true}`,
    ...(intent !== undefined ? { intent } : {}),
  })
}

/**
 * Whether removing `hookId` has to write a disabled revision first: another maintainer's
 * revision would be current once the signer's own are deleted ({@link removeWebhook}).
 */
export function removalNeedsTombstone(docs: readonly WebhookView[], hookId: string, me: string): boolean {
  return activeHooks(docs.filter((h) => h.hookId === hookId && h.ownerId !== me)).length > 0
}

/** What a removal wrote: the disabled revision it had to add (if any), and what it deleted. */
export interface RemovedWebhook {
  readonly tombstone: boolean
  readonly deleted: number
}

/**
 * Remove hook `hookId` (forge-core `remove`): delete every document of it the signer wrote. When
 * another maintainer's document would then be current (only its writer can delete it), first
 * write a newer disabled one addressed to the signer's own identity, so no relay can read its
 * secret and the hook's relay stops: written first, the other document is never current again.
 */
export async function removeWebhook(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, seal: SecretSealer | null, hookId: string): Promise<RemovedWebhook> {
  const me = auth.identityId
  const history = (await readWebhookDocs(sdk, repo)).filter((h) => h.hookId === hookId)
  const others = activeHooks(history.filter((h) => h.ownerId !== me))
  let tombstone = false
  const current = others[0]
  if (current !== undefined) {
    // Only the tombstone needs the encryption key; plain deletes need the signing key alone.
    if (seal === null) throw new Error('another maintainer also wrote this webhook, so removing it writes a disabled revision sealed from your encryption key first: unlock it in this browser')
    // Deliberately no write intent: a retry after the tombstone landed would replay it, find it
    // among the signer's revisions below and delete it, making the other maintainer's current
    // again. Without one, a retry writes a second tombstone and deletes the first (one extra write).
    await writeWebhook(sdk, auth, repo, seal, { hookId, url: current.url, events: current.events, relayIdentityId: me, secret: generateWebhookSecret(), disabled: true })
    tombstone = true
  }
  let deleted = 0
  for (const h of history.filter((x) => x.ownerId === me)) {
    await deleteDocumentIdempotent(sdk, auth, { contractId: repo.forge.community, documentType: DOC.webhook, documentId: h.documentId, repo: repo.repoId })
    deleted++
  }
  return { tombstone, deleted }
}

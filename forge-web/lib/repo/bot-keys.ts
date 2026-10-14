/**
 * Bots' keys for members-only posts (mixed-visibility DESIGN §4.9, `private-repos.md` §23): a
 * maintainer sends each bot of a repository its post key for the current key in a `postKey`
 * letter (kind 10) when members-only content is turned on, when the bot is added, on every
 * rotation (once its anchor won) and on a repair. The twin of forge-core `bot_keys`.
 *
 * A bot never holds the members key (L4) and is never wrapped to, so adding or removing one
 * rotates nothing. Its post key opens nothing but its own posts. Each letter is sealed to the
 * signer (slot 0, so it can find what it sent) and the bot, and stored on Platform chunks with a
 * kind-10 `packManifest`, as an environment snapshot is.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import * as secp from '@noble/secp256k1'

import { decodeIdentifier } from '../auth/base58'
import { fetchIdentityKeys, ownerKeysOf, usableEncryptionKey, type EncKeyLike } from '../auth/encryption-key'
import { VaultLockedError, withEncryptionKeys } from '../auth/vault'
import { PACK_KIND, type Network } from '../constants'
import { postKeyLetterCredits } from '../env/write'
import {
  PostKey,
  bytesToHex,
  constantTimeEqual,
  hexToBytes,
  openKeyLetter,
  postKeyLetterFromTyped,
  postKeyLetterToTyped,
  sealKeyLetter,
  type EpochKeys,
  type PostKeyLetter,
} from '../private'
import { previewCredits, sumPreviews, type CostPreview, type WriteAuth } from '../sdk'
import { toast } from '../../hooks/use-toasts'
import { sha256Hex } from '../storage/sigv4'
import { shortId } from '../utils'
import { loadStoredArtifactBytes } from '../view/browse-source'
import { mapPooled } from '../view/pool'
import type { RepoRef } from './contract'
import { readManifestsOfKind } from './packs'
import { putPlatformChunks, writePackManifest } from './push'

export { POST_KEY_LETTER_BYTES, postKeyLetterCredits } from '../env/write'

/** The cost of `n` `postKey` letters, for the previews of the changes that send them. */
export function postKeyLettersCost(n: number): CostPreview {
  return sumPreviews(Array.from({ length: n }, () => previewCredits(postKeyLetterCredits())))
}

/** What a send did (forge-core `bot_keys::Issued`). */
export interface PostKeysSent {
  /** The key epoch the post keys are for. */
  readonly epoch: number
  /** Bots sent their post key. */
  readonly sent: readonly string[]
  /** Bots that could not be sent one: no usable encryption key, or this run stopped before them. */
  readonly skipped: readonly string[]
  /** Why the run stopped before every bot was sent one, when it did. */
  readonly failed?: string
}

/** One party of a letter: an identity and its encryption public key (33 bytes). */
interface Party {
  readonly identityId: Uint8Array
  readonly publicKey: Uint8Array
}

/** The I/O a send needs, injected so the plan is testable ({@link sdkPostKeyIo} binds it to the SDK and the vault). */
export interface PostKeyIo {
  /** The signer (base58), the letters' sender. */
  readonly me: string
  /** The signer's encryption key the letters are sealed from: the newest usable one this browser holds, or null. */
  sender(): Promise<{ readonly keyId: number; readonly publicKey: Uint8Array } | null>
  /** `id`'s usable encryption public key, or null (none, or the identity could not be read). */
  recipientKey(id: string): Promise<Uint8Array | null>
  /** Seal each letter to `[sender, bot]` from the sender key (the vault opened once for all of them). */
  seal(sender: { readonly keyId: number; readonly publicKey: Uint8Array }, letters: readonly { readonly bot: Party; readonly letter: PostKeyLetter }[]): Promise<Uint8Array[]>
  /** Store one sealed letter: its chunks, then its kind-10 manifest. */
  store(sealed: Uint8Array, bot: string): Promise<void>
  /** The `postKey` letters this signer sent in the repository (its own kind-10 letters it can open). */
  sentLetters(): Promise<PostKeyLetter[]>
}

/**
 * Send the post key of `keys`'s epoch to each of `bots`: one `postKey` letter per bot. A bot with
 * no usable encryption key is skipped, never an error. A failed write stops the run: what was
 * sent stays sent, the rest is reported skipped with the reason, and a repair finishes it.
 */
export async function sendPostKeys(io: PostKeyIo, keys: EpochKeys, bots: readonly string[]): Promise<PostKeysSent> {
  const epoch = keys.epoch
  if (bots.length === 0) return { epoch, sent: [], skipped: [] }
  const sender = await io.sender()
  if (sender === null) return { epoch, sent: [], skipped: [...bots], failed: "this browser doesn't hold a usable encryption key of yours" }
  const skipped: string[] = []
  const ready: { id: string; bot: Party; letter: PostKeyLetter }[] = []
  const sent: string[] = []
  try {
    for (const id of bots) {
      const publicKey = await io.recipientKey(id)
      if (publicKey === null) {
        skipped.push(id)
        continue
      }
      const botId = decodeIdentifier(id)
      const post = await PostKey.derive(keys, botId)
      ready.push({ id, bot: { identityId: botId, publicKey }, letter: { epoch, key: post.key() } })
      post.wipe()
    }
    const sealed = ready.length === 0 ? [] : await io.seal(sender, ready)
    for (const [i, r] of ready.entries()) {
      await io.store(sealed[i] as Uint8Array, r.id)
      sent.push(r.id)
    }
  } catch (e) {
    const rest = bots.filter((id) => !sent.includes(id) && !skipped.includes(id))
    return { epoch, sent, skipped: [...skipped, ...rest], failed: e instanceof Error ? e.message : String(e) }
  } finally {
    for (const r of ready) r.letter.key.fill(0)
  }
  return { epoch, sent, skipped }
}

/**
 * Which of `bots` have no post key for `keys`'s epoch among the letters this signer sent (its own
 * letters are addressed to it too, slot 0): a letter counts for the bot whose post key it carries
 * (each bot's key differs). Letters other maintainers sent are not visible to this signer, so a
 * bot one of them keyed may be sent the same key again, which is harmless.
 */
export async function missingPostKeys(io: PostKeyIo, keys: EpochKeys, bots: readonly string[]): Promise<string[]> {
  if (bots.length === 0) return []
  const sent = (await io.sentLetters()).filter((l) => l.epoch === keys.epoch)
  const out: string[] = []
  try {
    for (const id of bots) {
      const post = await PostKey.derive(keys, decodeIdentifier(id))
      const w = post.key()
      post.wipe()
      if (!sent.some((l) => constantTimeEqual(l.key, w))) out.push(id)
      w.fill(0)
    }
  } finally {
    for (const l of sent) l.key.fill(0)
  }
  return out
}

/** A key letter is fetched for its post key this many at once. */
const FETCH_WINDOW = 4

/**
 * {@link PostKeyIo} over the SDK and this browser's vault, writing as `auth` in `repo` (each manifest's intent under `intent`).
 * `since`: the block height the current key was first stated at; a letter written before it is for an earlier key, so it is not fetched.
 */
export function sdkPostKeyIo(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  network: Network,
  heldKeyIds: readonly number[],
  intent: string,
  since?: number,
): PostKeyIo {
  const me = auth.identityId
  const core = repo.forge.core
  const repoId = decodeIdentifier(repo.repoId)
  const meId = decodeIdentifier(me)
  const usable = (keys: readonly EncKeyLike[] | null): EncKeyLike | null => usableEncryptionKey(keys ?? [], core)
  return {
    me,
    sender: async () => {
      const own = ((await fetchIdentityKeys(sdk, me)) ?? []).filter((k) => heldKeyIds.includes(k.keyId))
      const k = usable(own)
      return k === null ? null : { keyId: k.keyId, publicKey: hexToBytes(k.data) }
    },
    recipientKey: async (id) => {
      const k = usable(await fetchIdentityKeys(sdk, id).catch(() => null))
      return k === null ? null : hexToBytes(k.data)
    },
    seal: (sender, letters) =>
      withEncryptionKeys(network, me, async (held) => {
        const want = bytesToHex(sender.publicKey)
        const secret = held.find((k) => bytesToHex(secp.getPublicKey(k.secret, true)) === want)
        if (secret === undefined) throw new VaultLockedError('this browser no longer holds the encryption key it was about to send with; unlock it again')
        const self: Party = { identityId: meId, publicKey: sender.publicKey }
        const out: Uint8Array[] = []
        for (const l of letters) out.push(await sealKeyLetter(repoId, secret.secret, sender.keyId, meId, [self, l.bot], postKeyLetterToTyped(l.letter)))
        return out
      }),
    store: async (sealed, bot) => {
      const packHash = await sha256Hex(sealed)
      const { locator, chunkCount } = await putPlatformChunks(sdk, auth, repo, sealed, packHash)
      await writePackManifest(
        sdk,
        auth,
        repo,
        { packHash, kind: PACK_KIND.KEY_LETTER, sizeBytes: sealed.length, objectCount: 0, chunkCount, storage: 0, uris: [locator] },
        `${intent}:${bot}:${packHash}`,
      )
    },
    sentLetters: async () => {
      const own = (await readManifestsOfKind(sdk, repo, PACK_KIND.KEY_LETTER)).filter(
        (m) => m.uploader === me && (since === undefined || m.createdAtBlockHeight === undefined || m.createdAtBlockHeight >= since),
      )
      if (own.length === 0) return []
      const fetched = await mapPooled(own, FETCH_WINDOW, async (m) => ({ m, bytes: await loadStoredArtifactBytes(sdk, repo, m).catch(() => null) }))
      const ownerKeys = ownerKeysOf((await fetchIdentityKeys(sdk, me)) ?? [])
      return withEncryptionKeys(network, me, async (held) => {
        const reader = { identityId: meId, secrets: held.map((k) => k.secret) }
        const out: PostKeyLetter[] = []
        for (const { m, bytes } of fetched) {
          if (bytes === null) continue
          const opened = await openKeyLetter(repoId, { packHash: hexToBytes(m.packHash), sizeBytes: m.sizeBytes }, bytes, ownerKeys, reader)
          const letter = 'letter' in opened ? postKeyLetterFromTyped(opened.letter) : null
          if (letter !== null) out.push(letter)
        }
        return out
      })
    },
  }
}

/**
 * The toasts of a send (DESIGN §10 style, plain words): who got a key for members-only posts, who
 * could not and why. Nothing when there were no bots.
 */
export function postKeysToasts(r: PostKeysSent): { readonly title: string; readonly tone?: 'warn'; readonly detail?: string }[] {
  const out: { title: string; tone?: 'warn'; detail?: string }[] = []
  if (r.sent.length === 1) out.push({ title: `Sent ${shortId(r.sent[0] as string)} its key for members-only posts` })
  else if (r.sent.length > 1) out.push({ title: `Sent ${r.sent.length} bots their keys for members-only posts` })
  if (r.skipped.length > 0) {
    const one = r.skipped.length === 1
    const who = one ? shortId(r.skipped[0] as string) : `${r.skipped.length} bots`
    out.push({
      title: `${who} didn't get ${one ? 'its key' : 'their keys'} for members-only posts`,
      tone: 'warn',
      // the reason stays in the step log: an error's own words are not written for this toast
      detail:
        r.failed !== undefined
          ? 'Sending stopped part-way. You can send the rest from the repo page.'
          : `${one ? 'It has' : 'They have'} no encryption key yet. You can send ${one ? 'it' : 'them'} from the repo page once ${one ? 'it adds one' : 'they add one'}.`,
    })
  }
  return out
}

/** Show {@link postKeysToasts}. */
export function announcePostKeys(r: PostKeysSent): void {
  for (const t of postKeysToasts(r)) toast(t)
}

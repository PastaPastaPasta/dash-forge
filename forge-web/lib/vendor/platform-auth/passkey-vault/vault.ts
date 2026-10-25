// The passkey vault service: enrol a passkey, seal a session's keys to it on Platform, open them on another device, list, remove and
// re-seal. Free of the SDK and of any UI: Platform is the app's VaultPort, WebAuthn its PasskeyAdapter, the chain check its `verify`.
//
// The rule that matters (govhub service.ts storeInVault; Yappr docs/PASSKEY_VAULT.md §6-7): the vault never seals to a recipient key
// it did not derive in this tab from a passkey's PRF output, or that the caller did not vouch for from its own local record. A
// recipient key read from the chain is public and anyone holding a live key of the owner can plant an entry; sealing the user's keys
// to it would hand them over. So `store` takes only a ConfirmedPasskey minted by `confirm` in this instance, and `reseal` only a
// TrustedRecipient minted by `confirm` or `trustMarker` for that entry's credential, which the entry, re-read, must still carry.
import { bytesEqual, wipe } from './bytes'
import type { BundleCodec } from './codecs'
import { isCredentialIdLength, openEntry, prfInput, recipientFromPrf, sealEntry, type SealedVaultEntry } from './entry'
import { need, PasskeyError, VaultError } from './errors'
import type { OnChainKey, VaultEntryRecord, VaultPort } from './port'
import type { VaultProfile } from './profile'
import { parseUserHandle, userHandleFor } from './user-handle'
import type { PasskeyAdapter } from './webauthn'

export const DEFAULT_MAX_PASSKEYS = 10

export interface VerifyContext<B> {
  ownerId: Uint8Array
  entry: VaultEntryRecord
  codec: BundleCodec<B>
  now: number
}

export interface PasskeyVaultOptions<S, B, R> {
  profile: VaultProfile<B>
  /** The format this vault seals with (one of the profile's). */
  codec: BundleCodec<B>
  /** Picks another of the profile's formats for a session (govhub: a seed or a single key). Default: `codec`. */
  codecFor?(session: S): BundleCodec<B>
  port: VaultPort
  adapter: PasskeyAdapter
  rpId: string
  rpName: string
  /** The vault contract id (32 bytes): in the PRF input, the HPKE info and the user handle. */
  contractId: Uint8Array
  /** Passkeys per identity (the client's cap; the contract has none). Default 10. */
  maxPasskeys?: number
  /** The identity a session signs for. */
  ownerOf(session: S): Uint8Array
  /** A fresh bundle of what the session keeps (copies of its keys): the vault wipes it after sealing. */
  bundleFor(session: S): B
  /** The entry key id, for a codec with no `authKeyIdOf` (a seed bundle). */
  authKeyIdOf?(session: S): number
  /**
   * The chain check: decides whether an opened bundle may be used, against the owner's keys read with proofs. Throw to refuse
   * (`VaultError` 'refused' is the code meant for it; anything thrown propagates as itself, so a failed read stays a failed read).
   * Return what the sign-in keeps, as copies: the vault wipes the bundle as soon as this returns.
   */
  verify(bundle: B, keys: OnChainKey[], ctx: VerifyContext<B>): R | Promise<R>
  /** Clock, ms since the epoch. */
  now?(): number
  /** Waits between reads in waitForEntry (tests replace it). */
  sleep?(ms: number): Promise<void>
}

/** A passkey just made by `enroll`. Persist only `ownerId` and `credentialId` (public); `createPrf` is secret and stays in memory. */
export interface PendingEnrolment {
  ownerId: Uint8Array
  credentialId: Uint8Array
  /** The PRF output at creation, when the authenticator gave one; a successful `confirm` checks it, wipes it and sets it to null. */
  createPrf: Uint8Array | null
  /** Whether the authenticator said it supports PRF. False usually means `confirm` will fail with 'no-prf'. */
  prfEnabled: boolean
}

/** What `confirm` takes: a pending enrolment, or an existing entry (whose recipient key the passkey must then give). */
export interface ConfirmTarget {
  ownerId: Uint8Array
  credentialId: Uint8Array
  createPrf?: Uint8Array | null
  recipientKey?: Uint8Array
}

/**
 * A recipient key this vault instance trusts for one credential of one identity. Only instances it minted are honoured, and their
 * bytes are kept privately (mutating these fields changes nothing).
 */
export interface TrustedRecipient {
  readonly ownerId: Uint8Array
  readonly credentialId: Uint8Array
  readonly recipientKey: Uint8Array
  /** 'passkey': the passkey gave it in this tab (`confirm`); 'marker': the app's own local record vouches for it (`trustMarker`). */
  readonly source: 'passkey' | 'marker'
}

/** A recipient key a passkey gave in this tab (`confirm`). The only kind `store` seals a new entry to. */
export interface ConfirmedPasskey extends TrustedRecipient {
  readonly source: 'passkey'
}

export interface OpenedVault<R> {
  ownerId: Uint8Array
  credentialId: Uint8Array
  entry: VaultEntryRecord
  /** What `verify` returned. */
  result: R
  /** The assertion's PRF output, only with `keepPrfOutput` (the caller must wipe it); otherwise null and already wiped. */
  prfOutput: Uint8Array | null
}

export class PasskeyVault<S, B, R> {
  readonly #o: PasskeyVaultOptions<S, B, R>
  readonly #prfInput: Uint8Array
  readonly #max: number
  /** Minted TrustedRecipients and private copies of their bytes. */
  readonly #trusted = new WeakMap<TrustedRecipient, TrustedRecipient>()

  constructor(options: PasskeyVaultOptions<S, B, R>) {
    need(options.profile.formats.includes(options.codec), "the codec is not one of the profile's formats")
    need(options.codec.authKeyIdOf !== undefined || options.authKeyIdOf !== undefined, 'a codec without authKeyIdOf needs the authKeyIdOf option')
    this.#o = { ...options, contractId: options.contractId.slice() }
    this.#prfInput = prfInput(options.profile, options.contractId)
    this.#max = options.maxPasskeys ?? DEFAULT_MAX_PASSKEYS
  }

  /** The PRF `first` input every passkey of this vault is evaluated with. */
  get prfInput(): Uint8Array {
    return this.#prfInput.slice()
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now()
  }

  #assertRoom(passkeys: number): void {
    if (passkeys >= this.#max) throw new VaultError(`An identity can have ${this.#max} passkeys. Remove one first.`, 'too-many')
  }

  /**
   * Step 1 of adding a passkey: the create ceremony, with the 64-byte user handle, the PRF evaluated, and the owner's existing
   * passkeys excluded. Writes nothing. Follow with `confirm` (its own user gesture), then `store`; or `abandon`.
   */
  async enroll(session: S, o: { userName: string; displayName?: string; signal?: AbortSignal }): Promise<PendingEnrolment> {
    const ownerId = this.#o.ownerOf(session).slice()
    const entries = await this.#o.port.list(ownerId)
    this.#assertRoom(entries.length)
    const created = await this.#o.adapter.create({
      rpId: this.#o.rpId,
      rpName: this.#o.rpName,
      userHandle: userHandleFor(ownerId, this.#o.contractId),
      userName: o.userName,
      displayName: o.displayName,
      prfInput: this.prfInput,
      exclude: entries.map((e) => e.credentialId),
      signal: o.signal,
    })
    const pending: PendingEnrolment = { ownerId, credentialId: created.credentialId, createPrf: created.prfOutput, prfEnabled: created.prfEnabled }
    if (!isCredentialIdLength(created.credentialId.length)) {
      await this.abandon(pending)
      throw new PasskeyError('This passkey has an unusual credential id and cannot be used.', 'unsupported', created.credentialId)
    }
    return pending
  }

  /**
   * A get ceremony restricted to one credential, whose user handle must name `target.ownerId` and this vault, and whose PRF output
   * must equal the create-time one (a pending enrolment) or give `target.recipientKey` (an existing entry). Returns the recipient key
   * as a ConfirmedPasskey. The assertion's PRF output is wiped; on success so is `target.createPrf` (then set to null, so a pending
   * enrolment can be confirmed again after a failed store). A cancelled or refused confirm leaves the target as it was.
   */
  async confirm(target: ConfirmTarget, o: { signal?: AbortSignal } = {}): Promise<ConfirmedPasskey> {
    const a = await this.#o.adapter.get({ rpId: this.#o.rpId, prfInput: this.prfInput, allow: [target.credentialId], signal: o.signal })
    try {
      if (!bytesEqual(a.credentialId, target.credentialId)) throw new VaultError('The browser answered with another passkey.', 'mismatch')
      const identity = parseUserHandle(a.userHandle, this.#o.contractId)
      if (!bytesEqual(identity, target.ownerId)) throw new VaultError('This passkey belongs to another identity.', 'other-identity')
      if (target.createPrf && !bytesEqual(target.createPrf, a.prfOutput)) {
        throw new VaultError('The passkey gave a different key than when it was made. Try adding it again.', 'mismatch')
      }
      const recipient = recipientFromPrf(a.prfOutput)
      wipe(recipient.privateKey)
      if (target.recipientKey && !bytesEqual(target.recipientKey, recipient.publicKey)) {
        throw new VaultError("This passkey doesn't open that entry.", 'mismatch')
      }
      if (target.createPrf) {
        wipe(target.createPrf)
        target.createPrf = null
      }
      return this.#mint({ ownerId: target.ownerId, credentialId: target.credentialId, recipientKey: recipient.publicKey }, 'passkey') as ConfirmedPasskey
    } finally {
      wipe(a.prfOutput)
    }
  }

  /**
   * Vouches for a recipient key from the app's own local record of a passkey this device made (Forge's IndexedDB marker
   * `{credentialId, recipientKey}`), for `reseal` only. Never pass a key read from the chain: that is what a planted entry carries.
   */
  trustMarker(marker: { ownerId: Uint8Array; credentialId: Uint8Array; recipientKey: Uint8Array }): TrustedRecipient {
    need(marker.ownerId.length === 32 && marker.recipientKey.length === 32, 'the owner id and recipient key must be 32 bytes')
    return this.#mint(marker, 'marker')
  }

  #mint(o: Omit<TrustedRecipient, 'source'>, source: TrustedRecipient['source']): TrustedRecipient {
    const copyOf = (): TrustedRecipient => ({ ownerId: o.ownerId.slice(), credentialId: o.credentialId.slice(), recipientKey: o.recipientKey.slice(), source })
    const token = Object.freeze(copyOf())
    this.#trusted.set(token, copyOf())
    return token
  }

  #seal(session: S, ownerId: Uint8Array, credentialId: Uint8Array, recipientKey: Uint8Array): SealedVaultEntry {
    const { profile, contractId } = this.#o
    const codec = this.#o.codecFor?.(session) ?? this.#o.codec
    const bundle = this.#o.bundleFor(session)
    try {
      const authKeyId = codec.authKeyIdOf ? undefined : this.#o.authKeyIdOf?.(session)
      return sealEntry(profile, { contractId, ownerId, credentialId, recipientKey, bundle, codec, authKeyId })
    } finally {
      codec.wipe(bundle)
    }
  }

  #assertOwner(session: S, ownerId: Uint8Array): void {
    if (!bytesEqual(this.#o.ownerOf(session), ownerId)) throw new VaultError('This passkey belongs to another identity.', 'other-identity')
  }

  /**
   * Seals the session to a confirmed passkey and writes (or replaces) its entry. An entry for the same credential sealed to another
   * recipient key can never be opened by this passkey (recipient keys are immutable on chain): once the new entry is sealed, it is
   * removed and a new one created. Nothing is written when sealing or the cap refuses.
   */
  async store(session: S, confirmed: ConfirmedPasskey): Promise<SealedVaultEntry> {
    const t = this.#trusted.get(confirmed)
    if (!t || t.source !== 'passkey') throw new VaultError('Only a passkey confirmed in this tab can be sealed to.', 'untrusted-recipient')
    this.#assertOwner(session, t.ownerId)
    const { port } = this.#o
    const existing = await port.byCredential(t.ownerId, t.credentialId)
    if (existing && !bytesEqual(existing.ownerId, t.ownerId)) throw new VaultError('The entry belongs to another identity.', 'other-identity')
    const stale = existing !== null && !bytesEqual(existing.recipientKey, t.recipientKey)
    if (!existing || stale) {
      const others = (await port.list(t.ownerId)).filter((e) => !bytesEqual(e.credentialId, t.credentialId))
      this.#assertRoom(others.length)
    }
    const entry = this.#seal(session, t.ownerId, t.credentialId, t.recipientKey)
    if (existing && stale) await port.remove({ ownerId: t.ownerId, entry: existing })
    await port.put({ ownerId: t.ownerId, entry, existing: stale ? null : existing })
    return entry
  }

  /**
   * Re-seals an existing entry with the session's current keys, to a TrustedRecipient for that credential (from `confirm`, or
   * `trustMarker` for this device's own passkeys). The entry, re-read with proofs, must still be sealed to it.
   */
  async reseal(entry: VaultEntryRecord, session: S, o: { trustedRecipient: TrustedRecipient }): Promise<SealedVaultEntry> {
    const ownerId = entry.ownerId.slice()
    this.#assertOwner(session, ownerId)
    const t = this.#trusted.get(o.trustedRecipient)
    if (!t) throw new VaultError('Only a recipient key this vault was given to trust can be sealed to.', 'untrusted-recipient')
    if (!bytesEqual(t.ownerId, ownerId) || !bytesEqual(t.credentialId, entry.credentialId)) {
      throw new VaultError('That trusted key is for another passkey.', 'untrusted-recipient')
    }
    const fresh = await this.#o.port.byCredential(ownerId, entry.credentialId)
    if (!fresh) throw new VaultError('The entry is gone.', 'no-entry')
    if (!bytesEqual(fresh.ownerId, ownerId) || !bytesEqual(fresh.recipientKey, t.recipientKey)) {
      throw new VaultError('This entry is sealed to a key this device does not trust.', 'untrusted-recipient')
    }
    const sealed = this.#seal(session, ownerId, entry.credentialId, t.recipientKey)
    await this.#o.port.put({ ownerId, entry: sealed, existing: fresh })
    return sealed
  }

  /**
   * Waits until a proved read shows the entry sealed to `recipientKey` (nodes can lag a block): at most `reads` reads (default 15),
   * `intervalMs` apart. A read that fails is retried, except the last, whose error propagates.
   */
  async waitForEntry(ownerId: Uint8Array, credentialId: Uint8Array, recipientKey: Uint8Array, o: { reads?: number; intervalMs?: number } = {}): Promise<VaultEntryRecord> {
    const reads = Math.max(1, o.reads ?? 15)
    const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (let i = 1; ; i += 1) {
      const last = i >= reads
      const read = this.#o.port.byCredential(ownerId, credentialId)
      const e = last ? await read : await read.catch(() => null)
      if (e && bytesEqual(e.recipientKey, recipientKey)) return e
      if (last) throw new VaultError('The passkey entry is not visible on Platform yet. Check again in a minute.', 'not-visible')
      await sleep(o.intervalMs ?? 2000)
    }
  }

  /**
   * Sign-in: one get ceremony (discoverable unless `allow` is given), the entry its user handle and credential id name, opened with
   * its PRF output, then the app's chain check against the owner's keys read with proofs. The bundle is wiped once `verify` returns.
   */
  async open(o: { allow?: readonly Uint8Array[]; keepPrfOutput?: boolean; signal?: AbortSignal } = {}): Promise<OpenedVault<R>> {
    const a = await this.#o.adapter.get({ rpId: this.#o.rpId, prfInput: this.prfInput, allow: o.allow ?? [], signal: o.signal })
    let keep = false
    try {
      const ownerId = parseUserHandle(a.userHandle, this.#o.contractId)
      const entry = await this.#o.port.byCredential(ownerId, a.credentialId)
      if (!entry) throw new VaultError('No entry for this passkey. It may have been removed; sign in another way and add it again.', 'no-entry')
      if (!bytesEqual(entry.ownerId, ownerId)) throw new VaultError('The entry belongs to another identity.', 'other-identity')
      if (!bytesEqual(entry.credentialId, a.credentialId)) throw new VaultError('The entry is for another passkey.', 'mismatch')
      const { codec, bundle } = openEntry(this.#o.profile, { contractId: this.#o.contractId, ownerId, entry, prfOutput: a.prfOutput })
      let result: R
      try {
        const keys = await this.#o.port.identityKeys(ownerId)
        if (!keys) throw new VaultError('The identity this passkey names was not found.', 'unknown-identity')
        result = await this.#o.verify(bundle, keys, { ownerId, entry, codec, now: this.#now() })
      } finally {
        codec.wipe(bundle)
      }
      keep = o.keepPrfOutput === true
      return { ownerId, credentialId: a.credentialId, entry, result, prfOutput: keep ? a.prfOutput : null }
    } finally {
      if (!keep) wipe(a.prfOutput)
    }
  }

  list(ownerId: Uint8Array): Promise<VaultEntryRecord[]> {
    return this.#o.port.list(ownerId)
  }

  /** Deletes an entry. Tell the provider only about this device's own passkeys (`thisDevice`): another may be anyone's credential id. */
  async remove(entry: VaultEntryRecord, o: { thisDevice?: boolean } = {}): Promise<void> {
    await this.#o.port.remove({ ownerId: entry.ownerId, entry })
    if (o.thisDevice) await this.#o.adapter.signalUnknown?.(this.#o.rpId, entry.credentialId)
  }

  /** Drops a passkey made but never stored (no PRF, the dialog closed, the confirm failed): wipes its PRF output, tells the provider. */
  async abandon(pending: Pick<PendingEnrolment, 'credentialId' | 'createPrf'>): Promise<void> {
    wipe(pending.createPrf)
    await this.#o.adapter.signalUnknown?.(this.#o.rpId, pending.credentialId)
  }
}

// copy-lint-ignore-file: a test helper no user reads
/**
 * A scripted App Connect v2 wallet for the wallet-login e2e and the live test: what a wallet that
 * speaks `APP_CONNECT_PROFILE.md` does with the `dash-key:...&v=2` request Forge shows, done with a
 * devnet test identity's own keys in Node. Like a real wallet it never signs the app's transitions:
 * it parses the request, checks it, and rebuilds the identity update from its own state.
 *
 *   approveV2({ wallet, uri, identityFile, devnet })
 *     1. parse and check the request (the wallet rules: freshness, one contractGroup binding of
 *        the Forge group at HIGH with a budget, no encryption binding);
 *     2. in ONE identity update signed by the master key: add a fresh key bound to the group with
 *        the requested budget and expiry (or the `limits` given), and disable the key of this
 *        wallet's previous grant for the same (identity, connection id);
 *     3. publish the `loginKeyResponse` in the App Connect contract under the identity, sealed to
 *        the request's ephemeral key (`answerV2`, the vendored module's own sealing).
 *   disableGrants({ wallet, identityFile, devnet })
 *     cleanup: disable every key this wallet added that is still live.
 *
 * The wallet's memory of its grants is the `wallet` object (an identity-and-connection map to key
 * ids): the chain does not record connection ids. It reuses `connect()` of wallet-responder.mjs.
 * It broadcasts: run only against a devnet with a test identity of your own.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils.js'

import { APP_CONNECT_CONTRACT_ID } from '../lib/auth/app-connect'
import { base58Encode } from '../lib/auth/base58'
import { answerV2 } from '../lib/auth/wallet-sim'
import {
  KeySecurityLevel,
  checkAppConnectRequestAge,
  parseAppConnectUri,
  type AppConnectRequest,
} from '../lib/vendor/platform-auth/app-connect'

type Responder = typeof import('./wallet-responder.mjs')
const responder = (): Promise<Responder> => import(pathToFileURL(join(__dirname, 'wallet-responder.mjs')).href)

/** The grants one scripted wallet has made, so a renewal can disable the key it replaces. */
export interface V2Wallet {
  /** `<identity>:<connection id hex>` → the live key id of that grant. */
  readonly grants: Map<string, number>
  /** Every key id this wallet added, per identity (for cleanup). */
  readonly added: Map<string, number[]>
}

export function newV2Wallet(): V2Wallet {
  return { grants: new Map(), added: new Map() }
}

/** Why this wallet would refuse a request (the profile's `ac` statuses), or null when it accepts. */
export function v2RequestRefusal(
  req: AppConnectRequest,
  p: { readonly now: number; readonly groupId: string; readonly expectLabel?: string },
): { readonly status: 'stale' | 'unsupported' | 'invalid'; readonly why: string } | null {
  const age = checkAppConnectRequestAge(req.createdAt, p.now)
  if (age !== null) return { status: 'stale', why: `request is ${age}` }
  if (req.mode !== undefined) return { status: 'unsupported', why: `unknown mode ${req.mode}` }
  if (req.authBindings.length !== 1) return { status: 'invalid', why: `${req.authBindings.length} auth bindings, Forge asks for one` }
  if (req.encBindings.length !== 0) return { status: 'invalid', why: 'an encryption binding: no Forge contract allows wallet-issued encryption keys' }
  const [binding] = req.authBindings
  if (binding === undefined) return { status: 'invalid', why: 'no auth binding' }
  if (binding.kind !== 'contractGroup') return { status: 'invalid', why: `binding kind ${binding.kind}` }
  if (base58Encode(binding.id) !== p.groupId) return { status: 'invalid', why: 'not the Forge contract group' }
  if (binding.securityLevel !== KeySecurityLevel.HIGH) return { status: 'invalid', why: 'a contractGroup key other than HIGH' }
  // Wallet rule 5: a contractGroup key always has a budget (and an expiry).
  if (binding.totalBudget === undefined || binding.totalBudget <= 0n) return { status: 'invalid', why: 'no budget' }
  if (binding.expiresAt === undefined || binding.expiresAt <= p.now) return { status: 'invalid', why: 'no usable expiry' }
  if (p.expectLabel !== undefined && req.label !== p.expectLabel) return { status: 'invalid', why: `label ${JSON.stringify(req.label)}` }
  return null
}

export interface ApprovedV2 {
  readonly identityId: string
  /** The key this approval added. */
  readonly keyId: number
  /** The key of this wallet's previous grant for the same connection id that the update disabled. */
  readonly replacedKeyId: number | null
  readonly requestHash: string
  readonly label: string
  /** What the key was granted with. */
  readonly granted: { readonly budget: bigint; readonly expiresAt: number }
}

/** A key as the identity files (`~/.config/dash-forge/test-identities`) record it. */
interface IdentityFileKey {
  readonly id: number
  readonly purpose: string
  readonly securityLevel: string
  readonly keyType: string
  readonly publicKeyHex: string
  readonly privateKeyWif: string
}

const grantKey = (identityId: string, connectionId: Uint8Array | undefined): string => `${identityId}:${connectionId ? bytesToHex(connectionId) : 'none'}`

/**
 * Approve `uri`. `limits` grants other limits than the request proposed (a wallet clamps to its
 * presets: 0.1 DASH and up); by default the proposal is granted as asked.
 */
export async function approveV2(p: {
  readonly wallet: V2Wallet
  readonly uri: string
  readonly identityFile: string
  /** The devnet's name (`E2E_DEVNET`), or '' on testnet. */
  readonly devnet: string
  readonly limits?: { readonly budget?: bigint; readonly expiresAt?: number }
  readonly now?: () => number
}): Promise<ApprovedV2> {
  const wallet = await responder()
  const { evo, sdk, dep } = await wallet.connect(p.devnet)
  const groupId = String(dep.v2.contractGroupId)
  const rec = JSON.parse(readFileSync(p.identityFile, 'utf8')) as { identityId: string; identityKeys: IdentityFileKey[] }
  const identityId = rec.identityId

  // The parsing and sealing are the vendored module's own: parse once to check, answer from the same URI.
  const parsed = parseAppConnectUri(p.uri)
  const req = parsed.request
  const refusal = v2RequestRefusal(req, { now: (p.now ?? Date.now)(), groupId })
  if (refusal !== null) throw new Error(`the scripted wallet refuses this request (${refusal.status}): ${refusal.why}`)
  const binding = req.authBindings[0]!
  const budget = p.limits?.budget ?? binding.totalBudget!
  const expiresAt = p.limits?.expiresAt ?? binding.expiresAt!

  const identity = await sdk.identities.fetch(identityId)
  const next = Math.max(...identity.publicKeys.map((k: { keyId: number }) => k.keyId)) + 1
  const priv = secp.utils.randomSecretKey()
  const fresh = evo.PrivateKey.fromBytes(priv, 'testnet')
  const master = rec.identityKeys.find((x) => x.securityLevel === 'MASTER')
  if (!master) throw new Error('the identity file has no master key')
  const signer = new evo.IdentitySigner()
  signer.addKey(evo.PrivateKey.fromWIF(master.privateKeyWif))
  signer.addKey(fresh)

  // The previous grant for this (identity, connection id), if the chain still shows it live.
  const slot = grantKey(identityId, req.connectionId)
  const previous = p.wallet.grants.get(slot) ?? null
  const live = previous !== null && identity.publicKeys.some((k: { keyId: number; disabledAt?: unknown }) => k.keyId === previous && k.disabledAt === undefined)
  const key = new evo.IdentityPublicKeyInCreation({
    keyId: next,
    purpose: 'authentication',
    securityLevel: 'high',
    keyType: 'ecdsa_secp256k1',
    data: fresh.getPublicKey().toBytes(),
    contractBounds: evo.ContractBounds.ContractGroup(groupId),
    totalBudget: budget,
    expiresAt: BigInt(expiresAt),
  })
  // One master-signed update: the new key in, the previous grant's key out.
  await sdk.identities.update({ identity, addPublicKeys: [key], ...(live ? { disablePublicKeys: [previous] } : {}), signer })
  p.wallet.grants.set(slot, next)
  p.wallet.added.set(identityId, [...(p.wallet.added.get(identityId) ?? []), next])

  // Publish the response under the identity, sealed to the request's ephemeral key.
  const answer = await answerV2(p.uri, { ownerId: identityId, slots: [priv] })
  // The identity's own HIGH authentication key signs the document, built from the identity file as wallet-responder.mjs does.
  const high = rec.identityKeys.find((x) => x.securityLevel === 'HIGH' && x.purpose === 'AUTHENTICATION')
  if (!high) throw new Error('the identity file has no HIGH authentication key')
  const identityKey = new evo.IdentityPublicKey({
    keyId: high.id,
    purpose: high.purpose,
    securityLevel: high.securityLevel,
    keyType: high.keyType,
    isReadOnly: false,
    data: Buffer.from(high.publicKeyHex, 'hex'),
  })
  const publisher = new evo.IdentitySigner()
  publisher.addKey(evo.PrivateKey.fromWIF(high.privateKeyWif))
  const base = new evo.Document({ properties: {}, documentTypeName: 'loginKeyResponse', dataContractId: APP_CONNECT_CONTRACT_ID, ownerId: identityId })
  const document = evo.Document.fromObject(
    {
      ...base.toObject(),
      appEphemeralPubKeyHash: answer.requestHash,
      walletEphemeralPubKey: answer.walletEphemeralPubKey,
      encryptedPayload: answer.encryptedPayload,
    },
    sdk.version(),
  )
  await sdk.documents.create({ document, identityKey, signer: publisher })
  priv.fill(0)

  return {
    identityId,
    keyId: next,
    replacedKeyId: live ? previous : null,
    requestHash: bytesToHex(answer.requestHash),
    label: req.label,
    granted: { budget, expiresAt },
  }
}

/** Cleanup: disable every key this wallet added that is still live on `identityFile`'s identity. */
export async function disableGrants(p: { readonly wallet: V2Wallet; readonly identityFile: string; readonly devnet: string }): Promise<number[]> {
  const wallet = await responder()
  const { evo, sdk } = await wallet.connect(p.devnet)
  const rec = JSON.parse(readFileSync(p.identityFile, 'utf8')) as { identityId: string; identityKeys: IdentityFileKey[] }
  const mine = new Set(p.wallet.added.get(rec.identityId) ?? [])
  if (mine.size === 0) return []
  const identity = await sdk.identities.fetch(rec.identityId)
  const ids = identity.publicKeys.filter((k: { keyId: number; disabledAt?: unknown }) => mine.has(k.keyId) && k.disabledAt === undefined).map((k: { keyId: number }) => k.keyId)
  if (ids.length === 0) return []
  const master = rec.identityKeys.find((x) => x.securityLevel === 'MASTER')
  if (!master) throw new Error('the identity file has no master key')
  const signer = new evo.IdentitySigner()
  signer.addKey(evo.PrivateKey.fromWIF(master.privateKeyWif))
  await sdk.identities.update({ identity, disablePublicKeys: ids, signer })
  return ids
}

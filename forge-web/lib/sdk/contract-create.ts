/**
 * Repo contract instantiation (createRepo) — the browser port of forge-core `repo.rs::create_repo`.
 *
 * Publishing a repo creates its per-repo token-bearing data contract (the headline ~1.18 DASH
 * cost) with a **CRITICAL** key (S0.7). The committed `repo-v1` template models an *org* repo
 * (token admin held by a control group, positions numbered globally); native validation rejects
 * both shapes for a solo owner, so two runtime fixes are applied **exactly** as forge-core does —
 * this is load-bearing for cross-client interop (a web-created repo must match a CLI-created one):
 *
 *  1. {@link applySoloOwnerTokenRules} — drop `groups`, re-point every `MainGroup` token-admin
 *     rule to `ContractOwner`, null out `mainControlGroup` (a 1-member group is rejected).
 *  2. {@link normalizeDocumentPositions} — renumber each object level's `position` fields to a
 *     contiguous `0..N` (native rs-dpp requires top-level positions with no gaps).
 *
 * The transforms are pure and unit-tested against the bundled template; the publish step then
 * hands the fixed contract to the evo-sdk. `DataContract.fromJSON`'s accepted shape is the one
 * SDK-interop risk here (see the createRepo note in the task report).
 */

import type { DataContract, EvoSDK } from '@dashevo/evo-sdk'

import { SECURITY_LEVEL, WriteAuthError, findSigningKey, type WriteAuth } from './write'
import repoV1Template from './repo-v1-template.json'

/** A JSON value (the template is manipulated structurally before publish). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

function isObject(v: JsonValue | undefined): v is { [key: string]: JsonValue } {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Re-point a solo-owner repo's token rules: drop the top-level `groups`, replace every
 * `MainGroup` action-taker with `ContractOwner`, and null any `mainControlGroup`. Mutates in
 * place. Parity with `apply_solo_owner_token_rules` / `repoint_group_rules_to_owner`.
 */
export function applySoloOwnerTokenRules(template: { [key: string]: JsonValue }): void {
  delete template['groups']
  const tokens = template['tokens']
  if (isObject(tokens)) {
    for (const key of Object.keys(tokens)) {
      const token = tokens[key]
      if (token !== undefined) repointGroupRulesToOwner(token)
    }
  }
}

function repointGroupRulesToOwner(value: JsonValue | undefined): void {
  if (Array.isArray(value)) {
    for (const item of value) repointGroupRulesToOwner(item)
    return
  }
  if (!isObject(value)) return
  for (const key of Object.keys(value)) {
    const v = value[key]
    if (
      (key === 'authorizedToMakeChange' || key === 'adminActionTakers') &&
      v === 'MainGroup'
    ) {
      value[key] = 'ContractOwner'
    } else if (key === 'mainControlGroup') {
      value[key] = null
    } else {
      repointGroupRulesToOwner(v)
    }
  }
}

/**
 * Renumber every document schema's `position` fields to contiguous `0..N` per object level (in
 * existing position order), recursing into nested object properties. Mutates in place. Parity
 * with `normalize_document_positions` / `renumber_object_positions`.
 */
export function normalizeDocumentPositions(template: { [key: string]: JsonValue }): void {
  const schemas = template['documentSchemas']
  if (!isObject(schemas)) return
  for (const key of Object.keys(schemas)) {
    const schema = schemas[key]
    if (schema !== undefined) renumberObjectPositions(schema)
  }
}

function renumberObjectPositions(schema: JsonValue | undefined): void {
  if (!isObject(schema)) return
  const props = schema['properties']
  if (!isObject(props)) return
  const order: Array<{ key: string; pos: number }> = Object.keys(props).map((key) => {
    const prop = props[key]
    const pos = isObject(prop) && typeof prop['position'] === 'number' ? prop['position'] : 0
    return { key, pos }
  })
  order.sort((a, b) => a.pos - b.pos)
  order.forEach((entry, newPos) => {
    const prop = props[entry.key]
    if (isObject(prop)) {
      prop['position'] = newPos
      renumberObjectPositions(prop)
    }
  })
}

/** Deep-clone the bundled repo-v1 template and apply both runtime fixes. */
export function buildRepoV1Contract(): { [key: string]: JsonValue } {
  const template = structuredClone(repoV1Template) as unknown as { [key: string]: JsonValue }
  applySoloOwnerTokenRules(template)
  normalizeDocumentPositions(template)
  return template
}

interface IdentitiesNonceFacade {
  nonce(identityId: string): Promise<bigint | undefined>
  fetch(identityId: string): Promise<
    | {
        readonly publicKeys: {
          keyId: number
          purposeNumber: number
          securityLevelNumber: number
          validatePrivateKey(bytes: Uint8Array, network: string): boolean
        }[]
        readonly balance: bigint
        getPublicKeyById(keyId: number): unknown
      }
    | undefined
  >
}
interface ContractsPublishFacade {
  publish(options: unknown): Promise<{ id?: { toString(): string } } | unknown>
}
interface SdkContractCreateFacades {
  identities: IdentitiesNonceFacade
  contracts: ContractsPublishFacade
}
function facades(sdk: EvoSDK): SdkContractCreateFacades {
  return sdk as unknown as SdkContractCreateFacades
}

const SEQUENCE_MASK = (1n << 40n) - 1n

/** The result of a repo contract instantiation. */
export interface CreateRepoContractResult {
  readonly contractId: string
  /** Approximate DASH cost previewed pre-sign (the exact fee settles at consensus). */
  readonly estimatedDash: number
}

/**
 * Instantiate a repo's per-repo data contract (DataContractCreate) with the acting identity's
 * CRITICAL key. Returns the new contract id. This is the expensive create; callers write the
 * initial `config` + registry `repoListing` separately (see `repo/writes.ts::finalizeRepo`).
 */
export async function createRepoContract(
  sdk: EvoSDK,
  auth: WriteAuth,
  opts: { readonly version?: number } = {},
): Promise<CreateRepoContractResult> {
  // Dynamic import keeps the evo-sdk WASM out of the initial bundle (loaded on first write).
  const { DataContract, IdentitySigner } = await import('@dashevo/evo-sdk')
  const template = buildRepoV1Contract()
  const ownerId = auth.identityId
  template['ownerId'] = ownerId

  const wif = auth.getSigningKeyWif()
  const identity = await facades(sdk).identities.fetch(ownerId)
  if (!identity) throw new WriteAuthError(`identity ${ownerId} not found`)
  const signing = await findSigningKey(identity, wif, auth.network, SECURITY_LEVEL.CRITICAL)
  if (!signing) {
    throw new WriteAuthError('repo creation requires a CRITICAL AUTHENTICATION key')
  }

  const rawNonce = (await facades(sdk).identities.nonce(ownerId)) ?? 0n
  const identityNonce = (rawNonce & SEQUENCE_MASK) + 1n

  const platformVersion = opts.version ?? (sdk as unknown as { version(): number }).version()

  // Derive and stamp the deterministic contract id (owner + identity nonce).
  const contractIdBytes = (
    DataContract as unknown as {
      generateId(ownerId: string, identityNonce: bigint): { toString(): string }
    }
  ).generateId(ownerId, identityNonce)
  const contractId = contractIdBytes.toString()
  template['id'] = contractId

  const dataContract = (
    DataContract as unknown as {
      fromJSON(value: unknown, fullValidation: boolean, platformVersion: number): DataContract
    }
  ).fromJSON(template, true, platformVersion)

  const signer = new IdentitySigner()
  signer.addKeyFromWif(wif)

  const published = await facades(sdk).contracts.publish({
    dataContract,
    identityKey: signing.publicKey,
    signer,
  })

  const publishedId =
    published !== null &&
    typeof published === 'object' &&
    'id' in published &&
    (published as { id?: { toString(): string } }).id
      ? (published as { id: { toString(): string } }).id.toString()
      : contractId

  return { contractId: publishedId, estimatedDash: 1.18 }
}

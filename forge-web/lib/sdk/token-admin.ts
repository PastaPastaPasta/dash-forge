/**
 * Token-admin writes — collaborator grant (mint) / suspend (freeze) / revoke (freeze + destroy).
 *
 * These are the CRITICAL-key token operations (S0.7: token admin ops reject a HIGH key). Unlike
 * document writes they go through the typed token facade (`tokens.mint` / `freeze` /
 * `destroyFrozen`), which builds + broadcasts + waits internally — the browser is the supported
 * runtime for these (the Node `waitForResponse` panic does not apply in a real browser).
 *
 * Parity with forge-core `tokens.rs`: grant mints `GRANT_AMOUNT` of the role token to the member
 * (WRITE = position 0, MAINTAIN = position 1) and **verifies via a balance query** — the
 * keepsHistory `mint()` return value is not trusted (known SDK bug, spike-results). Suspend
 * freezes; revoke freezes-then-destroys. Idempotent: a grant to an existing (unfrozen) holder,
 * or a freeze of an already-frozen balance, is a no-op success.
 */

import type { EvoSDK, IdentityPublicKey, IdentitySigner } from '@dashevo/evo-sdk'

import { findSigningKey, SECURITY_LEVEL, WriteAuthError, type WriteAuth } from './write'

/** Amount minted per grant (a single role token confers the ACL; parity with forge-core). */
export const GRANT_AMOUNT = 1

/** Repo role → token position (WRITE = 0, MAINTAIN = 1). */
export const ROLE_POSITION = { write: 0, maintain: 1 } as const
export type Role = keyof typeof ROLE_POSITION

interface TokensFacadeLike {
  calculateId(contractId: string, tokenPosition: number): Promise<string>
  balances(identityIds: string[], tokenId: string): Promise<Map<string, bigint>>
  identitiesTokenInfos(identityIds: string[], tokenId: string): Promise<Map<string, unknown>>
  mint(options: unknown): Promise<unknown>
  freeze(options: unknown): Promise<unknown>
  unfreeze(options: unknown): Promise<unknown>
  destroyFrozen(options: unknown): Promise<unknown>
}
interface IdentitiesFacadeLike {
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
interface SdkTokenFacades {
  tokens: TokensFacadeLike
  identities: IdentitiesFacadeLike
}
function facades(sdk: EvoSDK): SdkTokenFacades {
  return sdk as unknown as SdkTokenFacades
}

/** Build the CRITICAL-key signer material (signer + wasm public key) for a token-admin op. */
async function criticalSigner(
  sdk: EvoSDK,
  auth: WriteAuth,
): Promise<{ signer: IdentitySigner; identityKey: IdentityPublicKey }> {
  const wif = auth.getSigningKeyWif()
  const identity = await facades(sdk).identities.fetch(auth.identityId)
  if (!identity) throw new WriteAuthError(`identity ${auth.identityId} not found`)
  const signing = await findSigningKey(identity, wif, auth.network, SECURITY_LEVEL.CRITICAL)
  if (!signing) {
    throw new WriteAuthError(
      'token-admin operations require a CRITICAL AUTHENTICATION key that matches the stored key',
    )
  }
  const { IdentitySigner } = await import('@dashevo/evo-sdk')
  const signer = new IdentitySigner()
  signer.addKeyFromWif(wif)
  return { signer, identityKey: signing.publicKey as IdentityPublicKey }
}

function isFrozen(info: unknown): boolean {
  if (info != null && typeof info === 'object') {
    const rec = info as Record<string, unknown>
    if (rec['isFrozen'] === true || rec['frozen'] === true) return true
  }
  return false
}

async function balanceOf(sdk: EvoSDK, tokenId: string, member: string): Promise<bigint> {
  const balances = await facades(sdk).tokens.balances([member], tokenId)
  return balances.get(member) ?? 0n
}
async function frozenOf(sdk: EvoSDK, tokenId: string, member: string): Promise<boolean> {
  const infos = await facades(sdk).tokens.identitiesTokenInfos([member], tokenId)
  return isFrozen(infos.get(member))
}

/**
 * Grant a collaborator a role (mint the role token to `memberId`). Idempotent: an existing
 * unfrozen holder is skipped. Verified via a post-mint balance query. Returns whether a mint
 * was actually broadcast.
 */
export async function grantRole(
  sdk: EvoSDK,
  auth: WriteAuth,
  contractId: string,
  memberId: string,
  role: Role,
): Promise<{ minted: boolean }> {
  const position = ROLE_POSITION[role]
  const tokenId = await facades(sdk).tokens.calculateId(contractId, position)
  if ((await balanceOf(sdk, tokenId, memberId)) > 0n) {
    return { minted: false }
  }
  const { Identifier } = await import('@dashevo/evo-sdk')
  const { signer, identityKey } = await criticalSigner(sdk, auth)
  await facades(sdk).tokens.mint({
    dataContractId: new Identifier(contractId),
    tokenPosition: position,
    amount: BigInt(GRANT_AMOUNT),
    identityId: new Identifier(auth.identityId),
    recipientId: new Identifier(memberId),
    identityKey,
    signer,
  })
  if ((await balanceOf(sdk, tokenId, memberId)) === 0n) {
    throw new Error('grant broadcast but the member balance did not increase')
  }
  return { minted: true }
}

/** Suspend a collaborator (freeze the role balance). Idempotent; verified via a freeze query. */
export async function suspendRole(
  sdk: EvoSDK,
  auth: WriteAuth,
  contractId: string,
  memberId: string,
  role: Role,
): Promise<{ frozen: boolean }> {
  const position = ROLE_POSITION[role]
  const tokenId = await facades(sdk).tokens.calculateId(contractId, position)
  if (await frozenOf(sdk, tokenId, memberId)) return { frozen: true }
  const { Identifier } = await import('@dashevo/evo-sdk')
  const { signer, identityKey } = await criticalSigner(sdk, auth)
  await facades(sdk).tokens.freeze({
    dataContractId: new Identifier(contractId),
    tokenPosition: position,
    authorityId: new Identifier(auth.identityId),
    frozenIdentityId: new Identifier(memberId),
    identityKey,
    signer,
  })
  if (!(await frozenOf(sdk, tokenId, memberId))) {
    throw new Error('suspend broadcast but the member token is not frozen')
  }
  return { frozen: true }
}

/** Revoke a collaborator's role: freeze (if needed) then destroy the frozen balance. */
export async function revokeRole(
  sdk: EvoSDK,
  auth: WriteAuth,
  contractId: string,
  memberId: string,
  role: Role,
): Promise<{ revoked: boolean }> {
  const position = ROLE_POSITION[role]
  const tokenId = await facades(sdk).tokens.calculateId(contractId, position)
  const { Identifier } = await import('@dashevo/evo-sdk')
  const { signer, identityKey } = await criticalSigner(sdk, auth)
  if (!(await frozenOf(sdk, tokenId, memberId))) {
    await facades(sdk).tokens.freeze({
      dataContractId: new Identifier(contractId),
      tokenPosition: position,
      authorityId: new Identifier(auth.identityId),
      frozenIdentityId: new Identifier(memberId),
      identityKey,
      signer,
    })
  }
  await facades(sdk).tokens.destroyFrozen({
    dataContractId: new Identifier(contractId),
    tokenPosition: position,
    authorityId: new Identifier(auth.identityId),
    frozenIdentityId: new Identifier(memberId),
    identityKey,
    signer,
  })
  if ((await balanceOf(sdk, tokenId, memberId)) !== 0n) {
    throw new Error('revoke broadcast but the member balance is not zero')
  }
  return { revoked: true }
}

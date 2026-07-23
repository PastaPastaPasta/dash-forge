/**
 * Token-history reconstruction (data-contracts §2.1, §4) — the as-of-time WRITE / MAINTAIN
 * authorization source for the issue/PR event fold.
 *
 * A TS port of forge-core `tokens.rs::token_history()`. A repo's two tokens ARE its ACL, so
 * the folded state of an issue/PR must honor *who held which token when each event landed*.
 * Platform emits an audit document on the system **TokenHistory** contract for every
 * `mint` / `freeze` / `unfreeze` / `destroyFrozenFunds`; replaying those (as {@link TokenRecord}s)
 * through {@link holdingsAsOf} reconstructs spendable holdings at any past `$createdAt`.
 *
 * Faithful to the hardened Rust after its review fixes:
 *   1. **Seed the owner** — the repo owner is auto-credited both tokens' `baseSupply` at
 *      contract creation, which emits NO `mint` document. Without a synthetic genesis mint
 *      (`createdAt = 0`) the owner would read as a non-holder and its legitimate actions
 *      would fold as unauthorized.
 *   2. **Paginate to exhaustion** (`query_all`) — a repo with >100 grants would otherwise drop
 *      late collaborators from the resolver.
 *   3. **Observe owner freeze** — the owner is always in the affected set so its freeze /
 *      unfreeze / destroy history is reconstructed (org joint-ownership can freeze the owner);
 *      otherwise the owner reads as perpetually unfrozen.
 *
 * Best-effort: any read failure (contract unreachable, index shape, mainnet not deployed)
 * degrades to an empty history — the fold then honors only the target author's own
 * close/reopen, exactly the prior behavior, never a hard error in the UI.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Decode, base58Encode } from '../auth/base58'
import { TOKEN_HISTORY_CONTRACT_ID, type Network } from '../constants'
import { AuthzResolver, type TokenKind, type TokenOp, type TokenRecord } from '../rules'
import { base64ToBytes, queryAllDocuments } from '../sdk'
import { repoTokenIds } from './collab'
import type { RepoRef } from './contract'

/** TokenHistory document type names (parity with `tokens.rs`). */
const TH = {
  mint: 'mint',
  freeze: 'freeze',
  unfreeze: 'unfreeze',
  destroy: 'destroyFrozenFunds',
} as const

/** The two repo token positions, in the fixed WRITE-then-MAINTAIN order. */
const ROLES: ReadonlyArray<{ readonly kind: TokenKind; readonly key: 'write' | 'maintain' }> = [
  { kind: 'write', key: 'write' },
  { kind: 'maintain', key: 'maintain' },
]

/** The freeze-lifecycle doc types mapped to their {@link TokenOp}. */
const FREEZE_OPS: ReadonlyArray<{ readonly doc: string; readonly op: TokenOp }> = [
  { doc: TH.freeze, op: 'freeze' },
  { doc: TH.unfreeze, op: 'unfreeze' },
  { doc: TH.destroy, op: 'destroy' },
]

/**
 * Normalize an identifier-typed result field to base58. The SDK's `toJSON` serializes
 * identifier fields as base58, but a byteArray-typed field would arrive base64 — accept
 * either so a schema nuance on the system contract cannot silently drop records.
 */
function toIdentityB58(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  try {
    if (base58Decode(v).length === 32) return v
  } catch {
    // Not base58 — fall through to base64.
  }
  try {
    const bytes = base64ToBytes(v)
    if (bytes.length === 32) return base58Encode(bytes)
  } catch {
    // Not base64 either.
  }
  return null
}

function num(doc: Record<string, unknown>, field: string): number {
  const v = doc[field]
  if (typeof v === 'bigint') return Number(v)
  return typeof v === 'number' ? v : 0
}

/**
 * Read the repo's full token history as {@link TokenRecord}s (both tokens), ready to feed
 * {@link AuthzResolver} / {@link holdingsAsOf}. See the module note for the three parity
 * invariants (owner seed, pagination, owner-freeze). Returns `[]` on any failure.
 */
export async function readTokenHistory(
  sdk: EvoSDK,
  repo: RepoRef,
  network: Network = 'testnet',
): Promise<TokenRecord[]> {
  const historyContractId = TOKEN_HISTORY_CONTRACT_ID[network]
  if (!historyContractId) return []

  try {
    const owner = repo.ownerId
    const tokenIds = await repoTokenIds(sdk, repo)
    const records: TokenRecord[] = []

    // (1) Synthetic genesis mint for the owner on both tokens (baseSupply, no mint doc).
    for (const role of ROLES) {
      records.push({
        id: `baseSupply:${owner}:${role.key}`,
        identity: owner,
        token: role.kind,
        op: 'mint',
        createdAt: 0,
      })
    }

    // Two waves per role (the affected set depends on the mints), roles in parallel and
    // every freeze/unfreeze/destroy read of a wave in parallel — the fold is
    // order-independent (AuthzResolver sorts by createdAt), so only completeness matters.
    const perRole = await Promise.all(
      ROLES.map(async (role) => {
        const roleRecords: TokenRecord[] = []
        // `tokenId` / `frozenIdentityId` on the TokenHistory contract are IDENTIFIER-typed,
        // so the wasm query operand is the base58 id itself — NOT the base64 byteArray form
        // used for hash/oid fields (verified live against the deployed testnet contract: a
        // base64 operand is rejected with "could not be decoded from base 58").
        const tokenIdB58 = tokenIds[role.key]

        // Mints (byDate index: tokenId, $createdAt), paginated to exhaustion.
        const mints = await queryAllDocuments(sdk, {
          dataContractId: historyContractId,
          documentTypeName: TH.mint,
          where: [['tokenId', '==', tokenIdB58]],
          orderBy: [['$createdAt', 'asc']],
        })

        // (3) Always include the owner so its freeze history is reconstructed.
        const affected = new Set<string>([owner])
        for (const m of mints) {
          const recipient = toIdentityB58(m['recipientId'])
          if (recipient === null) continue
          affected.add(recipient)
          roleRecords.push({
            id: typeof m['$id'] === 'string' ? (m['$id'] as string) : undefined,
            identity: recipient,
            token: role.kind,
            op: 'mint',
            createdAt: num(m, '$createdAt'),
          })
        }

        // Freeze / unfreeze / destroy per affected identity (byFrozenIdentityId index).
        const freezeWaves = await Promise.all(
          [...affected].flatMap((identity) =>
            FREEZE_OPS.map(async ({ doc, op }): Promise<TokenRecord[]> => {
              const docs = await queryAllDocuments(sdk, {
                dataContractId: historyContractId,
                documentTypeName: doc,
                where: [
                  ['tokenId', '==', tokenIdB58],
                  ['frozenIdentityId', '==', identity],
                ],
                orderBy: [['$createdAt', 'asc']],
              })
              return docs.map((d) => ({
                id: typeof d['$id'] === 'string' ? (d['$id'] as string) : undefined,
                identity,
                token: role.kind,
                op,
                createdAt: num(d, '$createdAt'),
              }))
            }),
          ),
        )
        for (const wave of freezeWaves) roleRecords.push(...wave)
        return roleRecords
      }),
    )
    for (const roleRecords of perRole) records.push(...roleRecords)

    return records
  } catch {
    return []
  }
}

// Grants change rarely, but every issues/pulls page needs the resolver — cache it per
// contract. A failed reconstruction returns [] (degraded author-only folds); a SUCCESSFUL
// run always contains at least the two synthetic genesis records, so a short history marks
// a failure and is evicted immediately rather than pinning the degraded resolver for the TTL.
const AUTHZ_TTL_MS = 5 * 60_000
const authzCache = new Map<string, { at: number; promise: Promise<AuthzResolver> }>()

function authzKey(network: Network, contractId: string): string {
  return `${network}:${contractId}`
}

/** Drop a repo's cached authz resolver (call after a grant / suspend / revoke lands). */
export function invalidateAuthz(contractId: string): void {
  for (const key of authzCache.keys()) {
    if (key.endsWith(`:${contractId}`)) authzCache.delete(key)
  }
}

/**
 * Build an {@link AuthzResolver} from the repo's reconstructed token history — the as-of-time
 * WRITE/MAINTAIN source the issue/PR fold consumes. Degrades to an empty resolver (author-only
 * actions) if the history is unavailable. Cached per contract for {@link AUTHZ_TTL_MS};
 * failures are not cached.
 */
export async function resolveAuthz(
  sdk: EvoSDK,
  repo: RepoRef,
  network: Network = 'testnet',
): Promise<AuthzResolver> {
  const key = authzKey(network, repo.contractId)
  const hit = authzCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < AUTHZ_TTL_MS) return hit.promise
  const promise: Promise<AuthzResolver> = readTokenHistory(sdk, repo, network).then(
    (records) => {
      if (records.length < 2 && authzCache.get(key)?.promise === promise) {
        authzCache.delete(key)
      }
      return new AuthzResolver(records)
    },
  )
  // readTokenHistory never rejects today, but a rejected entry must not be pinned for the
  // TTL — evict it like every other session cache does.
  promise.catch(() => {
    if (authzCache.get(key)?.promise === promise) authzCache.delete(key)
  })
  authzCache.set(key, { at: Date.now(), promise })
  return promise
}

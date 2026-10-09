/**
 * Register a DPNS username from the web (#452).
 *
 * Which key can sign it (platform v5.0.0-beta.3; gaps1 `dpns-research.md` has the citations):
 *   - DPNS `preorder` and `domain` set no `signatureSecurityLevelRequirement`, so they need HIGH,
 *     and a batch may then be signed at CRITICAL or HIGH, never MASTER
 *     (`rs-dpp/.../try_from_schema/common/mod.rs:1604-1609`, `rs-drive/src/state_transition_action/batch/mod.rs:494-532`);
 *   - a contract-bound key may only sign inside its contract or contract group
 *     (`rs-drive-abci/.../batch/advanced_structure/v1/mod.rs:149-200`), so neither this browser's
 *     key (bound to the Forge group) nor a wallet login's (bound to forge-core) can.
 * The identity's own unbound AUTHENTICATION key at CRITICAL (else HIGH) can: every identity made
 * here, by `dg auth new` or by the bridge holds one (`./hd` `CANONICAL_KEYS` ids 2 and 1). It comes,
 * like the master key for a key top-up, from the identity file or the recovery phrase, signs the
 * preorder and the domain, and is not kept. `dg auth name register` signs with the same key
 * (`crates/forge-core/src/platform/identity.rs` `register_dpns_name`).
 *
 * The SDK's `dpns.registerName` (`js-evo-sdk/src/dpns/facade.ts:42-45`, `rs-sdk/src/platform/dpns_usernames/mod.rs:142-305`)
 * salts and submits the preorder, then the domain, each waiting for its proof.
 */

import type { EvoSDK, IdentitySigner as WasmSigner } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { authSdk, type WasmKey } from '../sdk/facade'
import { CANONICAL_KEYS, deriveAt, identityKeyPath } from './hd'
import { controlsKey } from './wif'

/** The canonical CRITICAL, then HIGH, authentication key ids (`./hd`): what a phrase derives. */
export const USERNAME_KEY_IDS: readonly number[] = ['CRITICAL', 'HIGH'].map((level) => CANONICAL_KEYS.find((k) => k.purpose === 'AUTHENTICATION' && k.level === level)!.id)

/** The identity file or phrase given holds no live, unbound CRITICAL or HIGH key of the identity. */
export class NoUsernameKeyError extends Error {
  constructor(readonly identityId: string) {
    super(
      "That file or phrase has no key that can sign a username for this identity. It needs the identity's own unbound CRITICAL or HIGH authentication key. Try the file `dg auth new` saved, or the dg command below.",
    )
    this.name = 'NoUsernameKeyError'
  }
}

/** The private keys (WIF) a recovery phrase derives for {@link USERNAME_KEY_IDS}, in that order. */
export async function usernameKeysFromPhrase(mnemonic: string, network: Network): Promise<string[]> {
  const out: string[] = []
  for (const id of USERNAME_KEY_IDS) out.push((await deriveAt(mnemonic, identityKeyPath(network, id), network)).wif)
  return out
}

/**
 * The first of `wifs` that controls a key of `keys` able to sign a DPNS document: AUTHENTICATION,
 * CRITICAL or HIGH, not disabled, bound to no contract. Null when none does.
 */
export function pickUsernameKey(keys: readonly WasmKey[], wifs: readonly string[], network: Network): { readonly key: WasmKey; readonly wif: string } | null {
  for (const wif of wifs) {
    const key = keys.find(
      (k) =>
        k.purposeNumber === 0 &&
        (k.securityLevelNumber === 1 || k.securityLevelNumber === 2) &&
        k.disabledAt === undefined &&
        k.contractBounds === undefined &&
        controlsKey(k, wif, network),
    )
    if (key) return { key, wif }
  }
  return null
}

/**
 * Register `label` (`label.dash`, checked valid and not contested by the caller) for `identityId`,
 * signed by the first of `wifs` that is a usable key ({@link pickUsernameKey}); else
 * {@link NoUsernameKeyError}, before anything is sent.
 */
export async function registerUsername(sdk: EvoSDK, p: { readonly network: Network; readonly identityId: string; readonly label: string; readonly wifs: readonly string[] }): Promise<void> {
  const identity = await authSdk(sdk).identities.fetch(p.identityId)
  if (!identity) throw new Error(`identity ${p.identityId} not found on ${p.network}`)
  const picked = pickUsernameKey(identity.publicKeys, p.wifs, p.network)
  if (picked === null) throw new NoUsernameKeyError(p.identityId)
  const { IdentitySigner } = await import('@dashevo/evo-sdk')
  const signer: WasmSigner = new IdentitySigner()
  try {
    signer.addKeyFromWif(picked.wif)
    const options = { label: p.label, identity, identityKey: identity.getPublicKeyById(picked.key.keyId), signer }
    // The wasm `Identity` and key, narrowed by `authSdk`: the SDK takes the objects themselves.
    const result = await sdk.dpns.registerName(options as unknown as Parameters<EvoSDK['dpns']['registerName']>[0])
    result.free()
  } finally {
    signer.free()
  }
}

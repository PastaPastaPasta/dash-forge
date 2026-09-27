/**
 * Recovery from the 12 words alone: the identity is the one whose master key (key 0, derived
 * from the words) Platform indexes by its hash160. `getIdentityByPublicKeyHash` covers unique
 * ECDSA_SECP256K1 keys, which every identity's master key is (evo-sdk 4.2
 * `identities.byPublicKeyHash`; a proof-verified read on a trusted connection).
 */

import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { EvoSDK } from '@dashevo/evo-sdk'
import type { Network } from '../constants'
import { authSdk } from '../sdk/facade'

/** hash160 of a compressed public key (hex in, hex out): the key-hash index Platform keeps. */
export function publicKeyHash(publicKeyHex: string): string {
  return bytesToHex(ripemd160(sha256(hexToBytes(publicKeyHex))))
}

/** The identity whose master key is `publicKeyHex`, or an error saying none was found. */
export async function identityOfMasterKey(sdk: EvoSDK, publicKeyHex: string, network: Network): Promise<string> {
  const identity = await authSdk(sdk).identities.byPublicKeyHash(publicKeyHash(publicKeyHex))
  if (!identity) {
    throw new Error(
      `No identity on ${network} uses these words' master key. Check the words, or enter the identity ID (an identity created with other software may use a different key path).`,
    )
  }
  return identity.id.toBase58()
}

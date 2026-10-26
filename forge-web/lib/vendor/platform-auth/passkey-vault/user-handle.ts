// The WebAuthn user handle of a vault passkey: identityId ‖ vaultContractId, 64 bytes (WebAuthn's maximum), binary.
// A discoverable sign-in learns from it which identity's entry to read and that the passkey is this vault's. Two deployments of one
// relying party (testnet and mainnet contracts) never share a handle, so a provider never replaces one network's passkey with the
// other's (providers replace a passkey with the same relying party and user handle).
import { bytesEqual } from './bytes'
import { need, PasskeyError } from './errors'

export const USER_HANDLE_LENGTH = 64

export function userHandleFor(identityId: Uint8Array, contractId: Uint8Array): Uint8Array {
  need(identityId.length === 32 && contractId.length === 32, 'the identity and contract ids must be 32 bytes')
  const handle = new Uint8Array(USER_HANDLE_LENGTH)
  handle.set(identityId)
  handle.set(contractId, 32)
  return handle
}

/**
 * The identity a user handle names for this vault contract. Throws `PasskeyError` 'not-vault' when the handle is absent or not 64
 * bytes (an app's local-only passkey with a random 32-byte id, say), and 'other-vault' when it names another vault contract.
 */
export function parseUserHandle(handle: Uint8Array | null | undefined, contractId: Uint8Array): Uint8Array {
  need(contractId.length === 32, 'the contract id must be 32 bytes')
  if (!handle || handle.length !== USER_HANDLE_LENGTH) throw new PasskeyError("This passkey doesn't hold a key on Platform.", 'not-vault')
  if (!bytesEqual(handle.subarray(32), contractId)) throw new PasskeyError("This passkey is set up for another network or app.", 'other-vault')
  return handle.slice(0, 32)
}

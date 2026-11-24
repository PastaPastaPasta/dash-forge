/**
 * A simulated App Connect v2 wallet, for tests (`APP_CONNECT_PROFILE.md`), on the vendored
 * module's parser and sealing: the reference the profile's vectors check.
 */

import { appConnectRequestHash, parseAppConnectUri, sealAppConnectPayload, type ParsedAppConnectUri } from '../vendor/platform-auth/app-connect'
import { base58Decode } from './base58'

/** What an App Connect v2 wallet publishes for a request: the `loginKeyResponse` fields. */
export interface V2Answer {
  readonly parsed: ParsedAppConnectUri
  /** `appEphemeralPubKeyHash`. */
  readonly requestHash: Uint8Array
  readonly walletEphemeralPubKey: Uint8Array
  readonly encryptedPayload: Uint8Array
}

/**
 * An App Connect v2 wallet's answer to `uri`: the request parsed as the profile specifies (a v1
 * URI is refused as unsupported), and `slots` (the private keys it registered, one per granted
 * binding) sealed to it under `ownerId`. Registering those keys is the caller's part.
 */
export async function answerV2(uri: string, p: { readonly ownerId: string; readonly slots: readonly Uint8Array[] }): Promise<V2Answer> {
  const parsed = parseAppConnectUri(uri)
  const sealed = await sealAppConnectPayload({ appEphemeralPubKey: parsed.request.appEphemeralPubKey, ownerId: base58Decode(p.ownerId), slots: [...p.slots] })
  return { parsed, requestHash: appConnectRequestHash(parsed.request), ...sealed }
}

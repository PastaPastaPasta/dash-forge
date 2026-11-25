import { bytesToHex } from '@noble/hashes/utils.js'

import { connectionId } from '../auth/connection-id'
import { ACTIVE_NETWORK } from '../constants'

/** This browser's short id: `<name>-<this>` names a local profile its synced namesake replaced in the view. */
export function deviceShortId(): string {
  return bytesToHex(connectionId(ACTIVE_NETWORK.key)).slice(0, 4)
}

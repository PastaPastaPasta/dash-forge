/**
 * Signatures a hosting service makes on its users' behalf, which no Forge profile can list: GitHub
 * signs the merges and edits made on github.com with its web-flow key, an RSA key too big for a
 * profile entry, so every repository imported from GitHub carries them. When a commit's verdict is
 * `unknown_key` for one of these keys, it is checked against the service's published key here,
 * and the badge says the service signed it, not that a member did. Display only: the shared
 * verdict (`lib/rules/signature.ts`, `dg verify-commit`) is unchanged.
 */

import { splitSignedCommit, type SignatureVerdict } from '../rules/signature'
import { GITHUB_WEB_FLOW_KEY } from './github-web-flow-keys'

/** A service that signs commits for its users. */
export type SigningService = 'github'

/** The fingerprint of GitHub's web-flow key (`GITHUB_WEB_FLOW_KEY`). */
const GITHUB_FINGERPRINT = '968479A1AFF927E37D1A566BB5690EEEBB952194'

const namesGitHub = (key: string): boolean => key === GITHUB_FINGERPRINT || (key.length === 16 && GITHUB_FINGERPRINT.endsWith(key))

/** OpenPGP hash algorithms accepted, as `lib/rules/signature.ts` accepts them: SHA2-256/384/512, SHA3-256/512. */
const PGP_HASHES: ReadonlySet<number> = new Set([8, 9, 10, 12, 14])

type OpenPgp = typeof import('openpgp')
let githubKey: ReturnType<OpenPgp['readKey']> | null = null

/**
 * What a service says of a commit whose signing key is on nobody's profile: `github` when the
 * signature checks against GitHub's web-flow key, `bad` when it names that key but does not check,
 * null when it names no service's key.
 */
export async function serviceSignature(bytes: Uint8Array, verdict: SignatureVerdict, sha256Repo = false): Promise<SigningService | 'bad' | null> {
  if (verdict.reason !== 'unknown_key' || verdict.format !== 'openpgp' || verdict.key === null || !namesGitHub(verdict.key)) return null
  const split = splitSignedCommit(bytes, sha256Repo)
  if (split === null) return null
  const pgp = await import('openpgp')
  githubKey ??= pgp.readKey({ armoredKey: GITHUB_WEB_FLOW_KEY })
  try {
    const signature = await pgp.readSignature({ armoredSignature: split.signature })
    const [packet, ...others] = signature.packets
    if (packet === undefined || others.length > 0) return 'bad'
    if (packet.signatureType !== pgp.enums.signature.binary || packet.hashAlgorithm === null || !PGP_HASHES.has(packet.hashAlgorithm)) return 'bad'
    const { signatures } = await pgp.verify({
      message: await pgp.createMessage({ binary: split.payload }),
      signature,
      verificationKeys: await githubKey,
      format: 'binary',
    })
    const [only, ...rest] = signatures
    if (only === undefined || rest.length > 0) return 'bad'
    await only.verified
    return 'github'
  } catch {
    return 'bad'
  }
}

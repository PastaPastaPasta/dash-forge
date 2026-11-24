/**
 * Signatures a hosting service makes on its users' behalf, which no Forge profile can list: GitHub
 * signs the merges and edits made on github.com with its web-flow key, an RSA key too big for a
 * profile entry, so every repository imported from GitHub carries them. When a commit's verdict is
 * `unknown_key` for one of these keys, it is checked against the service's published key here,
 * and the badge says the service signed it, not that a member did. Display only: the shared
 * verdict (`lib/rules/signature.ts`, `dg verify-commit`) is unchanged.
 */

import { splitSignedCommit, type SignatureVerdict } from '../rules/signature'
import { GITHUB_WEB_FLOW_KEYS } from './github-web-flow-keys'

/** A service that signs commits for its users. */
export type SigningService = 'github'

/** The fingerprints of GitHub's web-flow keys (`GITHUB_WEB_FLOW_KEYS`). */
const GITHUB_FINGERPRINTS = ['5DE3E0509C47EA3CF04A42D34AEE18F83AFDEB23', '968479A1AFF927E37D1A566BB5690EEEBB952194']

const namesGitHub = (key: string): boolean => GITHUB_FINGERPRINTS.some((fp) => fp === key || (key.length === 16 && fp.endsWith(key)))

type OpenPgp = typeof import('openpgp')
let githubKeys: Promise<Awaited<ReturnType<OpenPgp['readKeys']>>> | null = null

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
  githubKeys ??= pgp.readKeys({ armoredKeys: GITHUB_WEB_FLOW_KEYS })
  try {
    const { signatures } = await pgp.verify({
      message: await pgp.createMessage({ binary: split.payload }),
      signature: await pgp.readSignature({ armoredSignature: split.signature }),
      verificationKeys: await githubKeys,
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

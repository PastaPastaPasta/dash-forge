import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { base58Encode } from '../../../forge-web/lib/auth/base58'
import { DEPLOYMENTS, forgeV2Ids, type ForgeIds } from '../../../forge-web/lib/deployments'
import type { WriteSpec } from '../../../forge-web/lib/org/transition'

export const FIXTURE = fileURLToPath(new URL('../../../forge-contracts/fixtures/org/cross-sdk.json', import.meta.url))

export const forge = forgeV2Ids(DEPLOYMENTS['testnet']) as Required<ForgeIds>
export const ORG = '7xmySibLg9RELWNvBcaU4ErgK9w7tyjjb3zjWW1UbPhL'
export const KEY_ID = 2
export const SIGNER = { keyId: KEY_ID, cid: '72ece530e62e2438fb706becea302983dd06aa6f57653dbf930c6b1775944964', slot: 'high' }
export const PLATFORM_VERSIONS = [14, 15]

const bytes = (n: number): Uint8Array => new Uint8Array(32).fill(n)
const id = (n: number): string => base58Encode(bytes(n))
const org = Uint8Array.from(Buffer.from('676fead90056accbb6b46c02ed6836b234f7fcb69da10793cceb954547a2d5fb', 'hex'))
const repoId = bytes(9)
const alice = bytes(5)
const runner = bytes(6)

export interface Vector {
  readonly label: string
  readonly spec: WriteSpec
  readonly nonce: bigint
  readonly entropy?: Uint8Array
}

export const VECTORS: readonly Vector[] = [
  { label: 'repo create: repo', nonce: 5n, entropy: bytes(0x41), spec: { action: 'create', contractId: forge.core, documentType: 'repo', data: { name: 'widgets', visibility: 'public', description: 'Widgets for everyone', defaultBranch: 'main' } } },
  { label: 'repo create: owner maintainer', nonce: 6n, entropy: bytes(0x42), spec: { action: 'create', contractId: forge.core, documentType: 'maintainer', data: { repoId, memberId: org, vis: 'public' } } },
  { label: 'repo create: first config', nonce: 7n, entropy: bytes(0x43), spec: { action: 'create', contractId: forge.core, documentType: 'config', data: { repoId, defaultBranch: 'main', backend: { mode: 0 }, protectedPatterns: ['main', 'release/*'], vis: 'public' } } },
  { label: 'maintainer create', nonce: 8n, entropy: bytes(0x44), spec: { action: 'create', contractId: forge.core, documentType: 'maintainer', data: { repoId, memberId: alice, vis: 'public', consentBy: alice } } },
  { label: 'maintainer delete', nonce: 9n, spec: { action: 'delete', contractId: forge.core, documentType: 'maintainer', documentId: id(0x11) } },
  { label: 'writer create', nonce: 10n, entropy: bytes(0x45), spec: { action: 'create', contractId: forge.core, documentType: 'writer', data: { repoId, memberId: alice, vis: 'public', consentBy: alice, role: 2 } } },
  { label: 'writer delete', nonce: 11n, spec: { action: 'delete', contractId: forge.core, documentType: 'writer', documentId: id(0x12) } },
  { label: 'role change: revoke', nonce: 12n, spec: { action: 'delete', contractId: forge.core, documentType: 'writer', documentId: id(0x13) } },
  { label: 'role change: grant', nonce: 13n, entropy: bytes(0x46), spec: { action: 'create', contractId: forge.core, documentType: 'writer', data: { repoId, memberId: alice, vis: 'public', consentBy: alice, role: 3 } } },
  { label: 'repo replace (listing edit)', nonce: 14n, spec: { action: 'replace', contractId: forge.core, documentType: 'repo', documentId: id(9), revision: 2n, data: { name: 'widgets', visibility: 'public', description: 'New words', defaultBranch: 'main', topics: ['rust', 'cli'] } } },
  { label: 'topic create', nonce: 3n, entropy: bytes(0x47), spec: { action: 'create', contractId: forge.meta, documentType: 'topic', data: { repoId, name: 'rust' } } },
  { label: 'topic delete', nonce: 4n, spec: { action: 'delete', contractId: forge.meta, documentType: 'topic', documentId: id(0x14) } },
  { label: 'runner create', nonce: 2n, entropy: bytes(0x48), spec: { action: 'create', contractId: forge.community, documentType: 'runner', data: { repoId, memberId: runner } } },
  { label: 'runner delete', nonce: 3n, spec: { action: 'delete', contractId: forge.community, documentType: 'runner', documentId: id(0x15) } },
  { label: 'profile create', nonce: 5n, entropy: bytes(0x49), spec: { action: 'create', contractId: forge.meta, documentType: 'profile', data: { displayName: 'Acme', bio: 'We make widgets.', links: ['https://multisig.dashhq.org/'] } } },
  { label: 'profile replace', nonce: 6n, spec: { action: 'replace', contractId: forge.meta, documentType: 'profile', documentId: id(0x16), revision: 1n, data: { displayName: 'Acme Inc', bio: 'We make widgets.', links: ['https://multisig.dashhq.org/', 'https://acme.example/'] } } },
]

export interface FixtureVector {
  label: string
  intent: Record<string, unknown>
  derived: { documentId: string }
  unsigned: string
  signable: string
  dtiReview?: Record<string, string>
}

export interface Fixture {
  about: string
  platformVersions: number[]
  sdks: string[]
  dtiReview: Record<string, string>
  vectors: FixtureVector[]
}

export const readFixture = (): Fixture => JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture

export const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex')
export const bytesOf = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'))

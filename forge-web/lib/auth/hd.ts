/**
 * Mnemonic → keys, the paths `tools/mint-identity` (and the Dash bridge) use, so an identity
 * created here opens in the CLI and vice versa:
 *
 *   identity keys (DIP-13): m/9'/<coin>'/5'/0'/0'/<identityIndex>'/<keyIndex>'
 *   asset-lock key (BIP-44): m/44'/<coin>'/0'/0/0
 *
 * coin type 5 on mainnet, 1 elsewhere. The canonical key set (key id = index) is MASTER,
 * HIGH, CRITICAL authentication, CRITICAL transfer, MEDIUM encryption.
 *
 * Derivation runs in the evo-sdk WASM (`wallet.deriveKeyFromSeedWithPath`); verified against
 * mint-identity's @scure/bip32 output for the moutai fixture identities.
 */

import type { Network } from '../constants'

export type KeyPurpose = 'AUTHENTICATION' | 'TRANSFER' | 'ENCRYPTION'
export type KeyLevel = 'MASTER' | 'CRITICAL' | 'HIGH' | 'MEDIUM'

/** The canonical identity key set, by key id. */
export const CANONICAL_KEYS: readonly { id: number; purpose: KeyPurpose; level: KeyLevel }[] = [
  { id: 0, purpose: 'AUTHENTICATION', level: 'MASTER' },
  { id: 1, purpose: 'AUTHENTICATION', level: 'HIGH' },
  { id: 2, purpose: 'AUTHENTICATION', level: 'CRITICAL' },
  { id: 3, purpose: 'TRANSFER', level: 'CRITICAL' },
  { id: 4, purpose: 'ENCRYPTION', level: 'MEDIUM' },
]

export interface DerivedKey {
  readonly wif: string
  /** Compressed public key, hex. */
  readonly publicKeyHex: string
  /** P2PKH address. */
  readonly address: string
}

function coin(network: Network): number {
  return network === 'mainnet' ? 5 : 1
}

function wasmNetwork(network: Network): string {
  return network === 'mainnet' ? 'mainnet' : 'testnet'
}

export function identityKeyPath(network: Network, keyIndex: number, identityIndex = 0): string {
  return `m/9'/${coin(network)}'/5'/0'/0'/${identityIndex}'/${keyIndex}'`
}

export function assetLockKeyPath(network: Network): string {
  return `m/44'/${coin(network)}'/0'/0/0`
}

interface WalletFacade {
  deriveKeyFromSeedWithPath(p: { mnemonic: string; path: string; network: string }): Promise<{
    toJSON(): { privateKeyWif: string; publicKey: string; address: string }
    free(): void
  }>
  generateMnemonic(p?: { wordCount?: number }): Promise<string>
  validateMnemonic(m: string): Promise<boolean>
}

async function wallet(): Promise<WalletFacade> {
  const evo = await import('@dashevo/evo-sdk')
  await evo.EvoSDK.getLatestVersionNumber()
  return (evo as unknown as { wallet: WalletFacade }).wallet
}

/** Derive one key from a mnemonic at `path`. */
export async function deriveAt(mnemonic: string, path: string, network: Network): Promise<DerivedKey> {
  const info = await (await wallet()).deriveKeyFromSeedWithPath({ mnemonic: normalizeMnemonic(mnemonic), path, network: wasmNetwork(network) })
  const j = info.toJSON()
  info.free()
  return { wif: j.privateKeyWif, publicKeyHex: j.publicKey, address: j.address }
}

/** The identity's master key (key id 0) from its mnemonic. */
export function deriveMasterKey(mnemonic: string, network: Network): Promise<DerivedKey> {
  return deriveAt(mnemonic, identityKeyPath(network, 0), network)
}

/** A fresh 12-word English mnemonic (128 bits of entropy). */
export async function newMnemonic(): Promise<string> {
  return (await wallet()).generateMnemonic({ wordCount: 12 })
}

/** Whether `m` is a valid BIP-39 mnemonic (checksum included). */
export async function isValidMnemonic(m: string): Promise<boolean> {
  try {
    return await (await wallet()).validateMnemonic(normalizeMnemonic(m))
  } catch {
    return false
  }
}

/** Lowercase, single-spaced. */
export function normalizeMnemonic(m: string): string {
  return m.trim().toLowerCase().split(/\s+/).join(' ')
}

/**
 * Three distinct word positions (0-based) the backup quiz asks for, chosen at random.
 * `count` words total.
 */
export function quizPositions(count = 12, ask = 3): number[] {
  const picked = new Set<number>()
  const r = new Uint32Array(1)
  while (picked.size < ask) {
    crypto.getRandomValues(r)
    picked.add((r[0] as number) % count)
  }
  return [...picked].sort((a, b) => a - b)
}

// HD derivation (ported from mainnet-bridge/src/crypto/hd.ts).
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const BIP44_PURPOSE = 44;
const DIP9_PURPOSE = 9;
const DIP13_IDENTITY_FEATURE = 5;
const ECDSA_KEY_TYPE = 0;
const IDENTITY_INDEX = 0;

// Mainnet coin type 5; everything else (testnet/devnet) coin type 1.
export function getCoinType(network) {
  return network === 'mainnet' ? 5 : 1;
}

export function generateNewMnemonic(strength = 128) {
  return generateMnemonic(wordlist, strength);
}

export function mnemonicToHDKey(mnemonic, passphrase = '') {
  const seed = mnemonicToSeedSync(mnemonic, passphrase);
  return HDKey.fromMasterSeed(seed);
}

// Asset-lock key path (BIP44): m/44'/[coin]'/0'/0/0
export function getAssetLockDerivationPath(network) {
  const coinType = getCoinType(network);
  return `m/${BIP44_PURPOSE}'/${coinType}'/0'/0/0`;
}

// Identity key path (DIP-0013): m/9'/[coin]'/5'/0'/[keyType]'/[identityIndex]'/[keyIndex]'
export function getIdentityKeyDerivationPath(keyIndex, network, identityIndex = IDENTITY_INDEX, keyType = ECDSA_KEY_TYPE) {
  const coinType = getCoinType(network);
  return `m/${DIP9_PURPOSE}'/${coinType}'/${DIP13_IDENTITY_FEATURE}'/0'/${keyType}'/${identityIndex}'/${keyIndex}'`;
}

export function deriveKeyAtPath(hdKey, path) {
  const derived = hdKey.derive(path);
  if (!derived.privateKey || !derived.publicKey) {
    throw new Error(`Failed to derive key at path: ${path}`);
  }
  return { privateKey: derived.privateKey, publicKey: derived.publicKey };
}

export function deriveAssetLockKeyPair(mnemonic, network) {
  const hdKey = mnemonicToHDKey(mnemonic);
  const path = getAssetLockDerivationPath(network);
  const { privateKey, publicKey } = deriveKeyAtPath(hdKey, path);
  return { privateKey, publicKey, derivationPath: path };
}

export function deriveIdentityKey(mnemonic, keyIndex, network, identityIndex = IDENTITY_INDEX) {
  const hdKey = mnemonicToHDKey(mnemonic);
  const path = getIdentityKeyDerivationPath(keyIndex, network, identityIndex);
  const { privateKey, publicKey } = deriveKeyAtPath(hdKey, path);
  return { privateKey, publicKey, derivationPath: path };
}

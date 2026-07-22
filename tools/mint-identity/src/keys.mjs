// Key + identity-key generation (ported from mainnet-bridge/src/crypto/keys.ts + address.ts).
import * as secp256k1 from '@noble/secp256k1';
import { randomBytes } from '@noble/hashes/utils';
import { hash160 } from './hash.mjs';
import { bytesToHex, bytesToBase64, privateKeyToWif, base58CheckEncode, concatBytes } from './bytes.mjs';
import { deriveIdentityKey, deriveAssetLockKeyPair } from './hd.mjs';

export function generateKeyPair() {
  const privateKey = randomBytes(32);
  const publicKey = secp256k1.getPublicKey(privateKey, true); // compressed (33 bytes)
  return { privateKey, publicKey };
}

export function getPublicKey(privateKey) {
  return secp256k1.getPublicKey(privateKey, true);
}

// P2PKH address from a compressed public key.
export function publicKeyToAddress(publicKey, network) {
  const pubKeyHash = hash160(publicKey);
  const versionedHash = concatBytes(new Uint8Array([network.addressPrefix]), pubKeyHash);
  return base58CheckEncode(versionedHash);
}

function keyDataBytes(publicKey, keyType) {
  return keyType === 'ECDSA_HASH160' ? hash160(publicKey) : publicKey;
}

function identityKeyFromKeyPair(id, name, keyType, purpose, securityLevel, privateKey, publicKey, network, derivationPath) {
  const dataBytes = keyDataBytes(publicKey, keyType);
  return {
    id,
    name,
    keyType,
    purpose,
    securityLevel,
    privateKey,
    publicKey,
    privateKeyHex: bytesToHex(privateKey),
    privateKeyWif: privateKeyToWif(privateKey, network),
    publicKeyHex: bytesToHex(publicKey),
    dataBase64: bytesToBase64(dataBytes),
    derivationPath,
  };
}

function identityKeyFromMnemonic(id, name, keyType, purpose, securityLevel, network, mnemonic, keyIndex) {
  const { privateKey, publicKey, derivationPath } = deriveIdentityKey(mnemonic, keyIndex, network.name);
  return identityKeyFromKeyPair(id, name, keyType, purpose, securityLevel, privateKey, publicKey, network, derivationPath);
}

// The canonical 5-key identity set (ported from generateDefaultIdentityKeysHD).
export function generateDefaultIdentityKeysHD(network, mnemonic) {
  return [
    identityKeyFromMnemonic(0, 'Master', 'ECDSA_SECP256K1', 'AUTHENTICATION', 'MASTER', network, mnemonic, 0),
    identityKeyFromMnemonic(1, 'High Auth', 'ECDSA_SECP256K1', 'AUTHENTICATION', 'HIGH', network, mnemonic, 1),
    identityKeyFromMnemonic(2, 'Critical Auth', 'ECDSA_SECP256K1', 'AUTHENTICATION', 'CRITICAL', network, mnemonic, 2),
    identityKeyFromMnemonic(3, 'Transfer', 'ECDSA_SECP256K1', 'TRANSFER', 'CRITICAL', network, mnemonic, 3),
    identityKeyFromMnemonic(4, 'Encryption', 'ECDSA_SECP256K1', 'ENCRYPTION', 'MEDIUM', network, mnemonic, 4),
  ];
}

export { deriveAssetLockKeyPair };

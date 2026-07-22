// Hash helpers (ported from mainnet-bridge/src/crypto/hash.ts).
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';

export function sha256Hash(data) {
  return sha256(data);
}

export function hash256(data) {
  return sha256(sha256(data));
}

export function hash160(data) {
  return ripemd160(sha256(data));
}

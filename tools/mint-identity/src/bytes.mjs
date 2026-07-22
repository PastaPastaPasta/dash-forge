// Byte / hex / base helpers (ported from mainnet-bridge utils/hex.ts + base58.ts + wif.ts).
import bs58check from 'bs58check';

export function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('Hex string must have even length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

export function reverseBytes(bytes) {
  return new Uint8Array(bytes).reverse();
}

export function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

export function base58CheckEncode(data) {
  return bs58check.encode(data);
}

export function base58CheckDecode(str) {
  return new Uint8Array(bs58check.decode(str));
}

// WIF (compressed) from raw 32-byte private key.
export function privateKeyToWif(privateKey, network, compressed = true) {
  const prefix = new Uint8Array([network.wifPrefix]);
  if (compressed) {
    return base58CheckEncode(concatBytes(prefix, privateKey, new Uint8Array([0x01])));
  }
  return base58CheckEncode(concatBytes(prefix, privateKey));
}

export function wifToPrivateKey(wif) {
  const decoded = base58CheckDecode(wif);
  const prefix = decoded[0];
  if (decoded.length === 34 && decoded[33] === 0x01) {
    return { privateKey: decoded.slice(1, 33), compressed: true, prefix };
  }
  if (decoded.length === 33) {
    return { privateKey: decoded.slice(1, 33), compressed: false, prefix };
  }
  throw new Error('Invalid WIF format');
}

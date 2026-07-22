// Shared helpers for the S0.2 chunk-geometry spike.
// evo-sdk is resolved via the symlinked node_modules -> tools/mint-identity/node_modules.
import { readFileSync } from 'node:fs';
import * as evoSdk from '@dashevo/evo-sdk';

// Intended identity was CONTRIB, but DataContractCreate requires ~0.14 DASH
// balance-present (see RESULTS.md); CONTRIB had only ~0.0487 DASH, the faucet was
// rate-limited, and inter-identity credit transfer was blocked by the safety
// classifier. TREASURY (same throwaway testnet pool, ~0.6 DASH) is used instead.
// Override with SPIKE_IDENTITY=/abs/path if needed.
export const IDENTITY_FILE = process.env.SPIKE_IDENTITY
  || '/Users/pasta/.config/dash-forge/test-identities/TREASURY.identity.json';
export const PUT_SETTINGS = { connectTimeoutMs: 15000, timeoutMs: 60000, retries: 3 };

export function log(msg) {
  process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`);
}

export function loadIdentity() {
  const rec = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'));
  return rec;
}

// Pick an identity key by securityLevel name (e.g. 'HIGH' or 'CRITICAL'), AUTHENTICATION purpose.
export function pickAuthKey(rec, level) {
  const k = rec.identityKeys.find(
    (k) => k.purpose === 'AUTHENTICATION' && k.securityLevel === level,
  );
  if (!k) throw new Error(`No AUTHENTICATION ${level} key in identity file`);
  return k;
}

let sdkPromise = null;
export async function getSdk() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const { EvoSDK } = evoSdk;
      const sdk = EvoSDK.testnetTrusted({ settings: PUT_SETTINGS });
      log('Connecting to Dash Platform (testnet trusted)...');
      await sdk.connect();
      log('Connected.');
      return sdk;
    })();
  }
  return sdkPromise;
}

export async function disconnectSdk() {
  if (!sdkPromise) return;
  try {
    const sdk = await sdkPromise;
    if (sdk?.disconnect) await sdk.disconnect();
  } catch { /* ignore */ }
  sdkPromise = null;
}

// Build an IdentityPublicKey (wasm) + a signer holding its WIF for a given key record.
export function buildKeyAndSigner(keyRec) {
  const { IdentityPublicKey, IdentitySigner } = evoSdk;
  const publicKey = new IdentityPublicKey({
    keyId: keyRec.id,
    purpose: keyRec.purpose.toLowerCase(),
    securityLevel: keyRec.securityLevel.toLowerCase(),
    keyType: keyRec.keyType.toLowerCase(),
    isReadOnly: false,
    data: Buffer.from(keyRec.publicKeyHex, 'hex'),
  });
  const signer = new IdentitySigner();
  signer.addKeyFromWif(keyRec.privateKeyWif);
  return { publicKey, signer };
}

export { evoSdk };

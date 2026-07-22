// Shared helpers for the S0.7 token-ACL spike.
// evo-sdk resolved via the symlinked node_modules -> tools/mint-identity/node_modules.
import { readFileSync } from 'node:fs';
import * as evoSdk from '@dashevo/evo-sdk';

export const ID_DIR = '/Users/pasta/.config/dash-forge/test-identities';
export const PUT_SETTINGS = { connectTimeoutMs: 15000, timeoutMs: 60000, retries: 3 };
export const STATE_FILE = new URL('./state.json', import.meta.url);

export function log(msg) {
  process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`);
}

export function loadIdentity(name) {
  return JSON.parse(readFileSync(`${ID_DIR}/${name}.identity.json`, 'utf8'));
}

// Pick an AUTHENTICATION key by security level name ('HIGH' | 'CRITICAL' | 'MASTER').
export function pickAuthKey(rec, level) {
  const k = rec.identityKeys.find(
    (k) => k.purpose === 'AUTHENTICATION' && k.securityLevel === level,
  );
  if (!k) throw new Error(`No AUTHENTICATION ${level} key in ${rec.identityId}`);
  return k;
}

// Pick a TRANSFER key (needed for token transfers on some paths).
export function pickTransferKey(rec) {
  const k = rec.identityKeys.find((k) => k.purpose === 'TRANSFER');
  if (!k) throw new Error(`No TRANSFER key in ${rec.identityId}`);
  return k;
}

let sdkPromise = null;
export async function getSdk() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const { EvoSDK } = evoSdk;
      const sdk = EvoSDK.testnetTrusted({ settings: PUT_SETTINGS, version: 12 });
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
// (Locally-constructed key; used for ST.sign on the manual contract-create path.)
export function buildKeyAndSigner(keyRec) {
  const { IdentityPublicKey, IdentitySigner } = evoSdk;
  const publicKey = new IdentityPublicKey({
    keyId: keyRec.id,
    purpose: keyRec.purpose,        // UPPERCASE enum strings, per wasm-sdk test helper
    securityLevel: keyRec.securityLevel,
    keyType: keyRec.keyType,
    isReadOnly: false,
    data: Buffer.from(keyRec.publicKeyHex, 'hex'),
  });
  const signer = new IdentitySigner();
  signer.addKeyFromWif(keyRec.privateKeyWif);
  return { publicKey, signer };
}

// Preferred for facade token/document ops: fetch the identity and use its real
// on-chain IdentityPublicKey object (getPublicKeyById), paired with a WIF signer.
export async function fetchKeyAndSigner(sdk, rec, level) {
  const keyRec = pickAuthKey(rec, level);
  const identity = await sdk.identities.fetch(rec.identityId);
  if (!identity) throw new Error(`identity ${rec.identityId} not found on platform`);
  const publicKey = identity.getPublicKeyById(keyRec.id);
  if (!publicKey) throw new Error(`key id ${keyRec.id} not found on-chain for ${rec.identityId}`);
  const signer = new evoSdk.IdentitySigner();
  signer.addKeyFromWif(keyRec.privateKeyWif);
  return { publicKey, signer, keyRec };
}

// Compact error extraction from a thrown DAPI/consensus error.
export function errText(e) {
  const parts = [];
  if (e?.name) parts.push(`name=${e.name}`);
  if (e?.code !== undefined) parts.push(`code=${e.code}`);
  if (e?.message) parts.push(`message=${e.message}`);
  // Some wasm errors stash detail on other fields
  for (const k of ['data', 'details', 'cause', 'source']) {
    if (e?.[k] && typeof e[k] !== 'object') parts.push(`${k}=${e[k]}`);
  }
  const s = parts.join(' | ');
  return s || String(e);
}

// wasm-sdk bug: token ops on a history-keeping token return a HistoricalDocument,
// and document_to_wasm() passes `None` for the platform version (token.rs:155),
// which deserializes to '' and throws below. The state transition has ALREADY been
// broadcast + accepted at consensus by the time this fires — so it is safe to treat
// this specific error as "landed; verify via query".
export const HISTORY_PARSE_BUG = "'platformVersion' string value '' is not a valid u32";
export function isHistoryParseBug(e) {
  return errText(e).includes(HISTORY_PARSE_BUG);
}

// Run a token op; if it throws ONLY the post-broadcast history-parse bug, swallow it
// and mark landed=true. Any other error propagates (real consensus rejection).
export async function tokenOp(label, fn) {
  try {
    const res = await fn();
    log(`${label}: broadcast OK`);
    return { landed: true, parseBug: false, res };
  } catch (e) {
    if (isHistoryParseBug(e)) {
      log(`${label}: broadcast landed at consensus, SDK result-parse hit history bug (verify via query)`);
      return { landed: true, parseBug: true, err: errText(e) };
    }
    throw e;
  }
}

export { evoSdk };

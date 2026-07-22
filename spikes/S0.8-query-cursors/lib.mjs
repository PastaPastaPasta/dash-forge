// Shared helpers for the S0.8 query-cursor spike.
// evo-sdk resolves via the node_modules symlink -> tools/mint-identity/node_modules.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import * as evoSdk from '@dashevo/evo-sdk';

export const ID_DIR = '/Users/pasta/.config/dash-forge/test-identities';
export const PUT_SETTINGS = { connectTimeoutMs: 15000, timeoutMs: 90000, retries: 5, waitTimeoutMs: 120000 };
export const BROADCAST_SETTINGS = { connectTimeoutMs: 15000, timeoutMs: 30000, retries: 2 };
export const PV = 12;
export const STATE_FILE = new URL('./state.json', import.meta.url);

export function log(msg) {
  process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${msg}\n`);
}

export function loadIdentity(name = 'DEPLOYER') {
  return JSON.parse(readFileSync(`${ID_DIR}/${name}.identity.json`, 'utf8'));
}

export function loadState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
}
export function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export function pickAuthKey(rec, level) {
  const k = rec.identityKeys.find((k) => k.purpose === 'AUTHENTICATION' && k.securityLevel === level);
  if (!k) throw new Error(`No AUTHENTICATION ${level} key in ${rec.identityId}`);
  return k;
}

let sdkPromise = null;
export async function getSdk() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const { EvoSDK } = evoSdk;
      const sdk = EvoSDK.testnetTrusted({ settings: PUT_SETTINGS, version: PV });
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

export function buildKeyAndSigner(keyRec) {
  const { IdentityPublicKey, IdentitySigner, PrivateKey } = evoSdk;
  const publicKey = new IdentityPublicKey({
    keyId: keyRec.id,
    purpose: keyRec.purpose,
    securityLevel: keyRec.securityLevel,
    keyType: keyRec.keyType,
    isReadOnly: false,
    data: Buffer.from(keyRec.publicKeyHex, 'hex'),
  });
  const signer = new IdentitySigner();
  signer.addKeyFromWif(keyRec.privateKeyWif);
  const priv = PrivateKey.fromWIF(keyRec.privateKeyWif);
  return { publicKey, signer, priv };
}

// --- refUpdate contract schema (no token gating; open-creation, DEPLOYER owns) ---
export const REF_SCHEMAS = {
  refUpdate: {
    type: 'object',
    documentsMutable: false,
    canBeDeleted: true, // so the spike can reclaim storage
    properties: {
      refNameHash: { type: 'array', byteArray: true, minItems: 32, maxItems: 32, position: 0 },
      refName: { type: 'string', maxLength: 255, position: 1 },
      newOid: { type: 'array', byteArray: true, minItems: 20, maxItems: 32, position: 2 },
    },
    indices: [
      { name: 'refState', properties: [{ refNameHash: 'asc' }, { $createdAt: 'asc' }] },
      { name: 'reflog', properties: [{ $createdAt: 'asc' }] },
    ],
    required: ['refNameHash', 'refName', 'newOid'],
    additionalProperties: false,
  },
};

export function refHash(name) {
  return createHash('sha256').update(Buffer.from(name, 'utf8')).digest(); // Buffer(32)
}

// Build + sign a refUpdate document-create ST with a manual sequential nonce.
export function buildRefCreateSt({ ownerId, dataContractId, refNameHash, refName, nonce, priv, publicKey }) {
  const { Document, DocumentCreateTransition, BatchedTransition, BatchTransition } = evoSdk;
  const props = {
    refNameHash: new Uint8Array(refNameHash),
    refName,
    newOid: new Uint8Array(randomBytes(20)),
  };
  const doc = new Document({ properties: props, documentTypeName: 'refUpdate', dataContractId, ownerId });
  const docId = doc.id.toString();
  const dct = new DocumentCreateTransition({ document: doc, identityContractNonce: nonce });
  const batch = BatchTransition.fromBatchedTransitions([new BatchedTransition(dct.toDocumentTransition())], ownerId, 0);
  batch.setIdentityContractNonce(nonce);
  const st = batch.toStateTransition();
  st.setIdentityContractNonce(nonce);
  st.sign(priv, publicKey);
  return { st, docId, nonce };
}

export function buildRefDeleteSt({ ownerId, dataContractId, docId, nonce, priv, publicKey }) {
  const { Document, DocumentDeleteTransition, BatchedTransition, BatchTransition } = evoSdk;
  const doc = new Document({ properties: {}, documentTypeName: 'refUpdate', dataContractId, ownerId, id: docId });
  const ddt = new DocumentDeleteTransition({ document: doc, identityContractNonce: nonce });
  const batch = BatchTransition.fromBatchedTransitions([new BatchedTransition(ddt.toDocumentTransition())], ownerId, 0);
  batch.setIdentityContractNonce(nonce);
  const st = batch.toStateTransition();
  st.setIdentityContractNonce(nonce);
  st.sign(priv, publicKey);
  return { st, docId, nonce };
}

// --- nonce helpers (DIP-30 mask) ---
export const NONCE_MASK = (1n << 40n) - 1n;
export async function contractNonce(sdk, ownerId, dataContractId) {
  const raw = (await sdk.identities.contractNonce(ownerId, dataContractId)) ?? 0n;
  return raw & NONCE_MASK;
}
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function pollNonce(sdk, ownerId, dataContractId, target, timeoutMs = 180000, intervalMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let cn = 0n;
  while (Date.now() < deadline) {
    try { cn = await contractNonce(sdk, ownerId, dataContractId); } catch { await sleep(intervalMs); continue; }
    if (cn >= target) return cn;
    await sleep(intervalMs);
  }
  return cn;
}

// Encode a byteArray query operand. `form` is one of: 'bytes','b64','arr','hex','b58'.
export function encHash(bytes, form) {
  const buf = Buffer.from(bytes);
  switch (form) {
    case 'bytes': return new Uint8Array(buf);
    case 'b64': return buf.toString('base64');
    case 'arr': return Array.from(buf);
    case 'hex': return buf.toString('hex');
    case 'b58': return evoSdk.default ? undefined : undefined; // handled by caller with bs58
    default: throw new Error(`unknown form ${form}`);
  }
}

export function errStr(e) {
  if (!e) return String(e);
  const parts = [];
  for (const k of ['name', 'kind', 'code', 'isRetriable', 'message']) {
    try { const v = e[k]; if (v !== undefined) parts.push(`${k}=${v}`); } catch { /* getter threw */ }
  }
  if (parts.length) return parts.join(' ');
  return e.message || String(e);
}

export { evoSdk, randomBytes };

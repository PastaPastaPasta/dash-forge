// Shared helpers for the S0.1 throughput spike.
// evo-sdk resolves via node_modules symlink -> tools/mint-identity/node_modules.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as evoSdk from '@dashevo/evo-sdk';

export const IDENTITY_FILE = process.env.SPIKE_IDENTITY
  || '/Users/pasta/.config/dash-forge/test-identities/OWNER.identity.json';
// Generous timeouts: pipelined broadcasts can queue behind each other on DAPI.
export const PUT_SETTINGS = { connectTimeoutMs: 15000, timeoutMs: 90000, retries: 5, waitTimeoutMs: 120000 };
export const PV = 12; // protocol version (testnet)

// Frozen chunk geometry from S0.2: 3 byteArray fields x 4900 B = 14,700 B payload.
export const FIELD = 4900;

export function log(msg) {
  process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${msg}\n`);
}

export function loadIdentity() {
  return JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'));
}

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

export function buildKeyAndSigner(keyRec) {
  const { IdentityPublicKey, IdentitySigner, PrivateKey } = evoSdk;
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
  const priv = PrivateKey.fromWIF(keyRec.privateKeyWif);
  return { publicKey, signer, priv };
}

// The `chunk` doc type schema (single-type contract to minimize the create reservation).
export const CHUNK_SCHEMAS = {
  chunk: {
    type: 'object',
    indices: [{ name: 'pack_seq', properties: [{ packHash: 'asc' }, { seq: 'asc' }], unique: true }],
    properties: {
      packHash: { type: 'array', byteArray: true, minItems: 32, maxItems: 32, position: 0 },
      seq: { type: 'integer', minimum: 0, position: 1 },
      d0: { type: 'array', byteArray: true, maxItems: 5120, position: 2 },
      d1: { type: 'array', byteArray: true, maxItems: 5120, position: 3 },
      d2: { type: 'array', byteArray: true, maxItems: 5120, position: 4 },
    },
    required: ['packHash', 'seq'],
    additionalProperties: false,
  },
};

// Build + sign a document-create state transition for the chunk type.
// Returns { st, docId, seq, nonce }. entropy auto-generated -> unique $id.
export function buildChunkCreateSt({ ownerId, dataContractId, packHash, seq, nonce, priv, publicKey }) {
  const { Document, DocumentCreateTransition, BatchedTransition, BatchTransition } = evoSdk;
  const props = {
    packHash,
    seq,
    d0: randomBytes(FIELD),
    d1: randomBytes(FIELD),
    d2: randomBytes(FIELD),
  };
  const doc = new Document({ properties: props, documentTypeName: 'chunk', dataContractId, ownerId });
  const docId = doc.id.toString();
  const dct = new DocumentCreateTransition({ document: doc, identityContractNonce: nonce });
  const batch = BatchTransition.fromBatchedTransitions([new BatchedTransition(dct.toDocumentTransition())], ownerId, 0);
  batch.setIdentityContractNonce(nonce);
  const st = batch.toStateTransition();
  st.setIdentityContractNonce(nonce);
  st.sign(priv, publicKey);
  return { st, docId, seq, nonce };
}

// Build + sign a document-DELETE state transition for a chunk doc by id.
export function buildChunkDeleteSt({ ownerId, dataContractId, docId, nonce, priv, publicKey }) {
  const { Document, DocumentDeleteTransition, BatchedTransition, BatchTransition } = evoSdk;
  const doc = new Document({ properties: {}, documentTypeName: 'chunk', dataContractId, ownerId, id: docId });
  const ddt = new DocumentDeleteTransition({ document: doc, identityContractNonce: nonce });
  const batch = BatchTransition.fromBatchedTransitions([new BatchedTransition(ddt.toDocumentTransition())], ownerId, 0);
  batch.setIdentityContractNonce(nonce);
  const st = batch.toStateTransition();
  st.setIdentityContractNonce(nonce);
  st.sign(priv, publicKey);
  return { st, docId, nonce };
}

// Extract a readable string from a thrown value (WasmSdkError has getters).
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

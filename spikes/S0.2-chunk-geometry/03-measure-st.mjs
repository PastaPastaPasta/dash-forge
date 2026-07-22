// Measure the exact signed document-create state-transition size as a function of
// payload, entirely offline (build + sign locally, no broadcast, no fees).
//
// The platform's max_state_transition_size = 20480 is a byte-length check on the
// serialized signed ST (st.toBytes()). So this offline measurement is exactly the
// quantity consensus tests. We sweep 3-field ('blob') and single-field ('wide')
// payloads and report the ST size and the fixed overhead (ST bytes - payload bytes).
import { readFileSync } from 'node:fs';
import * as evoSdk from '@dashevo/evo-sdk';

const { DataContract, Document, DocumentCreateTransition, BatchedTransition, BatchTransition, IdentityPublicKey, PrivateKey, EvoSDK } = evoSdk;

// Initialize the wasm module (its constructors are undefined until an SDK connects).
// This is a read-only connect; nothing is broadcast in this script.
const _sdk = EvoSDK.testnetTrusted({ settings: { connectTimeoutMs: 15000, timeoutMs: 60000 } });
await _sdk.connect();

const ID_FILE = '/Users/pasta/.config/dash-forge/test-identities/CONTRIB.identity.json';
const rec = JSON.parse(readFileSync(ID_FILE, 'utf8'));
const ownerId = rec.identityId;
const critKey = rec.identityKeys.find((k) => k.purpose === 'AUTHENTICATION' && k.securityLevel === 'HIGH');

const PV = 12; // protocol version (testnet, confirmed via sdk.version())

const schemas = {
  blob: {
    type: 'object',
    properties: {
      seq: { type: 'integer', position: 0 },
      d0: { type: 'array', byteArray: true, maxItems: 5120, position: 1 },
      d1: { type: 'array', byteArray: true, maxItems: 5120, position: 2 },
      d2: { type: 'array', byteArray: true, maxItems: 5120, position: 3 },
    },
    required: ['seq'],
    additionalProperties: false,
  },
  wide: {
    type: 'object',
    properties: {
      seq: { type: 'integer', position: 0 },
      d: { type: 'array', byteArray: true, maxItems: 5300, position: 1 },
    },
    required: ['seq'],
    additionalProperties: false,
  },
};

// Contract needs a real-ish id/nonce; content-independent of payload size.
const contract = new DataContract({ ownerId, identityNonce: 1n, schemas, fullValidation: true, platformVersion: PV });
const dataContractId = contract.id.toString();

const publicKey = new IdentityPublicKey({
  keyId: critKey.id,
  purpose: critKey.purpose.toLowerCase(),
  securityLevel: critKey.securityLevel.toLowerCase(),
  keyType: critKey.keyType.toLowerCase(),
  isReadOnly: false,
  data: Buffer.from(critKey.publicKeyHex, 'hex'),
});
const priv = PrivateKey.fromWIF(critKey.privateKeyWif);

function buildSignedSt(typeName, properties) {
  const doc = new Document({ properties, documentTypeName: typeName, dataContractId, ownerId });
  const dct = new DocumentCreateTransition({ document: doc, identityContractNonce: 1n });
  const dt = dct.toDocumentTransition();
  const bt = new BatchedTransition(dt);
  const batch = BatchTransition.fromBatchedTransitions([bt], ownerId, 0);
  const st = batch.toStateTransition();
  st.setIdentityContractNonce?.(1n);
  const sig = st.sign(priv, publicKey);
  return { stBytes: st.toBytes(), sigLen: sig?.length };
}

function bytesOf(n) { return new Uint8Array(n).fill(0xab); }

const LIMIT = 20480;

// --- 3-field blob sweep ---
console.log('# 3-field blob: per-field bytes s, total payload 3s, signed ST bytes, overhead, headroom vs 20480');
console.log('s\t3s\tstBytes\toverhead\theadroom\tsigLen');
let boundary3 = null;
for (const s of [4700, 4800, 4900, 5000, 5100, 5115, 5116, 5117, 5118, 5119, 5120]) {
  const props = { seq: 1, d0: bytesOf(s), d1: bytesOf(s), d2: bytesOf(s) };
  const { stBytes, sigLen } = buildSignedSt('blob', props);
  const total = 3 * s;
  const overhead = stBytes.length - total;
  const headroom = LIMIT - stBytes.length;
  console.log(`${s}\t${total}\t${stBytes.length}\t${overhead}\t${headroom}\t${sigLen}`);
  if (headroom >= 0) boundary3 = { s, total, stBytes: stBytes.length, overhead, headroom };
}
console.log(`\n# largest 3-field payload with ST <= ${LIMIT}: s=${boundary3?.s} (3s=${boundary3?.total}), ST=${boundary3?.stBytes}, overhead=${boundary3?.overhead}, headroom=${boundary3?.headroom}`);

// --- single-field wide sweep (probe how big one field's ST is) ---
console.log('\n# single-field wide: field bytes s, signed ST bytes, overhead');
console.log('s\tstBytes\toverhead');
for (const s of [1, 100, 1000, 4900, 5120, 5200, 5300]) {
  try {
    const { stBytes } = buildSignedSt('wide', { seq: 1, d: bytesOf(s) });
    console.log(`${s}\t${stBytes.length}\t${stBytes.length - s}`);
  } catch (e) {
    console.log(`${s}\tERR\t${e?.message}`);
  }
}

console.log('\nDONE');
await _sdk.disconnect?.();

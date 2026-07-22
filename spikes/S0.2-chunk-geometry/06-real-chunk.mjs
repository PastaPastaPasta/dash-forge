// Measure the signed document-create ST size for the ACTUAL `chunk` type from
// data-contracts.md §2.3: packHash (byteArray 32) + seq (integer) + d0..d2
// (byteArray, maxItems 4900) with unique index (packHash, seq). Offline; the ST
// byte length is exactly what consensus compares to max_state_transition_size.
import { readFileSync } from 'node:fs';
import * as evoSdk from '@dashevo/evo-sdk';
const { DataContract, Document, DocumentCreateTransition, BatchedTransition, BatchTransition, IdentityPublicKey, PrivateKey, EvoSDK } = evoSdk;

const _sdk = EvoSDK.testnetTrusted({ settings: { connectTimeoutMs: 15000, timeoutMs: 60000 } });
await _sdk.connect();

const rec = JSON.parse(readFileSync('/Users/pasta/.config/dash-forge/test-identities/CONTRIB.identity.json', 'utf8'));
const ownerId = rec.identityId;
const k = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === 'HIGH');
const PV = 12;
const LIMIT = 20480;

// Real chunk type incl. packHash + the unique (packHash, seq) index.
const schemas = {
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
const contract = new DataContract({ ownerId, identityNonce: 1n, schemas, fullValidation: true, platformVersion: PV });
const dataContractId = contract.id.toString();
const publicKey = new IdentityPublicKey({ keyId: k.id, purpose: k.purpose.toLowerCase(), securityLevel: k.securityLevel.toLowerCase(), keyType: k.keyType.toLowerCase(), isReadOnly: false, data: Buffer.from(k.publicKeyHex, 'hex') });
const priv = PrivateKey.fromWIF(k.privateKeyWif);

function stBytesFor(s) {
  const props = { packHash: new Uint8Array(32).fill(0x11), seq: 1, d0: new Uint8Array(s).fill(0xab), d1: new Uint8Array(s).fill(0xab), d2: new Uint8Array(s).fill(0xab) };
  const doc = new Document({ properties: props, documentTypeName: 'chunk', dataContractId, ownerId });
  const dct = new DocumentCreateTransition({ document: doc, identityContractNonce: 1n });
  const batch = BatchTransition.fromBatchedTransitions([new BatchedTransition(dct.toDocumentTransition())], ownerId, 0);
  const st = batch.toStateTransition();
  st.sign(priv, publicKey);
  return st.toBytes().length;
}

console.log('# real chunk type (packHash + seq + d0..d2), 3 data fields of s bytes each');
console.log('s\t3s(payload)\tstBytes\toverhead\theadroom');
for (const s of [4900, 5000, 5100, 5120]) {
  const st = stBytesFor(s);
  console.log(`${s}\t${3 * s}\t${st}\t${st - 3 * s}\t${LIMIT - st}`);
}
await _sdk.disconnect?.();

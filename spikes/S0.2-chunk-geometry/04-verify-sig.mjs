// Verify the measured ST bytes correspond to a genuinely SIGNED transition:
// compare unsigned vs signed toBytes(), print signature length + key id.
import { readFileSync } from 'node:fs';
import * as evoSdk from '@dashevo/evo-sdk';
const { DataContract, Document, DocumentCreateTransition, BatchedTransition, BatchTransition, IdentityPublicKey, PrivateKey, EvoSDK } = evoSdk;

const _sdk = EvoSDK.testnetTrusted({ settings: { connectTimeoutMs: 15000, timeoutMs: 60000 } });
await _sdk.connect();

const rec = JSON.parse(readFileSync('/Users/pasta/.config/dash-forge/test-identities/CONTRIB.identity.json', 'utf8'));
const ownerId = rec.identityId;
const k = rec.identityKeys.find((k) => k.purpose === 'AUTHENTICATION' && k.securityLevel === 'HIGH');
const PV = 12;
const schemas = { blob: { type: 'object', properties: { seq: { type: 'integer', position: 0 }, d0: { type: 'array', byteArray: true, maxItems: 5120, position: 1 }, d1: { type: 'array', byteArray: true, maxItems: 5120, position: 2 }, d2: { type: 'array', byteArray: true, maxItems: 5120, position: 3 } }, required: ['seq'], additionalProperties: false } };
const contract = new DataContract({ ownerId, identityNonce: 1n, schemas, fullValidation: true, platformVersion: PV });
const dataContractId = contract.id.toString();
const publicKey = new IdentityPublicKey({ keyId: k.id, purpose: k.purpose.toLowerCase(), securityLevel: k.securityLevel.toLowerCase(), keyType: k.keyType.toLowerCase(), isReadOnly: false, data: Buffer.from(k.publicKeyHex, 'hex') });
const priv = PrivateKey.fromWIF(k.privateKeyWif);

const s = 4900;
const doc = new Document({ properties: { seq: 1, d0: new Uint8Array(s).fill(0xab), d1: new Uint8Array(s).fill(0xab), d2: new Uint8Array(s).fill(0xab) }, documentTypeName: 'blob', dataContractId, ownerId });
const dct = new DocumentCreateTransition({ document: doc, identityContractNonce: 1n });
const batch = BatchTransition.fromBatchedTransitions([new BatchedTransition(dct.toDocumentTransition())], ownerId, 0);
const st = batch.toStateTransition();
const unsignedLen = st.toBytes().length;
st.sign(priv, publicKey);
const signedLen = st.toBytes().length;
console.log(JSON.stringify({
  perFieldBytes: s,
  payload: 3 * s,
  unsignedStBytes: unsignedLen,
  signedStBytes: signedLen,
  signatureAddsBytes: signedLen - unsignedLen,
  signatureLen: st.signature?.length,
  signaturePublicKeyId: st.signaturePublicKeyId,
  keyType: k.keyType,
}, null, 2));
await _sdk.disconnect?.();

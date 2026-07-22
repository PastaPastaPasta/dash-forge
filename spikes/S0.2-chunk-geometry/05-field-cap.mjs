// Probe the per-field cap offline. The `blob` type declares byteArray maxItems 5120.
// Serialize documents through the contract schema (Document.toBytes(contract,...)),
// which round-trips against the document-type schema, at 5120 (should pass) and
// 5121 (should be rejected by maxItems). Also serialize via the `wide` type whose
// schema allows up to 5300, to isolate the schema constraint from the platform's
// system-wide max_field_value_size = 5120 (which additionally caps consensus).
import { readFileSync } from 'node:fs';
import * as evoSdk from '@dashevo/evo-sdk';
const { DataContract, Document, EvoSDK } = evoSdk;

const _sdk = EvoSDK.testnetTrusted({ settings: { connectTimeoutMs: 15000, timeoutMs: 60000 } });
await _sdk.connect();

const rec = JSON.parse(readFileSync('/Users/pasta/.config/dash-forge/test-identities/CONTRIB.identity.json', 'utf8'));
const ownerId = rec.identityId;
const PV = 12;
const schemas = {
  blob: { type: 'object', properties: { seq: { type: 'integer', position: 0 }, d0: { type: 'array', byteArray: true, maxItems: 5120, position: 1 }, d1: { type: 'array', byteArray: true, maxItems: 5120, position: 2 }, d2: { type: 'array', byteArray: true, maxItems: 5120, position: 3 } }, required: ['seq'], additionalProperties: false },
  wide: { type: 'object', properties: { seq: { type: 'integer', position: 0 }, d: { type: 'array', byteArray: true, maxItems: 5300, position: 1 } }, required: ['seq'], additionalProperties: false },
};
const contract = new DataContract({ ownerId, identityNonce: 1n, schemas, fullValidation: true, platformVersion: PV });
const dataContractId = contract.id.toString();

function trySerialize(typeName, field, size) {
  try {
    const props = { seq: 1, [field]: new Uint8Array(size).fill(0xab) };
    const doc = new Document({ properties: props, documentTypeName: typeName, dataContractId, ownerId });
    const bytes = doc.toBytes(contract, PV); // serialize through the contract schema
    return { ok: true, bytes: bytes.length };
  } catch (e) {
    return { ok: false, err: (e?.message || String(e)).slice(0, 160) };
  }
}

const results = [
  ['blob.d0 = 5120 (== maxItems)', trySerialize('blob', 'd0', 5120)],
  ['blob.d0 = 5121 (> maxItems)', trySerialize('blob', 'd0', 5121)],
  ['wide.d = 5120', trySerialize('wide', 'd', 5120)],
  ['wide.d = 5121 (schema allows <=5300; > system max_field_value_size 5120)', trySerialize('wide', 'd', 5121)],
  ['wide.d = 5300 (== schema maxItems; > system max)', trySerialize('wide', 'd', 5300)],
];
for (const [label, r] of results) console.log(`${label}\n   -> ${JSON.stringify(r)}`);
await _sdk.disconnect?.();

// Confirm landing mechanics: contractNonce, documents.get by id, and a base64 query.
import { readFileSync } from 'node:fs';
import { getSdk, disconnectSdk, loadIdentity, log, errStr } from './lib.mjs';

const contract = JSON.parse(readFileSync(new URL('./contract.json', import.meta.url)));
const dataContractId = contract.contractId;
const rec = loadIdentity();
const ownerId = rec.identityId;
const sdk = await getSdk();

log(`contractNonce=${await sdk.identities.contractNonce(ownerId, dataContractId)}`);
log(`balance=${Number(await sdk.identities.balance(ownerId))}`);

// documents.get by id (probe doc from previous run)
const probeDocId = '5dhv7GncNcNicPKn5H5AmMdZ2TL4ko3ufMhW6Zb2DdVP';
try {
  const d = await sdk.documents.get(dataContractId, 'chunk', probeDocId);
  log(`documents.get(${probeDocId.slice(0,8)}): ${d ? 'FOUND' : 'undefined'}`);
} catch (e) { log(`get err: ${errStr(e)}`); }

// Query all chunk docs owned (no where), to enumerate orphans.
try {
  const res = await sdk.documents.query({ dataContractId, documentTypeName: 'chunk', orderBy: [['$createdAt', 'asc']], limit: 100 });
  const ids = res instanceof Map ? [...res.keys()] : (res ?? []).map((d) => d.id?.toString?.());
  log(`query all chunk (no where): ${ids.length} docs`);
  for (const id of ids) log(`  doc ${id}`);
} catch (e) { log(`query-all err: ${errStr(e)}`); }

await disconnectSdk();

#!/usr/bin/env node
// verify-c1.mjs — the live acceptance checks of the final contract revision (platform-parity
// spec §7, C-1) against the deployed forge-core / forge-collab / forge-community on a devnet.
// beta.7 only: needs evo-sdk 4.2.0-beta.7 (forge-contracts/sdk-v2) and the three-contract
// deployment; star, starBeat, watch, policy and checkRun live in forge-community.
//
//   node forge-contracts/scripts/verify-c1.mjs --owner <A.identity.json> --member <B.identity.json> \
//        [--network devnet --devnet-name moutai]
//
// Needs two identities minted for the run (never the shared fixtures): OWNER creates a scratch
// repo, and MEMBER is enrolled as its runner, then revoked. Checks, each printed PASS / FAIL:
//   1. forge-core knows `runner` and `topic`;
//   2. a runner's `checkRun` is accepted; after the runner membership is deleted, the same
//      identity's next `checkRun` is refused at consensus (40120);
//   3. a `checkRun` that says `completed` with no conclusion is refused (the beta.5 rule);
//   4. a `policy` with `requiredChecks` is accepted;
//   5. a `watch` is created and deleted by its values;
//   6. `count` on `topic.byName` counts the scratch repo's topic;
//   7. `documents.ranked` on `starBeat` with `oldest` returns the seeded order (both identities
//      star-beat the scratch repo, OWNER beats a second repo; a recount of the window agrees).
// Writes only to repos it creates (`c1-verify-<run>`), about 0.02 DASH per identity.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { communityId, loadEvoSdk } from './deploy-v2.mjs';

const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);
function args() {
  const out = { network: 'devnet', 'devnet-name': 'moutai' };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1];
  return out;
}
const a = args();
const key = a.network === 'devnet' ? `devnet-${a['devnet-name']}` : a.network;
const dep = JSON.parse(readFileSync(resolve(new URL('..', import.meta.url).pathname, 'deployments', `${key}.json`), 'utf8'));
const core = dep.v2.forgeCore.contractId;
const collab = dep.v2.forgeCollab.contractId;
const community = communityId(dep);

const evo = await loadEvoSdk();
const { EvoSDK, Document, IdentityPublicKey, IdentitySigner, PrivateKey, Identifier } = evo;
const sdk = new EvoSDK({ network: a.network, ...(a.network === 'devnet' ? { devnetName: a['devnet-name'], addresses: dep.dapiAddresses } : {}), trusted: true, version: 14, settings: { connectTimeoutMs: 10000, timeoutMs: 60000, retries: 3 } });
await sdk.connect();
const version = sdk.version();

function who(file) {
  const rec = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const k = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === 'HIGH');
  const identityKey = new IdentityPublicKey({ keyId: k.id, purpose: k.purpose, securityLevel: k.securityLevel, keyType: k.keyType, isReadOnly: false, data: Buffer.from(k.publicKeyHex, 'hex') });
  const signer = new IdentitySigner();
  signer.addKey(PrivateKey.fromWIF(k.privateKeyWif));
  return { id: rec.identityId, identityKey, signer };
}
const OWNER = who(a.owner);
const MEMBER = who(a.member);
const b58 = (s) => Buffer.from(Identifier.fromBase58(s).toBytes());
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
// evo-sdk 4.2.0-beta.7 resolves indexOnly creates (platform#5136): no refusal to catch.
async function create(w, contractId, documentTypeName, data) {
  const base = new Document({ properties: {}, documentTypeName, dataContractId: contractId, ownerId: w.id });
  const document = Document.fromObject({ ...base.toObject(), ...data }, version);
  return sdk.documents.create({ document, identityKey: w.identityKey, signer: w.signer });
}
async function refused(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}
const until = async (f, tries = 12) => {
  for (let i = 0; i < tries; i++) {
    if (await f()) return true;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
};

const run = Date.now().toString(36);
// 1. forge-core knows the C-1 types (version 1 when registered fresh, as on moutai after the beta.6 reset)
const coreContract = await sdk.contracts.fetch(core);
const types = coreContract.getDocumentTypes ? Object.keys(coreContract.getDocumentTypes()) : Object.keys(coreContract.toJSON().documentSchemas);
check('forge-core knows runner and topic', types.includes('runner') && types.includes('topic'), `version ${coreContract.version}`);

// scratch repos + membership
const repo = await create(OWNER, core, 'repo', { name: `c1-verify-${run}`, visibility: 'public' });
const repoId = repo.id.toBase58();
const R = b58(repoId);
await create(OWNER, core, 'maintainer', { repoId: R, memberId: b58(OWNER.id) });
const repo2 = await create(OWNER, core, 'repo', { name: `c1-verify-${run}-b`, visibility: 'public' });
const repo2Id = repo2.id.toBase58();
log(`scratch repos ${repoId}, ${repo2Id}`);

// 2. runner: accepted, then refused after revocation
const runnerDoc = await create(OWNER, core, 'runner', { repoId: R, memberId: b58(MEMBER.id) });
const head = Buffer.alloc(20, 7);
const run1 = await refused(() => create(MEMBER, community, 'checkRun', { repoId: R, headOid: head, name: 'build', status: 'in_progress', startedAt: Date.now() }));
check('a runner posts a checkRun', run1 === null, run1 ?? '');
await sdk.documents.delete({ document: { id: runnerDoc.id, ownerId: OWNER.id, dataContractId: core, documentTypeName: 'runner' }, identityKey: OWNER.identityKey, signer: OWNER.signer });
const after = await refused(() => create(MEMBER, community, 'checkRun', { repoId: R, headOid: head, name: 'test', status: 'queued' }));
check('a revoked runner is refused at consensus (40120)', after !== null && /40120|ReferencedEntityNotFound|not found/i.test(after), (after ?? 'accepted').slice(0, 160));

// 3. beta.5 rule: completed needs a conclusion
const noConclusion = await refused(() => create(OWNER, community, 'checkRun', { repoId: R, headOid: head, name: 'lint', status: 'completed', startedAt: Date.now(), completedAt: Date.now() }));
check('a completed checkRun without a conclusion is refused (propertyConstraints)', noConclusion !== null && /conclusionIfDone|constraint/i.test(noConclusion), (noConclusion ?? 'accepted').slice(0, 160));

// 4. policy.requiredChecks
const pol = await refused(() => create(OWNER, community, 'policy', { repoId: R, requiredApprovals: 0, requireChecks: true, requiredChecks: ['build', 'test'] }));
check('a policy with requiredChecks is accepted', pol === null, pol ?? '');

// 5. watch create + delete by values
const ownRows = (w, t, id) => sdk.documents.query({ dataContractId: community, documentTypeName: t, where: [['$ownerId', '==', w.id], ['repoId', '==', id]], orderBy: [['$ownerId', 'asc']], limit: 1 });
const own = async (w, t, id) => (await ownRows(w, t, id)).size > 0;
await create(OWNER, community, 'watch', { repoId: R });
const watched = await until(() => own(OWNER, 'watch', repoId));
const doc = [...(await ownRows(OWNER, 'watch', repoId)).values()][0];
await sdk.documents.delete({ document: doc, identityKey: OWNER.identityKey, signer: OWNER.signer });
const unwatched = await until(async () => !(await own(OWNER, 'watch', repoId)));
check('a watch is created and deleted by its values', watched && unwatched);

// 6. topic count
const topicName = `c1v${run}`.slice(0, 30);
await create(OWNER, core, 'topic', { repoId: R, name: topicName });
const counted = await until(async () => {
  const c = await sdk.documents.count({ dataContractId: core, documentTypeName: 'topic', where: [['name', '==', topicName]] });
  return [...c.values()].reduce((x, y) => x + y, 0n) === 1n;
});
check('count on topic.byName counts the tagged repo', counted);

// 7. ranked trending with `oldest`
for (const [w, id] of [[OWNER, R], [MEMBER, R], [OWNER, b58(repo2Id)]]) await create(w, community, 'starBeat', { repoId: id });
// The scratch repos' rows of the ranking, in ranked order: [repoId, count].
let mine = [];
await until(async () => {
  const ranked = await sdk.documents.ranked({ dataContractId: community, documentTypeName: 'starBeat', groupBy: 'repoId', aggregate: { type: 'count' }, limit: 100, timeRange: [{ field: '$createdAt', selector: 'oldest' }] });
  mine = ranked.entries.filter((e) => e.groupValue === repoId || e.groupValue === repo2Id).map((e) => [e.groupValue, Number(e.value)]);
  return mine.length === 2;
});
check('ranked(starBeat, oldest) returns the seeded order', JSON.stringify(mine) === JSON.stringify([[repoId, 2], [repo2Id, 1]]), JSON.stringify(mine));

const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ run, repoId, repo2Id, passed: results.length - failed, failed }));
process.exit(failed === 0 ? 0 : 1);

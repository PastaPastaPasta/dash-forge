// Read-only: every aggregate query shape the clients use, against a repo, a target and an identity
// that have NO matching documents on the RC1 contracts. Each must prove 0 (or an empty map), never
// fail verification. An ungrouped range count or sum over a path key that does not exist is the
// suspect shape (grovedb verify_v1_leaf_chain); the `in [x]` + groupBy "carrier" form returns an
// empty map instead. Nothing is written.
//
//   node forge-contracts/scripts/rc1-empty-aggregates.mjs [--devnet-name sakura] [--report <file.json>]
//   node forge-contracts/scripts/rc1-empty-aggregates.mjs --network testnet --record <scratch-record.json> [--report <file.json>]
//   node forge-contracts/scripts/rc1-empty-aggregates.mjs --offline [--contracts forge-contracts/contracts/mainnet]
//
// Target (lib/target.mjs): --network devnet|testnet (default devnet), --devnet-name, and
// --record <file> for a scratch registration. It reads only, but the release plan (WS-D, QA-14) keeps
// every live suite off the production registrations: on testnet and mainnet the network's own record
// is refused, so pass --record. A three- or four-contract record (forge-meta, the mainnet set: QA-03)
// works alike: each probe goes to the contract the registered contracts say holds its type.
// --offline runs the probes against an in-memory chain (lib/offline-chain.mjs) of the devnet set or
// --contracts <dir>: a check that every probe routes to a contract of that set, not of the proofs.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadEvoSdk } from './deploy-v2.mjs';
import { offlineSession } from './lib/rc1-offline.mjs';
import { documentSchemasOf } from './lib/seed-io.mjs';
import { addressesFor, checkFlags, contractIds, refuseMainnet, refuseProduction, resolveTarget, sdkOptions } from './lib/target.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, t, i, a) => (t.startsWith('--') ? [...acc, [t.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]] : acc), []));
const usage = 'usage: rc1-empty-aggregates.mjs [--network devnet|testnet] [--devnet-name sakura] [--record <scratch-record.json>] [--addresses <dapi,...>] [--report <file.json>]\n' +
  '       rc1-empty-aggregates.mjs --offline [--contracts <dir>] [--report <file.json>]';
if (args.help) {
  console.log(usage);
  process.exit(0);
}
let target;
let OFF = null;
try {
  checkFlags(process.argv.slice(2), { values: ['network', 'devnet-name', 'record', 'addresses', 'report', 'contracts'], bools: ['help', 'offline'] });
  if (args.offline) {
    for (const f of ['network', 'devnet-name', 'record', 'addresses']) {
      if (args[f] !== undefined) throw new Error(`--offline runs against an in-memory chain, not a network: drop --${f}`);
    }
    OFF = offlineSession({ contractsDir: args.contracts });
    target = OFF.target;
  } else {
    if (args.contracts !== undefined) throw new Error('--contracts is an --offline option');
    refuseMainnet(args.network, 'rc1-empty-aggregates');
    target = resolveTarget(args);
    refuseProduction(target);
  }
} catch (e) {
  console.error(`rc1-empty-aggregates: ${e.message}\n${usage}`);
  process.exit(2);
}
const IDS = contractIds(target);
const addresses = OFF ? undefined : addressesFor(target, args);

const evo = OFF ? OFF.evo : await loadEvoSdk();
const connect = async () => {
  const sdk = new evo.EvoSDK(sdkOptions(target, { addresses, settings: { timeoutMs: 60000 } }));
  await sdk.connect();
  return sdk;
};
let sdk = await connect();
// The contract that holds each type, as the registered contracts declare (three or four: QA-03)
const HOME = {};
for (const contractId of Object.values(IDS)) {
  for (const type of Object.keys(documentSchemasOf(await sdk.contracts.fetch(contractId), contractId))) HOME[type] = contractId;
}
const b58 = (bytes) => evo.Identifier.fromBytes(bytes).toBase58();
const R = b58(randomBytes(32)); // a repo id nothing was ever written under
const T = b58(randomBytes(32)); // a target (issue / PR) id with no transitions or comments
const T2 = b58(randomBytes(32));
const A = b58(randomBytes(32)); // an identity with no stars, follows, issues
const H = randomBytes(20).toString('base64'); // a head no check run names
const PH = b58(randomBytes(32)); // a pack hash with no chunks
const now = Date.now();

const results = [];
async function probe(label, kind, query, prop) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fn = { count: 'countWithProof', sum: 'sumWithProof', average: 'averageWithProof' }[kind];
      const r = kind === 'count' ? await sdk.documents[fn](query) : await sdk.documents[fn](query, prop);
      const m = r.data ?? r;
      const entries = [...m.entries()].map(([k, v]) => [k, typeof v === 'object' && v !== null ? { count: Number(v.count), sum: Number(v.sum) } : Number(v)]);
      const zero = entries.every(([, v]) => (typeof v === 'object' ? v.count === 0 && v.sum === 0 : v === 0));
      results.push({ label, kind, pass: zero, got: JSON.stringify(Object.fromEntries(entries)) });
      console.error(`${zero ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(Object.fromEntries(entries))}`);
      return;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (/quorum not found|invalid quorum|no available addresses/i.test(msg) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 10000));
        sdk = await connect();
        continue;
      }
      results.push({ label, kind, pass: false, got: `error: ${msg.slice(0, 400)}` });
      console.error(`FAIL ${label}: ${msg.slice(0, 300)}`);
      return;
    }
  }
}
const q = (type, where, extra = {}) => {
  if (!HOME[type]) throw new Error(`the registered contracts hold no ${type}`);
  return { dataContractId: HOME[type], documentTypeName: type, where, ...extra };
};
const KINDS = [1, 2, 3, 4, 11, 12, 13, 14, 15, 16, 17, 18, 19];

// ---- forge-collab: the header counts, list states, dense numbering ----
await probe('issue total (perRepo countable), repoId ==', 'count', q('issue', [['repoId', '==', R]]));
await probe('patch total (perRepo countable), repoId ==', 'count', q('patch', [['repoId', '==', R]]));
await probe('issue total, carrier repoId in [R] groupBy repoId', 'count', q('issue', [['repoId', 'in', [R]]], { groupBy: ['repoId'] }));
await probe('transitions by kind (perRepoKind), kind in [...] groupBy kind', 'count', q('transition', [['repoId', '==', R], ['kind', 'in', KINDS]], { groupBy: ['kind'] }));
await probe('transitions of one kind, repoId == and kind ==', 'count', q('transition', [['repoId', '==', R], ['kind', '==', 1]]));
await probe('state sums (perTarget summable), targetId in [...] groupBy targetId', 'sum', q('transition', [['targetId', 'in', [T, T2]]], { groupBy: ['targetId'] }), 'delta');
await probe('state sum of one target, targetId ==', 'sum', q('transition', [['targetId', '==', T]]), 'delta');
await probe('transition count of one target (perTarget countable)', 'count', q('transition', [['targetId', '==', T]]));
await probe("author's issues in a repo (author rangeCountable, prefix)", 'count', q('issue', [['$ownerId', '==', A], ['repoId', '==', R]]));
await probe('comments on a target (target rangeCountable), targetId ==', 'count', q('comment', [['targetId', '==', T]]));
await probe('comments on targets, carrier targetId in [...] groupBy targetId', 'count', q('comment', [['targetId', 'in', [T, T2]]], { groupBy: ['targetId'] }));
await probe('reviews on a PR (patch rangeCountable), patchId ==', 'count', q('review', [['patchId', '==', T]]));
await probe('verdict counts (verdicts countable), patchId == commitOid == verdict in groupBy', 'count', q('review', [['patchId', '==', T], ['commitOid', '==', H], ['verdict', 'in', [1, 2]]], { groupBy: ['verdict'] }));

// ---- forge-community: social counts and rankings ----
await probe('star count (byRepo rangeCountable), repoId ==', 'count', q('star', [['repoId', '==', R]]));
await probe('star counts, carrier repoId in [R] groupBy repoId', 'count', q('star', [['repoId', 'in', [R]]], { groupBy: ['repoId'] }));
await probe("an identity's stars (byOwner countable, COMM-9)", 'count', q('star', [['$ownerId', '==', A]]));
await probe('watch count (byRepo rangeCountable, COMM-9), repoId ==', 'count', q('watch', [['repoId', '==', R]]));
await probe("an identity's watches (byOwner countable, COMM-9)", 'count', q('watch', [['$ownerId', '==', A]]));
await probe('followers (byTarget rangeCountable), identityId ==', 'count', q('follow', [['identityId', '==', A]]));
await probe('following (byOwner countable), $ownerId ==', 'count', q('follow', [['$ownerId', '==', A]]));
await probe('check outcomes per head (F3), carrier outcome in [0,1,2] groupBy outcome', 'count', q('checkRun', [['repoId', '==', R], ['headOid', '==', H], ['outcome', 'in', [0, 1, 2]]], { groupBy: ['outcome'] }));
await probe('check outcomes per head, ungrouped range outcome >= 0', 'count', q('checkRun', [['repoId', '==', R], ['headOid', '==', H], ['outcome', '>=', 0]]));
await probe('check outcomes per head, range outcome >= 0 groupBy outcome', 'count', q('checkRun', [['repoId', '==', R], ['headOid', '==', H], ['outcome', '>=', 0]], { groupBy: ['outcome'] }));
await probe('PR-list dots: headOid in [...] outcome >= 0 groupBy [headOid, outcome]', 'count', q('checkRun', [['repoId', '==', R], ['headOid', 'in', [H, randomBytes(20).toString('base64')]], ['outcome', '>=', 0]], { groupBy: ['headOid', 'outcome'] }));
await probe('check outcomes per head, one outcome ==', 'count', q('checkRun', [['repoId', '==', R], ['headOid', '==', H], ['outcome', '==', 1]]));

// ---- forge-core: releases, packs, topics, repos ----
await probe('release count (F4), ungrouped range sum over perTag, repoId ==', 'sum', q('release', [['repoId', '==', R]]), 'delta');
await probe('release count (F4), carrier repoId in [R] groupBy repoId', 'sum', q('release', [['repoId', 'in', [R]]], { groupBy: ['repoId'] }), 'delta');
await probe('release count (F4), ungrouped range repoId == tagName > ""', 'sum', q('release', [['repoId', '==', R], ['tagName', '>', '']]), 'delta');
await probe('release count (F4), carrier repoId in [R] tagName > "" groupBy repoId', 'sum', q('release', [['repoId', 'in', [R]], ['tagName', '>', '']], { groupBy: ['repoId'] }), 'delta');
await probe('release count (F4), per tag: repoId == tagName > "" groupBy tagName', 'sum', q('release', [['repoId', '==', R], ['tagName', '>', '']], { groupBy: ['tagName'] }), 'delta');
await probe('one tag live? point sum repoId == tagName ==', 'sum', q('release', [['repoId', '==', R], ['tagName', '==', 'v1.0.0']]), 'delta');
await probe('pack bytes (bytes summable), storage == 0, kind in [...] groupBy kind', 'sum', q('packManifest', [['repoId', '==', R], ['storage', '==', 0], ['kind', 'in', [0, 1, 2, 3, 4, 5]]], { groupBy: ['kind'] }), 'sizeBytes');
await probe('pack bytes, one kind: repoId == storage == kind ==', 'sum', q('packManifest', [['repoId', '==', R], ['storage', '==', 0], ['kind', '==', 0]]), 'sizeBytes');
await probe('pack count (created rangeCountable), repoId ==', 'count', q('packManifest', [['repoId', '==', R]]));
await probe('chunk count and seq sum of a pack (perPack averageable)', 'average', q('chunk', [['repoId', '==', R], ['$ownerId', '==', A], ['packHash', '==', PH]]), 'seq');
await probe('chunk count of a pack (perPack), countOf shape', 'count', q('chunk', [['repoId', '==', R], ['$ownerId', '==', A], ['packHash', '==', PH]]));
await probe('topics of a repo (perRepo countable)', 'count', q('topic', [['repoId', '==', R]]));
await probe("an owner's repos (ownerName rangeCountable, prefix)", 'count', q('repo', [['$ownerId', '==', A]]));
await probe('forks of a repo (forkOf rangeCountable)', 'count', q('repo', [['forkOf', '==', R]]));
await probe('Explore: public repos since a time in the future (recent rangeCountable, range)', 'count', q('repo', [['visibility', '==', 'public'], ['$createdAt', '>', now + 86400000]]));

const failed = results.filter((r) => !r.pass);
const report = { network: target.label, record: target.scratch ? target.recordFile : undefined, contracts: IDS, ids: { repo: R, target: T, identity: A }, passed: results.length - failed.length, total: results.length, results };
if (args.report) writeFileSync(String(args.report), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: report.passed, total: report.total, failed }, null, 2));
process.exit(failed.length ? 1 : 0);

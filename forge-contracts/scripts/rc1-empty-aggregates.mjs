// Read-only: every aggregate query shape the clients use, against a repo, a target and an identity
// that have NO matching documents on the RC1 contracts. Each must prove 0 (or an empty map), never
// fail verification. An ungrouped range count or sum over a path key that does not exist is the
// suspect shape (grovedb verify_v1_leaf_chain); the `in [x]` + groupBy "carrier" form returns an
// empty map instead. Nothing is written.
//
//   node forge-contracts/scripts/rc1-empty-aggregates.mjs [--devnet-name sakura] [--report <file.json>]
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvoSdk } from './deploy-v2.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, t, i, a) => (t.startsWith('--') ? [...acc, [t.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]] : acc), []));
const devnetName = args['devnet-name'] || 'sakura';
const dep = JSON.parse(readFileSync(join(ROOT, 'deployments', `devnet-${devnetName}.json`), 'utf8'));
const CORE = dep.v2.forgeCore.contractId;
const COLLAB = dep.v2.forgeCollab.contractId;
const COMM = dep.v2.forgeCommunity.contractId;

const evo = await loadEvoSdk();
const connect = async () => {
  const sdk = new evo.EvoSDK({ network: 'devnet', devnetName, trusted: true, addresses: dep.dapiAddresses, settings: { timeoutMs: 60000 } });
  await sdk.connect();
  return sdk;
};
let sdk = await connect();
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
const q = (contract, type, where, extra = {}) => ({ dataContractId: contract, documentTypeName: type, where, ...extra });
const KINDS = [1, 2, 3, 4, 11, 12, 13, 14, 15, 16, 17, 18, 19];

// ---- forge-collab: the header counts, list states, dense numbering ----
await probe('issue total (perRepo countable), repoId ==', 'count', q(COLLAB, 'issue', [['repoId', '==', R]]));
await probe('patch total (perRepo countable), repoId ==', 'count', q(COLLAB, 'patch', [['repoId', '==', R]]));
await probe('issue total, carrier repoId in [R] groupBy repoId', 'count', q(COLLAB, 'issue', [['repoId', 'in', [R]]], { groupBy: ['repoId'] }));
await probe('transitions by kind (perRepoKind), kind in [...] groupBy kind', 'count', q(COLLAB, 'transition', [['repoId', '==', R], ['kind', 'in', KINDS]], { groupBy: ['kind'] }));
await probe('transitions of one kind, repoId == and kind ==', 'count', q(COLLAB, 'transition', [['repoId', '==', R], ['kind', '==', 1]]));
await probe('state sums (perTarget summable), targetId in [...] groupBy targetId', 'sum', q(COLLAB, 'transition', [['targetId', 'in', [T, T2]]], { groupBy: ['targetId'] }), 'delta');
await probe('state sum of one target, targetId ==', 'sum', q(COLLAB, 'transition', [['targetId', '==', T]]), 'delta');
await probe('transition count of one target (perTarget countable)', 'count', q(COLLAB, 'transition', [['targetId', '==', T]]));
await probe("author's issues in a repo (author rangeCountable, prefix)", 'count', q(COLLAB, 'issue', [['$ownerId', '==', A], ['repoId', '==', R]]));
await probe('comments on a target (target rangeCountable), targetId ==', 'count', q(COLLAB, 'comment', [['targetId', '==', T]]));
await probe('comments on targets, carrier targetId in [...] groupBy targetId', 'count', q(COLLAB, 'comment', [['targetId', 'in', [T, T2]]], { groupBy: ['targetId'] }));
await probe('reviews on a PR (patch rangeCountable), patchId ==', 'count', q(COLLAB, 'review', [['patchId', '==', T]]));
await probe('verdict counts (verdicts countable), patchId == commitOid == verdict in groupBy', 'count', q(COLLAB, 'review', [['patchId', '==', T], ['commitOid', '==', H], ['verdict', 'in', [1, 2]]], { groupBy: ['verdict'] }));

// ---- forge-community: social counts and rankings ----
await probe('star count (byRepo rangeCountable), repoId ==', 'count', q(COMM, 'star', [['repoId', '==', R]]));
await probe('star counts, carrier repoId in [R] groupBy repoId', 'count', q(COMM, 'star', [['repoId', 'in', [R]]], { groupBy: ['repoId'] }));
await probe("an identity's stars (byOwner countable, COMM-9)", 'count', q(COMM, 'star', [['$ownerId', '==', A]]));
await probe('watch count (byRepo rangeCountable, COMM-9), repoId ==', 'count', q(COMM, 'watch', [['repoId', '==', R]]));
await probe("an identity's watches (byOwner countable, COMM-9)", 'count', q(COMM, 'watch', [['$ownerId', '==', A]]));
await probe('followers (byTarget rangeCountable), identityId ==', 'count', q(COMM, 'follow', [['identityId', '==', A]]));
await probe('following (byOwner countable), $ownerId ==', 'count', q(COMM, 'follow', [['$ownerId', '==', A]]));
await probe('check outcomes per head (F3), carrier outcome in [0,1,2] groupBy outcome', 'count', q(COMM, 'checkRun', [['repoId', '==', R], ['headOid', '==', H], ['outcome', 'in', [0, 1, 2]]], { groupBy: ['outcome'] }));
await probe('check outcomes per head, ungrouped range outcome >= 0', 'count', q(COMM, 'checkRun', [['repoId', '==', R], ['headOid', '==', H], ['outcome', '>=', 0]]));
await probe('check outcomes per head, range outcome >= 0 groupBy outcome', 'count', q(COMM, 'checkRun', [['repoId', '==', R], ['headOid', '==', H], ['outcome', '>=', 0]], { groupBy: ['outcome'] }));
await probe('PR-list dots: headOid in [...] outcome >= 0 groupBy [headOid, outcome]', 'count', q(COMM, 'checkRun', [['repoId', '==', R], ['headOid', 'in', [H, randomBytes(20).toString('base64')]], ['outcome', '>=', 0]], { groupBy: ['headOid', 'outcome'] }));
await probe('check outcomes per head, one outcome ==', 'count', q(COMM, 'checkRun', [['repoId', '==', R], ['headOid', '==', H], ['outcome', '==', 1]]));

// ---- forge-core: releases, packs, topics, repos ----
await probe('release count (F4), ungrouped range sum over perTag, repoId ==', 'sum', q(CORE, 'release', [['repoId', '==', R]]), 'delta');
await probe('release count (F4), carrier repoId in [R] groupBy repoId', 'sum', q(CORE, 'release', [['repoId', 'in', [R]]], { groupBy: ['repoId'] }), 'delta');
await probe('release count (F4), ungrouped range repoId == tagName > ""', 'sum', q(CORE, 'release', [['repoId', '==', R], ['tagName', '>', '']]), 'delta');
await probe('release count (F4), carrier repoId in [R] tagName > "" groupBy repoId', 'sum', q(CORE, 'release', [['repoId', 'in', [R]], ['tagName', '>', '']], { groupBy: ['repoId'] }), 'delta');
await probe('release count (F4), per tag: repoId == tagName > "" groupBy tagName', 'sum', q(CORE, 'release', [['repoId', '==', R], ['tagName', '>', '']], { groupBy: ['tagName'] }), 'delta');
await probe('one tag live? point sum repoId == tagName ==', 'sum', q(CORE, 'release', [['repoId', '==', R], ['tagName', '==', 'v1.0.0']]), 'delta');
await probe('pack bytes (bytes summable), storage == 0, kind in [...] groupBy kind', 'sum', q(CORE, 'packManifest', [['repoId', '==', R], ['storage', '==', 0], ['kind', 'in', [0, 1, 2, 3, 4, 5]]], { groupBy: ['kind'] }), 'sizeBytes');
await probe('pack bytes, one kind: repoId == storage == kind ==', 'sum', q(CORE, 'packManifest', [['repoId', '==', R], ['storage', '==', 0], ['kind', '==', 0]]), 'sizeBytes');
await probe('pack count (created rangeCountable), repoId ==', 'count', q(CORE, 'packManifest', [['repoId', '==', R]]));
await probe('chunk count and seq sum of a pack (perPack averageable)', 'average', q(CORE, 'chunk', [['repoId', '==', R], ['$ownerId', '==', A], ['packHash', '==', PH]]), 'seq');
await probe('chunk count of a pack (perPack), countOf shape', 'count', q(CORE, 'chunk', [['repoId', '==', R], ['$ownerId', '==', A], ['packHash', '==', PH]]));
await probe('topics of a repo (perRepo countable)', 'count', q(CORE, 'topic', [['repoId', '==', R]]));
await probe("an owner's repos (ownerName rangeCountable, prefix)", 'count', q(CORE, 'repo', [['$ownerId', '==', A]]));
await probe('forks of a repo (forkOf rangeCountable)', 'count', q(CORE, 'repo', [['forkOf', '==', R]]));
await probe('Explore: public repos since a time in the future (recent rangeCountable, range)', 'count', q(CORE, 'repo', [['visibility', '==', 'public'], ['$createdAt', '>', now + 86400000]]));

const failed = results.filter((r) => !r.pass);
const report = { network: `devnet-${devnetName}`, contracts: { core: CORE, collab: COLLAB, community: COMM }, ids: { repo: R, target: T, identity: A }, passed: results.length - failed.length, total: results.length, results };
if (args.report) writeFileSync(String(args.report), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: report.passed, total: report.total, failed }, null, 2));
process.exit(failed.length ? 1 : 0);

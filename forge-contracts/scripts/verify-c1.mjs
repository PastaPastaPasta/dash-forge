#!/usr/bin/env node
// verify-c1.mjs — the live acceptance checks of the C-1 types (platform-parity spec §7) against
// the RC1 forge-core / forge-collab / forge-community deployed on a devnet.
//
//   node forge-contracts/scripts/verify-c1.mjs --owner <A.identity.json> --member <B.identity.json> \
//        --third <C.identity.json> [--network devnet --devnet-name sakura] [--deployment <file>]
//
// Needs `npm ci` in forge-contracts/sdk-v2 (evo-sdk 5.0.0-beta.1). The network defaults to
// DASH_FORGE_NETWORK / DASH_FORGE_DEVNET_NAME, else devnet sakura.
//
// Three identities minted for the run (never the shared fixtures): OWNER creates two scratch
// repos; MEMBER is enrolled as a runner of the first, then revoked; MEMBER and THIRD beat it
// (the owner may not beat its own repo). Checks, each printed PASS / FAIL:
//   1. the contracts hold the moved types: `topic` and `consent` in forge-core; `transition` and
//      `repoKey` in forge-collab; `runner`, `event`, `authorEvent` and `milestone` in forge-community;
//   2. a runner's `checkRun` is accepted; after the runner enrolment is deleted, the same
//      identity's next `checkRun` is refused at consensus (40120);
//   3. a `checkRun` that says `completed` with no conclusion is refused (`conclusionIfDone`);
//   4. a `policy` whose `requiredChecks` are pinned to `requiredCheckSources` is accepted;
//   5. a `watch` is created and deleted by its values;
//   6. `count` on `topic.byName` counts the scratch repo's topic;
//   7. `documents.ranked` on `starBeat` (on `star` with RC2's fused star) with `oldest` returns
//      the seeded order: MEMBER and THIRD beat the first repo, MEMBER the second.
// Writes only to repos it creates (`c1-verify-<run>`), about 0.02 DASH per identity.
import {
  FUSED_STAR, VIS, checkOutcome, expectRefused, idBytes, loadIdentity, log, membership, openSession, parseArgs, refusalOf, runIfMain, until,
} from './lib/seed-io.mjs';

const MOVED = {
  core: ['topic', 'consent'],
  collab: ['transition', 'repoKey'],
  community: ['runner', 'event', 'authorEvent', 'milestone'],
};

export async function main(argv, injected) {
  const a = parseArgs(argv);
  if (!a.owner || !a.member || !a.third) throw new Error('usage: --owner <A> --member <B> --third <C>');
  const { net, evo, write: create, read, retry } = await openSession(a, injected);
  const { ids } = net;
  const OWNER = loadIdentity(evo, a.owner, 'OWNER');
  const MEMBER = loadIdentity(evo, a.member, 'MEMBER');
  const THIRD = loadIdentity(evo, a.third, 'THIRD');

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const run = Date.now().toString(36);
  // 1. the moved types are where the RC1 layout puts them
  const missing = [];
  for (const [contract, types] of Object.entries(MOVED)) {
    const fetched = await retry((sdk) => sdk.contracts.fetch(ids[contract]));
    const known = fetched.getDocumentTypes ? Object.keys(fetched.getDocumentTypes()) : Object.keys(fetched.toJSON().documentSchemas);
    missing.push(...types.filter((t) => !known.includes(t)).map((t) => `${contract}.${t}`));
  }
  check('the contracts hold the RC1 layout', missing.length === 0, missing.join(', '));

  // scratch repos + the owner's own enrolment
  const repo = await create(OWNER, 'repo', { name: `c1-verify-${run}`, visibility: VIS });
  const repoId = repo.id.toBase58();
  const R = idBytes(repoId);
  await create(OWNER, 'maintainer', membership(R, OWNER.id, OWNER.id));
  const repo2 = await create(OWNER, 'repo', { name: `c1-verify-${run}-b`, visibility: VIS });
  const repo2Id = repo2.id.toBase58();
  log(`scratch repos ${repoId}, ${repo2Id}`);

  // 2. runner: accepted, then refused after revocation
  const runnerDoc = await create(OWNER, 'runner', { repoId: R, memberId: idBytes(MEMBER.id) });
  const head = Buffer.alloc(20, 7);
  const run1 = await refusalOf(() =>
    create(MEMBER, 'checkRun', { repoId: R, headOid: head, name: 'build', status: 'in_progress', outcome: checkOutcome('in_progress'), startedAt: Date.now(), vis: VIS }),
  );
  check('a runner posts a checkRun', run1 === null, run1 ?? '');
  // A delete that lands after its confirmation fails is retried, and the retry is refused with
  // 40101 (already gone) rather than counted a success; run again if this throws on a flaky devnet.
  await retry((sdk) => sdk.documents.delete({ document: { id: runnerDoc.id, ownerId: OWNER.id, dataContractId: ids.community, documentTypeName: 'runner' }, identityKey: OWNER.identityKey, signer: OWNER.signer }));
  const after = await expectRefused('40120', () => create(MEMBER, 'checkRun', { repoId: R, headOid: head, name: 'test', status: 'queued', outcome: checkOutcome('queued'), vis: VIS }));
  check('a revoked runner is refused at consensus (40120)', after !== null && /40120|ReferencedEntityNotFound|not found/i.test(after), (after ?? 'accepted').slice(0, 160));

  // 3. completed needs a conclusion (outcome 2 is what a missing conclusion reads as, so only
  // conclusionIfDone is broken)
  const noConclusion = await expectRefused('conclusionIfDone', () =>
    create(OWNER, 'checkRun', { repoId: R, headOid: head, name: 'lint', status: 'completed', outcome: 2, startedAt: Date.now() - 1000, completedAt: Date.now(), vis: VIS }),
  );
  check('a completed checkRun without a conclusion is refused (conclusionIfDone)', noConclusion !== null && /conclusionIfDone|constraint/i.test(noConclusion), (noConclusion ?? 'accepted').slice(0, 160));

  // 4. policy.requiredChecks, each pinned to its source (the owner, a maintainer)
  const pol = await refusalOf(() =>
    create(OWNER, 'policy', { repoId: R, requiredApprovals: 0, requireChecks: true, requiredChecks: ['build', 'test'], requiredCheckSources: [idBytes(OWNER.id), idBytes(OWNER.id)] }),
  );
  check('a policy with requiredChecks and their sources is accepted', pol === null, pol ?? '');

  // 5. watch create + delete by values. The doc to delete comes from the very read that confirms
  // the watch is visible, not a second, separately-raced one: two reads a `until` apart can land
  // on different nodes, and a lagging one could see nothing yet and hand `delete` an undefined
  // document.
  await create(OWNER, 'watch', { repoId: R });
  let doc;
  const watched = await until(async () => {
    const rows = [...(await read.ownRows(OWNER, 'watch', repoId)).values()];
    doc = rows.find(Boolean);
    return doc !== undefined;
  });
  if (watched) await retry((sdk) => sdk.documents.delete({ document: doc, identityKey: OWNER.identityKey, signer: OWNER.signer }));
  const unwatched = await until(async () => !(await read.owns(OWNER, 'watch', repoId)));
  check('a watch is created and deleted by its values', watched && unwatched);

  // 6. topic count (the name matches the topic pattern: lowercase base36)
  const topicName = `c1v${run}`.slice(0, 30);
  await create(OWNER, 'topic', { repoId: R, name: topicName, vis: VIS });
  const counted = await until(async () => {
    const c = await retry((sdk) => sdk.documents.count({ dataContractId: ids.core, documentTypeName: 'topic', where: [['name', '==', topicName]] }));
    return [...c.values()].reduce((x, y) => x + y, 0n) === 1n;
  });
  check('count on topic.byName counts the tagged repo', counted);

  // 7. ranked trending with `oldest`: two beats on the first repo, one on the second
  const beatType = FUSED_STAR ? 'star' : 'starBeat';
  for (const [w, id] of [[MEMBER, R], [THIRD, R], [MEMBER, idBytes(repo2Id)]]) {
    await create(w, beatType, FUSED_STAR ? { repoId: id } : { repoId: id, vis: VIS, repoOwner: idBytes(OWNER.id) });
  }
  // The scratch repos' rows of the ranking, in ranked order: [repoId, count].
  let mine = [];
  await until(async () => {
    const ranked = await retry((sdk) =>
      sdk.documents.ranked({ dataContractId: ids.community, documentTypeName: beatType, groupBy: 'repoId', aggregate: { type: 'count' }, limit: 100, timeRange: [{ field: '$createdAt', selector: 'oldest' }] }),
    );
    mine = ranked.entries.filter((e) => e.groupValue === repoId || e.groupValue === repo2Id).map((e) => [e.groupValue, Number(e.value)]);
    return mine.length === 2;
  });
  check(`ranked(${beatType}, oldest) returns the seeded order`, JSON.stringify(mine) === JSON.stringify([[repoId, 2], [repo2Id, 1]]), JSON.stringify(mine));

  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ run, repoId, repo2Id, passed: results.length - failed, failed }));
  return failed === 0 ? 0 : 1;
}

runIfMain(import.meta.url, main);

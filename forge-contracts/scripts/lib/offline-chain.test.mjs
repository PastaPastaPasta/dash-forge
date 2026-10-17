// node --test forge-contracts/scripts/lib/: the offline chain refuses what consensus refuses for
// the rules that need chain state, so a seed that breaks one fails seed-offline.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import { OfflineChain } from './offline-chain.mjs';
import { CONTRACTS, CONTRACT_OF, META_TYPES, ROOT, TRANSITION, VIS, b58encode, contractOn, documentReader, documentWriter, idBytes, membership, shapeOfSet, transition } from './seed-io.mjs';

// The default set's shape, as the seeds read it from the loaded contract.
const SHAPE = shapeOfSet({ contracts: CONTRACTS, contractOf: CONTRACT_OF });
const FUSED_STAR = SHAPE.fusedStar;
const MEMBER_ROLES = SHAPE.memberRoles;

const person = (name) => ({ name, id: b58encode(createHash('sha256').update(name).digest()) });
const OWNER = person('owner');
const OTHER = person('other');

/** No reconnect ever triggers offline: the chain never fails with a stale-connection message. */
const noReconnect = async () => {
  throw new Error('offline chain: reconnect should never be called');
};

/** A chain holding one public repo of OWNER, OWNER its maintainer. */
async function repoChain() {
  const chain = new OfflineChain();
  const evo = chain.evo();
  const sdk = new evo.EvoSDK();
  // retries: 0 -- the offline chain is synchronous and deterministic, so a 10422/40101 here is
  // always the real rule verdict, never a lagging node's stale read; retrying would only make
  // every refusal test wait out documentWriter's retry pause for nothing.
  const write = documentWriter({ sdk }, evo, { ids: chain.ids }, noReconnect, { shape: SHAPE, retries: 0 });
  const repoId = (await write(OWNER, 'repo', { name: 'r', visibility: VIS })).id.toBase58();
  const R = idBytes(repoId);
  await write(OWNER, 'maintainer', membership(R, OWNER.id, OWNER.id));
  return { chain, write, R, repoId };
}
const issue = (R, number) => ({ repoId: R, number, tk: 0, title: `#${number}`, vis: VIS });
const refusedWith = (code, rule) => (e) => e.code === code && (rule === undefined || e.rule === rule);

test('issues and PRs take dense numbers from one sequence', async () => {
  const { write, R } = await repoChain();
  await assert.rejects(write(OWNER, 'issue', issue(R, 2)), refusedWith(10422, 'dense'));
  await write(OWNER, 'issue', issue(R, 1));
  const patch = { repoId: R, number: 1, tk: 1, title: 'p', baseRefNameHash: Buffer.alloc(32, 1), sourceRepoId: R, headOid: Buffer.alloc(20, 2), vis: VIS };
  await assert.rejects(write(OWNER, 'patch', patch), refusedWith(10422, 'dense'));
  await write(OWNER, 'patch', { ...patch, number: 2 });
});

test('an invited member is enrolled only after its consent', async () => {
  const { write, R } = await repoChain();
  await assert.rejects(write(OWNER, 'writer', membership(R, OWNER.id, OTHER.id)), refusedWith(40120, 'writer.consentBy'));
  await write(OTHER, 'consent', { repoId: R });
  await write(OWNER, 'writer', membership(R, OWNER.id, OTHER.id));
});

test('a non-member cannot write an event; the repo owner cannot beat its own repo (no beat with the fused star)', async () => {
  const { write, R } = await repoChain();
  const i1 = (await write(OWNER, 'issue', issue(R, 1))).id.toBase58();
  const label = { repoId: R, targetId: idBytes(i1), targetNumber: 1, kind: 4, value: 'bug' };
  await assert.rejects(write(OTHER, 'event', label), refusedWith(40120, 'event.ownerRefersTo'));
  await write(OWNER, 'event', label);
  if (FUSED_STAR) {
    // RC2 C1: the star is the trending entry, with no repoOwner to tell the owner apart
    await assert.rejects(write(OTHER, 'starBeat', { repoId: R, vis: VIS, repoOwner: idBytes(OWNER.id) }), /starBeat/);
    await write(OWNER, 'star', { repoId: R });
    return;
  }
  await assert.rejects(write(OWNER, 'starBeat', { repoId: R, vis: VIS, repoOwner: idBytes(OWNER.id) }), refusedWith(10419));
  await write(OTHER, 'starBeat', { repoId: R, vis: VIS, repoOwner: idBytes(OWNER.id) });
  // The repo is found, but its owner is not the beat's repoOwner: a `where` mismatch.
  await assert.rejects(write(OTHER, 'starBeat', { repoId: R, vis: VIS, repoOwner: idBytes(person('third').id) }), refusedWith(40127, 'starBeat.repoId'));
});

// RC2 MOD (design/v5/MODERATION.md): a hide names the writer's maintainer document of the repo.
// The hideByMaint rule (asMaintainer = the writer) is rs-dpp's (rc1 vectors); the lookup is this.
test('a hide proves its writer a maintainer of the repo now', { skip: !('asMaintainer' in (CONTRACTS.community.documentSchemas.event.properties ?? {})) }, async () => {
  const { chain, write, R } = await repoChain();
  const sdk = new (chain.evo().EvoSDK)();
  const i1 = (await write(OWNER, 'issue', issue(R, 1))).id.toBase58();
  const hide = (who) => ({ repoId: R, targetId: idBytes(i1), targetNumber: 1, kind: 24, refId: Buffer.alloc(32, 5), asMaintainer: idBytes(who.id) });
  await write(OWNER, 'event', hide(OWNER));
  // A writer passes the event gate (ownerRefersTo) but holds no maintainer document
  await write(OTHER, 'consent', { repoId: R });
  await write(OWNER, 'writer', membership(R, OWNER.id, OTHER.id));
  await assert.rejects(write(OTHER, 'event', hide(OTHER)), refusedWith(40120, 'event.asMaintainer'));
  // A maintainer of another repo is no maintainer of this one
  const theirs = idBytes((await write(OTHER, 'repo', { name: 'theirs', visibility: VIS })).id.toBase58());
  await write(OTHER, 'maintainer', membership(theirs, OTHER.id, OTHER.id));
  await assert.rejects(write(OTHER, 'event', hide(OTHER)), refusedWith(40120, 'event.asMaintainer'));
  // Promoted, then removed: the hide written meanwhile stands, the next one is refused
  const promoted = await write(OWNER, 'maintainer', membership(R, OWNER.id, OTHER.id));
  await write(OTHER, 'event', hide(OTHER));
  await sdk.documents.delete({ document: promoted });
  await assert.rejects(write(OTHER, 'event', hide(OTHER)), refusedWith(40120, 'event.asMaintainer'));
  assert.equal(chain.live('event').filter((e) => e.view.kind === 24).length, 2);
});

test('transitions move only from the state their rules name', async () => {
  const { write, R } = await repoChain();
  const target = { id: (await write(OTHER, 'issue', issue(R, 1))).id.toBase58(), number: 1 };
  await assert.rejects(write(OTHER, 'transition', transition(R, target, TRANSITION.issueClose)), refusedWith(40120, 'transition.ownerRefersTo'));
  await write(OTHER, 'transition', transition(R, target, TRANSITION.issueClose, { byAuthor: true }));
  await assert.rejects(write(OWNER, 'transition', transition(R, target, TRANSITION.issueClose)), refusedWith(10422, 'c1_closedAfter'));
  await write(OWNER, 'transition', transition(R, target, TRANSITION.issueLock));
  await assert.rejects(write(OWNER, 'transition', transition(R, target, TRANSITION.issueLock)), refusedWith(10422, 'c6_lockedAfter'));
  await write(OWNER, 'transition', transition(R, target, TRANSITION.issueReopen));

  // Unlocking a closed issue that is not locked: the sum would be -15, and the chain's
  // Euclidean division puts it below 0 (-1), where a truncating one would say 0.
  const other = { id: (await write(OTHER, 'issue', issue(R, 2))).id.toBase58(), number: 2 };
  await write(OWNER, 'transition', transition(R, other, TRANSITION.issueClose));
  await assert.rejects(write(OWNER, 'transition', transition(R, other, TRANSITION.issueUnlock)), refusedWith(10422, 'c6_lockedAfter'));
});

test('a rerun adopts what landed: by a unique index, or by the target of a transition', async () => {
  const { chain, write, R, repoId } = await repoChain();
  const evo = chain.evo();
  const read = documentReader({ sdk: new evo.EvoSDK() }, { ids: chain.ids }, 0, noReconnect, SHAPE);
  const i1 = issue(R, 1);
  const id = (await write(OWNER, 'issue', i1)).id.toBase58();
  assert.equal(await read.existing(OWNER, 'issue', i1), id);
  assert.equal(await read.existing(OWNER, 'issue', { ...i1, title: 'another' }), null);
  assert.equal(await read.existing(OTHER, 'issue', i1), null);
  const close = transition(R, { id, number: 1 }, TRANSITION.issueClose);
  assert.equal(await read.existing(OWNER, 'transition', close), null);
  const moved = (await write(OWNER, 'transition', close)).id.toBase58();
  assert.equal(await read.existing(OWNER, 'transition', close), moved);
  assert.equal(await read.existing(OWNER, 'maintainer', membership(R, OWNER.id, OWNER.id)), (await read.first('maintainer', [['repoId', '==', repoId]])).$id);
});

test('totals: topics, chunks and releases', async () => {
  const { write, R } = await repoChain();
  await write(OWNER, 'topic', { repoId: R, name: 't0', vis: VIS });
  await assert.rejects(write(OWNER, 'topic', { repoId: R, name: 't0', vis: VIS }), refusedWith(40105));
  for (let i = 1; i < 20; i++) await write(OWNER, 'topic', { repoId: R, name: `t${i}`, vis: VIS });
  // The chain judges the rules before the unique indices: a 21st topic is refused by the cap.
  await assert.rejects(write(OWNER, 'topic', { repoId: R, name: 't20', vis: VIS }), refusedWith(10422, 'atMost20'));

  const packHash = Buffer.alloc(32, 9);
  await write(OWNER, 'chunk', { repoId: R, packHash, seq: 0, d0: Buffer.alloc(10) });
  const manifest = { repoId: R, packHash, kind: 0, sizeBytes: 20, objectCount: 1, chunkCount: 2, storage: 0 };
  await assert.rejects(write(OWNER, 'packManifest', manifest), refusedWith(10422, 'platformChunks'));
  await write(OWNER, 'packManifest', { ...manifest, chunkCount: 1, sizeBytes: 10 });

  const release = { repoId: R, tagName: 'v1', vis: VIS, delta: 1 };
  await write(OWNER, 'release', release);
  await assert.rejects(write(OWNER, 'release', release), refusedWith(10422, 'oneLive'));
  await write(OWNER, 'release', { ...release, delta: 0 });
});

test('a retry after a write that landed resolves to it, not to a second write', async () => {
  const { chain, R } = await repoChain();
  const evo = chain.evo();
  const sdk = new evo.EvoSDK();
  let calls = 0;
  // The first attempt lands and then times out; the retry is refused (dense), and the writer
  // finds the document it built by its id.
  const flaky = {
    version: () => sdk.version(),
    documents: {
      ...sdk.documents,
      create: async (args) => {
        calls++;
        const created = await sdk.documents.create(args);
        if (calls === 1) throw new Error('request timeout');
        return created;
      },
    },
  };
  const write = documentWriter({ sdk: flaky }, evo, { ids: chain.ids }, noReconnect, { shape: SHAPE, pauseMs: 0 });
  const id = (await write(OWNER, 'issue', issue(R, 1))).id.toBase58();
  assert.equal(calls, 2);
  assert.equal(chain.live('issue').length, 1);
  assert.equal(chain.live('issue')[0].id, id);
});

test('a document goes to the contract that holds its type', async () => {
  const chain = new OfflineChain();
  const evo = chain.evo();
  const sdk = new evo.EvoSDK();
  const wrong = documentWriter({ sdk }, evo, { ids: { ...chain.ids, community: chain.ids.collab } }, noReconnect, { shape: SHAPE });
  await assert.rejects(wrong(OWNER, 'star', { repoId: Buffer.alloc(32, 1) }), /star is in forge-community, not forge-collab/);
});

test('the deployment record picks the layout: forge-meta holds the moved types only on a four-contract set (D44)', () => {
  const three = { core: 'C', collab: 'L', community: 'M' };
  const four = { ...three, meta: 'X' };
  for (const t of META_TYPES) {
    assert.ok(CONTRACT_OF[t], `${t} has a three-contract home`);
    assert.equal(contractOn(three, t), CONTRACT_OF[t], t);
    assert.equal(contractOn(four, t), 'meta', t);
  }
  for (const t of ['repo', 'issue', 'star', 'event']) assert.equal(contractOn(four, t), CONTRACT_OF[t], t);
});

test('member roles: the writer gate proves the claimed r against writer.role', { skip: !MEMBER_ROLES }, async () => {
  const { write, R } = await repoChain();
  await write(OTHER, 'consent', { repoId: R });
  await write(OWNER, 'writer', { ...membership(R, OWNER.id, OTHER.id), role: 2 });
  const i1 = (await write(OWNER, 'issue', issue(R, 1))).id.toBase58();
  const ref = { repoId: R, refNameHash: Buffer.alloc(32, 1), refName: 'refs/heads/main', newOid: Buffer.alloc(20, 1), vis: VIS };
  // triage cannot push: r 1 is not its role (the writer operand, the last, reports 40127)
  await assert.rejects(write(OTHER, 'refUpdate', ref), refusedWith(40127, 'refUpdate.ownerRefersTo'));
  await write(OWNER, 'refUpdate', ref);
  // triage labels and closes with r 2, and a claim of r 1 is refused
  const label = { repoId: R, targetId: idBytes(i1), targetNumber: 1, kind: 4, value: 'bug' };
  await assert.rejects(write(OTHER, 'event', label), refusedWith(40127, 'event.ownerRefersTo'));
  await write(OTHER, 'event', { ...label, r: 2 });
  await write(OTHER, 'label', { repoId: R, name: 'bug', r: 2 });
  await write(OTHER, 'transition', { ...transition(R, { id: i1, number: 1 }, TRANSITION.issueClose), r: 2 });
});

test('member roles: a reader matches no gate', { skip: !MEMBER_ROLES }, async () => {
  const { write, R } = await repoChain();
  await write(OTHER, 'consent', { repoId: R });
  await write(OWNER, 'writer', { ...membership(R, OWNER.id, OTHER.id), role: 3 });
  const i1 = (await write(OWNER, 'issue', issue(R, 1))).id.toBase58();
  for (const r of [1, 2]) {
    await assert.rejects(write(OTHER, 'label', { repoId: R, name: 'x', r }), refusedWith(40127, 'label.ownerRefersTo'));
    await assert.rejects(write(OTHER, 'event', { repoId: R, targetId: idBytes(i1), targetNumber: 1, kind: 4, value: 'bug', r }), refusedWith(40127, 'event.ownerRefersTo'));
  }
});

// The committed four-contract set (contracts/mainnet): forge-meta gets an id, and the moved types
// are written to it and to no other contract.
test('a four-contract set routes the moved types to forge-meta', async () => {
  const chain = new OfflineChain({ contractsDir: join(ROOT, 'contracts', 'mainnet') });
  assert.deepEqual(Object.keys(chain.ids), ['core', 'collab', 'community', 'meta']);
  const evo = chain.evo();
  const write = documentWriter({ sdk: new evo.EvoSDK() }, evo, { ids: chain.ids }, noReconnect, { shape: shapeOfSet(chain.set), retries: 0 });
  const R = idBytes((await write(OWNER, 'repo', { name: 'r', visibility: VIS })).id.toBase58());
  for (const type of META_TYPES) assert.equal(contractOn(chain.ids, type), 'meta', type);
  await write(OWNER, 'topic', { repoId: R, name: 't0', vis: VIS });
  assert.equal(chain.live('topic').length, 1);
  // the same type addressed to its three-contract home is refused: forge-core no longer holds it
  const sdk = new evo.EvoSDK();
  const doc = new evo.Document({ documentTypeName: 'topic', dataContractId: chain.ids.core, ownerId: OWNER.id });
  doc.data = { repoId: R, name: 't1', vis: VIS };
  assert.throws(() => chain.create({ document: doc }), /topic is in forge-meta, not forge-core/);
  assert.deepEqual(Object.keys((await sdk.contracts.fetch(chain.ids.meta)).getDocumentTypes()).sort(), [...META_TYPES].sort());
});

// The four-contract set's own forms: identifiers are `type: "identifier"` (the reader finds a
// document by one), `topic` no longer declares `vis`, and a member's `asMember` proves a role.
test('a four-contract set: identifier lookups, no topic vis, and asMember with the signer\'s role', async () => {
  const chain = new OfflineChain({ contractsDir: join(ROOT, 'contracts', 'mainnet') });
  const evo = chain.evo();
  const sdk = new evo.EvoSDK();
  const shape = shapeOfSet(chain.set);
  const write = documentWriter({ sdk }, evo, { ids: chain.ids }, noReconnect, { shape, retries: 0 });
  const read = documentReader({ sdk }, { ids: chain.ids }, 0, noReconnect, shape);
  const repoId = (await write(OWNER, 'repo', { name: 'r', visibility: VIS })).id.toBase58();
  const R = idBytes(repoId);
  await write(OWNER, 'maintainer', membership(R, OWNER.id, OWNER.id));
  assert.ok(await read.first('maintainer', [['repoId', '==', repoId], ['memberId', '==', OWNER.id]]), 'a maintainer is found by its identifier values');
  // a topic written with vis (as the RC1 seeds do) goes out without it
  await write(OWNER, 'topic', { repoId: R, name: 't0', vis: VIS });
  assert.equal('vis' in chain.live('topic')[0].view, false);
  // a maintainer's asMember carries no mRole; a role-1 writer's carries 1
  await write(OTHER, 'consent', { repoId: R });
  await write(OWNER, 'writer', membership(R, OWNER.id, OTHER.id));
  const asMember = (who) => ({ repoId: R, number: chain.live('issue').length + 1, tk: 0, title: 't', vis: VIS, asMember: idBytes(who.id) });
  await write(OWNER, 'issue', asMember(OWNER));
  await write(OTHER, 'issue', asMember(OTHER));
  const [byOwner, byWriter] = chain.live('issue');
  assert.equal(byOwner.view.mRole, undefined);
  assert.equal(byWriter.view.mRole, 1);
  // a non-member's asMember is refused by the chain, not papered over
  await assert.rejects(write(person('stranger'), 'issue', asMember(person('stranger'))), refusedWith(40120, 'issue.asMember'));
});

// A lagging node just after an enrolment answers the role read without the writer row: `mRole` is
// left out, the member gate refuses (40120), and the write reads the role afresh and rebuilds once.
test('a stale role read is re-read once when the member gate refuses', async () => {
  const chain = new OfflineChain({ contractsDir: join(ROOT, 'contracts', 'mainnet') });
  const evo = chain.evo();
  const sdk = new evo.EvoSDK();
  const shape = shapeOfSet(chain.set);
  const plain = documentWriter({ sdk }, evo, { ids: chain.ids }, noReconnect, { shape, retries: 0 });
  const R = idBytes((await plain(OWNER, 'repo', { name: 'r', visibility: VIS })).id.toBase58());
  await plain(OWNER, 'maintainer', membership(R, OWNER.id, OWNER.id));
  await plain(OTHER, 'consent', { repoId: R });
  await plain(OWNER, 'writer', membership(R, OWNER.id, OTHER.id));
  const asMember = { repoId: R, number: 1, tk: 0, title: 't', vis: VIS, asMember: idBytes(OTHER.id) };

  let writerReads = 0;
  const lagging = {
    version: () => sdk.version(),
    documents: {
      ...sdk.documents,
      query: async (q) => (q.documentTypeName === 'writer' && ++writerReads === 1 ? new Map() : sdk.documents.query(q)),
    },
  };
  const write = documentWriter({ sdk: lagging }, evo, { ids: chain.ids }, noReconnect, { shape, retries: 0, roleLagMs: 0 });
  await write(OTHER, 'issue', asMember);
  assert.equal(writerReads, 2, 'the role was read, then read again after the refusal');
  assert.equal(chain.live('issue').length, 1);
  assert.equal(chain.live('issue')[0].view.mRole, 1);

  // a refusal that stands (a non-member) is retried once at most, then thrown
  writerReads = -100;
  const stranger = person('stranger');
  await assert.rejects(write(stranger, 'issue', { ...asMember, number: 2, asMember: idBytes(stranger.id) }), refusedWith(40120, 'issue.asMember'));
  assert.equal(chain.live('issue').length, 1);
});

// What rc1-live.mjs --offline reads and writes beyond the seeds: a replace as the next revision, a
// delete the schema forbids or a deleteConstraints rule keeps, proved aggregates keyed as a node
// keys them, a rule that reads the time, and `$revision` for the mainnet set's dense (R-05).
test('replace, delete, aggregates and the time for rc1-live --offline', async () => {
  const { chain, write, R, repoId } = await repoChain();
  const evo = chain.evo();
  const sdk = new evo.EvoSDK();
  const i1 = await write(OWNER, 'issue', issue(R, 1));
  // a replace is the stored document's next revision; a document already read keeps its revision
  const next = evo.Document.fromObject({ ...i1.toObject(), title: 'edited', $revision: 2n });
  await sdk.documents.replace({ document: next });
  assert.equal(chain.live('issue')[0].view.title, 'edited');
  assert.equal(i1.toObject().$revision, 1n);
  await assert.rejects(sdk.documents.replace({ document: next }), refusedWith(40103));
  // a release can not be deleted (10404)
  const rel = await write(OWNER, 'release', { repoId: R, tagName: 'v1', vis: VIS, delta: 1 });
  await assert.rejects(sdk.documents.delete({ document: rel }), refusedWith(10404));
  // grouped counts and sums: absent groups absent, keys in key order, an integer as its byte
  for (const kind of [3, 1]) await write(OWNER, 'transition', transition(R, { id: i1.id.toBase58(), number: 1 }, kind));
  const by = (await sdk.documents.countWithProof({ dataContractId: chain.ids.collab, documentTypeName: 'transition', where: [['repoId', '==', repoId], ['kind', 'in', [1, 2, 3]]], groupBy: ['kind'] })).data;
  assert.deepEqual([...by], [['01', 1n], ['03', 1n]]);
  const sums = (await sdk.documents.sumWithProof({ dataContractId: chain.ids.collab, documentTypeName: 'transition', where: [['targetId', '==', i1.id.toBase58()]] }, 'delta')).data;
  assert.deepEqual([...sums], [['', 17n]]);
  // notFuture reads the time: a run completed far in the future is refused
  const run = { repoId: R, headOid: Buffer.alloc(20, 1), name: 'b', status: 'completed', conclusion: 'success', startedAt: 1, completedAt: 9_000_000_000_000_000, outcome: 1, vis: VIS };
  await write(OWNER, 'runner', { repoId: R, memberId: idBytes(OWNER.id) });
  await assert.rejects(write(OWNER, 'checkRun', run), refusedWith(10422, 'notFuture'));
});

test('the mainnet set: dense reads $revision (R-05), and the owner\'s own maintainer row stays (R-08)', async () => {
  const chain = new OfflineChain({ contractsDir: join(ROOT, 'contracts', 'mainnet') });
  const evo = chain.evo();
  const sdk = new evo.EvoSDK();
  const write = documentWriter({ sdk }, evo, { ids: chain.ids }, noReconnect, { shape: shapeOfSet(chain.set), retries: 0 });
  const R = idBytes((await write(OWNER, 'repo', { name: 'r', visibility: VIS })).id.toBase58());
  const row = await write(OWNER, 'maintainer', membership(R, OWNER.id, OWNER.id));
  await assert.rejects(write(OWNER, 'issue', issue(R, 2)), refusedWith(10422, 'dense'));
  await assert.rejects(sdk.documents.delete({ document: row }), (e) => e.code === 'deleteConstraints' && e.rule === 'ownerRowStays');
});

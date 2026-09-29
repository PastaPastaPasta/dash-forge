// node --test forge-contracts/scripts/lib/: the offline chain refuses what consensus refuses for
// the rules that need chain state, so a seed that breaks one fails seed-offline.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { OfflineChain } from './offline-chain.mjs';
import { TRANSITION, VIS, b58encode, documentReader, documentWriter, idBytes, membership, transition } from './seed-io.mjs';

const person = (name) => ({ name, id: b58encode(createHash('sha256').update(name).digest()) });
const OWNER = person('owner');
const OTHER = person('other');

/** A chain holding one public repo of OWNER, OWNER its maintainer. */
async function repoChain() {
  const chain = new OfflineChain();
  const evo = chain.evo();
  const sdk = new evo.EvoSDK();
  const write = documentWriter(sdk, evo, { ids: chain.ids });
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

test('a non-member cannot write an event; the repo owner cannot beat its own repo', async () => {
  const { write, R } = await repoChain();
  const i1 = (await write(OWNER, 'issue', issue(R, 1))).id.toBase58();
  const label = { repoId: R, targetId: idBytes(i1), targetNumber: 1, kind: 4, value: 'bug' };
  await assert.rejects(write(OTHER, 'event', label), refusedWith(40120, 'event.ownerRefersTo'));
  await write(OWNER, 'event', label);
  await assert.rejects(write(OWNER, 'starBeat', { repoId: R, vis: VIS, repoOwner: idBytes(OWNER.id) }), refusedWith(10419));
  await write(OTHER, 'starBeat', { repoId: R, vis: VIS, repoOwner: idBytes(OWNER.id) });
  // The repo is found, but its owner is not the beat's repoOwner: a `where` mismatch.
  await assert.rejects(write(OTHER, 'starBeat', { repoId: R, vis: VIS, repoOwner: idBytes(person('third').id) }), refusedWith(40127, 'starBeat.repoId'));
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
  const read = documentReader(new evo.EvoSDK(), { ids: chain.ids });
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

test('a document goes to the contract that holds its type', async () => {
  const chain = new OfflineChain();
  const evo = chain.evo();
  const sdk = new evo.EvoSDK();
  const wrong = documentWriter(sdk, evo, { ids: { ...chain.ids, community: chain.ids.collab } });
  await assert.rejects(wrong(OWNER, 'star', { repoId: Buffer.alloc(32, 1) }), /star is in forge-community, not forge-collab/);
});

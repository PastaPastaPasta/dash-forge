// node --test forge-contracts/scripts/lib/: the seed scripts' view of a contract set agrees with
// the committed sets, so a four-contract run puts each document type in the contract that holds it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { CONTRACTS, CONTRACT_OF, META_TYPES, ROOT, assertWriteTarget, contractOn, contractsIn, resolveNetwork, shapeData, shapeOfSet } from './seed-io.mjs';

const typesOf = (dir, file) => Object.keys(JSON.parse(readFileSync(join(dir, file), 'utf8')).documentSchemas);

test('the default set is the three devnet contracts', () => {
  const set = contractsIn(join(ROOT, 'contracts'));
  assert.deepEqual(Object.keys(set.contracts), ['core', 'collab', 'community']);
  assert.deepEqual(set.contracts, CONTRACTS);
  assert.deepEqual(set.contractOf, CONTRACT_OF);
});

test('the committed mainnet set is four contracts, forge-meta last', () => {
  const dir = join(ROOT, 'contracts', 'mainnet');
  const { contracts, contractOf } = contractsIn(dir);
  assert.deepEqual(Object.keys(contracts), ['core', 'collab', 'community', 'meta']);
  // META_TYPES is the type list of forge-meta, no more and no fewer
  assert.deepEqual([...META_TYPES].sort(), typesOf(dir, 'forge-meta.json').sort());
  // every type resolves to the contract of its file under a record that has forge-meta
  const ids = { core: 'c', collab: 'l', community: 'm', meta: 'x' };
  for (const [c, json] of Object.entries(contracts)) {
    for (const t of Object.keys(json.documentSchemas)) {
      assert.equal(contractOf[t], c, t);
      assert.equal(contractOn(ids, t, contractOf), c, t);
    }
  }
});

test('a three-contract record keeps the moved types in their old homes', () => {
  const ids = { core: 'c', collab: 'l', community: 'm' };
  for (const t of META_TYPES) assert.equal(contractOn(ids, t), CONTRACT_OF[t], t);
});

// ---- the shape of a loaded set decides the fields a write carries (DESIGN MB1) ----
const SHAPES = { devnet: shapeOfSet(contractsIn(join(ROOT, 'contracts'))), mainnet: shapeOfSet(contractsIn(join(ROOT, 'contracts', 'mainnet'))) };
const noRole = async () => { throw new Error('no role read expected'); };

test('the shapes tell the sets apart', () => {
  assert.equal(SHAPES.devnet.declares('chunk', 'r'), true);
  assert.equal(SHAPES.mainnet.declares('chunk', 'r'), false);
  assert.equal(SHAPES.devnet.declares('topic', 'vis'), true);
  assert.equal(SHAPES.mainnet.declares('topic', 'vis'), false);
  assert.equal(SHAPES.devnet.declares('issue', 'mRole'), false);
  assert.equal(SHAPES.mainnet.declares('issue', 'mRole'), true);
  assert.equal(SHAPES.mainnet.declares('release', 'targetOid'), true);
  for (const shape of Object.values(SHAPES)) assert.deepEqual([shape.fusedStar, shape.memberRoles, shape.has('starBeat')], [true, true, false]);
  assert.deepEqual(SHAPES.mainnet.uniqueIndices('maintainer'), [['repoId', 'memberId']]);
});

test('shapeData: the roles and vis follow the declaring contract; mRole only where declared', async () => {
  const who = { id: 'W' };
  const repoId = new Uint8Array(32).fill(3);
  assert.deepEqual(await shapeData(SHAPES.devnet, 'writer', { repoId }, who, noRole), { repoId, role: 1 });
  assert.deepEqual(await shapeData(SHAPES.devnet, 'topic', { repoId, name: 'x', vis: 'public' }, who, noRole), { repoId, name: 'x', vis: 'public' });
  // a three-contract set declares no mRole: asMember is untouched and no role is read
  assert.deepEqual(await shapeData(SHAPES.devnet, 'issue', { repoId, asMember: repoId }, who, noRole), { repoId, asMember: repoId, });
  assert.deepEqual(await shapeData(SHAPES.mainnet, 'topic', { repoId, name: 'x', vis: 'public' }, who, noRole), { repoId, name: 'x' });
  assert.equal('r' in (await shapeData(SHAPES.mainnet, 'chunk', { repoId }, who, noRole)), false);
  const asWriter = await shapeData(SHAPES.mainnet, 'comment', { repoId, asMember: repoId }, who, async () => 1);
  assert.equal(asWriter.mRole, 1);
  assert.equal('mRole' in (await shapeData(SHAPES.mainnet, 'comment', { repoId, asMember: repoId }, who, async () => null)), false);
  assert.equal('mRole' in (await shapeData(SHAPES.mainnet, 'comment', { repoId }, who, noRole)), false);
  assert.equal((await shapeData(SHAPES.mainnet, 'comment', { repoId, asMember: repoId, mRole: 2 }, who, noRole)).mRole, 2);
});

// ---- CONT-V-01: no write to the live testnet or mainnet set unless told so by name ----
const tmps = [];
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const LIVE = { network: 'testnet', v2: { forgeCore: { contractId: 'LiveCore1111111111111111111111111111111111' }, contractGroupId: 'LiveGroup111111111111111111111111111111111' } };
const write = (file, json) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(json)); return file; };
/** A temp forge-contracts root whose deployments/ holds a live testnet record. */
function root() {
  const dir = mkdtempSync(join(tmpdir(), 'seed-io-guard-'));
  tmps.push(dir);
  write(join(dir, 'deployments', 'testnet.json'), LIVE);
  return dir;
}
const target = (dir, network, file, dep) => ({ network, file, dep: dep ?? JSON.parse(readFileSync(file, 'utf8')) });
const guard = (dir, network, file, a = {}, dep) => assertWriteTarget(target(dir, network, file, dep), a, dir, 'seed-x.mjs');

test('the live testnet record is written only with --production testnet', () => {
  const dir = root();
  const live = join(dir, 'deployments', 'testnet.json');
  assert.throws(() => guard(dir, 'testnet', live), /seed-x\.mjs writes permanent documents to the live testnet set \(deployments\/testnet\.json\).*scratch record.*--production testnet/s);
  assert.throws(() => guard(dir, 'testnet', live, { production: true }), /--production testnet/);
  assert.throws(() => guard(dir, 'testnet', live, { production: 'mainnet' }), /--production testnet/);
  assert.doesNotThrow(() => guard(dir, 'testnet', live, { production: 'testnet' }));
});

test('--production names the network the run connects to', () => {
  const dir = root();
  const live = join(dir, 'deployments', 'testnet.json');
  // a devnet run pointed at the live testnet record is still a write to it
  assert.throws(() => guard(dir, 'devnet', live, { production: 'testnet' }), /--production testnet/);
});

test('a scratch record is free; one naming the live forge-core or group is the live set', () => {
  const dir = root();
  const scratch = write(join(dir, 'scratch', 'rehearsal.json'), { v2: { forgeCore: { contractId: 'Scratch' }, contractGroupId: 'ScratchGroup' } });
  assert.doesNotThrow(() => guard(dir, 'testnet', scratch));
  const sameCore = write(join(dir, 'scratch', 'core.json'), { v2: { forgeCore: { contractId: LIVE.v2.forgeCore.contractId } } });
  assert.throws(() => guard(dir, 'testnet', sameCore), /live testnet set/);
  const sameGroup = write(join(dir, 'scratch', 'group.json'), { v2: { contractGroupId: LIVE.v2.contractGroupId } });
  assert.throws(() => guard(dir, 'testnet', sameGroup), /live testnet set/);
  // naming any one live contract is enough, a superseded one included
  const sameCollab = write(join(dir, 'scratch', 'collab.json'), { v2: { forgeCore: { contractId: 'Other' }, forgeCollab: { contractId: 'LiveCollab' } } });
  write(join(dir, 'deployments', 'testnet.json'), { ...LIVE, v2: { ...LIVE.v2, forgeCollab: { contractId: 'LiveCollab' }, forgeMetaSuperseded: [{ contractId: 'OldMeta' }] } });
  assert.throws(() => guard(dir, 'testnet', sameCollab), /live testnet set/);
  const oldMeta = write(join(dir, 'scratch', 'meta.json'), { v2: { forgeMeta: { contractId: 'OldMeta' } } });
  assert.throws(() => guard(dir, 'testnet', oldMeta), /live testnet set/);
  write(join(dir, 'deployments', 'testnet.json'), LIVE);
  // a symlink to the live record is the live record
  const link = join(dir, 'scratch', 'link.json');
  symlinkSync(join(dir, 'deployments', 'testnet.json'), link);
  assert.throws(() => guard(dir, 'testnet', link), /live testnet set/);
  assert.doesNotThrow(() => guard(dir, 'testnet', link, { production: 'testnet' }));
});

test('a devnet record is untouched by the guard', () => {
  const dir = root();
  const sakura = write(join(dir, 'deployments', 'devnet-sakura.json'), { network: 'devnet', v2: { forgeCore: { contractId: 'SakuraCore' } } });
  assert.doesNotThrow(() => guard(dir, 'devnet', sakura));
});

test('DASH_FORGE_NETWORK=testnet alone never authorizes a write', () => {
  assert.throws(() => resolveNetwork({}, { DASH_FORGE_NETWORK: 'testnet' }), /writes permanent documents to the live testnet set.*--production testnet/s);
  assert.throws(() => resolveNetwork({ network: 'mainnet' }, {}), /live mainnet set.*--production mainnet/s);
  // devnet is the default and is not affected
  assert.equal(resolveNetwork({}, {}).network, 'devnet');
});

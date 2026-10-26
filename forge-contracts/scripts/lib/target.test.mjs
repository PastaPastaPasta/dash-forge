// node --test forge-contracts/scripts/lib/target.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { depPath } from '../deploy-v2.mjs';
import {
  DEFAULT_DEPLOYMENTS_DIR,
  JULY_POOL_IDS,
  SUPERSEDED_KEYS,
  addressesFor,
  assertNotJulyIdentity,
  assertScratchBaseline,
  checkFlags,
  liveRecordPath,
  productionOverlap,
  refuseMainnet,
  refuseProduction,
  contractIds,
  resolveTarget,
  scratchStampError,
  sdkOptions,
  setIds,
  sharesLiveSet,
  validateDevnetName,
} from './target.mjs';

const threeContracts = (core = 'CORE', group = 'GROUP') => ({
  v2: { forgeCore: { contractId: core, contractGroupId: group }, forgeCollab: { contractId: `${core}_COLLAB` }, forgeCommunity: { contractId: `${core}_COMM` }, contractGroupId: group },
});
const fourContracts = (core = 'CORE4', group = 'GROUP4') => {
  const r = threeContracts(core, group);
  r.v2.forgeMeta = { contractId: `${core}_META` };
  return r;
};

// what `deploy-v2.mjs --contracts <dir> --record <file>` stamps on a scratch registration
const scratched = (rec) => ({ ...rec, v2: { ...rec.v2, contractsDir: 'forge-contracts/contracts/mainnet' } });
// what a committed-set (--set) run writes: the live record
const committed = (rec) => ({ ...rec, v2: { ...rec.v2, contractsSet: 'mainnet' } });

let dir; // a stand-in forge-contracts/
let deployments;
let scratchDir; // outside deployments/
const write = (file, value) => writeFileSync(file, `${JSON.stringify(value)}\n`);

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'target-test-'));
  deployments = join(dir, 'deployments');
  scratchDir = join(dir, 'scratch');
  mkdirSync(deployments);
  mkdirSync(scratchDir);
  write(join(deployments, 'devnet-sakura.json'), { network: 'devnet', dapiAddresses: ['https://10.0.0.1:1443'], ...threeContracts('SAKURA_CORE', 'SAKURA_GROUP') });
  write(join(deployments, 'devnet-other.json'), { network: 'devnet', dapiAddresses: ['https://10.0.0.2:1443'], ...threeContracts('OTHER_CORE', 'OTHER_GROUP') });
  write(join(deployments, 'testnet.json'), { dapiAddresses: ['https://stale:1443'], keyExchange: {} }); // before the registration
  write(join(deployments, 'mainnet.json'), committed({ network: 'mainnet', ...fourContracts('MAIN_CORE', 'MAIN_GROUP') }));
  write(join(scratchDir, 'scratch-testnet.json'), scratched({ network: 'testnet', ...fourContracts('SCRATCH_CORE', 'SCRATCH_GROUP') }));
  write(join(scratchDir, 'scratch-testnet-3.json'), scratched({ network: 'testnet', ...threeContracts('S3_CORE', 'S3_GROUP') }));
  write(join(scratchDir, 'wrong-network.json'), scratched({ network: 'devnet', ...fourContracts('W_CORE', 'W_GROUP') }));
  write(join(scratchDir, 'mainnet-copy.json'), scratched({ network: 'mainnet', ...fourContracts('MAIN_CORE', 'ANOTHER_GROUP') }));
  write(join(scratchDir, 'group-copy.json'), scratched({ ...fourContracts('NEW_CORE', 'MAIN_GROUP') }));
  write(join(scratchDir, 'stale-live-copy.json'), { dapiAddresses: ['https://stale:1443'], ...committed({ network: 'mainnet', ...fourContracts('F2_CORE', 'F2_GROUP') }) });
  write(join(scratchDir, 'empty.json'), {});
  write(join(scratchDir, 'token-only.json'), { network: 'testnet', v2: { permissionTokens: {} } });
  symlinkSync(deployments, join(scratchDir, 'link-to-deployments'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const opts = () => ({ deploymentsDir: deployments });

describe('the record path matches deploy-v2.mjs depPath', () => {
  test('devnet, testnet, mainnet', () => {
    assert.equal(liveRecordPath(DEFAULT_DEPLOYMENTS_DIR, 'devnet', 'sakura'), depPath('devnet', 'sakura'));
    assert.equal(liveRecordPath(DEFAULT_DEPLOYMENTS_DIR, 'testnet'), depPath('testnet'));
    assert.equal(liveRecordPath(DEFAULT_DEPLOYMENTS_DIR, 'mainnet'), depPath('mainnet'));
  });
});

describe('--network and --devnet-name', () => {
  test('default is devnet sakura, as before', () => {
    const t = resolveTarget({}, opts());
    assert.equal(t.network, 'devnet');
    assert.equal(t.devnetName, 'sakura');
    assert.equal(t.label, 'devnet-sakura');
    assert.equal(t.recordFile, join(deployments, 'devnet-sakura.json'));
    assert.equal(t.production, false);
    assert.equal(t.scratch, false);
  });
  test('another devnet', () => {
    const t = resolveTarget({ 'devnet-name': 'other' }, opts());
    assert.equal(t.recordFile, join(deployments, 'devnet-other.json'));
    assert.equal(t.production, false);
  });
  test('testnet resolves deployments/testnet.json and is production', () => {
    const t = resolveTarget({ network: 'testnet' }, opts());
    assert.equal(t.recordFile, join(deployments, 'testnet.json'));
    assert.equal(t.label, 'testnet');
    assert.equal(t.devnetName, undefined);
    assert.equal(t.production, true);
  });
  test('unknown networks and devnet names are refused', () => {
    assert.throws(() => resolveTarget({ network: 'regtest' }, opts()), /--network accepts/);
    assert.throws(() => resolveTarget({ network: true }, opts()), /--network takes/);
    assert.throws(() => resolveTarget({ 'devnet-name': '../testnet' }, opts()), /--devnet-name must match/);
    assert.throws(() => resolveTarget({ 'devnet-name': 'Sakura' }, opts()), /--devnet-name must match/);
    assert.throws(() => resolveTarget({ 'devnet-name': 'a/b' }, opts()), /--devnet-name must match/);
    assert.throws(() => resolveTarget({ 'devnet-name': '' }, opts()), /--devnet-name must match/);
    assert.throws(() => resolveTarget({ 'devnet-name': true }, opts()), /takes a name/);
    assert.throws(() => resolveTarget({ 'devnet-name': 'nope' }, opts()), /does not exist/);
  });
  test('--devnet-name beside a production network is refused', () => {
    assert.throws(() => resolveTarget({ network: 'testnet', 'devnet-name': 'sakura' }, opts()), /only applies to --network devnet/);
  });
  test('validateDevnetName accepts the real names', () => {
    for (const ok of ['sakura', 'moutai', 'dev-1', 'a']) assert.equal(validateDevnetName(ok), ok);
  });
});

describe('--record', () => {
  test('a scratch record on testnet is not production', () => {
    const t = resolveTarget({ network: 'testnet', record: join(scratchDir, 'scratch-testnet.json') }, opts());
    assert.equal(t.scratch, true);
    assert.equal(t.production, false);
    assert.equal(t.fourContract, true);
    assert.equal(t.liveFile, join(deployments, 'testnet.json'));
    assert.doesNotThrow(() => refuseProduction(t));
  });
  test('a record under deployments/ is refused, through a symlink and by case', () => {
    assert.throws(() => resolveTarget({ network: 'testnet', record: join(deployments, 'testnet.json') }, opts()), /outside forge-contracts\/deployments/);
    assert.throws(() => resolveTarget({ network: 'testnet', record: join(scratchDir, 'link-to-deployments', 'testnet.json') }, opts()), /outside forge-contracts\/deployments/);
    assert.throws(() => resolveTarget({ network: 'testnet', record: join(deployments, 'Testnet.JSON') }, opts()), /outside forge-contracts\/deployments|does not exist/);
    assert.throws(() => resolveTarget({ network: 'testnet', record: join(deployments, 'sub', 'x.json') }, opts()), /outside forge-contracts\/deployments/);
  });
  test('a record naming another network is refused', () => {
    assert.throws(() => resolveTarget({ network: 'testnet', record: join(scratchDir, 'wrong-network.json') }, opts()), /records network devnet, not testnet/);
  });
  test('a missing or unreadable record is refused', () => {
    assert.throws(() => resolveTarget({ network: 'testnet', record: join(scratchDir, 'nope.json') }, opts()), /does not exist/);
    assert.throws(() => resolveTarget({ network: 'testnet', record: true }, opts()), /--record takes a path/);
  });
  test('a copy of the live registration counts as live (same forge-core or group)', () => {
    const copy = resolveTarget({ network: 'mainnet', record: join(scratchDir, 'mainnet-copy.json') }, opts());
    assert.equal(copy.copiesLive, true);
    assert.equal(copy.production, true);
    assert.throws(() => refuseProduction(copy), /carries an id of the live mainnet registration/);
    const group = resolveTarget({ network: 'mainnet', record: join(scratchDir, 'group-copy.json') }, opts());
    assert.equal(group.production, true);
    assert.ok(sharesLiveSet(group.record, group.live));
  });
  test('a splice that keeps any live contract counts as live', () => {
    const dep2 = join(dir, 'dep2');
    mkdirSync(dep2);
    const live = { network: 'mainnet', ...fourContracts('M2_CORE', 'M2_GROUP') };
    write(join(dep2, 'mainnet.json'), live);
    const spliced = scratched({ network: 'mainnet', ...fourContracts('S2_CORE', 'S2_GROUP') });
    spliced.v2.forgeCommunity.contractId = live.v2.forgeCommunity.contractId; // fresh core and group, the live community
    write(join(scratchDir, 'splice.json'), spliced);
    const t = resolveTarget({ network: 'mainnet', record: join(scratchDir, 'splice.json') }, { deploymentsDir: dep2 });
    assert.equal(t.copiesLive, true);
    assert.equal(t.production, true);
    // and a fully fresh set is not
    write(join(scratchDir, 'fresh.json'), scratched({ network: 'mainnet', ...(() => { const r = fourContracts('F_CORE', 'F_GROUP'); r.v2.forgeCollab.contractId = 'F_COLLAB'; r.v2.forgeCommunity.contractId = 'F_COMM'; r.v2.forgeMeta.contractId = 'F_META'; return r; })() }));
    assert.equal(resolveTarget({ network: 'mainnet', record: join(scratchDir, 'fresh.json') }, { deploymentsDir: dep2 }).production, false);
  });
  test('a scratch record on a devnet may be a copy: a devnet is not production', () => {
    write(join(scratchDir, 'sakura-copy.json'), { network: 'devnet', ...threeContracts('SAKURA_CORE', 'SAKURA_GROUP') });
    const t = resolveTarget({ record: join(scratchDir, 'sakura-copy.json') }, opts());
    assert.equal(t.copiesLive, true);
    assert.equal(t.production, false);
  });
});

describe('the scratch stamp (fail closed on testnet and mainnet)', () => {
  test('a record without v2.contractsDir is not a scratch record', () => {
    for (const [network, file] of [['testnet', 'empty.json'], ['testnet', 'token-only.json'], ['mainnet', 'empty.json']]) {
      assert.throws(() => resolveTarget({ network, record: join(scratchDir, file) }, opts()), /is not a scratch record: it has no v2\.contractsDir/);
    }
  });
  test('a stale copy of the live record (v2.contractsSet) is refused whatever its ids', () => {
    assert.throws(() => resolveTarget({ network: 'mainnet', record: join(scratchDir, 'stale-live-copy.json') }, opts()), /is not a scratch record: it carries v2\.contractsSet/);
  });
  test('contractsSet beside contractsDir is refused too', () => {
    write(join(scratchDir, 'both.json'), { network: 'testnet', v2: { contractsDir: 'x', contractsSet: 'mainnet' } });
    assert.throws(() => resolveTarget({ network: 'testnet', record: join(scratchDir, 'both.json') }, opts()), /is not a scratch record/);
  });
  test('scratchStampError', () => {
    assert.equal(scratchStampError({ v2: { contractsDir: 'x' } }), null);
    assert.match(scratchStampError({}), /no v2\.contractsDir/);
    assert.match(scratchStampError({ v2: { contractsDir: '' } }), /no v2\.contractsDir/);
    assert.match(scratchStampError({ v2: { contractsDir: 7 } }), /no v2\.contractsDir/);
    assert.match(scratchStampError({ v2: { contractsSet: 'devnet' } }), /contractsSet/);
    // a committed-set rehearsal (--set mainnet --record <file> --scratch-on <network>)
    assert.equal(scratchStampError({ network: 'testnet', v2: { contractsSet: 'mainnet', scratchOn: 'testnet' } }), null);
    assert.match(scratchStampError({ network: 'mainnet', v2: { contractsSet: 'mainnet', scratchOn: 'testnet' } }), /no v2\.scratchOn for its network/);
    assert.match(scratchStampError({ network: 'testnet', v2: { contractsSet: 'mainnet', scratchOn: '' } }), /no v2\.scratchOn/);
    assert.match(scratchStampError({ v2: { contractsSet: 'mainnet', scratchOn: 'testnet' } }), /no v2\.scratchOn/);
  });
  test('a devnet scratch record needs no stamp', () => {
    write(join(scratchDir, 'devnet-scratch.json'), { network: 'devnet', ...threeContracts('D_CORE', 'D_GROUP') });
    const t = resolveTarget({ record: join(scratchDir, 'devnet-scratch.json') }, opts());
    assert.equal(t.scratch, true);
    assert.equal(t.production, false);
  });
  test('a devnet record naming another devnet is refused', () => {
    write(join(scratchDir, 'other-devnet.json'), { network: 'devnet', devnetName: 'other', ...threeContracts('O2_CORE', 'O2_GROUP') });
    assert.throws(() => resolveTarget({ record: join(scratchDir, 'other-devnet.json') }, opts()), /records devnet other, not sakura/);
    assert.equal(resolveTarget({ 'devnet-name': 'other', record: join(scratchDir, 'other-devnet.json') }, opts()).devnetName, 'other');
  });
});

describe('what counts as the live set', () => {
  const full = () => {
    const r = fourContracts('L_CORE', 'L_GROUP');
    r.v2.contractGroup = { id: 'L_GROUP_OBJ' };
    r.v2.forgeCore.contractGroupId = 'L_GROUP_CORE';
    r.v2.forgeCoreSuperseded = [{ contractId: 'OLD_CORE', contractGroupId: 'OLD_CORE_GROUP' }];
    r.v2.forgeCollabSuperseded = [{ contractId: 'OLD_COLLAB' }];
    r.v2.forgeCommunitySuperseded = [{ contractId: 'OLD_COMM' }];
    r.v2.forgeMetaSuperseded = [{ contractId: 'OLD_META' }];
    r.v2.contractGroupSuperseded = [{ id: 'OLD_GROUP' }];
    return r;
  };
  test('setIds collects every group field and every superseded list', () => {
    const ids = new Set(setIds(full()));
    for (const id of ['L_CORE', 'L_CORE_COLLAB', 'L_CORE_COMM', 'L_CORE_META', 'L_GROUP', 'L_GROUP_OBJ', 'L_GROUP_CORE', 'OLD_CORE', 'OLD_CORE_GROUP', 'OLD_COLLAB', 'OLD_COMM', 'OLD_META', 'OLD_GROUP']) {
      assert.ok(ids.has(id), `${id} missing`);
    }
    assert.equal(SUPERSEDED_KEYS.length, 5);
  });
  test('each id alone makes a record share the set', () => {
    const live = full();
    const probes = [
      (r) => { r.v2.contractGroup = { id: 'L_GROUP_OBJ' }; },
      (r) => { r.v2.forgeCore.contractGroupId = 'L_GROUP_CORE'; },
      (r) => { r.v2.contractGroupId = 'L_GROUP'; },
      (r) => { r.v2.forgeCoreSuperseded = [{ contractId: 'OLD_CORE' }]; },
      (r) => { r.v2.forgeCoreSuperseded = [{ contractGroupId: 'OLD_CORE_GROUP' }]; },
      (r) => { r.v2.forgeCollabSuperseded = [{ contractId: 'OLD_COLLAB' }]; },
      (r) => { r.v2.forgeCommunitySuperseded = [{ contractId: 'OLD_COMM' }]; },
      (r) => { r.v2.forgeMetaSuperseded = [{ contractId: 'OLD_META' }]; },
      (r) => { r.v2.contractGroupSuperseded = [{ id: 'OLD_GROUP' }]; },
    ];
    for (const [i, set] of probes.entries()) {
      const fresh = fourContracts(`X${i}_CORE`, `X${i}_GROUP`);
      assert.equal(sharesLiveSet(fresh, live), false, `probe ${i} starts disjoint`);
      set(fresh);
      assert.equal(sharesLiveSet({ v2: fresh.v2 }, live), true, `probe ${i}`);
      // and it goes both ways: the live record's superseded ids count when the scratch carries them live
      assert.equal(sharesLiveSet(live, { v2: fresh.v2 }), true, `probe ${i} reversed`);
    }
  });
  test('a record is compared against EVERY production record, whatever --network', () => {
    // testnet.json is the pre-registration stub; mainnet.json holds the MAIN_* set: a mainnet copy passed as testnet
    write(join(scratchDir, 'mainnet-as-testnet.json'), scratched({ network: 'testnet', ...fourContracts('MAIN_CORE', 'FRESH_G') }));
    const t = resolveTarget({ network: 'testnet', record: join(scratchDir, 'mainnet-as-testnet.json') }, opts());
    assert.equal(t.copiesLive, false); // not the testnet registration...
    assert.equal(t.overlap?.network, 'mainnet'); // ...but the mainnet one
    assert.equal(t.production, true);
    assert.throws(() => refuseProduction(t), /carries an id of the live mainnet registration/);
    assert.deepEqual(productionOverlap(t.record, deployments), { network: 'mainnet', file: join(deployments, 'mainnet.json') });
    assert.equal(productionOverlap(fourContracts('NOBODY', 'NOBODY_G'), deployments), null);
  });
  test('the testnet registration is compared too', () => {
    const dep3 = join(dir, 'dep3');
    mkdirSync(dep3);
    write(join(dep3, 'testnet.json'), committed({ network: 'testnet', ...fourContracts('T3_CORE', 'T3_GROUP') }));
    write(join(dep3, 'mainnet.json'), committed({ network: 'mainnet', ...fourContracts('M3_CORE', 'M3_GROUP') }));
    const spliced = scratched({ network: 'mainnet', ...fourContracts('S3X_CORE', 'S3X_GROUP') });
    spliced.v2.forgeMetaSuperseded = [{ contractId: 'T3_CORE_META' }];
    write(join(scratchDir, 'testnet-meta-in-mainnet.json'), spliced);
    const t = resolveTarget({ network: 'mainnet', record: join(scratchDir, 'testnet-meta-in-mainnet.json') }, { deploymentsDir: dep3 });
    assert.equal(t.overlap?.network, 'testnet');
    assert.equal(t.production, true);
  });
});

describe('mainnet is refused by the live tools', () => {
  test('refuseMainnet', () => {
    assert.throws(() => refuseMainnet('mainnet', 'rc1-live'), /--network mainnet is not supported for rc1-live.*real DASH/);
    for (const n of [undefined, 'devnet', 'testnet', true]) assert.doesNotThrow(() => refuseMainnet(n, 'rc1-live'));
  });
});

describe('fees2 --baseline', () => {
  const live = () => resolveTarget({ network: 'testnet', record: join(scratchDir, 'scratch-testnet.json') }, opts());
  const baseline = (core) => scratched({ network: 'testnet', ...fourContracts(core, `${core}_G`) });
  test('another scratch set passes', () => {
    assert.doesNotThrow(() => assertScratchBaseline(join(scratchDir, 'b.json'), baseline('BASE'), live(), { deploymentsDir: deployments }));
  });
  test('a file of deployments/ is refused, by symlink and by case-less prefix', () => {
    assert.throws(() => assertScratchBaseline(join(deployments, 'mainnet.json'), baseline('BASE'), live(), { deploymentsDir: deployments }), /outside forge-contracts\/deployments/);
    assert.throws(() => assertScratchBaseline(join(scratchDir, 'link-to-deployments', 'x.json'), baseline('BASE'), live(), { deploymentsDir: deployments }), /outside forge-contracts\/deployments/);
    // a sibling directory sharing the prefix is not under deployments/
    assert.doesNotThrow(() => assertScratchBaseline(join(dir, 'deployments-old', 'x.json'), baseline('BASE'), live(), { deploymentsDir: deployments }));
  });
  test('an unstamped or live-stamped baseline on testnet is refused', () => {
    assert.throws(() => assertScratchBaseline(join(scratchDir, 'b.json'), { v2: { ...baseline('B2').v2, contractsDir: undefined } }, live(), { deploymentsDir: deployments }), /not a scratch record/);
    assert.throws(() => assertScratchBaseline(join(scratchDir, 'b.json'), committed(baseline('B2')), live(), { deploymentsDir: deployments }), /not a scratch record/);
  });
  test('any live core, collab, community, meta or group (superseded too) is refused', () => {
    const t = resolveTarget({ network: 'testnet', record: join(scratchDir, 'scratch-testnet.json') }, opts());
    for (const mutate of [
      (v2) => { v2.forgeCommunity = { contractId: 'MAIN_CORE_COMM' }; },
      (v2) => { v2.forgeMeta = { contractId: 'MAIN_CORE_META' }; },
      (v2) => { v2.forgeCollab = { contractId: 'MAIN_CORE_COLLAB' }; },
      (v2) => { v2.contractGroupId = 'MAIN_GROUP'; },
      (v2) => { v2.forgeCommunitySuperseded = [{ contractId: 'MAIN_CORE_COMM' }]; },
    ]) {
      const b = baseline('BASE2');
      mutate(b.v2);
      assert.throws(() => assertScratchBaseline(join(scratchDir, 'b.json'), b, t, { deploymentsDir: deployments }), /carries an id of the live mainnet registration/);
    }
  });
  test('the live registration of the target network is refused (a devnet)', () => {
    const t = resolveTarget({}, opts());
    const b = { v2: { ...threeContracts('SAKURA_CORE', 'BASE_G').v2 } };
    assert.throws(() => assertScratchBaseline(join(scratchDir, 'b.json'), b, t, { deploymentsDir: deployments }), /live devnet-sakura registration/);
  });
  test('the set under test is refused as its own baseline', () => {
    const t = live();
    assert.throws(() => assertScratchBaseline(join(scratchDir, 'b.json'), scratched({ network: 'testnet', ...fourContracts('SCRATCH_CORE', 'SCRATCH_GROUP') }), t, { deploymentsDir: deployments }), /shares an id with the set under test/);
  });
});

describe('the production-write policy', () => {
  test('no --record on testnet or mainnet is the live registration: refused', () => {
    for (const network of ['testnet', 'mainnet']) {
      const t = resolveTarget({ network }, opts());
      assert.equal(t.production, true);
      assert.throws(() => refuseProduction(t), new RegExp(`refusing to run against a live registration: .*live ${network} registration.*scratch registration`));
    }
  });
  test('the refusal tells the operator how to run a scratch set', () => {
    assert.throws(() => refuseProduction(resolveTarget({ network: 'testnet' }, opts())), /deploy-v2\.mjs --network testnet --contracts <dir> --record <scratch\.json>/);
    assert.throws(() => refuseProduction(resolveTarget({ network: 'testnet' }, opts()), 'see --live-target'), /see --live-target$/);
  });
  test('a devnet is never refused', () => {
    assert.doesNotThrow(() => refuseProduction(resolveTarget({}, opts()), 'rc1-live'));
  });
  test('--live-target: only where the tool has the flag, and never with --record', () => {
    assert.throws(() => resolveTarget({ network: 'testnet', 'live-target': true }, opts()), /not an option of this tool/);
    const t = resolveTarget({ network: 'testnet', 'live-target': true }, { ...opts(), liveTargetFlag: true });
    assert.equal(t.liveTarget, true);
    assert.equal(t.production, true); // the tool decides what a live target may do
    assert.throws(() => resolveTarget({ network: 'testnet', 'live-target': true, record: join(scratchDir, 'scratch-testnet.json') }, { ...opts(), liveTargetFlag: true }), /drop --record/);
    assert.equal(resolveTarget({ network: 'testnet' }, { ...opts(), liveTargetFlag: true }).liveTarget, false);
  });
});

describe('layout', () => {
  test('a record names three contracts, or four with forge-meta (QA-03: the rule suites route either)', () => {
    const four = resolveTarget({ network: 'testnet', record: join(scratchDir, 'scratch-testnet.json') }, opts());
    assert.deepEqual(Object.keys(contractIds(four)), ['core', 'collab', 'community', 'meta']);
    const three = resolveTarget({ network: 'testnet', record: join(scratchDir, 'scratch-testnet-3.json') }, opts());
    assert.deepEqual(Object.keys(contractIds(three)), ['core', 'collab', 'community']);
    assert.equal(three.fourContract, false);
  });
  test('a record missing one of the three, or a forge-meta without an id, is refused', () => {
    assert.throws(() => contractIds({ recordFile: 'r.json', record: { v2: { forgeCore: { contractId: 'C' } } } }), /records no forge-v2 contracts/);
    const half = { v2: { forgeCore: { contractId: 'C' }, forgeCollab: { contractId: 'L' }, forgeCommunity: { contractId: 'M' }, forgeMeta: {} } };
    assert.throws(() => contractIds({ recordFile: 'r.json', record: half }), /half-finished deploy/);
  });
});

describe('connection', () => {
  test('a devnet names itself and uses the record addresses', () => {
    const t = resolveTarget({}, opts());
    assert.deepEqual(addressesFor(t, {}), ['https://10.0.0.1:1443']);
    assert.deepEqual(sdkOptions(t, { addresses: addressesFor(t, {}), settings: { timeoutMs: 1 } }), {
      network: 'devnet',
      trusted: true,
      devnetName: 'sakura',
      addresses: ['https://10.0.0.1:1443'],
      settings: { timeoutMs: 1 },
    });
  });
  test('testnet discovers its nodes: the recorded (stale) list is not passed', () => {
    const t = resolveTarget({ network: 'testnet', record: join(scratchDir, 'scratch-testnet.json') }, opts());
    assert.equal(addressesFor(t, {}), undefined);
    assert.deepEqual(sdkOptions(t, { addresses: addressesFor(t, {}) }), { network: 'testnet', trusted: true });
  });
  test('--addresses overrides on any network', () => {
    const t = resolveTarget({ network: 'testnet', record: join(scratchDir, 'scratch-testnet.json') }, opts());
    assert.deepEqual(addressesFor(t, { addresses: 'https://a:1443, https://b:1443' }), ['https://a:1443', 'https://b:1443']);
  });
});

describe('the July pool', () => {
  test('nine ids, each refused on testnet and mainnet, none on a devnet', () => {
    assert.equal(JULY_POOL_IDS.size, 9);
    const testnet = resolveTarget({ network: 'testnet' }, opts());
    const devnet = resolveTarget({}, opts());
    for (const [id, role] of JULY_POOL_IDS) {
      assert.throws(() => assertNotJulyIdentity(testnet, id, 'owner.identity.json'), new RegExp(`July-era testnet ${role}`));
      assert.doesNotThrow(() => assertNotJulyIdentity(devnet, id, 'owner.identity.json'));
    }
    assert.doesNotThrow(() => assertNotJulyIdentity(testnet, 'SomeFreshIdentityId', 'owner.identity.json'));
  });
});

describe('checkFlags', () => {
  const spec = { values: ['network', 'record', 'identities'], bools: ['live-target', 'help'] };
  test('accepts the shapes the tools use', () => {
    assert.doesNotThrow(() => checkFlags(['--network', 'testnet', '--live-target', '--identities', '/x'], spec));
    assert.doesNotThrow(() => checkFlags(['--live-target'], spec));
    assert.doesNotThrow(() => checkFlags([], spec));
  });
  test('rejects what the reducer would misread', () => {
    assert.throws(() => checkFlags(['--network=testnet'], spec), /with a space, not '='/);
    assert.throws(() => checkFlags(['--live-target', 'false'], spec), /takes no value/);
    assert.throws(() => checkFlags(['--network'], spec), /takes a value/);
    assert.throws(() => checkFlags(['--network', '--live-target'], spec), /takes a value/);
    assert.throws(() => checkFlags(['--bogus', '1'], spec), /unknown option --bogus/);
    assert.throws(() => checkFlags(['testnet'], spec), /unexpected argument/);
  });
});

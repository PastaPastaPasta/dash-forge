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
  addressesFor,
  assertNotJulyIdentity,
  checkFlags,
  liveRecordPath,
  refuseProduction,
  requireThreeContract,
  resolveTarget,
  sdkOptions,
  sharesLiveSet,
  validateDevnetName,
} from './target.mjs';

const threeContracts = (core = 'CORE', group = 'GROUP') => ({
  v2: { forgeCore: { contractId: core, contractGroupId: group }, forgeCollab: { contractId: 'COLLAB' }, forgeCommunity: { contractId: 'COMM' }, contractGroupId: group },
});
const fourContracts = (core = 'CORE4', group = 'GROUP4') => {
  const r = threeContracts(core, group);
  r.v2.forgeMeta = { contractId: 'META' };
  return r;
};

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
  write(join(deployments, 'mainnet.json'), { network: 'mainnet', ...fourContracts('MAIN_CORE', 'MAIN_GROUP') });
  write(join(scratchDir, 'scratch-testnet.json'), { network: 'testnet', ...fourContracts('SCRATCH_CORE', 'SCRATCH_GROUP') });
  write(join(scratchDir, 'scratch-testnet-3.json'), { network: 'testnet', ...threeContracts('S3_CORE', 'S3_GROUP') });
  write(join(scratchDir, 'wrong-network.json'), { network: 'devnet', ...fourContracts('W_CORE', 'W_GROUP') });
  write(join(scratchDir, 'mainnet-copy.json'), { network: 'mainnet', ...fourContracts('MAIN_CORE', 'ANOTHER_GROUP') });
  write(join(scratchDir, 'group-copy.json'), { ...fourContracts('NEW_CORE', 'MAIN_GROUP') });
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
    assert.throws(() => refuseProduction(copy), /carries the live mainnet forge-core or contract group/);
    const group = resolveTarget({ network: 'mainnet', record: join(scratchDir, 'group-copy.json') }, opts());
    assert.equal(group.production, true);
    assert.ok(sharesLiveSet(group.record, group.live));
  });
  test('a splice that keeps any live contract counts as live', () => {
    const dep2 = join(dir, 'dep2');
    mkdirSync(dep2);
    const live = { network: 'mainnet', ...fourContracts('M2_CORE', 'M2_GROUP') };
    write(join(dep2, 'mainnet.json'), live);
    const spliced = { network: 'mainnet', ...fourContracts('S2_CORE', 'S2_GROUP') };
    spliced.v2.forgeCommunity.contractId = live.v2.forgeCommunity.contractId; // fresh core and group, the live community
    write(join(scratchDir, 'splice.json'), spliced);
    const t = resolveTarget({ network: 'mainnet', record: join(scratchDir, 'splice.json') }, { deploymentsDir: dep2 });
    assert.equal(t.copiesLive, true);
    assert.equal(t.production, true);
    // and a fully fresh set is not
    write(join(scratchDir, 'fresh.json'), { network: 'mainnet', ...(() => { const r = fourContracts('F_CORE', 'F_GROUP'); r.v2.forgeCollab.contractId = 'F_COLLAB'; r.v2.forgeCommunity.contractId = 'F_COMM'; r.v2.forgeMeta.contractId = 'F_META'; return r; })() });
    assert.equal(resolveTarget({ network: 'mainnet', record: join(scratchDir, 'fresh.json') }, { deploymentsDir: dep2 }).production, false);
  });
  test('a scratch record on a devnet may be a copy: a devnet is not production', () => {
    write(join(scratchDir, 'sakura-copy.json'), { network: 'devnet', ...threeContracts('SAKURA_CORE', 'SAKURA_GROUP') });
    const t = resolveTarget({ record: join(scratchDir, 'sakura-copy.json') }, opts());
    assert.equal(t.copiesLive, true);
    assert.equal(t.production, false);
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
  test('a four-contract record is refused by the three-contract tools', () => {
    const four = resolveTarget({ network: 'testnet', record: join(scratchDir, 'scratch-testnet.json') }, opts());
    assert.throws(() => requireThreeContract(four, 'rc1-live'), /four-contract set.*QA-03.*mv-live/);
    const three = resolveTarget({ network: 'testnet', record: join(scratchDir, 'scratch-testnet-3.json') }, opts());
    assert.doesNotThrow(() => requireThreeContract(three, 'rc1-live'));
    assert.equal(three.fourContract, false);
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

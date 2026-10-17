// node --test forge-contracts/scripts/p4-registration.test.mjs
//
// The P4 registration script against a fake four-contract testnet record (written by the real
// deploy-v2.mjs on the fake platform, lib/fake-platform.mjs) in a temp repo layout, with the tools it
// calls replaced by a recording `exec`: its refusals, its dry run, its order, and that a rerun changes nothing.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { SETS, formatSums, main as deploy, setSums } from './deploy-v2.mjs';
import { createFakePlatform } from './lib/fake-platform.mjs';
import { c1ReportProblems, main, recordProblems, wireRegistrations, wireSnapshot } from './p4-registration.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED = {
  dapiAddresses: ['https://68.67.122.1:1443', 'https://68.67.122.2:1443'],
  keyExchange: { contractId: '7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P', ownerId: 'hbGEcFcXKJ2W9Di24ekiozTWfFszrjqkxbjfEep3D8A', note: 'yappr' },
};
const BUILD_PY = "# stub\nNETWORK_REGISTRATIONS = {}\nCONTRACTS = 'x'\n";
const dirs = [];
let deployed; // a registered testnet record from the real deploy-v2 on the fake platform

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p4-record-'));
  dirs.push(dir);
  const root = join(dir, 'deployments');
  mkdirSync(root);
  writeFileSync(join(root, 'testnet.json'), `${JSON.stringify(SEED)}\n`);
  const fake = createFakePlatform({});
  const identity = fake.writeIdentity(dir);
  const sums = join(dir, 'sums.txt');
  writeFileSync(sums, formatSums(setSums(SETS.mainnet)));
  let tick = 0;
  await deploy(['--network', 'testnet', '--set', 'mainnet', '--identity', identity, '--expect-sha256', sums], {
    evo: fake.evo,
    git: { head: () => 'a'.repeat(40), porcelain: () => '', pushed: () => true, buildCheck: () => ({ ok: true, output: '' }) },
    now: () => new Date(Date.UTC(2026, 9, 20, 12, 0, tick++)),
    log: () => {},
    print: () => {},
    deploymentsRoot: root,
    sdkId: '@dashevo/evo-sdk@5.0.0-rc.3',
    settleMs: 0,
    settleTries: 1,
  });
  deployed = JSON.parse(readFileSync(join(root, 'testnet.json'), 'utf8'));
});
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const clone = (x) => JSON.parse(JSON.stringify(x));

/** A temp repo layout with the tools stubbed out, the seed table of the real contract-seed.ts and a record. */
function layout({ record = deployed, tools = true, buildPy = BUILD_PY, libTests = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'p4-root-'));
  dirs.push(root);
  const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  if (record) put('forge-contracts/deployments/testnet.json', `${JSON.stringify(record, null, 2)}\n`);
  put('forge-contracts/schema/build.py', buildPy);
  mkdirSync(join(root, 'forge-web/lib/sdk'), { recursive: true });
  copyFileSync(join(REPO, 'forge-web/lib/sdk/contract-seed.ts'), join(root, 'forge-web/lib/sdk/contract-seed.ts'));
  put('contract-validate', '');
  if (tools) {
    for (const f of ['freeze-registered.mjs', 'validate-registered.sh', 'check-release-network.mjs', 'refresh-dapi.mjs', 'freeze-c1-check.mjs', 'snapshot-contracts.mjs']) put(`forge-contracts/scripts/${f}`, '');
    if (libTests) put('forge-contracts/scripts/lib/deployments.test.mjs', '');
    else mkdirSync(join(root, 'forge-contracts/scripts/lib'), { recursive: true });
  }
  return root;
}

const RN_OK = 'release network check: ok (v0.2.0-rc.1, publish=true)';
const RN_DEVNET = '::warning::a final release\'s web build targets devnet-sakura (forge-web/scripts/ipfs-release.sh RELEASE_NETWORK); switch it to testnet first (M-IPFS).';
const RN_UNDEPLOYED = '::warning::v0.2.0-rc.1 would be refused as a final release, but forge-contracts/deployments/testnet.json has no registered forge-v2 set (it records no forge-v2 deployment): CLIE-02';

/**
 * An `exec` that records what would run. `fail`: the first command containing it exits 1. `git`: the result of
 * rev-parse. `jq`: whether jq exists. `rn`: what check-release-network prints.
 */
function recorder({ branch = 'rel1/p4-registration', gitStatus = 0, jq = 0, fail, rn = RN_DEVNET } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (cmd === 'git') return { status: gitStatus, stdout: gitStatus === 0 ? `${branch}\n` : '' };
    if (cmd === 'jq') return { status: jq, stdout: '' };
    calls.push(line);
    if (fail && line.includes(fail)) return { status: 1, stdout: '' };
    if (line.includes('freeze-registered.mjs')) {
      return { status: 0, stdout: "wrote registered/testnet/forge-core.v1.json\n\nAdd to NETWORK_REGISTRATIONS in forge-contracts/schema/build.py (then run build.py --check):\n  'testnet': {'set': 'mainnet', 'since': ()},\n" };
    }
    if (line.includes('check-release-network.mjs')) return { status: 0, stdout: `${rn}\n` };
    return { status: 0, stdout: '' };
  };
  return { calls, exec };
}

/** Run main() in `root` with the recording exec; the validator stub is always given. */
const run = (root, argv, over = {}) => {
  const out = [];
  const logs = [];
  const r = recorder(over);
  const args = argv.includes('--contract-validate') ? argv : [...argv, '--contract-validate', join(root, 'contract-validate')];
  return main(args, { root, exec: r.exec, print: (m) => out.push(m), log: (m) => logs.push(m), tmp: root })
    .then((res) => ({ res, out, logs, calls: r.calls }));
};
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const rejects = (promise, re) => assert.rejects(promise, re);
const passingReport = (root, over = {}) => {
  const file = join(root, 'c1-report.json');
  writeFileSync(file, JSON.stringify({ record: deployed.v2, results: [{ contract: 'forge-core', name: 'registered on chain', pass: true }], ...over }));
  return file;
};

test('the record from deploy-v2 --set mainnet is a complete registration', () => {
  assert.deepEqual(recordProblems(deployed), []);
});

test('it refuses a record that is not a complete testnet registration, naming why', () => {
  const mutate = (fn) => { const d = clone(deployed); fn(d); return recordProblems(d); };
  const has = (problems, re) => assert.ok(problems.some((p) => re.test(p)), `${re}: ${problems.join(' | ')}`);
  has(recordProblems(SEED), /no forge-v2 registration/);
  has(mutate((d) => { d.v2.contractsSet = 'devnet'; }), /contractsSet/);
  has(mutate((d) => { delete d.v2.forgeMeta; }), /forgeMeta is not recorded/);
  has(mutate((d) => { d.v2.forgeCommunity.status = 'broadcasting'; }), /forgeCommunity is broadcasting|half-finished|not a complete/);
  has(mutate((d) => { d.chainId = 'dash-devnet-sakura'; }), /chainId/);
  has(mutate((d) => { d.network = 'devnet'; }), /network is/);
  has(mutate((d) => { d.v2.contractGroup.admins = ['someone']; }), /admins/);
  has(mutate((d) => { d.v2.contractGroup.owner = 'other'; }), /group owner/);
  has(mutate((d) => { d.v2.forgeCollab.ownerId = 'other'; }), /more than one owner/);
  has(mutate((d) => { delete d.v2.forgeCore.sourceSha256; }), /no sourceSha256/);
  has(mutate((d) => { d.v2.nonceLedger = d.v2.nonceLedger.slice(0, 3); }), /nonce ledger has no registered create entry for forgeMeta/);
  has(mutate((d) => { d.dapiAddresses = []; }), /dapiAddresses is empty/);
  has(mutate((d) => { d.retired = true; }), /retired/);
  has(mutate((d) => { d.v2.forgeCollab.contractGroupId = 'otherGroup'; }), /forgeCollab records group otherGroup/);
  has(mutate((d) => { d.v2.forgeMeta.contractId = d.v2.forgeCore.contractId; }), /share one contract id/);
  has(mutate((d) => { d.v2.forgeMeta.pendingUpdate = { version: 2 }; }), /forgeMeta has a pending update/);
  has(mutate((d) => { delete d.v2.forgeCore.provedAt; }), /forgeCore records no provedAt\.height/);
  has(mutate((d) => { d.v2.deployer.identityId = 'someoneElse'; }), /deployer\.identityId someoneElse/);
  has(mutate((d) => { d.v2.nonceLedger[1].contractId = 'wrong'; }), /ledger's create entry for forgeCollab names wrong/);
  has(mutate((d) => { d.v2.nonceLedger.push({ identityNonce: '5', kind: 'dataContractUpdate', key: 'forgeCore', status: 'broadcasting' }); }), /still "broadcasting"/);
});

test('a run on today\'s undeployed testnet.json is refused, dry or not, and touches nothing', async () => {
  const root = layout({ record: SEED });
  for (const argv of [[], ['--dry-run']]) {
    const r = recorder();
    await rejects(main(argv, { root, exec: r.exec, print: () => {}, log: () => {} }), /not a complete testnet registration/);
    assert.deepEqual(r.calls, []);
  }
  const none = layout({ record: null });
  await rejects(main([], { root: none, exec: recorder().exec, print: () => {}, log: () => {} }), /registration \(P3\) has not written it/);
});

test('the committed testnet.json is incomplete today and must be a complete registration once it has a v2', () => {
  const committed = JSON.parse(readFileSync(join(REPO, 'forge-contracts/deployments/testnet.json'), 'utf8'));
  const problems = recordProblems(committed);
  if (committed.v2) assert.deepEqual(problems, [], 'testnet is registered: the committed record must be complete'); // after P4
  else assert.ok(problems.length > 0);
});

test('a real run refuses off the registration branch, with a missing tool, and with bad options', async () => {
  const root = layout();
  for (const over of [{ branch: 'master' }, { branch: 'main' }, { branch: 'HEAD' }, { gitStatus: 128 }]) {
    await rejects(run(root, [], over), /not on a registration branch/);
  }
  await rejects(run(layout({ tools: false }), []), /merge the prerequisite PRs.*freeze-registered\.mjs \(from #528.*refresh-dapi\.mjs \(from #521/);
  await rejects(run(layout({ buildPy: '# no table yet\n' }), []), /NETWORK_REGISTRATIONS in forge-contracts\/schema\/build\.py/);
  await rejects(run(root, [], { jq: 1 }), /jq \(validate-registered\.sh needs it\)/);
  await rejects(main(['--contract-validate', join(root, 'nope')], { root, exec: recorder().exec, print: () => {}, log: () => {} }), /the contract-validate binary at .*nope/);
  await rejects(run(root, ['--record', join(root, 'forge-contracts/deployments/testnet.json')]), /--record is for a --dry-run/);
  await rejects(run(root, ['--skip', 'bogus']), /--skip bogus/);
  await rejects(run(root, ['--nope']), /unknown option --nope/);
  await rejects(run(root, ['--dry-run', 'x']), /--dry-run takes no value/);
});

test('--dry-run prints the plan in order and changes nothing, not even a report directory', async () => {
  const root = layout();
  const files = ['forge-contracts/schema/build.py', 'forge-web/lib/sdk/contract-seed.ts', 'forge-contracts/deployments/testnet.json'];
  const before = files.map((f) => read(root, f));
  const reportDir = join(root, 'new-report-dir');
  const { out, calls } = await run(root, ['--dry-run', '--report', join(reportDir, 'c1.json')]);
  assert.deepEqual(calls, [], 'a dry run executes nothing');
  assert.deepEqual(files.map((f) => read(root, f)), before);
  assert.equal(existsSync(reportDir), false);
  const text = out.join('\n');
  const order = ['-- dapi', '-- c1', '-- snapshot', '-- freeze', '-- verify'].map((s) => text.indexOf(s));
  assert.ok(order.every((i) => i >= 0) && [...order].sort((a, b) => a - b).join() === order.join(), `steps in order: ${order}`);
  for (const needle of ['refresh-dapi.mjs --network testnet --write', 'refresh-dapi.mjs --network testnet --check', 'freeze-c1-check.mjs', 'snapshot-contracts.mjs --network testnet', 'freeze-registered.mjs --network testnet', 'would edit forge-web/lib/sdk/contract-seed.ts', 'would edit forge-contracts/schema/build.py', 'fixtures/testnet.json', 'git -C']) {
    assert.ok(text.includes(needle), `dry run mentions ${needle}`);
  }
});

test('a dry run against a scratch record says what a real run lacks instead of refusing for it', async () => {
  const bare = layout({ tools: false, buildPy: '# none\n' });
  const { logs, out } = await run(bare, ['--dry-run', '--record', join(bare, 'forge-contracts/deployments/testnet.json')], { branch: 'master', jq: 1 });
  assert.ok(logs.some((l) => /PREREQUISITES MISSING/.test(l) && /#528/.test(l) && /#521/.test(l) && /jq/.test(l)));
  assert.ok(logs.some((l) => /a real run refuses here: not on a registration branch/.test(l)));
  assert.ok(out.join('\n').includes('-- verify'));
});

test('a real run goes dapi, c1, snapshot, freeze, verify; edits SNAPSHOTS and NETWORK_REGISTRATIONS; a rerun changes nothing', async () => {
  const root = layout();
  const first = await run(root, []);
  assert.equal(first.res.ok, true);
  const names = ['refresh-dapi.mjs --network testnet --write', 'refresh-dapi.mjs --network testnet --check', 'freeze-c1-check.mjs', 'snapshot-contracts.mjs --network testnet', 'freeze-registered.mjs --network testnet', 'build.py --check', 'validate-registered.sh', '--test', 'check-release-network.mjs --version 0.2.0-rc.1 --publish true'];
  const at = names.map((n) => first.calls.findIndex((c) => c.includes(n)));
  assert.ok(at.every((i) => i >= 0), `every command ran: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in order');
  const c1 = first.calls.find((c) => c.includes('freeze-c1-check.mjs'));
  assert.match(c1, /--record \S*testnet\.json --contracts \S*contracts\/mainnet --network testnet --report /);
  assert.match(read(root, 'forge-web/lib/sdk/contract-seed.ts'), /testnet: \(\) => import\('\.\.\/\.\.\/\.\.\/forge-contracts\/deployments\/contracts\/testnet\.json'\),/);
  assert.match(read(root, 'forge-contracts/schema/build.py'), /NETWORK_REGISTRATIONS = \{\n    'testnet': \{'set': 'mainnet', 'since': \(\)\},\n\}/);
  const after1 = { build: read(root, 'forge-contracts/schema/build.py'), seed: read(root, 'forge-web/lib/sdk/contract-seed.ts') };
  const second = await run(root, []);
  assert.equal(read(root, 'forge-contracts/schema/build.py'), after1.build, 'build.py is not edited twice');
  assert.equal(read(root, 'forge-web/lib/sdk/contract-seed.ts'), after1.seed, 'SNAPSHOTS is not edited twice');
  assert.deepEqual(second.calls, first.calls, 'a rerun runs the same commands');
  assert.equal(second.out.filter((l) => l.includes('already has it')).length, 2);
  assert.equal(second.res.ok, true);
});

test('a failing step stops the run before the steps after it', async () => {
  for (const [fail, later] of [['--write', ['freeze-c1-check', 'snapshot-contracts', 'freeze-registered']], ['freeze-c1-check.mjs', ['snapshot-contracts', 'freeze-registered']], ['snapshot-contracts', ['freeze-registered']], ['freeze-registered', ['build.py']]]) {
    const root = layout();
    const before = read(root, 'forge-contracts/schema/build.py');
    const r = recorder({ fail });
    await rejects(main(['--contract-validate', join(root, 'contract-validate')], { root, exec: r.exec, print: () => {}, log: () => {}, tmp: root }), /step failed \(exit 1\)/);
    for (const l of later) assert.ok(!r.calls.some((c) => c.includes(l)), `${l} did not run after ${fail} failed`);
    if (fail !== 'freeze-registered') assert.equal(read(root, 'forge-contracts/schema/build.py'), before);
  }
});

test('--skip leaves steps out', async () => {
  const root = layout();
  const { calls, out } = await run(root, ['--skip', 'dapi,c1,snapshot,verify', '--report', passingReport(root)]);
  assert.deepEqual(calls.map((c) => c.replace(/^\S+ \S*\//, '').split(' ')[0]), ['freeze-registered.mjs']);
  assert.ok(out.join('\n').includes('-- dapi: skipped'));
});

test('--skip c1 needs a passing C1 report for this very record before it snapshots or freezes', async () => {
  const root = layout();
  await rejects(run(root, ['--skip', 'c1', '--report', join(root, 'missing.json')]), /needs the C1 report of an earlier run.*does not exist/);
  await rejects(run(root, ['--skip', 'c1', '--report', passingReport(root, { results: [{ contract: 'forge-meta', name: 'owner', pass: false }] })]), /1 check\(s\) failed \(forge-meta: owner\)/);
  await rejects(run(root, ['--skip', 'c1', '--report', passingReport(root, { record: { ...deployed.v2, forgeMeta: { contractId: 'other' } } })]), /made for another forgeMeta id/);
  const bad = join(root, 'junk.json');
  writeFileSync(bad, 'not json');
  await rejects(run(root, ['--skip', 'c1', '--report', bad]), /is not JSON/);
  const ok = await run(root, ['--skip', 'c1', '--report', passingReport(root)]);
  assert.ok(ok.calls.some((c) => c.includes('freeze-registered')));
  // skipping everything that depends on C1 as well needs no report
  const none = await run(root, ['--skip', 'c1,snapshot,freeze']);
  assert.ok(!none.calls.some((c) => c.includes('freeze-registered')));
  assert.deepEqual(c1ReportProblems({ results: [] }, deployed.v2), ['it holds no check results']);
});

test('the release-network check must find testnet deployed (its devnet finding is expected)', async () => {
  const root = layout();
  const fine = await run(root, [], { rn: `${RN_DEVNET}\n${RN_OK}` });
  assert.equal(fine.res.ok, true);
  await rejects(run(root, [], { rn: RN_UNDEPLOYED }), /still finds testnet\.json without a registered forge-v2 set/);
});

test('without lib/deployments.test.mjs (the record self-check from #528) verify has nothing to prove the record with', async () => {
  await rejects(run(layout({ libTests: false }), []), /deployments\.test\.mjs \(from #528/);
});

test('an edit left for a human fails the run (exit 1) even when every step passed', async () => {
  const root = layout({ buildPy: "NETWORK_REGISTRATIONS = {'mainnet': {'set': 'mainnet', 'since': ()}}\n" });
  const { res, logs } = await run(root, []);
  assert.equal(res.ok, false);
  assert.ok(res.manual[0].includes('add this line yourself'));
  assert.ok(logs.some((l) => l.startsWith('NOT DONE, by hand')));
});

test('wireSnapshot adds the entry once, to the real contract-seed.ts', () => {
  const text = readFileSync(join(REPO, 'forge-web/lib/sdk/contract-seed.ts'), 'utf8');
  const a = wireSnapshot(text);
  const has = /^\s*['"]?testnet['"]?:\s*\(\)\s*=>/m.test(text);
  assert.equal(a.changed, !has);
  const b = wireSnapshot(a.text);
  assert.equal(b.changed, false);
  assert.equal(b.text, a.text);
  assert.throws(() => wireSnapshot('export const nothing = 1\n'), /cannot find the SNAPSHOTS table/);
  // a mention in a comment is not the entry; a quoted key is
  const table = (inner) => `/** testnet: later */\nconst SNAPSHOTS: Readonly<Record<string, () => Promise<{ default: X }>>> = {\n${inner}}\n`;
  const withComment = table("  // testnet: not yet\n  'devnet-sakura': () => import('a.json'),\n");
  assert.equal(wireSnapshot(withComment).changed, true);
  assert.equal(wireSnapshot(table("  'testnet': () => import('t.json'),\n")).changed, false);
});

test('wireRegistrations fills the empty table, keeps an existing entry, and leaves other shapes to a human', () => {
  const entry = "'testnet': {'set': 'mainnet', 'since': ()},";
  const a = wireRegistrations('A = 1\nNETWORK_REGISTRATIONS = {}\nB = 2\n', entry);
  assert.equal(a.text, `A = 1\nNETWORK_REGISTRATIONS = {\n    ${entry}\n}\nB = 2\n`);
  assert.equal(wireRegistrations(a.text, entry).changed, false);
  assert.match(wireRegistrations("NETWORK_REGISTRATIONS = {'mainnet': {'set': 'mainnet', 'since': ()}}\n", entry).manual, /add this line yourself/);
  assert.match(wireRegistrations('X = 1\n', entry).manual, /not in build\.py/);
  // an entry after a nested dict is still found
  const both = "NETWORK_REGISTRATIONS = {\n    'mainnet': {'set': 'mainnet', 'since': ()},\n    'testnet': {'set': 'mainnet', 'since': ()},\n}\n";
  assert.deepEqual({ changed: wireRegistrations(both, entry).changed, manual: wireRegistrations(both, entry).manual }, { changed: false, manual: undefined });
  assert.match(wireRegistrations('NETWORK_REGISTRATIONS = {\n', entry).manual, /not closed/);
});

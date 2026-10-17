#!/usr/bin/env node
// p4-registration.mjs -- the data steps of the P4 registration PR, run mechanically AFTER the owner's
// permanent testnet registration (P3) has written forge-contracts/deployments/testnet.json
// (release plan 2.7 step 1; WS-B spec 8.2).
//
//   node forge-contracts/scripts/p4-registration.mjs --dry-run                 print the plan, change nothing
//   node forge-contracts/scripts/p4-registration.mjs                           run it, on the registration branch
//   node forge-contracts/scripts/p4-registration.mjs --dry-run --record <file> preview against a scratch record
//   options: --skip dapi,c1,snapshot,freeze,verify   leave steps out (a partly offline run, a rerun)
//            --contract-validate <bin>               the contract-validate binary validate-registered.sh runs
//                                                    (default $CARGO_TARGET_DIR/release/contract-validate, else
//                                                    target/release/contract-validate)
//            --report <file>                         where the C1 report goes (default: the temp dir)
//
// P4 ORDER OF OPERATIONS (this script does 2-8; the rest is by hand, listed again when it ends)
//   1. [OWNER, P3] deploy-v2.mjs --network testnet --set mainnet --expect-sha256 <signed sums> wrote the v2 record.
//      Copy deployments/testnet.json byte for byte into this branch (if P3 ran in another checkout).
//   2. dapi      refresh-dapi.mjs --network testnet --write, then --check: PV14-only seeds, no 206.245.167.63
//                (M-DAPI). First, so freeze-c1-check.mjs, which hands the recorded list to the SDK, never draws a
//                stale node. (snapshot-contracts.mjs uses SDK discovery on testnet and ignores the list.)
//   3. c1        freeze-c1-check.mjs: the four registered contracts equal contracts/mainnet, ids substituted
//                (read-only; P3 step 4). A failure stops the run: do not freeze what is not what was signed.
//   4. snapshot  snapshot-contracts.mjs --network testnet -> deployments/contracts/testnet.json, and `testnet`
//                added to forge-web contract-seed SNAPSHOTS (CONT-13, WEB-09).
//   5. freeze    freeze-registered.mjs --network testnet -> contracts/registered/testnet/*.v1.json, and the
//                NETWORK_REGISTRATIONS entry in build.py (CONT-03; tell rel1-freeze).
//   6. verify    build.py --check; validate-registered.sh; node --test forge-contracts/scripts/lib/*.test.mjs
//                (deployments.test.mjs checks the record); check-release-network.mjs for 0.2.0-rc.1, which must
//                find testnet deployed (its devnet RELEASE_NETWORK finding is expected until the switch PR).
//   7. [BY HAND] fixtures/testnet.json: seed-v2-fixture.mjs --network testnet --production testnet with a
//                labelled FORGE-QA identity (QA-14). Blocked until the seed scripts write the four-contract
//                (mainnet) shapes (WS-D).
//   8. [BY HAND] the checks that need a toolchain: cargo test -p dg -p forge-core -p git-remote-dash,
//                pnpm test in forge-web, `dg doctor --network testnet` (names four contracts, the group and meta=).
//   9. [BY HAND] git add the named paths (the script prints them), commit, fill in the PR body
//                (docs/ placeholders: ids, group, signed sha256s, provedAt heights), open the PR.
//
// Prerequisites that must be merged first: #520 (B2, the v2 record), #528 (B4: freeze-registered.mjs,
// validate-registered.sh, check-release-network.mjs, NETWORK_REGISTRATIONS in build.py), #521 (B5:
// refresh-dapi.mjs). Without them a real run refuses and a dry run says what is missing.
//
// It refuses to run (even with --dry-run) unless the record is a complete v2 record: forgeCore, forgeCollab,
// forgeCommunity and forgeMeta registered by deploy-v2 --set mainnet, contractsSet "mainnet", a testnet
// chainId, one owner, a contract group owned by it with no admins. A real run also refuses off the registration
// branch (master, main, a detached HEAD, or git failing), while a prerequisite tool, the contract-validate
// binary or jq is missing, and when --skip c1 would freeze without a passing C1 report for this record.
//
// Idempotent: a rerun after a partial failure just continues. The edits to contract-seed.ts and build.py see
// their change already in place; freeze-registered.mjs leaves identical files alone; refresh-dapi and
// snapshot-contracts re-read the network, so their output follows it. The network is only read; nothing is
// written to one. The script never stages or commits.
// Exit 0 when every step ran and nothing is left for a human in the files; 1 otherwise (a MANUAL line says what).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CHAIN_IDS, META_CONTRACT, DEPENDENT_CONTRACTS, parseArgs } from './deploy-v2.mjs';
import { incompleteReason } from './snapshot-contracts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const NETWORK = 'testnet';
export const STEPS = ['dapi', 'c1', 'snapshot', 'freeze', 'verify'];
const KEYS = ['forgeCore', ...DEPENDENT_CONTRACTS.map((c) => c.key), META_CONTRACT.key];

const REL = {
  record: 'forge-contracts/deployments/testnet.json',
  snapshot: 'forge-contracts/deployments/contracts/testnet.json',
  set: 'forge-contracts/contracts/mainnet',
  registered: 'forge-contracts/contracts/registered/testnet',
  buildPy: 'forge-contracts/schema/build.py',
  seedTs: 'forge-web/lib/sdk/contract-seed.ts',
  scripts: 'forge-contracts/scripts',
};
/** Tools this script calls and the PR that brings each (merge those first). */
const PREREQUISITES = [
  [`${REL.scripts}/freeze-registered.mjs`, '#528 (B4)'],
  [`${REL.scripts}/validate-registered.sh`, '#528 (B4)'],
  [`${REL.scripts}/check-release-network.mjs`, '#528 (B4)'],
  [`${REL.scripts}/lib/deployments.test.mjs`, '#528 (B4)'],
  [`${REL.scripts}/refresh-dapi.mjs`, '#521 (B5)'],
  [`${REL.scripts}/freeze-c1-check.mjs`, 'master (rel1-freeze)'],
  [`${REL.scripts}/snapshot-contracts.mjs`, 'master'],
];

/** Why a record is not a complete P3 registration (empty when it is). */
export function recordProblems(dep) {
  const p = [];
  if (!dep || typeof dep !== 'object') return ['the record is not a JSON object'];
  if (!dep.v2) return ['it records no forge-v2 registration (P3 has not written it)'];
  if (dep.retired) p.push('the record is marked retired');
  if (dep.network !== NETWORK) p.push(`network is ${JSON.stringify(dep.network)}, not "${NETWORK}"`);
  if (!CHAIN_IDS.testnet.test(String(dep.chainId ?? ''))) p.push(`chainId ${JSON.stringify(dep.chainId)} is not a dash-testnet-<n> chain`);
  const v2 = dep.v2;
  if (v2.contractsSet !== 'mainnet') p.push(`v2.contractsSet is ${JSON.stringify(v2.contractsSet)}, not "mainnet" (the four-contract set)`);
  const incomplete = incompleteReason(dep);
  if (incomplete) p.push(`not a complete deployment: ${incomplete}`);
  for (const key of KEYS) {
    const c = v2[key];
    if (!c) { p.push(`${key} is not recorded (a four-contract record has forgeCore, forgeCollab, forgeCommunity and forgeMeta)`); continue; }
    if (c.status !== 'registered' || !c.contractId) p.push(`${key} is ${c.status ?? 'not registered'}`);
    for (const f of ['ownerId', 'sourceFile', 'sourceSha256', 'registeredSchemaHash']) {
      if (!c[f]) p.push(`${key} records no ${f} (it was not registered by deploy-v2 --set mainnet)`);
    }
  }
  const ids = KEYS.map((k) => v2[k]?.contractId).filter(Boolean);
  if (new Set(ids).size !== ids.length) p.push('two contracts share one contract id');
  for (const key of KEYS) {
    const c = v2[key];
    if (!c) continue;
    if (c.contractGroupId !== v2.contractGroupId) p.push(`${key} records group ${c.contractGroupId}, not v2.contractGroupId ${v2.contractGroupId}`);
    if (c.pendingUpdate) p.push(`${key} has a pending update`);
    if (!c.provedAt?.height) p.push(`${key} records no provedAt.height (the PR body lists it)`);
    const entry = (v2.nonceLedger ?? []).find((e) => e.kind === 'dataContractCreate' && e.key === key && e.status === 'registered');
    if (entry && entry.contractId !== c.contractId) p.push(`the ledger's create entry for ${key} names ${entry.contractId}, not ${c.contractId}`);
  }
  if ((v2.nonceLedger ?? []).some((e) => e.status === 'broadcasting')) p.push('the nonce ledger has a transition still "broadcasting"');
  const owners = new Set(KEYS.map((k) => v2[k]?.ownerId).filter(Boolean));
  if (owners.size > 1) p.push(`the contracts have more than one owner (${[...owners].join(', ')})`);
  const owner = [...owners][0];
  if (v2.deployer?.identityId !== owner) p.push(`v2.deployer.identityId ${v2.deployer?.identityId} is not the contracts' owner ${owner}`);
  const g = v2.contractGroup;
  if (!g) p.push('v2.contractGroup (the verified group) is not recorded');
  else {
    if (g.id !== v2.contractGroupId) p.push(`v2.contractGroup.id ${g.id} differs from v2.contractGroupId ${v2.contractGroupId}`);
    if (owner && g.owner !== owner) p.push(`the group owner ${g.owner} is not the contracts' owner ${owner}`);
    if (!Array.isArray(g.admins) || g.admins.length !== 0) p.push(`the group has admins (${JSON.stringify(g.admins)}); Forge clients refuse that`);
  }
  const created = new Set((v2.nonceLedger ?? []).filter((e) => e.kind === 'dataContractCreate' && e.status === 'registered').map((e) => e.key));
  for (const key of KEYS) if (!created.has(key)) p.push(`the nonce ledger has no registered create entry for ${key}`);
  if (!Array.isArray(dep.dapiAddresses) || dep.dapiAddresses.length === 0) p.push('dapiAddresses is empty');
  return p;
}

/** Add `testnet` to the SNAPSHOTS table of contract-seed.ts. Returns { text, changed }. */
export function wireSnapshot(text) {
  const m = /(const SNAPSHOTS\b[^\n]*=\s*\{\n)((?:[ \t]+[^\n]*\n)*?)(\}\n)/.exec(text);
  if (!m) throw new Error('cannot find the SNAPSHOTS table in contract-seed.ts: add the testnet entry by hand');
  // (inside the table only, comments excluded: a mention of testnet in a comment is not the entry)
  const body = m[2].split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  if (/(^|\s)['"]?testnet['"]?\s*:/m.test(body)) return { text, changed: false };
  const entry = "  testnet: () => import('../../../forge-contracts/deployments/contracts/testnet.json'),\n";
  return { text: text.slice(0, m.index) + m[1] + m[2] + entry + m[3] + text.slice(m.index + m[0].length), changed: true };
}

/**
 * Add the `testnet` entry to build.py's NETWORK_REGISTRATIONS. Handles the empty table `{}` (the shape B4
 * ships) and a table that already holds the entry; anything else is left for a human.
 */
export function wireRegistrations(text, entry) {
  const head = /^NETWORK_REGISTRATIONS\s*=\s*\{/m.exec(text);
  if (!head) return { text, changed: false, manual: 'NETWORK_REGISTRATIONS is not in build.py (is #528 merged?)' };
  let depth = 1;
  let end = head.index + head[0].length;
  for (; end < text.length && depth > 0; end++) depth += text[end] === '{' ? 1 : text[end] === '}' ? -1 : 0;
  if (depth !== 0) return { text, changed: false, manual: `NETWORK_REGISTRATIONS is not closed in build.py; add this line yourself: ${entry}` };
  const inner = text.slice(head.index + head[0].length, end - 1);
  if (/['"]testnet['"]\s*:/.test(inner)) return { text, changed: false };
  if (inner.trim() !== '') return { text, changed: false, manual: `NETWORK_REGISTRATIONS already holds entries; add this line yourself: ${entry}` };
  return { text: text.slice(0, head.index) + `NETWORK_REGISTRATIONS = {\n    ${entry}\n}` + text.slice(end), changed: true };
}

const defaultExec = (cmd, args, { cwd, capture = false } = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', env: process.env });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
};

/**
 * Why a C1 report (freeze-c1-check.mjs --report) does not vouch for this record's contracts (empty when it does):
 * every check passed and the report was made for the same four contract ids.
 */
export function c1ReportProblems(report, v2) {
  const p = [];
  if (!report || !Array.isArray(report.results) || report.results.length === 0) return ['it holds no check results'];
  const failed = report.results.filter((r) => !r.pass);
  if (failed.length) p.push(`${failed.length} check(s) failed (${failed[0].contract}: ${failed[0].name})`);
  for (const key of KEYS) {
    if (report.record?.[key]?.contractId !== v2[key]?.contractId) p.push(`it was made for another ${key} id`);
  }
  return p;
}

/** The manual items and paths to add; printed at the end of every run. */
export function afterwards(root) {
  const paths = [REL.record, REL.snapshot, `${REL.registered}/forge-{core,collab,community,meta}.v1.json`, REL.buildPy, REL.seedTs];
  return [
    'DONE by this script; still BY HAND:',
    `  git add (named paths only, never -A):  git -C ${root} add ${paths.join(' ')}`,
    '  fixtures/testnet.json: seed-v2-fixture.mjs --network testnet --production testnet --identities <FORGE-QA>',
    '      (QA-14; blocked until the seed scripts write the four-contract/mainnet shapes, WS-D). Add the file in the same PR.',
    '  toolchain checks: cargo test -p dg -p forge-core -p git-remote-dash   (df -h first; shared CARGO_TARGET_DIR)',
    '                    (cd forge-web && pnpm lint && pnpm typecheck && pnpm test)',
    '                    dg doctor --network testnet   (four contracts, the group and meta=)',
    '  commit (conventional message) and fill in the PR body placeholders: ids, group, signed sha256s, provedAt heights.',
    '  tell rel1-freeze: NETWORK_REGISTRATIONS now has testnet; every later flag change needs it in `since`.',
    '  the switch PR (RELEASE_NETWORK, pages.yml, actions, docs, version), PAGES_NETWORK=devnet before it merges (release plan 2.7 steps 2-5) are separate.',
    '  check-release-network.mjs --version 0.2.0 --publish true still fails until the switch PR moves RELEASE_NETWORK (by design).',
  ].join('\n');
}

/**
 * Run the plan. `injected`: { root, exec, log, print, tmp } for tests. Returns { ok, steps, manual }:
 * ok is false when an edit was left for a human.
 */
export async function main(argv = process.argv.slice(2), injected = {}) {
  const root = injected.root ?? REPO_ROOT;
  const exec = injected.exec ?? defaultExec;
  const log = injected.log ?? ((m) => console.error(m));
  const print = injected.print ?? ((m) => console.log(m));
  const a = parseArgs(argv);
  const known = new Set(['dry-run', 'record', 'skip', 'contract-validate', 'report']);
  for (const k of Object.keys(a)) if (!known.has(k)) throw new Error(`unknown option --${k}`);
  for (const k of ['record', 'skip', 'contract-validate', 'report']) if (a[k] === true) throw new Error(`--${k} takes a value`);
  if (a['dry-run'] !== undefined && a['dry-run'] !== true) throw new Error(`--dry-run takes no value (got "${a['dry-run']}")`);
  const dry = a['dry-run'] === true;
  const skip = new Set(a.skip ? String(a.skip).split(',') : []);
  for (const s of skip) if (!STEPS.includes(s)) throw new Error(`--skip ${s}: steps are ${STEPS.join(', ')}`);
  if (a.record !== undefined && !dry) throw new Error('--record is for a --dry-run preview of a scratch record; a real run always reads ' + REL.record);

  // 1. refusals: the record first, then (real run) the branch and the tools
  const recordFile = a.record !== undefined ? resolve(String(a.record)) : join(root, REL.record);
  if (!existsSync(recordFile)) throw new Error(`${recordFile} does not exist: the owner's registration (P3) has not written it`);
  const dep = JSON.parse(readFileSync(recordFile, 'utf8'));
  const problems = recordProblems(dep);
  if (problems.length) throw new Error(`${relative(root, recordFile) || recordFile} is not a complete testnet registration (nothing was changed):\n  - ${problems.join('\n  - ')}`);

  const missing = PREREQUISITES.filter(([f]) => !existsSync(join(root, f))).map(([f, pr]) => `${f} (from ${pr})`);
  const buildPy = existsSync(join(root, REL.buildPy)) ? readFileSync(join(root, REL.buildPy), 'utf8') : '';
  if (!/^NETWORK_REGISTRATIONS\s*=/m.test(buildPy)) missing.push(`NETWORK_REGISTRATIONS in ${REL.buildPy} (from #528 (B4))`);
  const git = exec('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
  const branch = git.stdout.trim();
  const offBranch = git.status !== 0 || ['', 'HEAD', 'master', 'main'].includes(branch)
    ? `not on a registration branch (${git.status !== 0 ? 'git failed' : branch || 'no branch name'}): run this on rel1/p4-registration, never on master or a detached HEAD`
    : null;
  const validator = a['contract-validate'] ? resolve(String(a['contract-validate'])) : join(process.env.CARGO_TARGET_DIR ?? join(root, 'target'), 'release', 'contract-validate');
  if (!skip.has('verify')) {
    if (!existsSync(validator)) missing.push(`the contract-validate binary at ${validator} (cargo build --release -p contract-validate, or --contract-validate <bin>)`);
    if (exec('jq', ['--version'], { capture: true }).status !== 0) missing.push('jq (validate-registered.sh needs it)');
  }
  if (!dry) {
    if (offBranch) throw new Error(offBranch);
    if (missing.length) throw new Error(`merge the prerequisite PRs and install the tools first; missing: ${missing.join('; ')}`);
  } else {
    if (missing.length) log(`PREREQUISITES MISSING (a real run refuses): ${missing.join('; ')}`);
    if (offBranch) log(`a real run refuses here: ${offBranch}`);
  }

  const v2 = dep.v2;
  const say = (m) => print(`${dry ? '[dry-run] ' : ''}${m}`);
  say(`record ${relative(root, recordFile) || recordFile}: chain ${dep.chainId}, group ${v2.contractGroupId}`);
  for (const k of KEYS) say(`  ${k} ${v2[k].contractId} (${v2[k].sourceSha256.slice(0, 12)})`);

  const node = (script, args) => ({ cmd: 'node', args: [join(root, REL.scripts, script), ...args], shown: `node ${REL.scripts}/${script} ${args.join(' ')}` });
  const reportFile = a.report ? resolve(String(a.report)) : join(injected.tmp ?? tmpdir(), 'p4-c1-testnet.json');
  const results = [];
  const manual = [];
  if (skip.has('c1') && (!skip.has('snapshot') || !skip.has('freeze'))) {
    // C1 is what proves the chain holds what was signed; never snapshot or freeze without it
    let why = `--skip c1 needs the C1 report of an earlier run for this record: ${reportFile} does not exist (pass --report <file>)`;
    if (existsSync(reportFile)) {
      let report = null;
      try { report = JSON.parse(readFileSync(reportFile, 'utf8')); } catch (e) { why = `${reportFile} is not JSON (${e.message})`; }
      if (report) {
        const bad = c1ReportProblems(report, v2);
        why = bad.length ? `--skip c1: the C1 report ${reportFile} does not vouch for this record: ${bad.join('; ')}` : '';
      }
    }
    if (why && !dry) throw new Error(why);
    if (why) log(`a real run refuses: ${why}`);
  }
  const runCmd = (c, opts = {}) => {
    say(`$ ${c.shown ?? `${c.cmd} ${c.args.join(' ')}`}`);
    if (dry) return { status: 0, stdout: '' };
    const r = exec(c.cmd, c.args, { cwd: root, ...opts });
    if (r.status !== 0) throw new Error(`step failed (exit ${r.status}): ${c.shown ?? c.cmd}`);
    return r;
  };
  const step = async (name, title, fn) => {
    if (skip.has(name)) { say(`-- ${name}: skipped (--skip)`); results.push({ name, skipped: true }); return; }
    say(`-- ${name}: ${title}`);
    await fn();
    results.push({ name, skipped: false });
  };
  const edit = (rel, fn, what) => {
    const file = join(root, rel);
    if (!existsSync(file)) { if (dry) { say(`   would edit ${rel}: ${what}`); return; } throw new Error(`${rel} does not exist`); }
    const r = fn(readFileSync(file, 'utf8'));
    if (r.manual) { log(`MANUAL: ${r.manual}`); manual.push(r.manual); return; }
    if (!r.changed) { say(`   ${rel}: already has it`); return; }
    if (dry) { say(`   would edit ${rel}: ${what}`); return; }
    writeFileSync(file, r.text);
    say(`   edited ${rel}: ${what}`);
  };

  await step('dapi', 'PV14-only seeds from the quorum service (read-only network, edits dapiAddresses only)', () => {
    runCmd(node('refresh-dapi.mjs', ['--network', NETWORK, '--write']));
    runCmd(node('refresh-dapi.mjs', ['--network', NETWORK, '--check']));
  });

  await step('c1', 'the four contracts on chain equal contracts/mainnet (read-only)', () => {
    if (!dry) mkdirSync(dirname(reportFile), { recursive: true });
    runCmd(node('freeze-c1-check.mjs', ['--record', join(root, REL.record), '--contracts', join(root, REL.set), '--network', NETWORK, '--report', reportFile]));
    say(`   C1 report: ${reportFile}`);
  });

  await step('snapshot', 'bundle the contracts the web build reads, and wire testnet into SNAPSHOTS', () => {
    runCmd(node('snapshot-contracts.mjs', ['--network', NETWORK]));
    edit(REL.seedTs, wireSnapshot, "add testnet to SNAPSHOTS");
  });

  await step('freeze', "freeze what testnet registered, and add it to build.py's NETWORK_REGISTRATIONS", () => {
    const r = runCmd(node('freeze-registered.mjs', ['--network', NETWORK]), { capture: true });
    if (r.stdout) print(r.stdout.trimEnd());
    const entry = /^\s+('testnet'\s*:.*),?\s*$/m.exec(r.stdout)?.[1]?.replace(/,$/, '') ?? `'testnet': {'set': '${v2.contractsSet}', 'since': ()}`;
    edit(REL.buildPy, (t) => wireRegistrations(t, `${entry},`), `NETWORK_REGISTRATIONS gets ${entry}`);
  });

  await step('verify', 'the offline checks that prove the data (the toolchain ones are listed at the end)', () => {
    runCmd({ cmd: 'python3', args: [join(root, REL.buildPy), '--check'], shown: `python3 ${REL.buildPy} --check` });
    runCmd({ cmd: 'bash', args: [join(root, REL.scripts, 'validate-registered.sh'), validator], shown: `${REL.scripts}/validate-registered.sh ${validator}` });
    const tests = existsSync(join(root, REL.scripts, 'lib')) ? readdirSync(join(root, REL.scripts, 'lib')).filter((f) => f.endsWith('.test.mjs')).sort() : [];
    if (tests.length === 0 && !dry) throw new Error(`no ${REL.scripts}/lib/*.test.mjs to run (node --test with no files would run the whole repo)`);
    runCmd({ cmd: 'node', args: ['--test', ...tests.map((f) => join(root, REL.scripts, 'lib', f))], shown: `node --test ${REL.scripts}/lib/*.test.mjs` });
    // The rc.1 check exits 0 even with findings (a pre-release only warns), so read them: testnet must be deployed.
    // The finding about a devnet RELEASE_NETWORK is expected until the switch PR.
    const rn = runCmd(node('check-release-network.mjs', ['--version', '0.2.0-rc.1', '--publish', 'true']), { capture: true });
    if (rn.stdout) print(rn.stdout.trimEnd());
    if (/deployments\/testnet\.json has no registered forge-v2 set/.test(rn.stdout)) {
      throw new Error('check-release-network.mjs still finds testnet.json without a registered forge-v2 set');
    }
  });

  if (manual.length) log(`NOT DONE, by hand: ${manual.join(' | ')}`);
  print(afterwards(root));
  return { ok: manual.length === 0, steps: results, manual };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((r) => process.exit(r.ok ? 0 : 1), (e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}

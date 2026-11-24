#!/usr/bin/env node
// launch-network.mjs -- the whole registration of Forge's four contracts on testnet or mainnet, as
// one re-runnable command (docs/launch/mainnet-runbook.md). It DRY-RUNS unless --execute is given.
//
//   node forge-contracts/scripts/launch-network.mjs --network mainnet --identity <deployer.identity.json> \
//        --deployer-created-height <n> --expect-sha256 <signed sums> [--evidence <dir>]            # dry run
//   ... the same ... --execute                                                                     # register
//   ... the same ... --post-only                                                                   # checks only
//   node forge-contracts/scripts/launch-network.mjs --network testnet --identity <scratch.identity.json> \
//        --record <scratch-record.json> --scratch-on testnet --out <dir> [--execute]               # rehearsal
//
// Steps, each a child process of the scripts this wraps; the first failure stops the run:
//   1. preflight (always): deploy-v2 --self-test, the set's sums (compared with --expect-sha256),
//      refresh-dapi --check (--skip-dapi-check leaves it out), deploy-v2 --dry-run. Any WARNING line
//      the dry run prints fails it: on a live record deploy-v2 only warns, in a dry run, about what
//      would refuse the real registration (sums, uncommitted files, build.py --check, HEAD not pushed).
//      A scratch rehearsal always warns that it is one, so there the warnings are only printed.
//   2. register (--execute): deploy-v2 without --dry-run. deploy-v2 records every nonce before it
//      broadcasts, so re-running this command after an interruption completes what landed and never
//      registers a second copy. On mainnet it first asks the operator to type the network name
//      (or takes --confirm mainnet when stdin is not a terminal).
//   3. post (--execute or --post-only): freeze-c1-check (chain equals the signed JSON), the contract
//      group's owner and admins, freeze-registered and snapshot-contracts. All read-only on chain.
//
// It never passes --force-new, --update, --replay or --acknowledge-nonce: those stay manual decisions
// made with deploy-v2.mjs itself (docs/deploying-to-a-network.md §8).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseSums, sumsProblems } from './deploy-v2.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPTS, '..');
export const NETWORKS = ['testnet', 'mainnet'];
const VALUE_FLAGS = ['network', 'identity', 'deployer-created-height', 'expect-sha256', 'record', 'scratch-on', 'out', 'evidence', 'confirm'];
const BOOL_FLAGS = ['execute', 'post-only', 'skip-dapi-check'];

export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) throw new Error(`unexpected argument: ${t}`);
    const k = t.slice(2);
    if (BOOL_FLAGS.includes(k)) a[k] = true;
    else if (VALUE_FLAGS.includes(k)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${k} needs a value`);
      a[k] = v;
      i++;
    } else throw new Error(`unknown flag --${k} (this wrapper never forwards other deploy-v2 flags; run deploy-v2.mjs directly for those)`);
  }
  return a;
}

/** The checked options, or throws naming what is wrong. */
export function options(a) {
  if (!NETWORKS.includes(a.network)) throw new Error('--network testnet|mainnet is required');
  if (a.execute && a['post-only']) throw new Error('--execute and --post-only are exclusive');
  const scratch = a.record !== undefined;
  if (scratch !== (a['scratch-on'] !== undefined)) throw new Error('--record and --scratch-on go together (a scratch rehearsal)');
  if (scratch && a['scratch-on'] !== a.network) throw new Error('--scratch-on must equal --network');
  if (scratch && !a.out) throw new Error('a scratch rehearsal needs --out <dir> for its registered copy and snapshot');
  if (!a['post-only'] && !a.identity) throw new Error('--identity <deployer.identity.json> is required');
  if (!scratch && !a['post-only'] && !a['expect-sha256']) throw new Error('the live record needs --expect-sha256 <the sums the owner signed>, in a dry run too');
  if (a['deployer-created-height'] !== undefined && !/^[0-9]+$/.test(a['deployer-created-height'])) throw new Error('--deployer-created-height is a block height');
  const mode = a.execute ? 'execute' : a['post-only'] ? 'post-only' : 'dry-run';
  const record = scratch ? resolve(a.record) : join(ROOT, 'deployments', `${a.network}.json`);
  const evidence = resolve(a.evidence ?? (scratch ? join(a.out, 'evidence') : join(process.cwd(), `launch-evidence-${a.network}`)));
  for (const k of ['identity', 'expect-sha256']) if (a[k] !== undefined) a[k] = resolve(a[k]);
  return { network: a.network, mode, scratch, record, evidence, out: a.out && resolve(a.out), args: a };
}

/** Whether contracts/registered/<network>/ already holds a frozen registration. */
export function alreadyFrozen(network, root = ROOT) {
  const dir = join(root, 'contracts', 'registered', network);
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.v1.json'));
}

/** The steps a run takes, as [label, script, argv] (pure: the unit tests read it). */
export function plan(o, { frozen = false } = {}) {
  const a = o.args;
  const net = ['--network', o.network];
  const deploy = [...net, '--set', 'mainnet'];
  if (a.identity) deploy.push('--identity', a.identity);
  if (a['deployer-created-height']) deploy.push('--deployer-created-height', a['deployer-created-height']);
  if (a['expect-sha256']) deploy.push('--expect-sha256', a['expect-sha256']);
  if (o.scratch) deploy.push('--record', o.record, '--scratch-on', a['scratch-on']);
  const steps = [];
  if (o.mode !== 'post-only') {
    steps.push(['self-test', 'deploy-v2.mjs', ['--self-test', '--contracts', join(ROOT, 'contracts', 'mainnet')]]);
    steps.push(['sums', 'deploy-v2.mjs', ['--print-sha256', '--set', 'mainnet'], { capture: 'sha256sums.txt' }]);
    if (!a['skip-dapi-check']) steps.push(['dapi', 'refresh-dapi.mjs', [...net, '--check']]);
    steps.push(['dry-run', 'deploy-v2.mjs', [...deploy, '--dry-run'], { failOnWarning: !o.scratch }]);
  }
  if (o.mode === 'execute') steps.push(['register', 'deploy-v2.mjs', deploy, { confirm: true }]);
  if (o.mode !== 'dry-run') {
    steps.push(['c1', 'freeze-c1-check.mjs', ['--record', o.record, '--contracts', join(ROOT, 'contracts', 'mainnet'), ...net, '--report', join(o.evidence, 'c1.json')]]);
    steps.push(['group', null, [], { group: true }]);
    // A network's registration is frozen once, at the registration commit; a later re-run (after a
    // contract update moved the committed set on) leaves the frozen files alone.
    if (o.scratch) steps.push(['freeze', 'freeze-registered.mjs', [...net, '--record', o.record, '--out', join(o.out, 'registered')]]);
    else if (!frozen) steps.push(['freeze', 'freeze-registered.mjs', net]);
    steps.push(o.scratch
      ? ['snapshot', 'snapshot-contracts.mjs', [...net, '--record', o.record, '--out', join(o.out, 'snapshot.json')]]
      : ['snapshot', 'snapshot-contracts.mjs', net]);
  }
  return steps;
}

/** The WARNING lines of a script's output. */
export const warningLines = (text) => text.split('\n').filter((l) => /\bWARNING\b/.test(l));

/** Problems with the recorded contract group as the chain reports it (empty when it is fine). */
export function groupProblems(v2, info) {
  const want = v2?.contractGroup;
  if (!want?.id || !want?.owner) return ['the record names no contract group'];
  if (!info) return [`contract group ${want.id} not found on chain`];
  const p = [];
  if (info.ownerId !== want.owner) p.push(`group owner is ${info.ownerId}, the record says ${want.owner}`);
  if (want.owner !== v2.deployer?.identityId && v2.deployer?.identityId) p.push(`group owner ${want.owner} is not the deployer ${v2.deployer.identityId}`);
  if (!Array.isArray(info.adminIds)) p.push('the SDK reports no admin list: admins cannot be checked');
  else if (info.adminIds.length) p.push(`group has admins ${[...info.adminIds].join(', ')}`);
  return p;
}

async function checkGroup(o) {
  const { loadEvoSdk } = await import(pathToFileURL(join(SCRIPTS, 'deploy-v2.mjs')).href);
  const v2 = JSON.parse(readFileSync(o.record, 'utf8')).v2;
  const evo = await loadEvoSdk();
  const sdk = new evo.EvoSDK({ network: o.network, trusted: true, settings: { timeoutMs: 60000 } });
  await sdk.connect();
  const info = v2?.contractGroup?.id ? await sdk.contractGroups.info(v2.contractGroup.id) : null;
  const problems = groupProblems(v2, info);
  for (const p of problems) console.error(`FAIL group: ${p}`);
  if (!problems.length) console.error(`PASS group ${v2.contractGroup.id}: owner ${info.ownerId}, no admins`);
  writeFileSync(join(o.evidence, 'group.json'), `${JSON.stringify({ id: v2?.contractGroup?.id, ownerId: info?.ownerId ?? null, adminIds: info?.adminIds ? [...info.adminIds] : null, problems }, null, 2)}\n`);
  return problems.length === 0;
}

async function confirmBroadcast(o) {
  if (o.network !== 'mainnet') return true;
  if (o.args.confirm !== undefined) return o.args.confirm === 'mainnet';
  if (!process.stdin.isTTY) {
    console.error('refusing a mainnet broadcast without a terminal; pass --confirm mainnet');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question('\nThis registers Forge on MAINNET, permanently, and spends real DASH. Type "mainnet" to continue: ');
  rl.close();
  return answer.trim() === 'mainnet';
}

export async function main(argv = process.argv.slice(2)) {
  const o = options(parseArgs(argv));
  mkdirSync(o.evidence, { recursive: true });
  const say = (m) => console.error(`${new Date().toISOString().slice(11, 19)} [launch ${o.network}${o.scratch ? ' scratch' : ''}] ${m}`);
  say(`mode ${o.mode}; record ${o.record}; evidence ${o.evidence}`);
  if (o.mode === 'post-only' && !JSON.parse(readFileSync(o.record, 'utf8')).v2?.contractGroup?.id) {
    say(`${o.record} holds no registration yet: nothing to check`);
    return 1;
  }
  const frozen = !o.scratch && alreadyFrozen(o.network);
  if (frozen && o.mode !== 'dry-run') say(`contracts/registered/${o.network}/ is already frozen: not re-freezing`);
  const steps = plan(o, { frozen });
  for (const [label, script, argv2, extra = {}] of steps) {
    if (extra.confirm && !(await confirmBroadcast(o))) { say('not confirmed: nothing was broadcast'); return 1; }
    say(`step ${label}${script ? `: node ${script} ${argv2.join(' ')}` : ''}`);
    if (extra.group) {
      if (!(await checkGroup(o))) { say('step group FAILED'); return 1; }
      continue;
    }
    const piped = Boolean(extra.capture || extra.failOnWarning);
    const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...argv2], {
      cwd: resolve(ROOT, '..'),
      stdio: ['inherit', piped ? 'pipe' : 'inherit', piped ? 'pipe' : 'inherit'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (piped) {
      process.stdout.write(r.stdout ?? '');
      process.stderr.write(r.stderr ?? '');
    }
    if (r.status !== 0) { say(`step ${label} FAILED (exit ${r.status ?? r.signal})`); return 1; }
    if (extra.capture) {
      writeFileSync(join(o.evidence, extra.capture), r.stdout);
      const problems = o.args['expect-sha256'] ? sumsProblems(parseSums(readFileSync(o.args['expect-sha256'], 'utf8')), parseSums(r.stdout)) : [];
      for (const p of problems) say(`FAIL sums: ${p}`);
      if (problems.length) { say(`step ${label} FAILED: the set's files are not the signed sums`); return 1; }
    }
    if (extra.failOnWarning) {
      writeFileSync(join(o.evidence, `${label}.log`), `${r.stdout ?? ''}${r.stderr ?? ''}`);
      const warnings = warningLines(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
      if (warnings.length) { say(`step ${label} FAILED: ${warnings.length} WARNING line(s) above would stop or need a decision before the real run`); return 1; }
    }
  }
  if (o.mode === 'dry-run') say('dry run clean. Nothing was broadcast. Re-run with --execute to register.');
  else say(o.scratch
    ? `done. Registered copy and snapshot are under ${o.out}.`
    : `done. Commit deployments/${o.network}.json, contracts/registered/${o.network}/, deployments/contracts/${o.network}.json${steps.some(([l]) => l === 'freeze') ? ', the NETWORK_REGISTRATIONS line printed above' : ''}, and ${o.evidence}/c1.json (docs/deploying-to-a-network.md §6).`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => process.exit(code), (e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}

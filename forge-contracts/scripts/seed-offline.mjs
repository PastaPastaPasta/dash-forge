#!/usr/bin/env node
// seed-offline.mjs — run every seed and verify script against an in-memory chain
// (lib/offline-chain.mjs), with no network and no SDK install, and check what they write.
//
//   node forge-contracts/scripts/seed-offline.mjs [--out <dir>]
//
// Each script runs with synthetic identities. The seeds then run a second time, and that
// rerun must write nothing (they are idempotent). The run fails when:
//   * a script throws;
//   * a write breaks a rule that needs chain state and the script did not expect that refusal.
//     These are the references (40120), the total-reading rules (dense, c1..c6, lockGate,
//     platformChunks, oneLive, atMost20; 10422), distinctFrom (10419) and unique indices (40105);
//   * an expected refusal does not happen;
//   * a rerun writes;
//   * verify-c1 reports a failed check;
//   * the fixture's numbers are not the ones the specs read.
//
// With --out, every document written is saved as an rc1 vector (forge-contracts/vectors/rc1/
// README.md), one file per contract, for `contract-validate --vectors <dir>`, which judges the
// JSON schema, maxBytes and every other rule with rs-dpp. A document the script expected to be
// refused for such a rule is exported as a refuse vector with that reason.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { OfflineChain, vectorDoc } from './lib/offline-chain.mjs';
import { CONTRACT_OF, b58encode, parseArgs, runIfMain } from './lib/seed-io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A mint-identity file for a synthetic identity (the offline chain checks no signature). */
function identity(dir, name) {
  const identityId = b58encode(createHash('sha256').update(`offline identity ${name}`).digest());
  const file = join(dir, `${name}.identity.json`);
  const key = { id: 1, purpose: 'AUTHENTICATION', securityLevel: 'HIGH', keyType: 'ECDSA_SECP256K1', publicKeyHex: `02${'11'.repeat(32)}`, privateKeyWif: 'offline' };
  writeFileSync(file, JSON.stringify({ label: name, identityId, identityKeys: [key] }));
  return { file, id: identityId };
}

/** Run `fn` with console output held back; print it only when `fn` fails. */
async function quietly(fn) {
  const held = [];
  const { log, error } = console;
  console.log = (...a) => held.push(a.join(' '));
  console.error = (...a) => held.push(a.join(' '));
  try {
    return await fn();
  } catch (e) {
    console.log = log;
    console.error = error;
    console.error(held.join('\n'));
    throw e;
  } finally {
    console.log = log;
    console.error = error;
  }
}

export async function main(argv) {
  const a = parseArgs(argv);
  const tmp = mkdtempSync(join(tmpdir(), 'seed-offline-'));
  const chain = new OfflineChain();
  const evo = chain.evo();
  const deployment = join(tmp, 'devnet-offline.json');
  writeFileSync(deployment, JSON.stringify({
    network: 'devnet',
    devnetName: 'offline',
    v2: { forgeCore: { contractId: chain.ids.core }, forgeCollab: { contractId: chain.ids.collab }, forgeCommunity: { contractId: chain.ids.community } },
  }));
  const net = ['--network', 'devnet', '--devnet-name', 'offline', '--deployment', deployment];
  const ids = join(tmp, 'identities');
  mkdirSync(ids);
  const who = Object.fromEntries(
    ['OWNER', 'MAINTAINER', 'COLLAB', 'CONTRIB', 'F1OWNER', 'F1COLLAB', 'TREND-D', 'TREND-A', 'TREND-B', 'TREND-C', 'C1-OWNER', 'C1-MEMBER', 'C1-THIRD', 'FILLER'].map((n) => [n, identity(ids, n)]),
  );

  const runs = [
    { script: 'seed-v2-fixture', args: ['--identities', ids, '--state', join(tmp, 'fixture-state.json'), '--summary', join(tmp, 'fixture-summary.json')], rerun: true },
    { script: 'seed-issues-paging', args: ['--identity', who.F1OWNER.file, '--assignee', who.F1COLLAB.id, '--pace-ms', '0'], rerun: true },
    { script: 'seed-trending', args: ['--out', join(tmp, 'trending.json'), '--owner', who['TREND-D'].file, ...['A', 'B', 'C'].flatMap((x) => ['--identity', who[`TREND-${x}`].file])], rerun: true },
    { script: 'seed-explore-filler', args: ['--identity', who.FILLER.file, '--pace-ms', '0'], rerun: true },
    { script: 'verify-c1', args: ['--owner', who['C1-OWNER'].file, '--member', who['C1-MEMBER'].file, '--third', who['C1-THIRD'].file] },
  ];
  const problems = [];
  const results = {};
  for (const run of runs) {
    const { main: script } = await import(pathToFileURL(join(HERE, `${run.script}.mjs`)).href);
    for (const pass of run.rerun ? ['first', 'rerun'] : ['first']) {
      chain.script = run.script;
      const before = chain.records.length;
      try {
        results[run.script] = await quietly(() => script([...run.args, ...net], evo));
      } catch (e) {
        problems.push(`${run.script} (${pass} run) threw: ${e?.message ?? e}`);
        break;
      }
      const wrote = chain.records.length - before;
      if (pass === 'rerun' && wrote > 0) problems.push(`${run.script}: the rerun wrote ${wrote} documents; it must write none`);
      console.error(`${run.script} (${pass} run): ${wrote} writes`);
    }
  }

  // Expected refusals by a chain-state rule must have happened, for that reason.
  for (const r of chain.records) {
    if (r.why && /^\d+$/.test(r.why) && String(r.refusal?.code) !== r.why) {
      problems.push(`${r.script}: a ${r.type} was expected to be refused with ${r.why}, got ${r.refusal ? r.refusal.message : 'accepted'}`);
    }
  }
  if (results['verify-c1'] !== 0) problems.push('verify-c1 reported a failed check against the offline chain');
  const fixture = results['seed-v2-fixture'];
  if (fixture && JSON.stringify(fixture.pulls) !== JSON.stringify({ approved: 5, merged: 6, reviewParity: 7 })) {
    problems.push(`seed-v2-fixture: the specs read PRs 5, 6 and 7, the summary says ${JSON.stringify(fixture.pulls)}`);
  }

  if (a.out) {
    const cases = { core: [], collab: [], community: [] };
    const seen = new Map();
    for (const r of chain.records) {
      // A refusal for a rule rs-dpp judges becomes a refuse vector; a chain-state refusal (a
      // numeric code, judged above) leaves a document rs-dpp must accept.
      const refused = r.why && !/^\d+$/.test(r.why);
      const n = (seen.get(`${r.script} ${r.type}`) ?? 0) + 1;
      seen.set(`${r.script} ${r.type}`, n);
      cases[CONTRACT_OF[r.type]].push({
        item: r.script,
        name: `${r.script} ${r.type} #${n}`,
        type: r.type,
        expect: refused ? 'refused' : 'ok',
        ...(refused ? { why: r.why } : {}),
        owner: r.owner,
        doc: vectorDoc(r.type, r.data),
      });
    }
    mkdirSync(a.out, { recursive: true });
    for (const [c, list] of Object.entries(cases)) writeFileSync(join(a.out, `forge-${c}.json`), `${JSON.stringify(list, null, 1)}\n`);
    console.error(`vectors: ${Object.entries(cases).map(([c, l]) => `forge-${c} ${l.length}`).join(', ')} in ${a.out}`);
  }

  const byType = {};
  for (const r of chain.records) byType[r.type] = (byType[r.type] ?? 0) + 1;
  console.error(`${chain.records.length} writes: ${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} problems:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  console.error('every seed and verify script writes RC1 documents the chain-state rules accept');
  return 0;
}

runIfMain(import.meta.url, main);

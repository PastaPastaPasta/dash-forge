#!/usr/bin/env node
// seed-issues-paging.mjs — seed the issue-list paging fixture that forge-web's
// `e2e/v2-issues.spec.ts` reads: a repo with more issues than one list page (100), some
// labelled, a few closed, and one assigned to a second identity.
//
//   node forge-contracts/scripts/seed-issues-paging.mjs --identity <OWNER.identity.json> \
//     [--repo issues-paging] [--count 112] [--assignee <identity id>] \
//     [--network devnet --devnet-name bonsia] [--deployment <file>] [--pace-ms 700]
//
// Writes RC1 documents; needs `npm ci` in forge-contracts/sdk-v2 (evo-sdk 4.2.0-beta.7). The
// network defaults to DASH_FORGE_NETWORK / DASH_FORGE_DEVNET_NAME, else devnet bonsia. The repo
// is the identity's: when it does not exist yet the seed creates it (public, the owner its
// maintainer), as `dg repo create issues-paging --storage platform` would.
//
// Idempotent: the run lists what exists and writes only what is missing. Issue numbers are dense
// (issues and PRs share one sequence, and each create takes the next number), so a run that
// stopped part-way resumes at the next number. It writes only the events and transitions whose
// effect is not already there. Writes are paced (default 700 ms apart, one at a time) to stay
// far under the gateway's 150 requests/minute/IP, which every agent and test on the same machine
// shares.
//
// What it writes, for `--count N` (default 112):
//   * issues #1..#N, titled "Paging fixture issue #n"; #n has a body naming n;
//   * `label` definitions `paging-even` (#1f883d) and `paging-tens` (#d73a4a);
//   * label events: `paging-tens` on every multiple of 10, `paging-even` on #2..#20 even;
//   * close transitions on #3, #33 and #103 (so the Closed tab has rows on both pages);
//   * an assign of #7 to `--assignee`, carrying `refId` = the assignee (so the sparse
//     `event.addressee` index answers "assigned to me").
// Cost: about N × 0.00058 + 25 × 0.0005 DASH (≈ 0.08 DASH for 112).

import {
  EVENT, TRANSITION, VIS, idBytes, loadIdentity, log, membership, openSession, parseArgs, runIfMain, sleep, transition,
} from './lib/seed-io.mjs';

const LABELS = [
  { name: 'paging-even', color: '#1f883d', description: 'Even issue numbers up to 20 (paging fixture)' },
  { name: 'paging-tens', color: '#d73a4a', description: 'Multiples of ten (paging fixture)' },
];

export async function main(argv, injected) {
  const a = { repo: 'issues-paging', count: '112', 'pace-ms': '700', ...parseArgs(argv) };
  if (!a.identity) throw new Error('--identity <file> is required');
  const count = Number(a.count);
  const pace = Number(a['pace-ms']);
  const { net, evo, write, read } = await openSession(a, injected, { pace });
  const me = loadIdentity(evo, a.identity, 'OWNER');

  // A write is paced, and retried on a transient gateway error.
  const create = async (type, data) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const created = await write(me, type, data);
        await sleep(pace);
        return created.id.toBase58();
      } catch (e) {
        const msg = e?.message ?? String(e);
        if (attempt >= 4 || !/timeout|unavailable|no available|ResourceExhausted|rate/i.test(msg)) throw e;
        log(`retry ${attempt} after: ${msg.slice(0, 120)}`);
        await sleep(15000 * attempt);
      }
    }
  };

  let repoId = (await read.first('repo', [['$ownerId', '==', me.id], ['name', '==', a.repo]]))?.$id;
  if (!repoId) {
    repoId = await create('repo', { name: a.repo, visibility: VIS, description: 'Issue-list paging fixture (forge-web/e2e/v2-issues.spec.ts)' });
    log(`created repo ${a.repo}`);
  }
  const R = idBytes(repoId);
  log(`repo ${a.repo} = ${repoId}`);
  // The owner enrols itself (no consent needed): its issues, labels and events are a member's.
  if (!(await read.first('maintainer', [['repoId', '==', repoId], ['memberId', '==', me.id]]))) await create('maintainer', membership(R, me.id, me.id));

  // Labels: define each once (newest per name wins; an identical definition is not rewritten).
  const labels = await read.all('label', [['repoId', '==', repoId]]);
  for (const l of LABELS) {
    if (labels.some((d) => d.name === l.name && d.color === l.color)) continue;
    await create('label', { repoId: R, ...l, retired: false });
    log(`label ${l.name}`);
  }

  // Issues: the next dense number is one past every issue and PR the repo holds.
  const issues = await read.all('issue', [['repoId', '==', repoId]], [['number', 'asc']]);
  const byNumber = new Map(issues.map((d) => [d.number, d]));
  const held = issues.length + (await read.all('patch', [['repoId', '==', repoId]], [['number', 'asc']])).length;
  if (held > 0 && held !== issues.length) throw new Error(`${a.repo} holds pull requests: the paging fixture needs a repo of issues only`);
  for (let n = held + 1; n <= count; n++) {
    const id = await create('issue', { repoId: R, number: n, tk: 0, title: `Paging fixture issue #${n}`, body: `Issue ${n} of the paging fixture.`, vis: VIS, asMember: idBytes(me.id) });
    byNumber.set(n, { $id: id, number: n });
    if (n % 10 === 0) log(`issue #${n}`);
  }

  // Events (forge-community): only those whose effect is missing from the repo feed.
  const feed = await read.all('event', [['repoId', '==', repoId]], [['$createdAt', 'asc']]);
  const has = (targetId, kind, value) => feed.some((e) => e.targetId === targetId && e.kind === kind && (value === undefined || e.value === value));
  const event = async (n, kind, extra = {}) => {
    const t = byNumber.get(n);
    if (!t || has(t.$id, kind, extra.value)) return;
    await create('event', { repoId: R, targetId: idBytes(t.$id), targetNumber: n, kind, ...extra });
    log(`event kind ${kind} on #${n}${extra.value ? ` (${extra.value})` : ''}`);
  };
  for (let n = 10; n <= count; n += 10) await event(n, EVENT.labelAdd, { value: 'paging-tens' });
  for (let n = 2; n <= Math.min(20, count); n += 2) await event(n, EVENT.labelAdd, { value: 'paging-even' });
  if (a.assignee) await event(7, EVENT.assign, { value: a.assignee, refId: idBytes(a.assignee) });

  // Closes (forge-collab transitions, by the owner as a member): only on issues not closed yet.
  const moves = await read.all('transition', [['repoId', '==', repoId]], [['$createdAt', 'asc']]);
  for (const n of [3, 33, 103]) {
    const t = byNumber.get(n);
    if (!t || moves.some((m) => m.targetId === t.$id && m.kind === TRANSITION.issueClose)) continue;
    await create('transition', transition(R, { id: t.$id, number: n }, TRANSITION.issueClose));
    log(`closed #${n}`);
  }

  const summary = { network: net.key, repo: { owner: me.id, name: a.repo, repoId }, issues: count };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

runIfMain(import.meta.url, main);

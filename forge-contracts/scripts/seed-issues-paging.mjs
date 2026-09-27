#!/usr/bin/env node
// seed-issues-paging.mjs — seed the issue-list paging fixture that forge-web's
// `e2e/v2-issues.spec.ts` reads: a repo with more issues than one list page (100), some
// labelled, a few closed, and one assigned to a second identity.
//
//   node forge-contracts/scripts/seed-issues-paging.mjs --identity <OWNER.identity.json> \
//     [--repo issues-paging] [--count 112] [--assignee <identity id>] \
//     [--network devnet --devnet-name moutai] [--pace-ms 700]
//
// Needs `npm ci` in forge-contracts/sdk-v2. The repo must already exist, owned by the identity
// (`dg repo create issues-paging --storage platform`), since its owner is its maintainer.
//
// Idempotent: issue numbers are unique per repo, so the run lists what exists and writes only
// the missing numbers (and only the events whose effect is not already folded in). Writes are
// paced (default 700 ms apart, one at a time) to stay far under the gateway's 150
// requests/minute/IP, which every agent and test on the same machine shares.
//
// What it writes, for `--count N` (default 112):
//   * issues #1..#N, titled "Paging fixture issue #n"; #n has a body naming n;
//   * `label` definitions `paging-even` (#1f883d) and `paging-tens` (#d73a4a);
//   * label events: `paging-tens` on every multiple of 10, `paging-even` on #2..#20 even;
//   * close events on #3, #33 and #103 (so the Closed tab has rows on both pages);
//   * an assign of #7 to `--assignee`, carrying `refId` = the assignee (so the sparse
//     `event.addressee` index answers "assigned to me").
// Cost: about N × 0.00058 + 20 × 0.0005 DASH (≈ 0.075 DASH for 112).

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEvoSdk } from './deploy-v2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function args() {
  const out = { network: 'devnet', 'devnet-name': 'moutai', repo: 'issues-paging', count: '112', 'pace-ms': '700' };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1];
  if (!out.identity) throw new Error('--identity <file> is required');
  return out;
}

const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EVENT = { close: 1, labelAdd: 4, assign: 6 };
const LABELS = [
  { name: 'paging-even', color: '#1f883d', description: 'Even issue numbers up to 20 (paging fixture)' },
  { name: 'paging-tens', color: '#d73a4a', description: 'Multiples of ten (paging fixture)' },
];

async function main() {
  const a = args();
  const count = Number(a.count);
  const pace = Number(a['pace-ms']);
  const key = a.network === 'devnet' ? `devnet-${a['devnet-name']}` : a.network;
  const dep = JSON.parse(readFileSync(join(ROOT, 'deployments', `${key}.json`), 'utf8'));
  const core = dep.v2.forgeCore.contractId;
  const collab = dep.v2.forgeCollab.contractId;

  const evo = await loadEvoSdk();
  const { EvoSDK, Document, IdentityPublicKey, IdentitySigner, PrivateKey } = evo;
  const sdk = new EvoSDK({
    network: a.network,
    trusted: true,
    ...(a.network === 'devnet' ? { devnetName: a['devnet-name'] } : {}),
    ...(dep.dapiAddresses ? { addresses: dep.dapiAddresses } : {}),
    settings: { timeoutMs: 30000 },
  });
  await sdk.connect();

  const rec = JSON.parse(readFileSync(a.identity, 'utf8'));
  const k = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === 'HIGH');
  const identityKey = new IdentityPublicKey({
    keyId: k.id,
    purpose: k.purpose,
    securityLevel: k.securityLevel,
    keyType: k.keyType,
    isReadOnly: false,
    data: Buffer.from(k.publicKeyHex, 'hex'),
  });
  const signer = new IdentitySigner();
  signer.addKey(PrivateKey.fromWIF(k.privateKeyWif));
  const me = rec.identityId;
  const b58 = (s) => Buffer.from(evo.Identifier.fromBase58(s).toBytes());
  const version = sdk.version();

  const docs = async (contractId, type, where, orderBy) => {
    const out = [];
    let startAfter;
    for (;;) {
      const res = await sdk.documents.query({ dataContractId: contractId, documentTypeName: type, where, orderBy, limit: 100, ...(startAfter ? { startAfter } : {}) });
      const page = [...res.values()].filter(Boolean).map((d) => d.toJSON(version));
      out.push(...page);
      if (page.length < 100) return out;
      startAfter = page[page.length - 1].$id;
      await sleep(pace);
    }
  };
  const create = async (contractId, documentTypeName, data) => {
    const base = new Document({ properties: {}, documentTypeName, dataContractId: contractId, ownerId: me });
    const document = Document.fromObject({ ...base.toObject(), ...data }, version);
    for (let attempt = 1; ; attempt++) {
      try {
        const created = await sdk.documents.create({ document, identityKey, signer });
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

  const found = await docs(core, 'repo', [['$ownerId', '==', me], ['name', '==', a.repo]]);
  if (found.length !== 1) throw new Error(`repo ${me}/${a.repo} not found; create it first (dg repo create ${a.repo} --storage platform)`);
  const repoId = found[0].$id;
  const R = b58(repoId);
  log(`repo ${a.repo} = ${repoId}`);

  // Labels: define each once (newest per name wins; an identical definition is not rewritten).
  const labels = await docs(core, 'label', [['repoId', '==', repoId]]);
  for (const l of LABELS) {
    if (labels.some((d) => d.name === l.name && d.color === l.color)) continue;
    await create(core, 'label', { repoId: R, ...l, retired: false });
    log(`label ${l.name}`);
  }

  // Issues: write every missing number in order (the numbering rule allows count+1, and a
  // run that stopped part-way resumes at the first gap).
  const issues = await docs(collab, 'issue', [['repoId', '==', repoId]], [['number', 'asc']]);
  const byNumber = new Map(issues.map((d) => [d.number, d]));
  for (let n = 1; n <= count; n++) {
    if (byNumber.has(n)) continue;
    const id = await create(collab, 'issue', { repoId: R, number: n, title: `Paging fixture issue #${n}`, body: `Issue ${n} of the paging fixture.` });
    byNumber.set(n, { $id: id, number: n });
    if (n % 10 === 0) log(`issue #${n}`);
  }

  // Events: only those whose effect is missing from the repo feed.
  const feed = await docs(collab, 'event', [['repoId', '==', repoId]], [['$createdAt', 'asc']]);
  const has = (targetId, kind, value) => feed.some((e) => e.targetId === targetId && e.kind === kind && (value === undefined || e.value === value));
  const event = async (n, kind, extra = {}) => {
    const t = byNumber.get(n);
    if (!t || has(t.$id, kind, extra.value)) return;
    await create(collab, 'event', { repoId: R, targetId: b58(t.$id), targetNumber: n, kind, ...extra });
    log(`event kind ${kind} on #${n}${extra.value ? ` (${extra.value})` : ''}`);
  };
  for (let n = 10; n <= count; n += 10) await event(n, EVENT.labelAdd, { value: 'paging-tens' });
  for (let n = 2; n <= Math.min(20, count); n += 2) await event(n, EVENT.labelAdd, { value: 'paging-even' });
  for (const n of [3, 33, 103]) if (n <= count) await event(n, EVENT.close);
  if (a.assignee) await event(7, EVENT.assign, { value: a.assignee, refId: b58(a.assignee) });

  console.log(JSON.stringify({ network: key, repo: { owner: me, name: a.repo, repoId }, issues: count }, null, 2));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  },
);

#!/usr/bin/env node
// seed-v2-fixture.mjs — seed the forge-v2 read fixture that forge-web's devnet Playwright
// specs and live tests read.
//
//   node forge-contracts/scripts/seed-v2-fixture.mjs [--network devnet --devnet-name bonsia]
//        [--identities <dir>] [--state <file>] [--summary <file>] [--deployment <file>]
//
// Writes the RC1 documents (contracts/forge-{core,collab,community}.json; the rules are in
// docs/contracts/forge-v2.md). Needs `npm ci` in forge-contracts/sdk-v2 (evo-sdk 4.2.0-beta.7),
// the three-contract deployment in deployments/<network>.json, and the test identities OWNER,
// MAINTAINER, COLLAB and CONTRIB in --identities (default
// ~/.config/dash-forge/test-identities/<network>/). The network defaults to
// DASH_FORGE_NETWORK / DASH_FORGE_DEVNET_NAME, else devnet bonsia.
//
// It writes:
//   * repo `forge-v2-demo` owned by OWNER, OWNER and MAINTAINER as maintainers and COLLAB as a
//     writer (each invited member first writes its `consent`), a config protecting
//     refs/heads/main;
//   * one deterministic git history (three commits, a feature branch, a tag) packed with git,
//     stored on Platform as `chunk` documents behind a kind-0 `packManifest`, plus a kind-1
//     objectLocator over it, so the web app browses it through the published index;
//   * refs: main by protectedRefUpdate (two updates), the feature branch by COLLAB's
//     refUpdate, the tag by OWNER, and a release of the tag;
//   * issues #1-#4 by CONTRIB, then PRs #5-#7. Issues and PRs share one dense number sequence,
//     so numbers follow creation order:
//     - #2 is closed by its author, and #3 by MAINTAINER (both `transition` documents);
//     - PR #5 is open with MAINTAINER's approval and a passing check run by COLLAB;
//     - PR #6 is merged;
//   * the review-parity PR #7 (docs/design/review-parity-spec.md), by CONTRIB, who is not a member.
//     It is opened from c2 and marked draft (a kind-14 transition by the author). The author's
//     `headUpdate` moves its head to c3. Then:
//     - OWNER requests MAINTAINER's review;
//     - MAINTAINER writes a request-changes review with one multi-line inline comment attached
//       through `reviewId`;
//     - CONTRIB replies, and the author resolves the thread;
//     - OWNER dismisses the review with a reason, and OWNER sets a branch `policy`;
//   * the C-1 types (platform-parity-spec §6): CONTRIB's star, trending beat and watch; the
//     topics `fixture` and `forge-v2`; milestone `v0.2` holding issues #1 (open) and #3
//     (closed); issue #1 pinned;
//   * repo `forge-v2-empty` owned by MAINTAINER, with no refs (the empty-repo state).
//
// The pack and the locator are written directly, not through git-remote-dash. The chunk
// layout is forge-core `pack::split` (4900-byte fields, three per chunk). The locator is
// `pack/locator.rs`: fanout || 36-byte rows, with deltaChainSpan = the sentinel so readers walk
// each base.
//
// The summary (ids, numbers, commits) is printed and written to --summary (default
// deployments/fixtures/<network>.json, committed by the bring-up for the specs to read).
//
// Idempotent: the result of every step is recorded in --state (default
// ~/.cache/dash-forge/seed-v2-<network>.json) and a rerun skips what is recorded. A write that
// landed after its confirmation failed is adopted, not written again (the chain would refuse the
// repeat). The state records the contracts it seeded under (`contracts`). After forge-collab or
// forge-community is re-registered (forge-core unchanged), the steps that wrote into it are
// archived to `superseded` and seeded again. forge-community names forge-collab's id, so a new
// forge-collab re-seeds both. The repo, membership, pack and refs (forge-core) are kept.
// Without the state file (a fresh CI runner), a fixture that already exists on chain is left
// alone: the run checks `forge-v2-demo` resolves and exits. To seed from scratch, delete the file
// and pick new repo names.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CONTRACT_OF, EVENT, ROOT, TRANSITION, VIS, checkOutcome, idBytes, loadIdentity, log, membership, openSession, parseArgs,
  runIfMain, transition, until,
} from './lib/seed-io.mjs';

const DEMO = 'forge-v2-demo';
const EMPTY = 'forge-v2-empty';
const FIELD_MAX = 4900;
const FIELDS_PER_DOC = 3;
const FANOUT_LEN = 1024;
const ROW_LEN = 36;
const SPAN_SENTINEL = 0xffffffff;
/** The PR numbers the specs read (issues are #1-#4). */
const PULLS = { approved: 5, merged: 6, reviewParity: 7 };
const CHECK = 'fixture-ci';
const RELEASE_TAG = 'v0.1.0';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

// ---------------------------------------------------------------------------
// The deterministic git history
// ---------------------------------------------------------------------------

function git(cwd, argv, env = {}) {
  return execFileSync('git', argv, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, ...env },
    maxBuffer: 64 << 20,
  });
}

function buildHistory() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-v2-fixture-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const commit = (message, when, files) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    git(dir, ['add', '-A']);
    const date = `${when} +0000`;
    git(dir, ['commit', '-q', '-m', message], {
      GIT_AUTHOR_NAME: 'Forge Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@dash-forge.invalid',
      GIT_COMMITTER_NAME: 'Forge Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@dash-forge.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    return git(dir, ['rev-parse', 'HEAD']).toString().trim();
  };

  const c1 = commit('Initial import', '2026-09-01T12:00:00', {
    'README.md': '# forge-v2-demo\n\nThe forge-v2 read fixture: a repository that lives in the shared\n**forge-core** and **forge-collab** contracts (protocol 14).\n\n- `src/` holds the code\n- `lib/` holds helpers\n',
    'src/main.rs': 'fn main() {\n    println!("hello from forge-v2");\n}\n',
    'lib/util.ts': 'export function add(a: number, b: number): number {\n  return a + b\n}\n',
  });
  const c2 = commit('Document the fold rules', '2026-09-02T12:00:00', {
    'docs/rules.md': '# Rules\n\nIssue and PR state is folded from `event` and `authorEvent` documents.\n',
    'src/main.rs': 'fn main() {\n    println!("hello from forge-v2");\n    println!("reads are proof-checked");\n}\n',
  });
  git(dir, ['tag', RELEASE_TAG, c1]);
  git(dir, ['checkout', '-q', '-b', 'feature/greeting']);
  const c3 = commit('Greet by name', '2026-09-03T12:00:00', {
    'src/main.rs': 'fn main() {\n    let name = std::env::args().nth(1).unwrap_or("forge".into());\n    println!("hello, {name}");\n    println!("reads are proof-checked");\n}\n',
  });
  git(dir, ['checkout', '-q', 'main']);
  return { dir, commits: { c1, c2, c3 } };
}

/** `git pack-objects --stdout --all` needs rev-list input; feed it explicitly. */
function packAll(dir) {
  const revs = git(dir, ['rev-list', '--objects', '--all']).toString();
  return execFileSync('git', ['pack-objects', '--stdout', '-q'], {
    cwd: dir,
    input: revs,
    maxBuffer: 64 << 20,
  });
}

/** Locator rows for one pack (packRef 0), from `git verify-pack -v`. */
function buildLocator(dir, pack) {
  const packPath = join(dir, 'fixture.pack');
  writeFileSync(packPath, pack);
  git(dir, ['index-pack', '-o', join(dir, 'fixture.idx'), packPath]);
  const out = git(dir, ['verify-pack', '-v', join(dir, 'fixture.idx')]).toString();
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40}) (\w+)\s+(\d+) (\d+) (\d+)(?: (\d+) ([0-9a-f]{40}))?/.exec(line);
    if (!m) continue;
    rows.push({ oid: m[1], length: Number(m[4]), offset: Number(m[5]), depth: m[6] ? Number(m[6]) : 0 });
  }
  rows.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const bytes = Buffer.alloc(FANOUT_LEN + rows.length * ROW_LEN);
  const counts = new Array(256).fill(0);
  for (const r of rows) counts[parseInt(r.oid.slice(0, 2), 16)]++;
  let cum = 0;
  for (let i = 0; i < 256; i++) {
    cum += counts[i];
    bytes.writeUInt32BE(cum, i * 4);
  }
  let at = FANOUT_LEN;
  for (const r of rows) {
    Buffer.from(r.oid, 'hex').copy(bytes, at);
    bytes.writeUInt16BE(0, at + 20);
    bytes.writeUIntBE(r.offset, at + 22, 5);
    bytes.writeUInt32BE(r.length, at + 27);
    bytes.writeUInt32BE(SPAN_SENTINEL, at + 31);
    bytes[at + 35] = Math.min(r.depth, 255);
    at += ROW_LEN;
  }
  return { bytes, objectCount: rows.length };
}

/** forge-core `pack::split`: fill 4900-byte fields, three per chunk. */
function split(data) {
  const chunks = [];
  for (let at = 0; at < data.length; at += FIELD_MAX * FIELDS_PER_DOC) {
    const doc = data.subarray(at, at + FIELD_MAX * FIELDS_PER_DOC);
    const fields = [];
    for (let f = 0; f < doc.length; f += FIELD_MAX) fields.push(doc.subarray(f, f + FIELD_MAX));
    chunks.push(fields);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Platform writes
// ---------------------------------------------------------------------------

export async function main(argv, injected) {
  const a = parseArgs(argv);
  const { net, evo, write, read, retry } = await openSession(a, injected);
  const { key, ids } = net;

  const idDir = a.identities ?? join(homedir(), '.config/dash-forge/test-identities', key);
  const load = (name) => loadIdentity(evo, join(idDir, `${name}.identity.json`), name);
  const OWNER = load('OWNER');
  const MAINTAINER = load('MAINTAINER');
  const COLLAB = load('COLLAB');
  const CONTRIB = load('CONTRIB');
  const contracts = { forgeCore: ids.core, forgeCollab: ids.collab, forgeCommunity: ids.community };

  const statePath = a.state ?? join(homedir(), '.cache/dash-forge', `seed-v2-${key}.json`);
  mkdirSync(dirname(statePath), { recursive: true });
  if (!existsSync(statePath)) {
    // No local record: if the fixture is already on chain (seeded from another machine),
    // there is nothing to do. Re-seeding would fail on the unique `($ownerId, name)` index.
    const found = await retry((sdk) =>
      sdk.documents.query({
        dataContractId: ids.core,
        documentTypeName: 'repo',
        where: [
          ['$ownerId', '==', OWNER.id],
          ['name', '==', DEMO],
        ],
        limit: 1,
      }),
    );
    const doc = found instanceof Map ? [...found.values()].find((v) => v != null) : null;
    if (doc) {
      const repoId = String(doc.toJSON?.().$id ?? doc.id?.toBase58?.() ?? doc.id);
      // The last step the seeder writes is the pin; a fixture without it was interrupted on
      // the machine that holds its state file, and must be finished there.
      const events = await retry((sdk) =>
        sdk.documents.query({
          dataContractId: ids.community,
          documentTypeName: 'event',
          where: [['repoId', '==', repoId]],
          orderBy: [['$createdAt', 'asc']],
          limit: 100,
        }),
      );
      if (![...events.values()].some((e) => e?.toJSON?.().kind === EVENT.pin)) {
        throw new Error(`${DEMO} exists on ${key} but has no pin under forge-community ${ids.community}: the seed was interrupted or a contract was re-registered since; run the seeder where ~/.cache/dash-forge/seed-v2-${key}.json lives`);
      }
      log(`${DEMO} already exists on ${key} (${repoId}); nothing to seed`);
      const summary = { network: key, ...contracts, demo: { owner: OWNER.id, name: DEMO, repoId, reviewParityPull: PULLS.reviewParity }, pulls: PULLS, seeded: false };
      console.log(JSON.stringify(summary, null, 2));
      return summary;
    }
  }
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  // A state file from before a contract was re-registered names documents under the old one:
  // archive the steps that wrote into it and seed those again. Every step records its type
  // (`types`), so its contract is known.
  state.contracts ??= { ...ids };
  state.types ??= {};
  const changed = new Set(Object.keys(ids).filter((c) => state.contracts[c] !== ids[c]));
  if (changed.has('core')) {
    throw new Error(`${statePath} seeded forge-core ${state.contracts.core}, not ${ids.core}: a new forge-core needs a new fixture (delete the state file and pick new repo names)`);
  }
  // forge-community's events name forge-collab's issues and PRs
  if (changed.has('collab')) changed.add('community');
  if (changed.size > 0) {
    const stale = Object.keys(state.types).filter((k) => changed.has(CONTRACT_OF[state.types[k]]) && state[k]);
    state.superseded = [...(state.superseded ?? []), { contracts: state.contracts, steps: Object.fromEntries(stale.map((k) => [k, state[k]])) }];
    for (const k of stale) delete state[k];
    log(`${[...changed].map((c) => `forge-${c}`).join(' and ')} re-registered: re-seeding ${stale.length} steps`);
    state.contracts = { ...ids };
  }
  save();

  /** Create one document (once: the step name is recorded with its id). */
  async function create(step, who, type, data) {
    if (state[step]) return state[step];
    let id;
    try {
      id = (await write(who, type, data)).id.toBase58();
    } catch (e) {
      // It may have landed before the error (and a rerun of an unrecorded step would be
      // refused): adopt what landed.
      id = await read.existing(who, type, data);
      if (!id) throw e;
      log(`${step}: adopting ${type} ${id}, which landed before: ${String(e?.message ?? e).slice(0, 100)}`);
    }
    state[step] = id;
    state.types[step] = type;
    save();
    log(`${step}: ${type} ${id} (${who.name})`);
    return id;
  }

  // indexOnly documents (star, starBeat, watch) have no id to record. The write is confirmed by
  // a read of the writer's own entry.
  async function createIndexOnly(step, who, type, data) {
    if (state[step]) return;
    const own = () => read.owns(who, type, repoId);
    if (!(await own())) {
      await write(who, type, data);
      if (!(await until(own, 10, 2000))) throw new Error(`${step} did not land`);
    }
    state[step] = 'indexOnly';
    state.types[step] = type;
    save();
    log(step);
  }

  // --- repos, membership, config -----------------------------------------------------
  const repoId = await create('repo', OWNER, 'repo', {
    name: DEMO,
    visibility: VIS,
    displayName: 'forge-v2 demo',
    description: 'The forge-v2 read fixture: code, issues and pull requests in the shared contracts.',
    defaultBranch: 'main',
    topics: ['fixture', 'forge-v2'],
  });
  const R = idBytes(repoId);
  await create('maintainer:owner', OWNER, 'maintainer', membership(R, OWNER.id, OWNER.id));
  await create('config', OWNER, 'config', {
    repoId: R,
    defaultBranch: 'main',
    protectedPatterns: ['refs/heads/main'],
    backend: { mode: 0 },
    vis: VIS,
  });
  // An invited member accepts first (`consent`), then the owner enrols it.
  await create('consent:maintainer', MAINTAINER, 'consent', { repoId: R });
  await create('maintainer:maintainer', OWNER, 'maintainer', membership(R, OWNER.id, MAINTAINER.id));
  await create('consent:collab', COLLAB, 'consent', { repoId: R });
  await create('writer:collab', OWNER, 'writer', membership(R, OWNER.id, COLLAB.id));

  const emptyId = await create('repo:empty', MAINTAINER, 'repo', {
    name: EMPTY,
    visibility: VIS,
    description: 'A forge-v2 repository with nothing pushed yet.',
  });
  const E = idBytes(emptyId);
  await create('empty:maintainer', MAINTAINER, 'maintainer', membership(E, MAINTAINER.id, MAINTAINER.id));
  await create('empty:config', MAINTAINER, 'config', { repoId: E, defaultBranch: 'main', vis: VIS });

  // --- content: pack + locator on Platform --------------------------------------------
  const { dir, commits } = buildHistory();
  if (state.commits && JSON.stringify(state.commits) !== JSON.stringify(commits)) {
    throw new Error(`the fixture history changed (${JSON.stringify(commits)} vs recorded ${JSON.stringify(state.commits)})`);
  }
  state.commits = commits;
  save();
  const pack = packAll(dir);
  const packHash = sha256(pack);
  const locator = buildLocator(dir, pack);
  const locatorHash = sha256(locator.bytes);
  // Pack bytes depend on the git and zlib versions: a rerun must not write the rest of an
  // interrupted artifact under a different hash than its first chunks.
  const hashes = { pack: packHash.toString('hex'), locator: locatorHash.toString('hex') };
  if (state.hashes && JSON.stringify(state.hashes) !== JSON.stringify(hashes)) {
    throw new Error(`the packed bytes changed (${JSON.stringify(hashes)} vs recorded ${JSON.stringify(state.hashes)}); seed from scratch`);
  }
  state.hashes = hashes;
  save();

  // Every chunk lands before its manifest: the manifest's `platformChunks` rule counts them.
  async function storeArtifact(label, bytes, hash, kind, objectCount) {
    const chunks = split(bytes);
    for (let seq = 0; seq < chunks.length; seq++) {
      const data = { repoId: R, packHash: hash, seq };
      chunks[seq].forEach((field, i) => {
        data[`d${i}`] = Uint8Array.from(field);
      });
      await create(`${label}:chunk:${seq}`, OWNER, 'chunk', data);
    }
    return create(`${label}:manifest`, OWNER, 'packManifest', {
      repoId: R,
      packHash: hash,
      kind,
      sizeBytes: bytes.length,
      objectCount,
      chunkCount: chunks.length,
      storage: 0,
    });
  }
  await storeArtifact('pack', pack, packHash, 0, locator.objectCount);
  await storeArtifact('locator', locator.bytes, locatorHash, 1, locator.objectCount);

  // --- refs and the release -----------------------------------------------------------
  const oid = (hex) => Buffer.from(hex, 'hex');
  const refHash = (name) => sha256(Buffer.from(name));
  const ref = (name, newOid, prevOid) => ({
    repoId: R, refNameHash: refHash(name), refName: name, newOid: oid(newOid), ...(prevOid ? { prevOid: oid(prevOid) } : {}), vis: VIS,
  });
  await create('ref:main:1', OWNER, 'protectedRefUpdate', ref('refs/heads/main', commits.c1));
  await create('ref:main:2', MAINTAINER, 'protectedRefUpdate', ref('refs/heads/main', commits.c2, commits.c1));
  await create('ref:feature', COLLAB, 'refUpdate', ref('refs/heads/feature/greeting', commits.c3));
  await create('ref:tag', OWNER, 'refUpdate', ref(`refs/tags/${RELEASE_TAG}`, commits.c1));
  // A publish counts +1 toward the tag's one live release (`oneLive`).
  await create('release', OWNER, 'release', {
    repoId: R, tagName: RELEASE_TAG, name: RELEASE_TAG, notes: 'The first tagged commit of the fixture.', assets: '[]', vis: VIS, delta: 1,
  });

  // --- issues -------------------------------------------------------------------------
  // Issues and PRs share one dense sequence (`dense`): each is written at the next number, in
  // order. CONTRIB is not a member, so its issues carry no `asMember`.
  const issue = async (n, who, title, body) => ({
    id: await create(`issue:${n}`, who, 'issue', { repoId: R, number: n, tk: 0, title, body, vis: VIS }),
    number: n,
  });
  const i1 = await issue(1, CONTRIB, 'README should explain the event split', 'The README does not say why `authorEvent` is its own type.');
  const i2 = await issue(2, CONTRIB, 'Duplicate of #1', 'Opened twice by mistake.');
  const i3 = await issue(3, CONTRIB, 'Add a rules page', 'A page documenting the fold would help.');
  // #4 is a number that only an issue holds, which the jump-box spec (e2e/v2-explore.spec.ts x3)
  // needs.
  await issue(4, CONTRIB, 'Explain review requests', 'Who can request a review, and does it count?');
  const event = (step, who, type, target, kind, extra = {}) =>
    create(step, who, type, { repoId: R, targetId: idBytes(target.id), targetNumber: target.number, kind, ...extra });
  const move = (step, who, target, kind, opts) => create(step, who, 'transition', transition(R, target, kind, opts));
  await move('issue:2:author-close', CONTRIB, i2, TRANSITION.issueClose, { byAuthor: true });
  await event('issue:3:label', MAINTAINER, 'event', i3, EVENT.labelAdd, { value: 'docs' });
  await move('issue:3:close', MAINTAINER, i3, TRANSITION.issueClose);
  await event('issue:1:label', COLLAB, 'event', i1, EVENT.labelAdd, { value: 'question' });
  // A member's comment proves its membership (`asMember` = the signer).
  const comment = (step, who, target, body, extra = {}) =>
    create(step, who, 'comment', { repoId: R, targetId: idBytes(target.id), body, vis: VIS, ...extra });
  await comment('issue:1:comment:1', MAINTAINER, i1, 'Good point: the split is in docs/contracts/forge-v2.md §3.', { asMember: idBytes(MAINTAINER.id) });
  await comment('issue:3:comment:1', MAINTAINER, i3, 'Done in docs/rules.md; closing.', { asMember: idBytes(MAINTAINER.id) });

  // --- pull requests ------------------------------------------------------------------
  // Other suites open more PRs here, so readers must not assume these are the only numbers.
  const patch = async (n, who, title, body, headOid, sourceRef, extra = {}) => ({
    id: await create(`patch:${n}`, who, 'patch', {
      repoId: R,
      number: n,
      tk: 1,
      title,
      body,
      baseRefNameHash: refHash('refs/heads/main'),
      baseRefName: 'refs/heads/main',
      sourceRepoId: R,
      sourceRefNameHash: refHash(sourceRef),
      sourceRefName: sourceRef,
      headOid: oid(headOid),
      vis: VIS,
      ...extra,
    }),
    number: n,
  });
  const p5 = await patch(PULLS.approved, COLLAB, 'Greet by name', 'Reads the name from argv.', commits.c3, 'refs/heads/feature/greeting', { asMember: idBytes(COLLAB.id) });
  const p6 = await patch(PULLS.merged, MAINTAINER, 'Document the fold rules', 'Adds docs/rules.md.', commits.c2, 'refs/heads/main', { asMember: idBytes(MAINTAINER.id) });
  // A member's approval (verdict 1) must carry its proof.
  await create('patch:5:review', MAINTAINER, 'review', {
    repoId: R, patchId: idBytes(p5.id), verdict: 1, commitOid: oid(commits.c3), body: 'Looks good.', vis: VIS, asMember: idBytes(MAINTAINER.id),
  });
  await comment('patch:5:comment:1', OWNER, p5, 'Nice. Waiting on one more review.', { asMember: idBytes(OWNER.id) });
  // A writer's check run on PR #5's head: completed, so `outcome` is 1 and both times are set (ms).
  const finished = Date.now();
  await create('check:5', COLLAB, 'checkRun', {
    repoId: R,
    headOid: oid(commits.c3),
    name: CHECK,
    status: 'completed',
    conclusion: 'success',
    outcome: checkOutcome('completed', 'success'),
    startedAt: finished - 60_000,
    completedAt: finished,
    summary: 'The fixture build passed.',
    vis: VIS,
  });
  await move('patch:6:merge', OWNER, p6, TRANSITION.merge, { oid: oid(commits.c2) });

  // --- review parity (docs/design/review-parity-spec.md §3, §4) ------------------------
  // PR #7 by CONTRIB, who is not a member: its state moves are author transitions (`asAuthor`),
  // its other author actions are `authorEvent`s.
  const p7 = await patch(PULLS.reviewParity, CONTRIB, 'Greet by name, reviewed', 'Opened as a draft from the commit before the greeting, then moved to it.', commits.c2, 'refs/heads/feature/greeting');
  await move('pr7:draft', CONTRIB, p7, TRANSITION.draft, { byAuthor: true });
  await event('pr7:head-update', CONTRIB, 'authorEvent', p7, EVENT.headUpdate, { oid: oid(commits.c3) });
  await event('pr7:request', OWNER, 'event', p7, EVENT.reviewRequest, { refId: idBytes(MAINTAINER.id) });
  const review7 = await create('pr7:review', MAINTAINER, 'review', {
    repoId: R,
    patchId: idBytes(p7.id),
    verdict: 2,
    commitOid: oid(commits.c3),
    body: 'One suggestion on the greeting.',
    commentCount: 1,
    vis: VIS,
    asMember: idBytes(MAINTAINER.id),
  });
  const thread7 = await comment('pr7:review-comment', MAINTAINER, p7, 'Default to "world":\n\n```suggestion\n    let name = std::env::args().nth(1).unwrap_or("world".into());\n    println!("hello, {name}");\n```\n', {
    reviewId: idBytes(review7),
    commitOid: oid(commits.c3),
    path: 'src/main.rs',
    startLine: 2,
    line: 3,
    side: 1,
    asMember: idBytes(MAINTAINER.id),
  });
  // A reply names the thread's root comment.
  await comment('pr7:reply', CONTRIB, p7, 'Keeping "forge" on purpose; resolving.', { replyTo: idBytes(thread7) });
  await event('pr7:resolve', CONTRIB, 'authorEvent', p7, EVENT.threadResolve, { refId: idBytes(thread7) });
  await event('pr7:dismiss', OWNER, 'event', p7, EVENT.reviewDismiss, { refId: idBytes(review7), value: 'the author answered the suggestion' });
  await create('policy', OWNER, 'policy', {
    repoId: R,
    requiredApprovals: 1,
    approverRole: 1,
    requireChecks: false,
    mergeMethods: 3,
  });

  // --- social and the C-1 types (platform-parity-spec §6) --------------------------------
  // CONTRIB's star counts toward Trending through its beat. The beat names the repo's owner, who
  // may not beat its own repo. CONTRIB also watches the repo.
  await createIndexOnly('star:contrib', CONTRIB, 'star', { repoId: R });
  await createIndexOnly('starBeat:contrib', CONTRIB, 'starBeat', { repoId: R, vis: VIS, repoOwner: idBytes(OWNER.id) });
  await createIndexOnly('watch:contrib', CONTRIB, 'watch', { repoId: R });
  // Topics (forge-core, the repo owner's): Explore by topic counts `fixture` and `forge-v2`.
  await create('topic:fixture', OWNER, 'topic', { repoId: R, name: 'fixture', vis: VIS });
  await create('topic:forge-v2', OWNER, 'topic', { repoId: R, name: 'forge-v2', vis: VIS });
  // A milestone holding issue #1 (open) and issue #3 (closed); issue #1 pinned (the last step).
  await create('milestone:v0.2', OWNER, 'milestone', {
    repoId: R,
    title: 'v0.2',
    description: 'The review-parity release.',
    dueOn: Date.UTC(2026, 11, 1),
  });
  await event('milestone:issue:1', MAINTAINER, 'event', i1, EVENT.milestoneSet, { value: 'v0.2' });
  await event('milestone:issue:3', MAINTAINER, 'event', i3, EVENT.milestoneSet, { value: 'v0.2' });
  await event('pin:issue:1', OWNER, 'event', i1, EVENT.pin);

  const summary = {
    network: key,
    ...contracts,
    demo: { owner: OWNER.id, name: DEMO, repoId, reviewParityPull: PULLS.reviewParity },
    pulls: PULLS,
    empty: { owner: MAINTAINER.id, name: EMPTY, repoId: emptyId },
    check: { name: CHECK, sha: commits.c3, reporter: COLLAB.id },
    release: RELEASE_TAG,
    commits,
    packHash: packHash.toString('hex'),
    locatorHash: locatorHash.toString('hex'),
  };
  const summaryPath = a.summary ?? join(ROOT, 'deployments', 'fixtures', `${key}.json`);
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

runIfMain(import.meta.url, main);

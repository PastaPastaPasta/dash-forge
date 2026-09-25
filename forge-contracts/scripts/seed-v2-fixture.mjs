#!/usr/bin/env node
// seed-v2-fixture.mjs — seed the forge-v2 read fixture that forge-web's devnet Playwright
// specs and live tests read.
//
//   node forge-contracts/scripts/seed-v2-fixture.mjs [--network devnet --devnet-name moutai]
//
// Needs `npm ci` in forge-contracts/sdk-v2 (evo-sdk 4.2, protocol 14) and the devnet test
// identities in ~/.config/dash-forge/test-identities/<network>/ (OWNER, MAINTAINER, COLLAB,
// CONTRIB).
//
// It writes, as the forge-v2 contracts define them (docs/contracts/forge-v2.md):
//   * repo `forge-v2-demo` owned by OWNER; OWNER and MAINTAINER as maintainers, COLLAB as a
//     writer; a config protecting refs/heads/main;
//   * one deterministic git history (three commits, a feature branch, a tag) packed with git,
//     stored on Platform as `chunk` documents behind a kind-0 `packManifest`, plus a kind-1
//     objectLocator over it, so the web app browses it through the published index;
//   * refs: main by protectedRefUpdate (two updates), the feature branch by COLLAB's
//     refUpdate, the tag by OWNER;
//   * issues, a PR still open with an approval, a merged PR, comments, `event`s and an
//     `authorEvent`, a star;
//   * repo `forge-v2-empty` owned by MAINTAINER, with no refs (the empty-repo state).
//
// The git-remote-dash v2 push path is not there yet (forge-core PR C), which is why the
// pack and the locator are written here directly. The chunk layout is forge-core
// `pack::split` (4900-byte fields, three per chunk); the locator is `pack/locator.rs`
// (fanout || 36-byte rows, deltaChainSpan = the sentinel so readers walk each base).
//
// Idempotent: the result of every step is recorded in
// ~/.cache/dash-forge/seed-v2-<network>.json and a rerun skips what is recorded. Delete that
// file (and pick new repo names) to seed from scratch.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEvoSdk } from './deploy-v2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const DEMO = 'forge-v2-demo';
const EMPTY = 'forge-v2-empty';
const FIELD_MAX = 4900;
const FIELDS_PER_DOC = 3;
const FANOUT_LEN = 1024;
const ROW_LEN = 36;
const SPAN_SENTINEL = 0xffffffff;
const EVENT = { close: 1, reopen: 2, merge: 3, labelAdd: 4 };

const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);

function args() {
  const out = { network: 'devnet', 'devnet-name': 'moutai' };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1];
  return out;
}

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
  git(dir, ['tag', 'v0.1.0', c1]);
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

async function main() {
  const a = args();
  const network = a.network;
  const devnetName = network === 'devnet' ? a['devnet-name'] : null;
  const key = devnetName ? `devnet-${devnetName}` : network;
  const dep = JSON.parse(readFileSync(join(ROOT, 'deployments', `${key}.json`), 'utf8'));
  const core = dep.v2?.forgeCore?.contractId;
  const collab = dep.v2?.forgeCollab?.contractId;
  if (!core || !collab) throw new Error(`no forge-v2 deployment recorded for ${key}`);

  const evo = await loadEvoSdk();
  const { EvoSDK, Document, IdentityPublicKey, IdentitySigner, PrivateKey } = evo;
  const sdk = new EvoSDK({
    network,
    trusted: true,
    ...(devnetName ? { devnetName } : {}),
    ...(dep.dapiAddresses ? { addresses: dep.dapiAddresses } : {}),
    settings: { timeoutMs: 30000 },
  });
  await sdk.connect();

  const idDir = join(homedir(), '.config/dash-forge/test-identities', key);
  const load = (name) => {
    const rec = JSON.parse(readFileSync(join(idDir, `${name}.identity.json`), 'utf8'));
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
    return { name, id: rec.identityId, identityKey, signer };
  };
  const OWNER = load('OWNER');
  const MAINTAINER = load('MAINTAINER');
  const COLLAB = load('COLLAB');
  const CONTRIB = load('CONTRIB');

  const statePath = join(homedir(), '.cache/dash-forge', `seed-v2-${key}.json`);
  mkdirSync(dirname(statePath), { recursive: true });
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const b58 = (s) => Buffer.from(evo.Identifier.fromBase58(s).toBytes());
  const version = sdk.version();

  /** Create one document (once: the step name is recorded with its id). */
  async function create(step, who, contractId, documentTypeName, data) {
    if (state[step]) return state[step];
    const base = new Document({ properties: {}, documentTypeName, dataContractId: contractId, ownerId: who.id });
    const document = Document.fromObject({ ...base.toObject(), ...data }, version);
    const created = await sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer });
    const id = created.id.toBase58();
    state[step] = id;
    save();
    log(`${step}: ${documentTypeName} ${id} (${who.name})`);
    return id;
  }

  // --- repos, membership, config -----------------------------------------------------
  const repoId = await create('repo', OWNER, core, 'repo', {
    name: DEMO,
    visibility: 'public',
    displayName: 'forge-v2 demo',
    description: 'The forge-v2 read fixture: code, issues and pull requests in the shared contracts.',
    defaultBranch: 'main',
    topics: ['fixture', 'forge-v2'],
  });
  const R = b58(repoId);
  await create('maintainer:owner', OWNER, core, 'maintainer', { repoId: R, memberId: b58(OWNER.id) });
  await create('config', OWNER, core, 'config', {
    repoId: R,
    defaultBranch: 'main',
    protectedPatterns: ['refs/heads/main'],
    backend: { mode: 0 },
  });
  await create('maintainer:maintainer', OWNER, core, 'maintainer', { repoId: R, memberId: b58(MAINTAINER.id) });
  await create('writer:collab', OWNER, core, 'writer', { repoId: R, memberId: b58(COLLAB.id) });

  const emptyId = await create('repo:empty', MAINTAINER, core, 'repo', {
    name: EMPTY,
    visibility: 'public',
    description: 'A forge-v2 repository with nothing pushed yet.',
  });
  const E = b58(emptyId);
  await create('empty:maintainer', MAINTAINER, core, 'maintainer', { repoId: E, memberId: b58(MAINTAINER.id) });
  await create('empty:config', MAINTAINER, core, 'config', { repoId: E, defaultBranch: 'main' });

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

  async function storeArtifact(label, bytes, hash, kind, objectCount) {
    const chunks = split(bytes);
    for (let seq = 0; seq < chunks.length; seq++) {
      const data = { repoId: R, packHash: hash, seq };
      chunks[seq].forEach((field, i) => {
        data[`d${i}`] = Uint8Array.from(field);
      });
      await create(`${label}:chunk:${seq}`, OWNER, core, 'chunk', data);
    }
    return create(`${label}:manifest`, OWNER, core, 'packManifest', {
      repoId: R,
      packHash: hash,
      kind,
      sizeBytes: bytes.length,
      objectCount,
      chunkCount: chunks.length,
      storage: 0,
      offsetIndexParts: 0,
    });
  }
  await storeArtifact('pack', pack, packHash, 0, locator.objectCount);
  await storeArtifact('locator', locator.bytes, locatorHash, 1, locator.objectCount);

  // --- refs ---------------------------------------------------------------------------
  const oid = (hex) => Buffer.from(hex, 'hex');
  const refHash = (name) => sha256(Buffer.from(name));
  await create('ref:main:1', OWNER, core, 'protectedRefUpdate', {
    repoId: R, refNameHash: refHash('refs/heads/main'), refName: 'refs/heads/main', newOid: oid(commits.c1),
  });
  await create('ref:main:2', MAINTAINER, core, 'protectedRefUpdate', {
    repoId: R, refNameHash: refHash('refs/heads/main'), refName: 'refs/heads/main', prevOid: oid(commits.c1), newOid: oid(commits.c2),
  });
  await create('ref:feature', COLLAB, core, 'refUpdate', {
    repoId: R, refNameHash: refHash('refs/heads/feature/greeting'), refName: 'refs/heads/feature/greeting', newOid: oid(commits.c3),
  });
  await create('ref:tag', OWNER, core, 'refUpdate', {
    repoId: R, refNameHash: refHash('refs/tags/v0.1.0'), refName: 'refs/tags/v0.1.0', newOid: oid(commits.c1),
  });

  // --- issues -------------------------------------------------------------------------
  const issue = (n, who, title, body) =>
    create(`issue:${n}`, who, collab, 'issue', { repoId: R, number: n, title, body });
  const i1 = await issue(1, CONTRIB, 'README should explain the event split', 'The README does not say why `authorEvent` is its own type.');
  const i2 = await issue(2, CONTRIB, 'Duplicate of #1', 'Opened twice by mistake.');
  const i3 = await issue(3, CONTRIB, 'Add a rules page', 'A page documenting the fold would help.');
  const ev = (step, who, type, targetId, targetNumber, kind, extra = {}) =>
    create(step, who, collab, type, { repoId: R, targetId: b58(targetId), targetNumber, kind, ...extra });
  await ev('issue:2:author-close', CONTRIB, 'authorEvent', i2, 2, EVENT.close);
  await ev('issue:3:label', MAINTAINER, 'event', i3, 3, EVENT.labelAdd, { value: 'docs' });
  await ev('issue:3:close', MAINTAINER, 'event', i3, 3, EVENT.close);
  await ev('issue:1:label', COLLAB, 'event', i1, 1, EVENT.labelAdd, { value: 'question' });
  const comment = (step, who, targetId, body) =>
    create(step, who, collab, 'comment', { repoId: R, targetId: b58(targetId), body });
  await comment('issue:1:comment:1', MAINTAINER, i1, 'Good point: the split is in docs/contracts/forge-v2.md §3.');
  await comment('issue:3:comment:1', MAINTAINER, i3, 'Done in docs/rules.md; closing.');

  // --- pull requests ------------------------------------------------------------------
  const patch = (n, who, title, body, headOid, sourceRef) =>
    create(`patch:${n}`, who, collab, 'patch', {
      repoId: R,
      number: n,
      title,
      body,
      baseRefNameHash: refHash('refs/heads/main'),
      baseRefName: 'refs/heads/main',
      sourceRepoId: R,
      sourceRefNameHash: refHash(sourceRef),
      sourceRefName: sourceRef,
      headOid: oid(headOid),
    });
  const p1 = await patch(1, COLLAB, 'Greet by name', 'Reads the name from argv.', commits.c3, 'refs/heads/feature/greeting');
  const p2 = await patch(2, MAINTAINER, 'Document the fold rules', 'Adds docs/rules.md.', commits.c2, 'refs/heads/main');
  await create('patch:1:review', MAINTAINER, collab, 'review', {
    repoId: R, patchId: b58(p1), verdict: 1, commitOid: oid(commits.c3), body: 'Looks good.',
  });
  await comment('patch:1:comment:1', OWNER, p1, 'Nice. Waiting on one more review.');
  await ev('patch:2:merge', OWNER, 'event', p2, 2, EVENT.merge, { oid: oid(commits.c2) });

  // --- social ---------------------------------------------------------------------------
  // `star` is indexOnly: evo-sdk 4.2's strict wait refuses that transition family after it
  // lands, so the star is confirmed by a count read instead.
  if (!state['star:contrib']) {
    const starCount = async () => {
      const counts = await sdk.documents.count({
        dataContractId: collab,
        documentTypeName: 'star',
        where: [['repoId', '==', repoId]],
      });
      let n = 0n;
      for (const v of counts.values()) n += v;
      return n;
    };
    if ((await starCount()) === 0n) {
      const base = new Document({ properties: {}, documentTypeName: 'star', dataContractId: collab, ownerId: CONTRIB.id });
      const document = Document.fromObject({ ...base.toObject(), repoId: R }, version);
      try {
        await sdk.documents.create({ document, identityKey: CONTRIB.identityKey, signer: CONTRIB.signer });
      } catch (e) {
        if (!/VerifiedDocuments snapshot/.test(String(e?.message ?? e))) throw e;
      }
      for (let i = 0; i < 10 && (await starCount()) === 0n; i++) await new Promise((r) => setTimeout(r, 2000));
      if ((await starCount()) === 0n) throw new Error('the star did not land');
    }
    state['star:contrib'] = 'indexOnly';
    save();
    log('star:contrib');
  }

  const summary = {
    network: key,
    forgeCore: core,
    forgeCollab: collab,
    demo: { owner: OWNER.id, name: DEMO, repoId },
    empty: { owner: MAINTAINER.id, name: EMPTY, repoId: emptyId },
    commits,
    packHash: packHash.toString('hex'),
    locatorHash: locatorHash.toString('hex'),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e?.stack ?? e?.message ?? String(e));
  process.exit(1);
});

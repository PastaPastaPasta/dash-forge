// The UPDATE-1 probe (roadmap D4, dash-forge-qa design/v5/CONTRACT-UPDATE-1.md): what the batched
// contract update costs per write, and what it does to a reader that still holds the old
// contract, measured on a throwaway contract that goes through the same kind of update.
//
//   node forge-contracts/scripts/update1-probe.mjs --devnet-name sakura --identity <file> [--state <file.json>] [--n 3]
//
// 1. Registers a throwaway contract at version 1 holding a bare copy of the registered release
//    type (registered/forge-core.v1.json; references, gates and total-reading rules dropped, as in
//    rc1-fee-probe.mjs), and writes releases to it.
// 2. Updates it in place to version 2: release gains `targetOid` and the two new types arrive,
//    bare packMirror and ban (build.py with every UPDATE-1 flag on). The update's fee is measured.
// 3. Writes releases without and with `targetOid`, packMirrors and bans: the per-write costs.
// 4. Reads the releases through an SDK that cached the version-1 contract before the update, and
//    records what it gets. A document written under version 2 of an updated type carries the new
//    property's presence byte, which rs-dpp's v3 decoder refuses with "trailing bytes ... refetch
//    the contract" (packages/rs-dpp/src/document/v0/serialize/v3.rs:557-570): every client must
//    refetch on that error. Then it drops the cached contract and reads again.
//
// --state keeps the throwaway contract's id and stage, so a rerun resumes rather than registering
// another. Prints one JSON report on stdout.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PROTOCOL_VERSION, contractId, loadEvoSdk } from './deploy-v2.mjs';
import { bare } from './lib/rc2-probe.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, t, i, a) => (t.startsWith('--') ? [...acc, [t.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]] : acc), []));
const devnetName = args['devnet-name'] || 'sakura';
const N = Number(args.n ?? 3);
const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);
if (typeof args.identity !== 'string') {
  console.error('usage: update1-probe.mjs --devnet-name <name> --identity <file> [--state <file>] [--n 3]');
  process.exit(2);
}
const statePath = String(args.state ?? join(homedir(), '.cache', 'dash-forge', `update1-probe-${devnetName}.json`));
const dep = JSON.parse(readFileSync(join(ROOT, 'deployments', `devnet-${devnetName}.json`), 'utf8'));
const mean = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);

/** The probe schemas: version 1 (the registered release) and version 2 (UPDATE-1 on). */
function probeSchemas() {
  const v1core = JSON.parse(readFileSync(join(ROOT, 'contracts', 'registered', 'forge-core.v1.json'), 'utf8'));
  const out = mkdtempSync(join(tmpdir(), 'update1-probe-'));
  try {
    execFileSync('python3', [join(ROOT, 'schema', 'build.py'), '--on', 'release_target_oid', '--out', out], { stdio: 'pipe' });
    const core = JSON.parse(readFileSync(join(out, 'forge-core.json'), 'utf8'));
    const collab = JSON.parse(readFileSync(join(out, 'forge-collab.json'), 'utf8'));
    const defs = (c, names) => Object.fromEntries(names.map((n) => [n, c.schemaDefs[n]]));
    const v1 = { schemaDefs: defs(v1core, ['id', 'oid', 'h32', 'enc', 'vis']), documentSchemas: { release: bare(v1core.documentSchemas.release) } };
    const v2 = {
      schemaDefs: defs(core, ['id', 'oid', 'h32', 'enc', 'vis', 'hid']),
      documentSchemas: {
        release: bare(core.documentSchemas.release),
        packMirror: bare(core.documentSchemas.packMirror),
        ban: bare(collab.documentSchemas.ban),
      },
    };
    return { v1, v2 };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const evo = await loadEvoSdk();
const { EvoSDK, DataContract, Document, IdentityPublicKey, IdentitySigner, PrivateKey, Identifier } = evo;
const connect = async () => {
  const s = new EvoSDK({ network: 'devnet', devnetName, trusted: true, addresses: dep.dapiAddresses, settings: { timeoutMs: 60000 } });
  await s.connect();
  return s;
};
const sdk = await connect();
const version = sdk.version();

const rec = JSON.parse(readFileSync(String(args.identity), 'utf8'));
const owner = rec.identityId;
const keyOf = (level) => {
  const k = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === level);
  const signer = new IdentitySigner();
  signer.addKey(PrivateKey.fromWIF(k.privateKeyWif));
  return {
    identityKey: new IdentityPublicKey({ keyId: k.id, purpose: k.purpose, securityLevel: k.securityLevel, keyType: k.keyType, isReadOnly: false, data: Buffer.from(k.publicKeyHex, 'hex') }),
    signer,
    privateKey: PrivateKey.fromWIF(k.privateKeyWif),
  };
};
const high = keyOf('HIGH');
const critical = keyOf('CRITICAL');
const balance = async () => BigInt((await sdk.identities.balance(owner)) ?? 0n);
async function settled(differentFrom) {
  let last = await balance();
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await balance();
    if (now === last && now !== differentFrom) return now;
    last = now;
  }
  return last;
}
async function priced(fn) {
  const before = await settled();
  await fn();
  return Number(before - (await settled(before)));
}

mkdirSync(dirname(statePath), { recursive: true });
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
const { v1, v2 } = probeSchemas();
const contractJson = (id, ver, schema) => ({ $formatVersion: '1', id, ownerId: owner, version: ver, description: `UPDATE-1 probe v${ver}`, ...schema });

async function create(on, contract, type, data) {
  const base = new Document({ properties: {}, documentTypeName: type, dataContractId: contract, ownerId: owner });
  const document = Document.fromObject({ ...base.toObject(), ...data }, version);
  return on.documents.create({ document, ...high });
}
const release = (extra = {}) => ({ repoId: randomBytes(32), tagName: `v${randomBytes(4).toString('hex')}`, name: 'probe', notes: 'UPDATE-1 fee probe', assets: '[]', vis: 'public', delta: 1, ...extra });
const report = { network: `devnet-${devnetName}`, fees: {}, compat: {} };

// 1. version 1 and its releases
if (!state.id || !(await sdk.contracts.fetch(state.id))) {
  const nonce = (BigInt((await sdk.identities.nonce(owner)) ?? 0n) & 0xFFFFFFFFFFn) + 1n;
  const id = contractId(owner, nonce);
  const dataContract = DataContract.fromJSON(contractJson(id, 1, v1), true, PROTOCOL_VERSION);
  const cost = await priced(() => sdk.contracts.publish({ dataContract, ...critical }));
  Object.assign(state, { id, stage: 1, registrationCredits: cost });
  save();
  log(`probe contract ${id} registered at version 1 (${cost} credits)`);
}
report.contract = state.id;
// A reader that holds version 1 from before the update (the stale snapshot a live client keeps)
// (seeded with the version-1 schema, as the web app seeds its bundled snapshot, so a rerun that
// resumes after the update still has a version-1 holder)
const stale = await connect();
const heldV1 = DataContract.fromJSON(contractJson(state.id, 1, v1), true, PROTOCOL_VERSION);
if (!stale.wasm.addKnownContract(heldV1)) throw new Error('the stale reader has no trusted context to seed');
report.compat.staleReaderHoldsVersion = Number(heldV1.version);
if (state.stage === 1) {
  state.v1Release = [];
  await create(sdk, state.id, 'release', release()); // warm-up: a type's first write costs more
  for (let i = 0; i < N; i++) state.v1Release.push(await priced(() => create(sdk, state.id, 'release', release())));
  save();
  // 2. the update
  const contract = DataContract.fromJSON(contractJson(state.id, 2, v2), true, PROTOCOL_VERSION);
  const before = await settled();
  try {
    await sdk.contracts.update({ dataContract: contract, identityKey: critical.identityKey, signer: critical.signer });
  } catch (e) {
    // evo-sdk proves an update by the state it affected (deploy-v2.mjs updateCore says the same)
    if (!/affected state only|VerifiedDataContract snapshot/i.test(String(e?.message ?? e))) throw e;
  }
  state.updateCredits = Number(before - (await settled(before)));
  const fetched = await sdk.contracts.fetch(state.id);
  if (Number(fetched?.version) !== 2) throw new Error(`update did not land: version ${fetched?.version}`);
  state.stage = 2;
  save();
  log(`probe contract updated to version 2 (${state.updateCredits} credits)`);
}
report.fees.registrationCredits = state.registrationCredits;
report.fees.updateCredits = state.updateCredits;
report.fees.releaseV1 = mean(state.v1Release);

// 3. per-write costs under version 2
const fresh = await connect();
await fresh.contracts.fetch(state.id);
await create(fresh, state.id, 'packMirror', { repoId: randomBytes(32), packHash: randomBytes(32), kind: 1, uris: ['https://mirror.example.com/p/x.pack'] });
await create(fresh, state.id, 'ban', { repoId: randomBytes(32), identityId: randomBytes(32), reason: 1 });
const costs = { releaseV2NoTarget: [], releaseV2Target20: [], packMirror: [], ban: [] };
for (let i = 0; i < N; i++) {
  costs.releaseV2NoTarget.push(await priced(() => create(fresh, state.id, 'release', release())));
  costs.releaseV2Target20.push(await priced(() => create(fresh, state.id, 'release', release({ targetOid: randomBytes(20) }))));
  costs.packMirror.push(await priced(() => create(fresh, state.id, 'packMirror', { repoId: randomBytes(32), packHash: randomBytes(32), kind: 1, uris: ['https://mirror.example.com/p/abcdef0123456789.pack'] })));
  costs.ban.push(await priced(() => create(fresh, state.id, 'ban', { repoId: randomBytes(32), identityId: randomBytes(32), reason: 1 })));
}
for (const [k, v] of Object.entries(costs)) report.fees[k] = mean(v);
report.fees.samples = { releaseV1: state.v1Release, ...costs };

// 4. the stale reader: the version-1 contract cached before the update
const query = { dataContractId: state.id, documentTypeName: 'release', where: [], orderBy: [], limit: 100 };
const attempt = async (on) => {
  try {
    const docs = await on.documents.query(query);
    return { ok: true, documents: docs.size };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 400) };
  }
};
report.compat.staleRead = await attempt(stale);
// A write through the stale reader: the node validates against version 2, so it lands; does the
// SDK's own wait (a proof of the written document) decode it?
try {
  await create(stale, state.id, 'release', release());
  report.compat.staleWrite = { ok: true };
} catch (e) {
  report.compat.staleWrite = { ok: false, error: String(e?.message ?? e).slice(0, 400) };
}
stale.wasm.removeCachedContract(Identifier.fromBase58(state.id));
report.compat.refetched = Number((await stale.contracts.fetch(state.id))?.version);
report.compat.readAfterRefetch = await attempt(stale);
log(`stale read: ${JSON.stringify(report.compat.staleRead)}; after refetch: ${JSON.stringify(report.compat.readAfterRefetch)}`);
console.log(JSON.stringify(report, null, 2));
process.exit(0);

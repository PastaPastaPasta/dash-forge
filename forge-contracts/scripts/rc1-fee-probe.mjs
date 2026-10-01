// The step-8 fee gates of the RC1 registration (WIPE-DECISIONS D-3, SCOPE-DECISION COMM-9 and
// check_outcome): what one index feature adds to a write, measured on chain as the difference
// between two small probe contracts that differ in that feature alone.
//
//   node forge-contracts/scripts/rc1-fee-probe.mjs --devnet-name bonsia --identity <file> [--state <file.json>] [--n 3]
//
// Probe A copies RC1's chunk, star and checkRun types; probe B is the same without
//   - chunk:    `documentsCountable`                          (D-3: kill switch above +5 %)
//   - star:     `byOwner` countable                           (COMM-9: kill switch above +5 %)
//   - checkRun: the `outcome (repoId, headOid, outcome)` index (O-07: fee reported, no switch)
// Cross-contract references and gates are dropped from both (they cost the same either way),
// so the identity writes both sets itself. The same documents (fresh ids) are written to both
// contracts, n times each, and the mean balance deltas are compared.
//
// --state keeps the probe contracts' ids, so a rerun measures again without registering again.
//
// --rc2 runs the RC2 registration gates instead (design/v5/PLAN.md §4.2 step 2; lib/rc2-probe.mjs):
// four probe contracts cut from the build.py variants (ALL, S2, S3, NONE), and per probe pair
//   - review:  S2 toAuthor alone, S3 author alone, and both, against neither   (ship each <= +10 %)
//   - star:    the fused star (C1) against star + starBeat                      (ship C1 when <=)
// It prints the build.py flags to turn off; the decision is then a FLAGS edit (build.py header).
//
//   node forge-contracts/scripts/rc1-fee-probe.mjs --rc2 --devnet-name bonsia --identity <file> [--n 4]
//   node forge-contracts/scripts/rc1-fee-probe.mjs --rc2 --emit <dir>   # offline: the probe contracts
//        and vectors, for `contract-validate --vectors <dir>/vectors <dir>/contracts/rc2-*.json`
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractId, loadEvoSdk } from './deploy-v2.mjs';
import { PROBES, RC2_DOCS, emitted, materialize, probeSchemas } from './lib/rc2-probe.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, t, i, a) => (t.startsWith('--') ? [...acc, [t.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]] : acc), []));
const devnetName = args['devnet-name'] || 'bonsia';
const N = Number(args.n ?? 4);
const RC2 = Boolean(args.rc2);
const statePath = String(args.state ?? join(homedir(), '.cache', 'dash-forge', `${RC2 ? 'rc2' : 'rc1'}-fee-probe-${devnetName}.json`));
const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);

if (RC2 && args.emit) {
  const dir = resolve(String(args.emit));
  for (const sub of ['contracts', 'vectors']) mkdirSync(join(dir, sub), { recursive: true });
  for (const [probe, schema] of Object.entries(probeSchemas())) {
    const { contract, vectors } = emitted(probe, schema);
    writeFileSync(join(dir, 'contracts', `rc2-${probe}.json`), `${JSON.stringify(contract, null, 2)}\n`);
    writeFileSync(join(dir, 'vectors', `rc2-${probe}.json`), `${JSON.stringify(vectors, null, 2)}\n`);
  }
  log(`wrote contracts/rc2-{${PROBES.join(',')}}.json and their vectors/ to ${dir}`);
  process.exit(0);
}
const dep = JSON.parse(readFileSync(join(ROOT, 'deployments', `devnet-${devnetName}.json`), 'utf8'));

const load = (name) => JSON.parse(readFileSync(join(ROOT, 'contracts', `${name}.json`), 'utf8'));
const core = load('forge-core');
const comm = load('forge-community');

/** A copy of an RC1 type with every reference and gate removed. */
function bare(schema) {
  const s = JSON.parse(JSON.stringify(schema));
  delete s.ownerRefersTo;
  for (const p of Object.values(s.properties)) delete p.refersTo;
  if (s.propertyConstraints) {
    // only the rules that read nothing else (none of these three reads a total or a reference)
    for (const [k, v] of Object.entries(s.propertyConstraints)) if (JSON.stringify(v).match(/countOf|sumOf/)) delete s.propertyConstraints[k];
  }
  return s;
}
function probe(withFeatures) {
  const chunk = bare(core.documentSchemas.chunk);
  const star = bare(comm.documentSchemas.star);
  const checkRun = bare(comm.documentSchemas.checkRun);
  if (!withFeatures) {
    delete chunk.documentsCountable;
    delete star.indices.find((i) => i.name === 'byOwner').countable;
    checkRun.indices = checkRun.indices.filter((i) => i.name !== 'outcome');
  }
  return {
    description: `RC1 fee probe ${withFeatures ? 'A (with)' : 'B (without)'}`,
    schemaDefs: { id: core.schemaDefs.id, hid: core.schemaDefs.hid, u32: core.schemaDefs.u32, oid: comm.schemaDefs.oid, vis: comm.schemaDefs.vis },
    documentSchemas: { chunk, star, checkRun },
  };
}

const evo = await loadEvoSdk();
const { EvoSDK, DataContract, Document, IdentityPublicKey, IdentitySigner, PrivateKey } = evo;
const sdk = new EvoSDK({ network: 'devnet', devnetName, trusted: true, addresses: dep.dapiAddresses, settings: { timeoutMs: 60000 } });
await sdk.connect();
const version = sdk.version();

const rec = JSON.parse(readFileSync(String(args.identity), 'utf8'));
const keyOf = (level) => {
  const k = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === level);
  const signer = new IdentitySigner();
  signer.addKey(PrivateKey.fromWIF(k.privateKeyWif));
  return { identityKey: new IdentityPublicKey({ keyId: k.id, purpose: k.purpose, securityLevel: k.securityLevel, keyType: k.keyType, isReadOnly: false, data: Buffer.from(k.publicKeyHex, 'hex') }), signer };
};
const owner = rec.identityId;
const high = keyOf('HIGH');
const critical = keyOf('CRITICAL');
const balance = async () => BigInt((await sdk.identities.balance(owner)) ?? 0n);
/** The balance once two reads 2 s apart agree (a node can answer from the block before a write). */
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
if (RC2) {
  // Register the four probes (each once: --state keeps their ids), then one patch per probe for
  // its reviews to name (review.patchId's `where` reads repoId and vis, so every review shares R)
  const schemas = probeSchemas();
  const R = randomBytes(32);
  for (const probe of PROBES) {
    if (state[probe] && (await sdk.contracts.fetch(state[probe]))) continue;
    const nonce = (BigInt((await sdk.identities.nonce(owner)) ?? 0n) & 0xFFFFFFFFFFn) + 1n;
    const id = contractId(owner, nonce);
    const dataContract = DataContract.fromJSON({ $formatVersion: '1', id, ownerId: owner, version: 1, ...schemas[probe] }, true, 14);
    state[probe] = id;
    state[`${probe}RegistrationCredits`] = await priced(() => sdk.contracts.publish({ dataContract, ...critical }));
    delete state.patches;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    log(`probe ${probe}: ${id} registered (${state[`${probe}RegistrationCredits`]} credits)`);
  }
  const patches = {};
  for (const probe of PROBES) {
    const document = Document.fromObject({ ...new Document({ properties: {}, documentTypeName: 'patch', dataContractId: state[probe], ownerId: owner }).toObject(), ...materialize(RC2_DOCS.patch, { repoId: R }, randomBytes) }, version);
    const created = await sdk.documents.create({ document, ...high });
    patches[probe] = Buffer.from(created.id.toBytes());
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const costs = { review: Object.fromEntries(PROBES.map((p) => [p, []])), star: { ALL: [], NONE: [] } };
  for (let i = 0; i < N; i++) {
    // the same review on every probe, in an order rotated each round so a drift over the run cancels out
    const review = materialize(RC2_DOCS.review, { repoId: R }, randomBytes);
    const order = PROBES.map((_, j) => PROBES[(i + j) % PROBES.length]);
    for (const probe of order) costs.review[probe].push(await write(state[probe], 'review', { ...review, patchId: patches[probe] }));
    const repoId = randomBytes(32);
    const beat = materialize(RC2_DOCS.starBeat, { repoId }, randomBytes);
    for (const probe of i % 2 === 0 ? ['ALL', 'NONE'] : ['NONE', 'ALL']) {
      let credits = await write(state[probe], 'star', { repoId });
      if (probe === 'NONE') credits += await write(state.NONE, 'starBeat', beat);
      costs.star[probe].push(credits);
    }
  }
  const none = mean(costs.review.NONE);
  const added = (probe) => Number((100 * (mean(costs.review[probe]) / none - 1)).toFixed(2));
  const fees = {
    review: Object.fromEntries(PROBES.map((p) => [p, Math.round(mean(costs.review[p]))])),
    reviewAddedPercent: { S2: added('S2'), S3: added('S3'), both: added('ALL') },
    star: { fused: Math.round(mean(costs.star.ALL)), starPlusBeat: Math.round(mean(costs.star.NONE)) },
    samples: costs,
  };
  const gates = {
    review_to_author: fees.reviewAddedPercent.S2 <= 10,
    review_author: fees.reviewAddedPercent.S3 <= 10,
    fused_star: fees.star.fused <= fees.star.starPlusBeat,
  };
  const off = Object.entries(gates).filter(([, pass]) => !pass).map(([flag]) => flag);
  log(`review: S2 +${fees.reviewAddedPercent.S2} %, S3 +${fees.reviewAddedPercent.S3} %, both +${fees.reviewAddedPercent.both} % (on ${fees.review.NONE} credits)`);
  log(`star: fused ${fees.star.fused} against star + starBeat ${fees.star.starPlusBeat} credits`);
  log(off.length ? `turn off in build.py FLAGS: ${off.join(', ')}` : 'every RC2 fee gate passes: keep the FLAGS defaults');
  console.log(JSON.stringify({ probes: Object.fromEntries(PROBES.map((p) => [p, state[p]])), fees, gates, turnOff: off }, null, 2));
  process.exit(0);
}
for (const [key, withFeatures] of [['A', true], ['B', false]]) {
  if (state[key] && (await sdk.contracts.fetch(state[key]))) continue;
  const json = probe(withFeatures);
  const nonce = (BigInt((await sdk.identities.nonce(owner)) ?? 0n) & 0xFFFFFFFFFFn) + 1n;
  const id = contractId(owner, nonce);
  const dataContract = DataContract.fromJSON({ $formatVersion: '1', id, ownerId: owner, version: 1, ...json }, true, 14);
  const cost = await priced(() => sdk.contracts.publish({ dataContract, ...critical }));
  state[key] = id;
  state[`${key}RegistrationCredits`] = cost;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  log(`probe ${key}: ${id} registered (${cost} credits)`);
}

async function write(contract, type, data) {
  const base = new Document({ properties: {}, documentTypeName: type, dataContractId: contract, ownerId: owner });
  const document = Document.fromObject({ ...base.toObject(), ...data }, version);
  return priced(() => sdk.documents.create({ document, ...high }));
}
const docs = {
  chunk: () => ({ repoId: randomBytes(32), packHash: randomBytes(32), seq: 0, d0: randomBytes(4900), d1: randomBytes(4900), d2: randomBytes(4900) }),
  star: () => ({ repoId: randomBytes(32) }),
  checkRun: () => ({ repoId: randomBytes(32), headOid: randomBytes(20), name: 'build', status: 'completed', conclusion: 'success', startedAt: Date.now() - 60000, completedAt: Date.now(), outcome: 1, vis: 'public' }),
};
const out = {};
for (const type of Object.keys(docs)) {
  const costs = { A: [], B: [] };
  for (let i = 0; i < N; i++) {
    const d = docs[type]();
    // ABBA: alternate which contract is written first, so a drift over the run cancels out
    for (const key of i % 2 === 0 ? ['A', 'B'] : ['B', 'A']) costs[key].push(await write(state[key], type, d));
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const paired = costs.A.map((a, i) => a - costs.B[i]).sort((x, y) => x - y);
  const median = paired[Math.floor(paired.length / 2)];
  out[type] = {
    with: Math.round(mean(costs.A)),
    without: Math.round(mean(costs.B)),
    addedPercent: Number((100 * (mean(costs.A) / mean(costs.B) - 1)).toFixed(2)),
    pairedMedianCredits: median,
    pairedMedianPercent: Number((100 * median / mean(costs.B)).toFixed(2)),
    samples: costs,
  };
  log(`${type}: with ${out[type].with}, without ${out[type].without} credits (+${out[type].addedPercent} %; paired median +${median}, ${out[type].pairedMedianPercent} %)`);
}
const gates = {
  'D-3 chunk documentsCountable <= +5 %': out.chunk.addedPercent <= 5,
  'COMM-9 star byOwner countable <= +5 %': out.star.addedPercent <= 5,
};
console.log(JSON.stringify({ probes: { A: state.A, B: state.B }, fees: out, gates }, null, 2));

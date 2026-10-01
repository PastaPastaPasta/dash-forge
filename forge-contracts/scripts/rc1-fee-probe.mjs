// The step-8 fee gates of the RC1 registration (WIPE-DECISIONS D-3, SCOPE-DECISION COMM-9 and
// check_outcome): what one index feature adds to a write, measured on chain as the difference
// between two small probe contracts that differ in that feature alone.
//
//   node forge-contracts/scripts/rc1-fee-probe.mjs --devnet-name sakura --identity <file> [--state <file.json>] [--n 3]
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
// six probe contracts cut from the build.py variants, written with the same documents
//   - review (ALL, S2, S3, NONE): S2 toAuthor alone, S3 author alone, and both, against neither
//     (ship S2, S3 each at <= +10 %)
//   - star (FUSED, SPLIT): the fused star (C1) against star + starBeat (ship C1 when it costs no
//     more than the pair, and no more than 54.9 M)
// Each probe contract gets one unpriced warm-up write per type first (a type's first write costs
// more), then n priced rounds in a rotated order. It prints the build.py flags to turn off
// (`turnOff`); the decision is then a FLAGS edit (build.py header). The state file keeps each
// probe's id and schema hash: a rerun reuses a probe whose schema is unchanged.
//
//   node forge-contracts/scripts/rc1-fee-probe.mjs --rc2 --devnet-name sakura --identity <file> [--n 4]
//   node forge-contracts/scripts/rc1-fee-probe.mjs --rc2 --emit <dir>   # offline: the probe contracts
//        and vectors, for `contract-validate --vectors <dir>/vectors <dir>/contracts/rc2-*.json`
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, contractId, loadEvoSdk } from './deploy-v2.mjs';
import { PROBES, RC2_DOCS, REVIEW_PROBES, bare, emitted, materialize, probeSchemas, schemaHash } from './lib/rc2-probe.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, t, i, a) => (t.startsWith('--') ? [...acc, [t.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]] : acc), []));
const devnetName = args['devnet-name'] || 'sakura';
const N = Number(args.n ?? 4);
const RC2 = Boolean(args.rc2);
const statePath = String(args.state ?? join(homedir(), '.cache', 'dash-forge', `${RC2 ? 'rc2' : 'rc1'}-fee-probe-${devnetName}.json`));
const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);
const usage = (m) => {
  console.error(`${m}\nusage: rc1-fee-probe.mjs [--rc2] --devnet-name <name> --identity <file> [--state <file>] [--n 4]\n       rc1-fee-probe.mjs --rc2 --emit <dir>`);
  process.exit(2);
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

if (args.emit !== undefined) {
  if (!RC2) usage('--emit needs --rc2');
  if (args.emit === true) usage('--emit needs a directory');
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
if (typeof args.identity !== 'string') usage('--identity <file> is required');
if (!(N >= 1)) usage('--n must be at least 1');
const dep = JSON.parse(readFileSync(join(ROOT, 'deployments', `devnet-${devnetName}.json`), 'utf8'));

const load = (name) => JSON.parse(readFileSync(join(ROOT, 'contracts', `${name}.json`), 'utf8'));

/** RC1 probe A (with the features) or B (without): chunk, star and checkRun, bare. */
function probe(withFeatures) {
  const core = load('forge-core');
  const comm = load('forge-community');
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
const saveState = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

/**
 * Register probe `key` from `json` unless the state file has it on chain from the same schema
 * (an RC1 record without a hash is reused as before). Returns true when it registered.
 */
async function register(key, json) {
  const hash = schemaHash(json);
  const recorded = state[`${key}SchemaHash`];
  if (state[key] && (recorded === undefined || recorded === hash) && (await sdk.contracts.fetch(state[key]))) return false;
  const nonce = (BigInt((await sdk.identities.nonce(owner)) ?? 0n) & 0xFFFFFFFFFFn) + 1n;
  const id = contractId(owner, nonce);
  const dataContract = DataContract.fromJSON({ $formatVersion: '1', id, ownerId: owner, version: 1, ...json }, true, PROTOCOL_VERSION);
  const cost = await priced(() => sdk.contracts.publish({ dataContract, ...critical }));
  Object.assign(state, { [key]: id, [`${key}RegistrationCredits`]: cost, [`${key}SchemaHash`]: hash });
  saveState();
  log(`probe ${key}: ${id} registered (${cost} credits)`);
  return true;
}

async function create(contract, type, data) {
  const base = new Document({ properties: {}, documentTypeName: type, dataContractId: contract, ownerId: owner });
  const document = Document.fromObject({ ...base.toObject(), ...data }, version);
  return sdk.documents.create({ document, ...high });
}
const write = (contract, type, data) => priced(() => create(contract, type, data));

if (RC2) {
  const schemas = probeSchemas();
  state.patches ??= {};
  for (const p of PROBES) if (await register(p, schemas[p])) delete state.patches[p];
  // One patch per review probe for its reviews to name (review.patchId's `where` reads repoId and
  // vis, so every review of a probe shares that patch's repoId), kept in the state file
  for (const p of REVIEW_PROBES) {
    if (state.patches[p]) continue;
    const repoId = randomBytes(32);
    const created = await create(state[p], 'patch', materialize(RC2_DOCS.patch, { repoId }, randomBytes));
    state.patches[p] = { id: Buffer.from(created.id.toBytes()).toString('hex'), repoId: repoId.toString('hex') };
    saveState();
  }
  const reviewOn = (p) => materialize(RC2_DOCS.review, { repoId: Buffer.from(state.patches[p].repoId, 'hex'), patchId: Buffer.from(state.patches[p].id, 'hex') }, randomBytes);
  /** The credits of a star on FUSED, or of a star and its beat on SPLIT (the same repo id for both). */
  const star = async (p) => {
    const repoId = randomBytes(32);
    const credits = await write(state[p], 'star', { repoId });
    return p === 'SPLIT' ? credits + (await write(state.SPLIT, 'starBeat', materialize(RC2_DOCS.starBeat, { repoId }, randomBytes))) : credits;
  };
  // The first write of a type costs more (its trees are created): one unmeasured write per probe first
  for (const p of REVIEW_PROBES) await create(state[p], 'review', reviewOn(p));
  for (const p of ['FUSED', 'SPLIT']) await star(p);
  const costs = { review: Object.fromEntries(REVIEW_PROBES.map((p) => [p, []])), star: { FUSED: [], SPLIT: [] } };
  for (let i = 0; i < N; i++) {
    // a rotated order each round, so a drift over the run cancels out
    for (const p of REVIEW_PROBES.map((_, j) => REVIEW_PROBES[(i + j) % REVIEW_PROBES.length])) costs.review[p].push(await write(state[p], 'review', reviewOn(p)));
    for (const p of i % 2 === 0 ? ['FUSED', 'SPLIT'] : ['SPLIT', 'FUSED']) costs.star[p].push(await star(p, true));
  }
  const none = mean(costs.review.NONE);
  const added = (p) => Number((100 * (mean(costs.review[p]) / none - 1)).toFixed(2));
  const pairedMedian = (p) => median(costs.review[p].map((c, i) => c - costs.review.NONE[i]));
  const STAR_BEAT_BETA7 = 54_900_000; // star + starBeat on bonsia beta.7 (WIPE-DECISIONS D-17)
  const fees = {
    review: Object.fromEntries(REVIEW_PROBES.map((p) => [p, Math.round(mean(costs.review[p]))])),
    reviewAddedPercent: { S2: added('S2'), S3: added('S3'), both: added('ALL') },
    reviewPairedMedianCredits: { S2: pairedMedian('S2'), S3: pairedMedian('S3'), both: pairedMedian('ALL') },
    star: { fused: Math.round(mean(costs.star.FUSED)), starPlusBeat: Math.round(mean(costs.star.SPLIT)), beta7StarPlusBeat: STAR_BEAT_BETA7 },
    samples: costs,
  };
  const gates = {
    review_to_author: fees.reviewAddedPercent.S2 <= 10,
    review_author: fees.reviewAddedPercent.S3 <= 10,
    fused_star: fees.star.fused <= fees.star.starPlusBeat && fees.star.fused <= STAR_BEAT_BETA7,
  };
  const turnOff = Object.entries(gates).filter(([, pass]) => !pass).map(([flag]) => flag);
  log(`review: S2 +${fees.reviewAddedPercent.S2} %, S3 +${fees.reviewAddedPercent.S3} %, both +${fees.reviewAddedPercent.both} % (on ${fees.review.NONE} credits)`);
  log(`star: fused ${fees.star.fused} against star + starBeat ${fees.star.starPlusBeat} credits (beta.7: ${STAR_BEAT_BETA7})`);
  log(turnOff.length ? `turn off in build.py FLAGS: ${turnOff.join(', ')}` : 'every RC2 fee gate passes: keep the FLAGS defaults');
  console.log(JSON.stringify({ probes: Object.fromEntries(PROBES.map((p) => [p, state[p]])), fees, gates, turnOff }, null, 2));
  process.exit(0);
}

for (const [key, withFeatures] of [['A', true], ['B', false]]) await register(key, probe(withFeatures));

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
  const paired = median(costs.A.map((a, i) => a - costs.B[i]));
  out[type] = {
    with: Math.round(mean(costs.A)),
    without: Math.round(mean(costs.B)),
    addedPercent: Number((100 * (mean(costs.A) / mean(costs.B) - 1)).toFixed(2)),
    pairedMedianCredits: paired,
    pairedMedianPercent: Number((100 * paired / mean(costs.B)).toFixed(2)),
    samples: costs,
  };
  log(`${type}: with ${out[type].with}, without ${out[type].without} credits (+${out[type].addedPercent} %; paired median +${paired}, ${out[type].pairedMedianPercent} %)`);
}
const gates = {
  'D-3 chunk documentsCountable <= +5 %': out.chunk.addedPercent <= 5,
  'COMM-9 star byOwner countable <= +5 %': out.star.addedPercent <= 5,
};
console.log(JSON.stringify({ probes: { A: state.A, B: state.B }, fees: out, gates }, null, 2));

#!/usr/bin/env node
// seed-trending.mjs — the data forge-web/e2e/trending.spec.ts ranks: three new repos starred by
// three identities so that Trending has a known shape (3, 2 and 1 new stargazers), each star
// with its trending beat, and the exact `$createdAt` of every beat read back from the chain.
//
//   node forge-contracts/scripts/seed-trending.mjs --out <seed.json> \
//        --identity <A.identity.json> --identity <B.identity.json> --identity <C.identity.json> \
//        [--network devnet --devnet-name moutai]
//
// beta.7 only: needs evo-sdk 4.2.0-beta.7 (forge-contracts/sdk-v2) and the three-contract
// deployment; star, starBeat, watch, policy and checkRun live in forge-community.
//
// The identities must be minted for the run (`qa mint`), never the shared fixtures. The first
// one owns the repos. Idempotent: a rerun with the same --out reuses the repos it recorded and
// writes only the stars and beats still missing (a beat is once per identity and repo, ever).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { communityId, loadEvoSdk } from './deploy-v2.mjs';

const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);
const argv = process.argv.slice(2);
const opt = { network: 'devnet', 'devnet-name': 'moutai', identity: [] };
for (let i = 0; i < argv.length; i += 2) {
  const k = argv[i].replace(/^--/, '');
  if (k === 'identity') opt.identity.push(argv[i + 1]);
  else opt[k] = argv[i + 1];
}
if (!opt.out || opt.identity.length !== 3) throw new Error('usage: --out <seed.json> --identity <A> --identity <B> --identity <C>');
const key = opt.network === 'devnet' ? `devnet-${opt['devnet-name']}` : opt.network;
const dep = JSON.parse(readFileSync(resolve(new URL('..', import.meta.url).pathname, 'deployments', `${key}.json`), 'utf8'));
const core = dep.v2.forgeCore.contractId;
const collab = dep.v2.forgeCollab.contractId;
const community = communityId(dep);

const evo = await loadEvoSdk();
const { EvoSDK, Document, IdentityPublicKey, IdentitySigner, PrivateKey, Identifier } = evo;
const sdk = new EvoSDK({ network: opt.network, ...(opt.network === 'devnet' ? { devnetName: opt['devnet-name'], addresses: dep.dapiAddresses } : {}), trusted: true, version: 14, settings: { connectTimeoutMs: 10000, timeoutMs: 60000, retries: 3 } });
await sdk.connect();
const version = sdk.version();

const who = (file) => {
  const rec = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const k = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === 'HIGH');
  const identityKey = new IdentityPublicKey({ keyId: k.id, purpose: k.purpose, securityLevel: k.securityLevel, keyType: k.keyType, isReadOnly: false, data: Buffer.from(k.publicKeyHex, 'hex') });
  const signer = new IdentitySigner();
  signer.addKey(PrivateKey.fromWIF(k.privateKeyWif));
  return { id: rec.identityId, identityKey, signer };
};
const [A, B, C] = opt.identity.map(who);
const state = existsSync(opt.out) ? JSON.parse(readFileSync(opt.out, 'utf8')) : { repos: [], beats: [] };
const save = () => writeFileSync(opt.out, `${JSON.stringify(state, null, 2)}\n`);
const bytes = (id) => Buffer.from(Identifier.fromBase58(id).toBytes());
// evo-sdk 4.2.0-beta.7 resolves indexOnly creates (platform#5136): no refusal to catch.
async function create(w, contractId, documentTypeName, data) {
  const base = new Document({ properties: {}, documentTypeName, dataContractId: contractId, ownerId: w.id });
  const document = Document.fromObject({ ...base.toObject(), ...data }, version);
  return sdk.documents.create({ document, identityKey: w.identityKey, signer: w.signer });
}

// No index gives a beat's exact `$createdAt` back (`byWeek` keeps only bucket starts, `byOwner`
// no time), so the seed brackets it between the clock before the write and after it was seen.
// The recount needs the day only (the grid steps at 00:00 UTC), so the bracket decides it
// unless the write straddles midnight, which the seed refuses.
async function beat(w, repoId) {
  if (state.beats.some((b) => b.repoId === repoId && b.owner === w.id)) return;
  const own = async (type) => (await sdk.documents.query({ dataContractId: community, documentTypeName: type, where: [['$ownerId', '==', w.id], ['repoId', '==', repoId]], orderBy: [['$ownerId', 'asc']], limit: 1 })).size > 0;
  const before = Date.now();
  if (!(await own('star'))) await create(w, community, 'star', { repoId: bytes(repoId) });
  if (!(await own('starBeat'))) await create(w, community, 'starBeat', { repoId: bytes(repoId) });
  for (let i = 0; i < 12 && !(await own('starBeat')); i++) await new Promise((r) => setTimeout(r, 2500));
  if (!(await own('starBeat'))) throw new Error(`the beat of ${w.id} on ${repoId} did not land`);
  const after = Date.now();
  const day = 86_400_000;
  if (Math.floor(before / day) !== Math.floor(after / day)) throw new Error('the beat straddled 00:00 UTC; rerun (the window test needs its day)');
  state.beats.push({ repoId, repoHex: bytes(repoId).toString('hex'), owner: w.id, createdAt: Math.round((before + after) / 2) });
  save();
  log(`beat ${w.id.slice(0, 6)} -> ${repoId.slice(0, 6)}`);
}

const run = state.run ?? Date.now().toString(36);
state.run = run;
for (const suffix of ['a', 'b', 'c']) {
  if (state.repos.some((r) => r.name === `trend-${run}-${suffix}`)) continue;
  const name = `trend-${run}-${suffix}`;
  const repo = await create(A, core, 'repo', { name, visibility: 'public', description: 'Trending e2e fixture (forge-web/e2e/trending.spec.ts)' }, false);
  const id = repo.id.toBase58();
  await create(A, core, 'maintainer', { repoId: bytes(id), memberId: bytes(A.id) }, false);
  state.repos.push({ id, name });
  save();
  log(`repo ${name} ${id}`);
}
const [ra, rb, rc] = state.repos.map((r) => r.id);
// 3, 2 and 1 new stargazers
for (const w of [A, B, C]) await beat(w, ra);
for (const w of [A, B]) await beat(w, rb);
await beat(A, rc);
console.log(JSON.stringify({ out: opt.out, repos: state.repos, beats: state.beats.length }));

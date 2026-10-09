// The mixed-visibility live negatives (dash-forge-qa design/mixed-visibility/DESIGN.md rev 4.1
// §9 phase M-C): raw documents against a scratch registration of the four-contract mainnet set
// (`build.py --mainnet`, registered by `deploy-v2.mjs --contracts <dir> --record <file>` with a
// scratch deployer), one refused case and one accepted positive control per rule, since a rule
// registered with mainnet can never be changed. It writes fresh repos on every run and prints
// (and with --report writes) one line per case, in the style of rc1-live.mjs.
//
//   (cd forge-contracts/sdk-v2 && npm ci)
//   node forge-contracts/scripts/mv-live.mjs --record <scratch-record.json> --identities <dir> \
//        [--devnet-name sakura] [--report <file.json>] [--only <group,...>] [--n 4] [--state <file>]
//   node forge-contracts/scripts/mv-live.mjs --self-test     # offline: the sealing helpers against
//                                                            # tools/private-repos-vectors constants
//
// <dir> holds owner, maint2, writer, triage, reader, bot, bot2 and stranger .identity.json
// (`qa mint` or `qa restore`). Roles in the shared public repo: `owner` owns it; `maint2` is a
// second maintainer; `writer`, `triage`, `reader`, `bot` and `bot2` hold writer rows of role 1, 2,
// 3, 4 and 4; `stranger` is never a member. A group that changes a role does it on a repo of its
// own.
//
// The scratch record must not be the network's live deployment (its forge-core and group are
// refused). The live set is only read, except by the `fees` group, which writes the same
// documents to a repo of its own on the live contracts to compare what a write costs there, and
// one `layout` case: a group-bound key signing a live forge-community `watch` of a repo that does
// not exist, which the signature check refuses (20014) and which could not land anyway (40120).
//
// Groups (DESIGN §8.2 rows; §8.3 items):
//   l1      L1 `aud` (rows 1-3): a stranger's members-only post, any stranger write to a private
//           repo, sealed and plaintext edits, Members -> letter, the author's Make public with the
//           settable-once `path` and branch names; a stranger's letter stays admitted
//   l2      L2 `mRole` (rows 5, 6): verdicts by role, imported provenance, a member's edit after a
//           role change restating the new role
//   c1      C1 one-way visibility, L3 public replies on a converted repo's old threads and C4
//           public-era ref updates, configs, releases and webhooks by unchanged member rows
//           (rows 17, 18, 41)
//   c2l4    C2 the Bot role and L4 no wrap to a bot (rows 14, 15)
//   c3      C3 maintainer-only manifest kinds (rows 9-11)
//   m1      M1 members-only check runs carry no text (rows 12, 13)
//   m2      M2 the triage allow-list and kind 23 (rows 7, 8)
//   m4      M4 an event's value on a members-only target is sealed (row 16)
//   m3      M3 an author's retarget of a members-only PR is sealed (row 19)
//   b1      B1 bot push grants (rows 42-45): grants, refusals, packs, expiry, the granter's
//           removal, renewal, a removed and re-added bot
//   layout  D44 the seven moved types written and read back in forge-meta, and a key bound to
//           the contract group signing a forge-meta write (row 49)
//   convert the R6 live case, Code only (DESIGN §4.10 steps 2-5, driven as raw documents: the
//           conversion tooling is phase 5A): a private repo with a real epoch-0 anchor, a sealed
//           (DFPK) pack and sealed ref updates, a seal-off rotation to epoch 1 with its own sealed
//           pack, the flip, the plaintext config, a fresh plaintext pack and ref update. Writes
//           --state <file> (0600; the repo and its synthetic epoch keys) for `everything`.
//   everything  step 7 on the repo `convert` wrote: the owner's kind-7 bundle publishing K_0
//           (entry 0x06), never K_1 (the seal-off epoch). Clone with an R6 `dg` between the two.
//   fees    the M-C fee probes: L3 (comment, review) and C4 (ref update, config) against the live
//           set, a bot push against a writer push, label/topic/packMirror in forge-meta against
//           the live forge-core (n rounds each after a warm-up write)
//
// Documents are synthetic: `enc` is random bytes behind a real version byte (0x03 members, 0x04
// letter, 0x05 bot post), since consensus never reads inside it; an exact grant's scope is a
// random 32 bytes (a branch key's HMAC until phase 3F). Clients do not write the mainnet fields
// before phase M-B.
//
// Every refusal is matched on the node's numeric code (and, for a rule, its name in the message):
// 10422 a rule (the first broken one in name order), 40127 a `where` mismatch, 40120 no document
// found, 40128 an immutable field, 40102 a replace by someone other than the owner, 10101 the JSON
// schema. An anyOf reference reports its LAST operand's error, so a failed `where` on an earlier
// operand shows as 40127 or 40120.
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvoSdk } from './deploy-v2.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, t, i, a) => (t.startsWith('--') ? [...acc, [t.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]] : acc), []));
const devnetName = args['devnet-name'] || 'sakura';
const only = args.only ? new Set(String(args.only).split(',')) : null;
const N = Number(args.n ?? 4);
const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);
// ---------------- sealing (docs/security/private-repos.md §2-§4, §18.3) ----------------
// The R6 live case writes a converted repository's private-era documents and packs with real
// keys, so R6 readers judge them as they would a real one. Checked offline by --self-test.
const sha256 = (b) => createHash('sha256').update(b).digest();
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const hmac = (key, msg) => createHmac('sha256', key).update(msg).digest();
/** HKDF-Expand (SHA-256) of one block: every key here is 32 bytes. */
const expand1 = (prk, info) => hmac(prk, Buffer.concat([info, Buffer.from([1])]));
const subkey = (K, repo, label, e, extra = Buffer.alloc(0)) => expand1(hmac(repo, K), Buffer.concat([Buffer.from(`dash-forge/v2/${label}\0`), u32(e), extra]));
const seal = {
  kDoc: (K, repo, e) => subkey(K, repo, 'doc', e),
  kRef: (K, repo, e) => subkey(K, repo, 'ref', e),
  commit: (K, repo, e) => subkey(K, repo, 'commit', e),
  kPack: (K, repo, e, fileId) => subkey(K, repo, 'pack', e, Buffer.concat([Buffer.from([1]), fileId])),
  refHash: (K, repo, e, name) => hmac(seal.kRef(K, repo, e), Buffer.from(name)),
  tlv: (...records) => Buffer.concat(records.map(([t, v]) => Buffer.concat([Buffer.from([t]), u16(v.length), v]))),
  gcm(key, nonce, pt, ad) {
    const c = createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(ad);
    return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  },
  /** AD (§4.1): domain, version, repo, owner, epoch, type, the type's binding. */
  ad: (version, repo, owner, e, type, binding) => Buffer.concat([Buffer.from('dash-forge/v2/doc\0'), Buffer.from([version]), repo, owner, u32(e), Buffer.from(`${type}\0`), binding]),
  /** A config anchor (0x02): its commitment in the clear, the settings TLV sealed. */
  anchor(K, repo, owner, e, pt, nonce = randomBytes(12)) {
    const c = seal.commit(K, repo, e);
    return Buffer.concat([Buffer.from([2]), c, nonce, seal.gcm(seal.kDoc(K, repo, e), nonce, pt, seal.ad(2, repo, owner, e, 'config', c))]);
  },
  /** A sealed ref update (0x01): the name in TLV tag 3; AD binds refNameHash, oidf(newOid), oidf(prevOid), force. */
  refUpdate(K, repo, owner, e, refNameHash, newOid, name, nonce = randomBytes(12)) {
    const binding = Buffer.concat([refNameHash, Buffer.from([newOid.length]), newOid, Buffer.from([0]), Buffer.from([0])]);
    return Buffer.concat([Buffer.from([1]), nonce, seal.gcm(seal.kDoc(K, repo, e), nonce, seal.tlv([3, Buffer.from(name)]), seal.ad(1, repo, owner, e, 'refUpdate', binding))]);
  },
  /** A sealed artifact (§3): the 36-byte DFPK header, then 2^L-byte segments, each AES-GCM with the header as AD. */
  pack(K, repo, e, plain, fileId = randomBytes(16), L = 14) {
    const header = Buffer.concat([Buffer.from('DFPK'), Buffer.from([1, L]), Buffer.alloc(2), u32(e), u64(plain.length), fileId]);
    const SEG = 1 << L;
    const n = Math.max(1, Math.ceil(plain.length / SEG));
    const kf = seal.kPack(K, repo, e, fileId);
    const out = [header];
    for (let i = 0; i < n; i++) out.push(seal.gcm(kf, Buffer.concat([u64(i), Buffer.from([0, 0, 0, i === n - 1 ? 1 : 0])]), plain.subarray(i * SEG, (i + 1) * SEG), header));
    return Buffer.concat(out);
  },
  /** A make-public bundle (§18.3): DFRV, version 1, count, entries [type, target, revision, key], note. */
  bundle(entries, note = '') {
    return Buffer.concat([Buffer.from('DFRV'), Buffer.from([1]), u16(entries.length), ...entries.map(([t, target, rev, key]) => Buffer.concat([Buffer.from([t]), target, u32(rev), key])), Buffer.from(note)]);
  },
};
if (args['self-test']) {
  // tools/private-repos-vectors/gen.py summary(): repoId 0x11 x 32, owner 0x22 x 32, K0 = 0..31, K1 = 32..63
  const repo = Buffer.alloc(32, 0x11);
  const owner = Buffer.alloc(32, 0x22);
  const K0 = Buffer.from([...Array(32).keys()]);
  const K1 = Buffer.from([...Array(32).keys()].map((i) => i + 32));
  const nonce = Buffer.from('000102030405060708090a0b', 'hex');
  const main0 = seal.refHash(K0, repo, 0, 'refs/heads/main');
  const checks = {
    refNameHash_main_e0: [main0, 'e729d18b929db396450159dfc6256e24302b94c9c3c9eb40643f5ae0be3fe579'],
    commit_e1: [seal.commit(K1, repo, 1), '307277ccb5bcfa7871f82e43c6e58515464a5065460b829def44e1cc32521c33'],
    K_pack_e0: [seal.kPack(K0, repo, 0, Buffer.from('f0e1d2c3b4a5968778695a4b3c2d1e0f', 'hex')), '7c3836d19c8c22116136d9a49d6cc92914771e1010c697673a7baba1c521932b'],
    refUpdate_enc: [seal.refUpdate(K0, repo, owner, 0, main0, Buffer.alloc(20, 0xaa), 'refs/heads/main', nonce), '01000102030405060708090a0b1d702080a6549f56371975d7b304906fd0738aace1e93172a442bd35c7f049054557'],
    // gen.py seal_doc(CONFIG1, K1, tlv((6, main), (8, u32(0)), (9, K0))), seal_pack(K0, 0, mod251(20000)), bundle_bytes
    config1_anchor: [seal.anchor(K1, repo, owner, 1, seal.tlv([6, Buffer.from('refs/heads/main')], [8, u32(0)], [9, K0]), nonce), '02307277ccb5bcfa7871f82e43c6e58515464a5065460b829def44e1cc32521c33000102030405060708090a0bd0b9cc2c71a2a510ad23e4af9dc285bf3b1800e8a693db7826a40e764928377bd1df1bc3d1a23620b0e6b8717040458d94ef824e6f006fc6b9426a3b518a80da052f2058689f2f6be010fd50'],
    sealed_pack_sha256: [sha256(seal.pack(K0, repo, 0, Buffer.from([...Array(20000).keys()].map((i) => i % 251)), Buffer.from('f0e1d2c3b4a5968778695a4b3c2d1e0f', 'hex'))), '332c2c71f201efb1e812d00537beedc80a152f2067d16d8f9ddaef4eb60b22ef'],
    bundle: [seal.bundle([[6, repo, 0, K0]], 'note'), '4446525601000106111111111111111111111111111111111111111111111111111111111111111100000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f6e6f7465'],
  };
  const bad = Object.entries(checks).filter(([, [got, want]]) => got.toString('hex') !== want).map(([k]) => k);
  console.log(bad.length ? `self-test FAILED: ${bad.join(', ')}` : `self-test: ok (${Object.keys(checks).join(', ')})`);
  process.exit(bad.length ? 1 : 0);
}

if (!args.record || !args.identities) {
  console.error('usage: mv-live.mjs --record <scratch-record.json> --identities <dir> [--devnet-name sakura] [--addresses <dapi,...>] [--report <file>] [--only <groups>] [--n 4] [--state <file>]\n       mv-live.mjs --self-test');
  process.exit(2);
}

// The scratch set, and the live set (read only; the fees group writes documents to it)
const liveFile = join(ROOT, 'deployments', `devnet-${devnetName}.json`);
const live = JSON.parse(readFileSync(liveFile, 'utf8'));
const recPath = realpathSync(String(args.record));
if (recPath.toLowerCase().startsWith(realpathSync(join(ROOT, 'deployments')).toLowerCase())) throw new Error('--record must be a scratch record, not a file under forge-contracts/deployments/');
const rec = JSON.parse(readFileSync(recPath, 'utf8'));
const CORE = rec.v2?.forgeCore?.contractId;
const COLLAB = rec.v2?.forgeCollab?.contractId;
const COMM = rec.v2?.forgeCommunity?.contractId;
const META = rec.v2?.forgeMeta?.contractId;
const GROUP = rec.v2?.contractGroup?.id ?? rec.v2?.forgeCore?.contractGroupId;
if (!CORE || !COLLAB || !COMM || !META || !GROUP) throw new Error(`${recPath} records no four-contract set (forge-core, -collab, -community, -meta and the group)`);
const LIVE = { core: live.v2?.forgeCore?.contractId, collab: live.v2?.forgeCollab?.contractId, community: live.v2?.forgeCommunity?.contractId };
if (CORE === LIVE.core || GROUP === (live.v2?.contractGroup?.id ?? live.v2?.forgeCore?.contractGroupId)) throw new Error('the scratch record names the live forge-core or group');
const addresses = args.addresses ? String(args.addresses).split(',') : rec.dapiAddresses ?? live.dapiAddresses;

const evo = await loadEvoSdk();
const { EvoSDK, Document, IdentityPublicKey, IdentityPublicKeyInCreation, IdentitySigner, PrivateKey, Identifier, ContractBounds } = evo;
const connect = async () => {
  const fresh = new EvoSDK({ network: 'devnet', devnetName, trusted: true, addresses, settings: { timeoutMs: 60000 } });
  await fresh.connect();
  return fresh;
};
// Replaced after a transport or proof failure (a devnet's quorums rotate faster than the trusted
// context's cache follows), as in rc1-live.mjs.
let sdk = await connect();
const version = sdk.version();

const identityFile = (name) => join(String(args.identities), `${name}.identity.json`);
function loadIdentity(name) {
  const rec = JSON.parse(readFileSync(identityFile(name), 'utf8'));
  const k = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === 'HIGH');
  const enc = rec.identityKeys.find((x) => x.purpose === 'ENCRYPTION');
  const identityKey = new IdentityPublicKey({ keyId: k.id, purpose: k.purpose, securityLevel: k.securityLevel, keyType: k.keyType, isReadOnly: false, data: Buffer.from(k.publicKeyHex, 'hex') });
  const signer = new IdentitySigner();
  signer.addKey(PrivateKey.fromWIF(k.privateKeyWif));
  return { name, id: rec.identityId, identityKey, signer, encKeyId: enc?.id };
}
const O = loadIdentity('owner');
const M2 = loadIdentity('maint2');
const W = loadIdentity('writer');
const T = loadIdentity('triage');
const RD = loadIdentity('reader');
const B = loadIdentity('bot');
const B2 = loadIdentity('bot2');
const S = loadIdentity('stranger');

const id = (b58) => Buffer.from(Identifier.fromBase58(String(b58)).toBytes());
const bytes = (n, fill) => (fill === undefined ? randomBytes(n) : Buffer.alloc(n, fill));
const refHash = (name) => sha256(Buffer.from(name));
/** A synthetic envelope: the version byte (0x03 members, 0x04 letter, 0x05 bot post), then random bytes. */
const sealed = (v = 3, n = 61) => Buffer.concat([Buffer.from([v]), randomBytes(n - 1)]);
const docId = (d) => d.id.toBase58();
/** A document's id as the 32 bytes a reference property holds. */
const docRef = (d) => id(docId(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A_BLOCK = 4000;
const tag = Date.now().toString(36);
const results = [];
const fees = {};
const WHERE_ANYOF = [40127, 40120];
const SCHEMA = [10101];
const DAY = 86_400_000;

class InfraError extends Error {}
const INFRA = /quorum not found|invalid quorum|prefetch quorums|error sending request|no available addresses|deadline|timed? ?out|unavailable|transport|connection/i;
const infraCases = [];

function codeOf(e) {
  try {
    if (typeof e?.code === 'number' && e.code >= 10000) return e.code;
  } catch { /* freed wasm pointer */ }
  const m = /\b(10\d{3}|20\d{3}|40\d{3})\b/.exec(String(e?.message ?? e));
  return m ? Number(m[1]) : null;
}
const isInfra = (e) => codeOf(e) === null && INFRA.test(String(e?.message ?? e));

function record(r) {
  results.push(r);
  log(`${r.pass ? 'PASS' : 'FAIL'} [${r.item}] ${r.label}: ${r.got}${r.note ? ` (${r.note})` : ''}`);
}

// The role every role-gated write claims unless the case names one: 1, what a maintainer, an
// author or a role-1 writer sends.
const ROLE_GATED = new Set(['refUpdate', 'packManifest', 'chunk', 'transition', 'event', 'checkRun', 'label', 'milestone']);
const CONTRACT = { repo: CORE, maintainer: CORE, writer: CORE, consent: CORE, refUpdate: CORE, protectedRefUpdate: CORE, config: CORE, release: CORE, packManifest: CORE, chunk: CORE, pushGrant: CORE, issue: COLLAB, patch: COLLAB, comment: COLLAB, review: COLLAB, transition: COLLAB, event: COMM, authorEvent: COMM, checkRun: COMM, runner: COMM, policy: COMM, milestone: COMM, star: COMM, watch: COMM, webhook: COMM, repoKey: META, ban: META, label: META, topic: META, packMirror: META, profile: META, follow: META };
function withDefaults(type, data) {
  if (type === 'writer' && data.role === undefined) return { ...data, role: 1 };
  if (type === 'pushGrant' && data.br === undefined) return { ...data, br: 4 };
  if (ROLE_GATED.has(type) && data.r === undefined) return { ...data, r: 1 };
  return data;
}
// Undefined drops a field, so a case can leave out a default
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
// Types with a rule that reads a total (dense, c1..c6, lockGate, platformChunks, oneLive,
// atMost20): wait a block so the node that checks the write has applied the ones before it.
const TOTALS = new Set(['issue', 'patch', 'transition', 'comment', 'review', 'packManifest', 'release', 'topic']);

// How many attempts the last create took: a priced write that was retried is not measured (the
// balance delta then holds a refused attempt's fees too)
let lastAttempts = 0;
/**
 * Create a document and return it as Platform committed it. After a transport failure the SDK is
 * replaced and the write retried, but only once reads show that no earlier attempt landed: a
 * numbered write (`dense`) retried after it landed would be refused as the wrong number. From
 * protocol 14 a new document's id commits to the identity contract nonce of its transition, and
 * the SDK sends a copy of the document, so the ids an attempt may have landed under are derived
 * here from the document's entropy and the nonces around the identity's current one.
 */
async function create(who, type, data, { contract = CONTRACT[type], key = who.identityKey, signer = who.signer } = {}) {
  if (TOTALS.has(type)) await sleep(A_BLOCK);
  const base = new Document({ properties: {}, documentTypeName: type, dataContractId: contract, ownerId: who.id });
  const document = Document.fromObject({ ...base.toObject(), ...clean(withDefaults(type, data)) }, version);
  for (let attempt = 0; ; attempt++) {
    lastAttempts = attempt + 1;
    try {
      return await sdk.documents.create({ document, identityKey: key, signer });
    } catch (e) {
      // a retry refused (by `dense` or a unique index, say) because an earlier attempt landed after all
      if (!isInfra(e)) {
        const got = attempt > 0 ? await landed(who, type, contract, document) : undefined;
        if (got) return got;
        throw e;
      }
      log(`infra (${msgOf(e).slice(0, 80)}); checking whether the ${type} landed before a retry`);
      await sleep(10000);
      sdk = await connect();
      const got = await landed(who, type, contract, document);
      if (got) return got;
      if (attempt >= 2) throw new InfraError(msgOf(e).slice(0, 300));
    }
  }
}
/** The document an earlier attempt of `document` committed, if any: read by every id it could have. */
async function landed(who, type, contract, document) {
  const MASK = (1n << 40n) - 1n; // the identity contract nonce's low 40 bits (rs-dpp)
  const nonce = await sdk.identities.contractNonce(who.id, contract).catch(() => undefined);
  if (nonce === undefined) return undefined;
  const ids = [];
  for (let k = (BigInt(nonce) & MASK) + 1n; k > 0n && ids.length < 4; k--) ids.push(Document.generateId(type, who.id, contract, document.entropy, k));
  for (let round = 0; round < 4; round++) {
    if (round) await sleep(3000);
    for (const docIdentifier of ids) {
      const got = await sdk.documents.get(contract, type, docIdentifier).catch(() => undefined);
      if (got) return got;
    }
  }
  return undefined;
}
/** A replace or delete, retried like `create` once a read shows it did not land. */
async function mutate(op, who, doc, landedIf) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sdk.documents[op]({ document: doc, identityKey: who.identityKey, signer: who.signer });
    } catch (e) {
      if (!isInfra(e) || attempt >= 2) throw isInfra(e) ? new InfraError(String(e?.message ?? e).slice(0, 300)) : e;
      await sleep(10000);
      sdk = await connect();
      const now = await sdk.documents.get(doc.dataContractId, doc.documentTypeName, doc.id).catch(() => null);
      if (now != null && landedIf(now)) return undefined;
    }
  }
}

const msgOf = (e) => String(e?.message ?? e);
const refusal = (codes, rule) => `refused ${codes.join('|')}${rule ? ` ${rule}` : ''}`;
const skipped = (item, label, expect) => record({ item, label, expect, got: 'SKIPPED: its document was not written', pass: false });
const failed = (item, label, e) => record({ item, label, expect: 'ok', got: `refused ${codeOf(e)}`, note: msgOf(e).slice(0, 300), pass: false });
/** Record a refusal against the expected `codes` (and, when given, the rule its message names). */
function judge(item, label, e, codes, rule) {
  const code = codeOf(e);
  const msg = msgOf(e);
  record({ item, label, expect: refusal(codes, rule), got: `refused ${code}`, note: msg.slice(0, 300), pass: codes.includes(code) && (!rule || msg.includes(rule)) });
}
async function noVerdict(item, label, e) {
  infraCases.push(label);
  record({ item, label, expect: 'a verdict', got: 'infra', note: e.message, pass: true, infra: true });
  await sleep(15000);
  sdk = await connect();
  return null;
}

async function balance(who) {
  return BigInt((await sdk.identities.balance(who.id)) ?? 0n);
}
/** The balance once two reads 2 s apart agree (a node can answer from the block before a write). */
async function settled(who, differentFrom) {
  let last = await balance(who);
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const now = await balance(who);
    if (now === last && now !== differentFrom) return now;
    last = now;
  }
  return last;
}
async function priced(who, fn) {
  const before = await settled(who).catch(() => null);
  const out = await fn();
  const after = before === null ? null : await settled(who, before).catch(() => null);
  return { out, credits: after === null || after === before ? null : Number(before - after) };
}

/** A write that must land. `opts.fee`: record its cost under that name (not when it was retried). */
async function ok(item, label, who, type, data, opts = {}) {
  try {
    const run = () => create(who, type, data, opts);
    const { out, credits: measured } = opts.fee ? await priced(who, run) : { out: await run(), credits: null };
    const credits = lastAttempts === 1 ? measured : null;
    if (opts.fee && credits !== null) (fees[opts.fee] ??= []).push(credits);
    record({ item, label, expect: 'ok', got: `ok ${docId(out)}${opts.fee ? ` ${credits ?? (lastAttempts > 1 ? 'unmeasured (retried)' : 'unmeasured')} credits` : ''}`, pass: true });
    return out;
  } catch (e) {
    if (e instanceof InfraError) return noVerdict(item, label, e);
    failed(item, label, e);
    return null;
  }
}
/** A write that must be refused with one of `codes` (and, when given, naming `rule`). */
async function no(item, label, who, type, data, codes, rule, opts = {}) {
  try {
    const out = await create(who, type, data, opts);
    record({ item, label, expect: refusal(codes, rule), got: `ACCEPTED ${docId(out)}`, pass: false });
    return out;
  } catch (e) {
    if (e instanceof InfraError) return noVerdict(item, label, e);
    judge(item, label, e, codes, rule);
    return null;
  }
}
/** The next revision of `doc`: `changes` applied, the `drop` fields removed. */
function revised(doc, changes = {}, drop = []) {
  const o = doc.toObject();
  for (const k of drop) delete o[k];
  return Document.fromObject({ ...o, ...clean(changes), $revision: BigInt(o.$revision ?? 1) + 1n }, version);
}
/** Replace `doc` with its next revision; resolves to that revision (a retry checks it landed). */
async function replace(who, doc, changes, drop) {
  const next = revised(doc, changes, drop);
  await sleep(A_BLOCK); // a replace checked by a node a block behind finds no document (40101)
  await mutate('replace', who, next, (now) => BigInt(now.revision ?? now.toObject().$revision) >= BigInt(next.toObject().$revision));
  return next;
}
/** A replace that must land; returns the new revision. */
async function replaceOk(item, label, who, doc, changes, drop = []) {
  if (!doc) return skipped(item, label, 'ok'), null;
  try {
    const next = await replace(who, doc, changes, drop);
    record({ item, label, expect: 'ok', got: 'ok', pass: true });
    return next;
  } catch (e) {
    if (e instanceof InfraError) return noVerdict(item, label, e);
    failed(item, label, e);
    return null;
  }
}
async function replaceNo(item, label, who, doc, changes, drop, codes, rule) {
  if (!doc) return skipped(item, label, refusal(codes));
  try {
    await replace(who, doc, changes, drop);
    record({ item, label, expect: refusal(codes, rule), got: 'ACCEPTED', pass: false });
  } catch (e) {
    if (e instanceof InfraError) return noVerdict(item, label, e);
    judge(item, label, e, codes, rule);
  }
}
async function deleteOk(item, label, who, doc) {
  if (!doc) return skipped(item, label, 'ok'), false;
  await sleep(A_BLOCK);
  try {
    await mutate('delete', who, doc, () => false);
    record({ item, label, expect: 'ok', got: 'ok', pass: true });
    return true;
  } catch (e) {
    // A delete retried after it landed finds nothing: that is the delete
    if (/not found|does not exist/i.test(msgOf(e)) && codeOf(e) === 40101) return record({ item, label, expect: 'ok', got: 'ok (gone on retry)', pass: true }), true;
    if (e instanceof InfraError) return noVerdict(item, label, e).then(() => false);
    failed(item, label, e);
    return false;
  }
}
/** A proved read by id in `contract`: the case passes when the document is there. */
async function readBack(item, label, contract, type, doc) {
  if (!doc) return record({ item, label, expect: 'read back', got: 'SKIPPED: not written', pass: false });
  try {
    let got;
    for (let i = 0; i < 6 && !got; i++) {
      if (i) await sleep(2000);
      const r = await sdk.documents.getWithProof(contract, type, doc.id);
      got = r?.data;
    }
    record({ item, label, expect: `${type} ${docId(doc)} in ${contract.slice(0, 8)}…, proved`, got: got ? 'found' : 'MISSING', pass: Boolean(got) });
  } catch (e) {
    record({ item, label, expect: 'read back', got: `error ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
  }
}
// fees writes to the live set, and convert/everything are steps of one case: each runs only when named
const EXPLICIT = new Set(['fees', 'convert', 'everything']);
const want = (group) => (only === null ? !EXPLICIT.has(group) : only.has(group));
// A setup write that failed stops the run (with its report): the cases after it would mean nothing
const need = (doc, what) => {
  if (!doc) throw new InfraError(`setup failed: ${what} was not written (see above); rerun`);
  return doc;
};

/** A repo with its owner's maintainer row and the given members (`[[identity, role|'maintainer'], ...]`). */
async function makeRepo(item, name, visibility, members = []) {
  const repo = need(await ok(item, `${visibility} repo ${name}`, O, 'repo', { name, visibility, ...(visibility === 'public' ? { defaultBranch: 'main' } : {}) }), `repo ${name}`);
  const R = docRef(repo);
  const vis = visibility;
  await ok(item, `${name}: the owner's maintainer row`, O, 'maintainer', { repoId: R, memberId: id(O.id), vis });
  const rows = {};
  for (const [who, role] of members) {
    await ok(item, `${name}: ${who.name} consents`, who, 'consent', { repoId: R });
    rows[who.name] = need(
      role === 'maintainer'
        ? await ok(item, `${name}: ${who.name} as maintainer`, O, 'maintainer', { repoId: R, memberId: id(who.id), vis, consentBy: id(who.id) })
        : await ok(item, `${name}: ${who.name} as writer role ${role}`, O, 'writer', { repoId: R, memberId: id(who.id), vis, consentBy: id(who.id), role }),
      `${who.name}'s row in ${name}`,
    );
  }
  await sleep(A_BLOCK);
  return { repo, R, rows, vis, n: 0 };
}
/** An issue or PR at the repo's next number (dense: issues and PRs share one sequence); refused with `codes` when given. */
async function numbered(r, item, label, who, type, data, codes, rule) {
  const full = { repoId: r.R, number: r.n + 1, tk: type === 'issue' ? 0 : 1, ...data };
  const doc = codes ? await no(item, label, who, type, full, codes, rule) : await ok(item, label, who, type, full);
  if (doc) r.n += 1;
  return doc;
}
const prData = (r, extra = {}) => ({ baseRefNameHash: refHash('refs/heads/main'), sourceRepoId: r.R, sourceRefNameHash: refHash(`refs/heads/f-${randomBytes(3).toString('hex')}`), headOid: bytes(20, 2), ...extra });
const member = (who, mRole) => clean({ asMember: id(who.id), mRole });

let stopped = null;
try {
  log(`scratch core ${CORE} collab ${COLLAB} community ${COMM} meta ${META} group ${GROUP}; run ${tag}`);

  // ---------------- the shared public repo and its members ----------------
  const needShared = ['l1', 'l2', 'c2l4', 'c3', 'm1', 'm2', 'm4', 'm3', 'b1', 'layout'].some(want);
  const pub = needShared ? await makeRepo('setup', `mv-${tag}`, 'public', [[M2, 'maintainer'], [W, 1], [T, 2], [RD, 3], [B, 4], [B2, 4]]) : null;
  const R = pub?.R;
  const priv = ['l1', 'm1', 'layout', 'c2l4'].some(want) ? await makeRepo('setup', `mvp-${tag}`, 'private', [[W, 1], [RD, 3]]) : null;
  const P = priv?.R;
  if (pub) {
    await no('C2', 'a writer row of role 5', O, 'writer', { repoId: R, memberId: id(S.id), vis: 'public', consentBy: id(S.id), role: 5 }, SCHEMA);
  }

  // ---------------- L1: aud ----------------
  if (want('l1')) {
    const I = 'L1';
    const pubIssue = need(await numbered(pub, I, 'a public issue (writer)', W, 'issue', { title: 'public', vis: 'public' }), 'the public issue');
    const memIssue = await numbered(pub, I, "a writer's members-only issue (aud 1, asMember, mRole 1)", W, 'issue', { vis: 'public', aud: 1, enc: sealed(), epoch: 0, ...member(W, 1) });
    await numbered(pub, I, "a stranger's members-only issue (aud 1, no asMember)", S, 'issue', { vis: 'public', aud: 1, enc: sealed(), epoch: 0 }, [10422], 'audMember');
    await numbered(pub, I, "a stranger's members-only issue claiming membership", S, 'issue', { vis: 'public', aud: 1, enc: sealed(), epoch: 0, asMember: id(S.id), mRole: 1 }, [40120]);
    await numbered(pub, I, 'a sealed issue without aud (dependentRequired enc -> aud)', W, 'issue', { vis: 'public', enc: sealed(), epoch: 0, ...member(W, 1) }, SCHEMA);
    await numbered(pub, I, 'aud without enc (dependentRequired aud -> enc)', W, 'issue', { vis: 'public', title: 't', aud: 1, ...member(W, 1) }, SCHEMA);
    await numbered(pub, I, "a stranger's letter on a public repo (aud 2, no asMember)", S, 'issue', { vis: 'public', aud: 2, enc: sealed(4), epoch: 0 });
    const tgt = docRef(pubIssue);
    const cm = (extra) => ({ repoId: R, targetId: tgt, vis: 'public', ...extra });
    await no(I, "a stranger's members-only comment (aud 1)", S, 'comment', cm({ aud: 1, enc: sealed(), epoch: 0 }), [10422], 'audMember');
    await ok(I, "a stranger's letter comment (aud 2)", S, 'comment', cm({ aud: 2, enc: sealed(4), epoch: 0 }));
    const wMem = await ok(I, "a writer's members-only comment (aud 1, mRole 1)", W, 'comment', cm({ aud: 1, enc: sealed(), epoch: 0, ...member(W, 1) }));
    const wMem2 = await ok(I, "a second members-only comment (to make public)", W, 'comment', cm({ aud: 1, enc: sealed(), epoch: 0, ...member(W, 1) }));
    await ok(I, "the owner's members-only comment (maintainer, no mRole)", O, 'comment', cm({ aud: 1, enc: sealed(), epoch: 0, asMember: id(O.id) }));
    const wPub = await ok(I, "a writer's public comment", W, 'comment', cm({ body: 'public words', ...member(W, 1) }));
    // edits
    await replaceNo(I, 'a plaintext edit that keeps aud (body, no enc)', W, wMem, { body: 'leak' }, ['enc', 'epoch'], SCHEMA);
    await replaceNo(I, 'a plaintext edit that keeps aud and enc (noPlain)', W, wMem, { body: 'leak' }, [], [10422], 'noPlain');
    await replaceNo(I, 'a sealed edit of a public comment (aud immutable once public)', W, wPub, { aud: 1, enc: sealed(), epoch: 0 }, ['body'], [40128]);
    await replaceNo(I, 'a Members -> letter edit (aud 1 -> 2)', W, wMem, { aud: 2, enc: sealed(4) }, [], [40128]);
    await replaceOk(I, "the author's sealed re-edit keeping aud 1 (new enc)", W, wMem, { enc: sealed() });
    await replaceOk(I, "the author's edit to Public (drops aud, enc, epoch)", W, wMem2, { body: 'now public' }, ['aud', 'enc', 'epoch']);
    // the settable-once fields (§4.11, M-A decision 2): an inline comment's path, a PR's branch names
    const pr = need(await numbered(pub, I, "a writer's members-only PR without branch names", W, 'patch', { vis: 'public', aud: 1, enc: sealed(), epoch: 0, ...member(W, 1), ...prData(pub) }), 'the members-only PR');
    const inline = await ok(I, 'a members-only inline comment (no path in plaintext)', W, 'comment', { repoId: R, targetId: docRef(pr), vis: 'public', aud: 1, enc: sealed(), epoch: 0, commitOid: bytes(20, 2), line: 3, side: 1, ...member(W, 1) });
    const inlinePub = await replaceOk(I, "the inline comment's author makes it public, setting path", W, inline, { body: 'nit', path: 'src/a.rs' }, ['aud', 'enc', 'epoch']);
    await replaceNo(I, 'a later change of the path (set once)', W, inlinePub, { path: 'src/b.rs' }, [], [40128]);
    const pubInline = await ok(I, 'a public inline comment without a path', W, 'comment', { repoId: R, targetId: docRef(pr), vis: 'public', body: 'general', commitOid: bytes(20, 2), line: 4, side: 1, ...member(W, 1) });
    await replaceNo(I, 'a public comment gaining a path later (three-term condition)', W, pubInline, { path: 'src/c.rs' }, [], [40128]);
    const prPub = await replaceOk(I, "the PR's author makes it public, setting both branch names", W, pr, { title: 'now public', baseRefName: 'refs/heads/main', sourceRefName: 'refs/heads/feature' }, ['aud', 'enc', 'epoch']);
    await replaceNo(I, "a later change of the PR's base branch name (set once)", W, prPub, { baseRefName: 'refs/heads/dev' }, [], [40128]);
    const pubPr = await numbered(pub, I, "a writer's public PR without branch names", W, 'patch', { vis: 'public', title: 'public', ...member(W, 1), ...prData(pub) });
    await replaceNo(I, 'a public PR gaining a source branch name later (three-term condition)', W, pubPr, { sourceRefName: 'refs/heads/late' }, [], [40128]);
    // the third term (`present aud`): a document that stays members-only never gains the field
    const sealedInline = await ok(I, 'a second members-only inline comment', W, 'comment', { repoId: R, targetId: docRef(pr), vis: 'public', aud: 1, enc: sealed(), epoch: 0, commitOid: bytes(20, 2), line: 5, side: 1, ...member(W, 1) });
    await replaceNo(I, 'a members-only comment gaining a plaintext diffHunk while it keeps aud', W, sealedInline, { diffHunk: '@@ -1 +1 @@\n+leak' }, [], [40128, 10422]);
    const hunkPub = await replaceOk(I, "its author makes it public, setting path and diffHunk", W, sealedInline, { body: 'see hunk', path: 'src/d.rs', diffHunk: '@@ -1 +1 @@\n+x' }, ['aud', 'enc', 'epoch']);
    await replaceNo(I, 'a later change of the diffHunk (set once)', W, hunkPub, { diffHunk: '@@ -1 +1 @@\n+y' }, [], [40128]);
    if (memIssue) await replaceOk(I, "a members-only issue's author makes it public", W, memIssue, { title: 'public now' }, ['aud', 'enc', 'epoch']);

    // any stranger write to a private repo (p_sealedIfPrivate)
    await numbered(priv, I, "a stranger's sealed issue on a private repo (aud 1)", S, 'issue', { vis: 'private', aud: 1, enc: sealed(), epoch: 0 }, [10422], 'audMember');
    await numbered(priv, I, "a stranger's letter on a private repo (aud 2)", S, 'issue', { vis: 'private', aud: 2, enc: sealed(4), epoch: 0 }, [10422], 'p_sealedIfPrivate');
    await numbered(priv, I, "a stranger's plaintext issue stamped private", S, 'issue', { vis: 'private', title: 'leak' }, [10422], 'p_sealedIfPrivate');
    const pIssue = need(await numbered(priv, I, "a writer's sealed issue on the private repo", W, 'issue', { vis: 'private', aud: 1, enc: sealed(), epoch: 0, ...member(W, 1) }), 'the private issue');
    await numbered(priv, I, "a member's letter on the private repo (aud 2 with asMember)", W, 'issue', { vis: 'private', aud: 2, enc: sealed(4), epoch: 0, ...member(W, 1) });
    const pPr = need(await numbered(priv, I, "a writer's sealed PR on the private repo", W, 'patch', { vis: 'private', aud: 1, enc: sealed(), epoch: 0, ...member(W, 1), ...prData(priv) }), 'the private PR');
    await no(I, "a stranger's letter comment on a private repo", S, 'comment', { repoId: P, targetId: docRef(pIssue), vis: 'private', aud: 2, enc: sealed(4), epoch: 0 }, [10422], 'p_sealedIfPrivate');
    await no(I, "a stranger's comment claiming membership of the private repo", S, 'comment', { repoId: P, targetId: docRef(pIssue), vis: 'private', aud: 1, enc: sealed(), epoch: 0, asMember: id(S.id), mRole: 1 }, [40120]);
    await no(I, "a stranger's sealed review on a private PR", S, 'review', { repoId: P, patchId: docRef(pPr), verdict: 3, commitOid: bytes(20, 2), vis: 'private', aud: 2, enc: sealed(4), epoch: 0 }, [10422], 'p_sealedIfPrivate');
    await no(I, "the owner's bodyless approval on a private PR without aud (L1 seals every private review)", O, 'review', { repoId: P, patchId: docRef(pPr), verdict: 1, commitOid: bytes(20, 2), vis: 'private', asMember: id(O.id) }, [10422], 'p_sealedIfPrivate');
    await ok(I, "the owner's sealed approval on a private PR (aud 1, enc, asMember)", O, 'review', { repoId: P, patchId: docRef(pPr), verdict: 1, commitOid: bytes(20, 2), vis: 'private', aud: 1, enc: sealed(), epoch: 0, asMember: id(O.id) });
    await ok(I, "a writer's sealed comment on the private issue", W, 'comment', { repoId: P, targetId: docRef(pIssue), vis: 'private', aud: 1, enc: sealed(), epoch: 0, ...member(W, 1) });
  }

  // ---------------- L2: mRole ----------------
  if (want('l2')) {
    const I = 'L2';
    const pr = need(await numbered(pub, I, "the owner's PR", O, 'patch', { vis: 'public', title: 'review me', ...prData(pub) }), 'the L2 PR');
    const rv = (who, verdict, extra = {}) => ({ repoId: R, patchId: docRef(pr), verdict, commitOid: bytes(20, 2), vis: 'public', ...extra });
    await no(I, "a reader's approve (asMember, mRole 3)", RD, 'review', rv(RD, 1, member(RD, 3)), [10422], 'memberVerdict');
    await no(I, "a reader's request-changes (verdict 2, mRole 3)", RD, 'review', rv(RD, 2, member(RD, 3)), [10422], 'memberVerdict');
    await no(I, "a reader's approve claiming mRole 1", RD, 'review', rv(RD, 1, member(RD, 1)), [40127]);
    await no(I, "triage's approve (mRole 2)", T, 'review', rv(T, 1, member(T, 2)), [10422], 'memberVerdict');
    await no(I, "a bot's approve (mRole 4)", B, 'review', rv(B, 1, member(B, 4)), [10422], 'memberVerdict');
    await no(I, "a stranger's approve (verdict 1, no asMember)", S, 'review', rv(S, 1), [10422], 'memberVerdict');
    await no(I, "a writer's approve with no mRole (its row says role 1)", W, 'review', rv(W, 1, { asMember: id(W.id) }), [40127]);
    await ok(I, "a writer's approve (mRole 1)", W, 'review', rv(W, 1, member(W, 1)));
    await ok(I, "a maintainer's approve with no mRole", O, 'review', rv(O, 1, { asMember: id(O.id) }));
    await ok(I, "the second maintainer's request-changes with no mRole", M2, 'review', rv(M2, 2, { asMember: id(M2.id) }));
    await ok(I, "a reader's comment-verdict (3) as a member", RD, 'review', rv(RD, 3, { body: 'looks fine', ...member(RD, 3) }));
    await ok(I, "a stranger's verdict 4 (outside approval)", S, 'review', rv(S, 4, { body: 'lgtm' }));
    await no(I, "a member's verdict 4 (outsider verdicts only)", W, 'review', rv(W, 4, member(W, 1)), [10422], 'memberVerdict');
    // i_provenance (row 6), now on review too
    const imp = { url: 'https://github.com/x/y/issues/9', author: 'octocat', createdAt: 1 };
    await numbered(pub, I, "triage imports an issue (mRole 2)", T, 'issue', { title: 'imported', vis: 'public', imported: imp, upstreamNumber: 9, ...member(T, 2) }, [10422], 'i_provenance');
    await numbered(pub, I, "a writer imports an issue (mRole 1)", W, 'issue', { title: 'imported', vis: 'public', imported: imp, upstreamNumber: 9, ...member(W, 1) });
    await numbered(pub, I, "a stranger imports an issue", S, 'issue', { title: 'imported', vis: 'public', imported: imp }, [10422], 'i_provenance');
    await no(I, "triage imports a review (i_provenance on review)", T, 'review', rv(T, 3, { body: 'imported', imported: { url: 'https://github.com/x/y/pull/1#r1' }, ...member(T, 2) }), [10422], 'i_provenance');
    await ok(I, "a writer imports a review", W, 'review', rv(W, 3, { body: 'imported', imported: { url: 'https://github.com/x/y/pull/1#r2' }, ...member(W, 1) }));
    // a member's edit after a role change restates the new mRole (a repo of its own)
    const rc = await makeRepo(I, `mvrc-${tag}`, 'public', [[W, 1]]);
    const iss = need(await numbered(rc, I, 'role-change repo: issue #1', O, 'issue', { title: 'x', vis: 'public' }), 'the role-change issue');
    const c = await ok(I, "the writer's comment as a member (mRole 1)", W, 'comment', { repoId: rc.R, targetId: docRef(iss), vis: 'public', body: 'v1', ...member(W, 1) });
    if (await deleteOk(I, "the owner removes the writer's role-1 row", O, rc.rows.writer)) {
      await ok(I, 'the owner re-adds the writer as triage (role 2)', O, 'writer', { repoId: rc.R, memberId: id(W.id), vis: 'public', consentBy: id(W.id), role: 2 });
      await sleep(A_BLOCK);
      await replaceNo(I, 'an edit restating the old mRole 1', W, c, { body: 'v2' }, [], [40127]);
      await replaceOk(I, 'an edit restating the new mRole 2', W, c, { body: 'v2', mRole: 2 });
    }
  }

  // ---------------- C1 + L3 + C4: a private repo made public ----------------
  if (want('c1')) {
    const I = 'C1';
    const cv = await makeRepo(I, `mvc-${tag}`, 'private', [[W, 1], [M2, 'maintainer'], [RD, 3]]);
    const C = cv.R;
    const oldIssue = need(await numbered(cv, I, 'an old sealed issue (private era)', W, 'issue', { vis: 'private', aud: 1, enc: sealed(), epoch: 0, ...member(W, 1) }), 'the old issue');
    const oldPr = need(await numbered(cv, I, 'an old sealed PR (private era)', W, 'patch', { vis: 'private', aud: 1, enc: sealed(), epoch: 0, ...member(W, 1), ...prData(cv) }), 'the old PR');
    const oldComment = await ok(I, 'an old sealed comment', W, 'comment', { repoId: C, targetId: docRef(oldIssue), vis: 'private', aud: 1, enc: sealed(), epoch: 0, ...member(W, 1) });
    await ok(I, 'an old sealed config', O, 'config', { repoId: C, vis: 'private', enc: sealed(1), epoch: 0 });
    await ok(I, 'an old sealed ref update by the writer', W, 'refUpdate', { repoId: C, refNameHash: bytes(32, 3), newOid: bytes(20, 3), vis: 'private', enc: sealed(1), epoch: 0 });
    // before the flip, the public writes are refused (the repo proves vis)
    await no(I, "before the flip: a stranger's public comment on the old issue", S, 'comment', { repoId: C, targetId: docRef(oldIssue), vis: 'public', body: 'hi' }, [40127]);
    await no(I, "before the flip: the writer's public ref update", W, 'refUpdate', { repoId: C, refNameHash: refHash('refs/heads/main'), refName: 'refs/heads/main', newOid: bytes(20, 4), vis: 'public' }, [40127]);
    const repoDoc = cv.repo;
    // The replace names the maintainer as its owner and is signed by it (an SDK replace of the
    // owner's document would carry the owner's id and fail the signature check, 20002, instead)
    await replaceNo(I, "a maintainer flips the owner's repo (only the owner replaces it)", M2, repoDoc, { $ownerId: M2.id, visibility: 'public', defaultBranch: 'main' }, [], [40102]);
    const flipped = await replaceOk(I, 'the owner flips private -> public', O, repoDoc, { visibility: 'public', defaultBranch: 'main' });
    if (flipped) {
      await replaceNo(I, 'the owner flips it back public -> private', O, flipped, { visibility: 'private' }, ['defaultBranch'], [40128]);
      await sleep(A_BLOCK);
      // L3: public replies on old threads
      await ok(I, "a stranger's public reply on an old members-only thread", S, 'comment', { repoId: C, targetId: docRef(oldIssue), vis: 'public', body: 'hello' });
      await ok(I, "a member's members-only reply on the old thread (aud 1, vis public)", W, 'comment', { repoId: C, targetId: docRef(oldIssue), vis: 'public', aud: 1, enc: sealed(), epoch: 0, ...member(W, 1) });
      await ok(I, "a stranger's public review on an old PR", S, 'review', { repoId: C, patchId: docRef(oldPr), verdict: 4, commitOid: bytes(20, 2), vis: 'public', body: 'lgtm' });
      await ok(I, "a writer's public approval on an old PR (mRole 1)", W, 'review', { repoId: C, patchId: docRef(oldPr), verdict: 1, commitOid: bytes(20, 2), vis: 'public', ...member(W, 1) });
      await no(I, 'a comment stamped private on the now-public repo', W, 'comment', { repoId: C, targetId: docRef(oldIssue), vis: 'private', aud: 1, enc: sealed(), epoch: 0, ...member(W, 1) }, [40127]);
      await replaceNo(I, "an author's edit to Public of an old private-era comment (vis private keeps aud required)", W, oldComment, { body: 'old words' }, ['aud', 'enc', 'epoch'], [10422], 'p_sealedIfPrivate');
      await numbered(cv, I, 'a new public issue on the converted repo', S, 'issue', { vis: 'public', title: 'new era' });
      // C4: the members' old rows (vis private) admit public-era writes untouched
      await ok(I, "the writer's public ref update (row stamped private, not re-issued)", W, 'refUpdate', { repoId: C, refNameHash: refHash('refs/heads/main'), refName: 'refs/heads/main', newOid: bytes(20, 5), vis: 'public' });
      await no(I, 'a ref update stamped private on the now-public repo', W, 'refUpdate', { repoId: C, refNameHash: bytes(32, 3), newOid: bytes(20, 6), vis: 'private', enc: sealed(1), epoch: 0 }, [40127]);
      await ok(I, "the owner's plaintext config (maintainer row stamped private)", O, 'config', { repoId: C, defaultBranch: 'main', vis: 'public' });
      await ok(I, "the second maintainer's protected ref update", M2, 'protectedRefUpdate', { repoId: C, refNameHash: refHash('refs/heads/main'), refName: 'refs/heads/main', newOid: bytes(20, 7), vis: 'public' });
      await ok(I, "the owner's public release", O, 'release', { repoId: C, tagName: 'v1', name: 'one', vis: 'public', delta: 1, targetOid: bytes(20, 7) });
      await ok(I, "the owner's webhook", O, 'webhook', { repoId: C, hookId: bytes(32), url: 'https://hooks.example.com/mv', events: ['push'], relayIdentityId: id(W.id), relayKeyId: W.encKeyId, senderKeyId: O.encKeyId, secret: bytes(48), vis: 'public' });
      await ok(I, "a reader's public comment as a member (row stamped private)", RD, 'comment', { repoId: C, targetId: docRef(oldIssue), vis: 'public', body: 'reader here', ...member(RD, 3) });
    }
    // C1 on a public repo from the start
    const p0 = await ok(I, 'a public repo for the one-way check', O, 'repo', { name: `mvo-${tag}`, visibility: 'public', defaultBranch: 'main' });
    await replaceNo(I, 'a public repo made private', O, p0, { visibility: 'private' }, ['defaultBranch'], [40128]);
    await replaceOk(I, "a public repo's description edit (visibility unchanged)", O, p0, { description: 'still public' });
  }

  // ---------------- C2 + L4: the Bot role and wraps ----------------
  if (want('c2l4')) {
    const I = 'L4';
    const wrap = (who, mr, repoId = R) => ({ repoId, memberId: id(who.id), epoch: 0, recipientKeyId: who.encKeyId, senderKeyId: O.encKeyId, wrapped: bytes(48), mr });
    await ok(I, 'a wrap to the writer (mr 1)', O, 'repoKey', wrap(W, 1));
    await ok(I, 'a wrap to triage (mr 2)', O, 'repoKey', wrap(T, 2));
    await ok(I, 'a wrap to the reader (mr 3)', O, 'repoKey', wrap(RD, 3));
    await ok(I, 'a wrap to the second maintainer (maintainer operand, mr 1)', O, 'repoKey', wrap(M2, 1));
    await ok(I, 'a wrap to the reader of the private repo (mr 3)', O, 'repoKey', wrap(RD, 3, P));
    await no(I, 'a wrap to a bot claiming mr 1', O, 'repoKey', wrap(B, 1), [40127]);
    await no(I, 'a wrap to a bot claiming mr 3', O, 'repoKey', wrap(B, 3), [40127]);
    await no(I, 'a wrap to a bot with mr 4 (maximum 3)', O, 'repoKey', wrap(B, 4), SCHEMA);
    await no(I, "the writer's wrap (maintainer only)", W, 'repoKey', { ...wrap(W, 1), senderKeyId: W.encKeyId }, [40120]);
    await no(I, 'a wrap to the writer claiming mr 2', O, 'repoKey', { ...wrap(W, 2), epoch: 1 }, [40127]);
    // C2: a bot is a member that passes no triage gate
    const iss = need(await numbered(pub, 'C2', "the writer's issue", W, 'issue', { title: 'bot target', vis: 'public' }), 'the C2 issue');
    const n = pub.n;
    const T2 = (kind, delta, r, extra = {}) => ({ repoId: R, targetId: docRef(iss), targetNumber: n, targetKind: 0, kind, delta, asAuthor: 0, r, ...extra });
    await no('C2', "a bot closes someone else's issue (r 2)", B, 'transition', T2(1, 1, 2), WHERE_ANYOF);
    await no('C2', "a bot closes someone else's issue (r 1)", B, 'transition', T2(1, 1, 1), WHERE_ANYOF);
    // the positive controls on the same issue and number
    await ok('C2', 'triage closes the same issue (r 2)', T, 'transition', T2(1, 1, 2));
    await ok('C2', 'triage reopens it (r 2)', T, 'transition', T2(2, -1, 2));
    await no('C2', 'a bot labels an issue (event kind 4, r 2)', B, 'event', { repoId: R, targetId: docRef(iss), targetNumber: n, kind: 4, value: 'bug', r: 2 }, [40127]);
    await ok('C2', 'triage labels the same issue (event kind 4, r 2)', T, 'event', { repoId: R, targetId: docRef(iss), targetNumber: n, kind: 4, value: 'bug', r: 2 });
    await no('C2', 'a bot creates a label (r 2)', B, 'label', { repoId: R, name: 'bot', r: 2 }, [40127]);
    await no('C2', 'a bot creates a milestone (r 2)', B, 'milestone', { repoId: R, title: 'bot', r: 2 }, [40127]);
    await no('C2', 'a bot posts a check run (r 1)', B, 'checkRun', { repoId: R, headOid: bytes(20, 2), name: 'b', status: 'queued', outcome: 0, vis: 'public', r: 1 }, [40127]);
    await ok('C2', "a bot's members-only comment (aud 1, v0x05, mRole 4)", B, 'comment', { repoId: R, targetId: docRef(iss), vis: 'public', aud: 1, enc: sealed(5), epoch: 0, ...member(B, 4) });
    await no('C2', "a bot's comment claiming mRole 1", B, 'comment', { repoId: R, targetId: docRef(iss), vis: 'public', aud: 1, enc: sealed(5), epoch: 0, ...member(B, 1) }, [40127]);
    await ok('C2', "a bot's public comment as a member (mRole 4)", B, 'comment', { repoId: R, targetId: docRef(iss), vis: 'public', body: 'bot says hi', ...member(B, 4) });
    const own = await numbered(pub, 'C2', "a bot opens its own issue", B, 'issue', { title: 'bot issue', vis: 'public', ...member(B, 4) });
    if (own) await ok('C2', 'a bot closes its own issue as the author (asAuthor)', B, 'transition', { repoId: R, targetId: docRef(own), targetNumber: pub.n, targetKind: 0, kind: 1, delta: 1, asAuthor: pub.n, r: 1 });
  }

  // ---------------- C3: maintainer-only manifest kinds ----------------
  if (want('c3')) {
    const I = 'C3';
    const man = (kind, r, extra = {}) => ({ repoId: R, packHash: bytes(32), kind, sizeBytes: 100, objectCount: 0, chunkCount: 0, storage: 1, r, ...extra });
    for (const kind of [7, 8, 9, 11]) await no(I, `a writer's kind-${kind} manifest (r 1)`, W, 'packManifest', man(kind, 1), [10422], 'maintKinds');
    await no(I, "a writer's kind-7 manifest claiming r 0", W, 'packManifest', man(7, 0), [40127]);
    await no(I, "triage's kind-0 manifest (r 2)", T, 'packManifest', man(0, 2), [10422], 'botPack');
    await no(I, "the owner's kind-7 manifest with r 1", O, 'packManifest', man(7, 1), [10422], 'maintKinds');
    for (const kind of [7, 8, 9, 11]) await ok(I, `a maintainer's kind-${kind} manifest (r 0)`, O, 'packManifest', man(kind, 0));
    await ok(I, "the second maintainer's kind-8 manifest (r 0)", M2, 'packManifest', man(8, 0));
    await ok(I, "a writer's kind-0 manifest (r 1)", W, 'packManifest', man(0, 1));
    await ok(I, "a writer's kind-10 key letter manifest (r 1)", W, 'packManifest', man(10, 1));
    await ok(I, "a maintainer's kind-0 manifest (r 0)", O, 'packManifest', man(0, 0));
  }

  // ---------------- M1: members-only check runs ----------------
  if (want('m1')) {
    const I = 'M1';
    const now = Date.now();
    const run = (repoId, vis, extra = {}) => ({ repoId, headOid: bytes(20, 2), name: `m1-${randomBytes(2).toString('hex')}`, status: 'completed', conclusion: 'success', startedAt: now - 60000, completedAt: now, outcome: 1, vis, ...extra });
    await no(I, 'an aud check run with a summary', O, 'checkRun', run(R, 'public', { aud: 1, summary: 'leak' }), [10422], 'sealedNoText');
    await no(I, 'an aud check run with a detailsUrl', O, 'checkRun', run(R, 'public', { aud: 1, detailsUrl: 'https://ci.example.com/1' }), [10422], 'sealedNoText');
    await no(I, 'an aud check run with an externalId', O, 'checkRun', run(R, 'public', { aud: 1, externalId: 'job-1' }), [10422], 'sealedNoText');
    await no(I, 'an aud check run with artifacts', O, 'checkRun', run(R, 'public', { aud: 1, artifacts: 'a.zip' }), [10422], 'sealedNoText');
    await no(I, 'a private check run with a summary', O, 'checkRun', run(P, 'private', { summary: 'leak' }), [10422], 'sealedNoText');
    await no(I, 'aud 2 on a check run (1 only)', O, 'checkRun', run(R, 'public', { aud: 2 }), SCHEMA);
    await ok(I, 'an aud check run with only an opaque log link', O, 'checkRun', run(R, 'public', { aud: 1, logUrl: 'https://logs.example.com/blob', logSha256: bytes(32, 1) }));
    await ok(I, 'a private check run with an opaque log link (row 13 loosened)', O, 'checkRun', run(P, 'private', { logUrl: 'https://logs.example.com/blob2', logSha256: bytes(32, 2) }));
    await ok(I, 'a public check run with text', O, 'checkRun', run(R, 'public', { summary: 'all green', detailsUrl: 'https://ci.example.com/2' }));
    const q = await ok(I, 'a queued public run', O, 'checkRun', { repoId: R, headOid: bytes(20, 3), name: 'm1-q', status: 'queued', outcome: 0, vis: 'public' });
    await replaceNo(I, 'a public run turned members-only later (aud immutable)', O, q, { aud: 1 }, [], [40128]);
  }

  // ---------------- M2: the triage allow-list and kind 23 ----------------
  if (want('m2')) {
    const I = 'M2';
    const iss = need(await numbered(pub, I, "the writer's issue", W, 'issue', { title: 'm2', vis: 'public' }), 'the M2 issue');
    const n = pub.n;
    const ev = (kind, r, extra = {}) => ({ repoId: R, targetId: docRef(iss), targetNumber: n, kind, r, ...extra });
    await no(I, 'triage asks for a CI re-run (kind 26)', T, 'event', ev(26, 2), [10422], 't_triageKinds');
    await no(I, 'triage asks a bot (kind 27)', T, 'event', ev(27, 2, { refId: id(B.id), value: 'fix it' }), [10422], 't_triageKinds');
    await no(I, 'triage writes kind 40 (a kind defined later)', T, 'event', ev(40, 2), [10422], 't_triageKinds');
    await ok(I, 'triage labels (kind 4)', T, 'event', ev(4, 2, { value: 'bug' }));
    await ok(I, 'triage assigns (kind 6)', T, 'event', ev(6, 2, { value: 'x', refId: id(W.id) }));
    await ok(I, 'triage sets a milestone (kind 17)', T, 'event', ev(17, 2, { value: 'v1' }));
    await ok(I, 'a writer asks a bot (kind 27, r 1)', W, 'event', ev(27, 1, { refId: id(B.id), value: 'fix it' }));
    await ok(I, 'a writer asks for a re-run (kind 26, r 1)', W, 'event', ev(26, 1));
    await ok(I, "a maintainer's policy bypass (kind 23, asMaintainer)", O, 'event', ev(23, 1, { asMaintainer: id(O.id) }));
    await no(I, 'a policy bypass without asMaintainer', O, 'event', ev(23, 1), [10422], 'hideByMaint');
    await no(I, "a writer's policy bypass naming itself", W, 'event', ev(23, 1, { asMaintainer: id(W.id) }), [40120]);
    await no(I, "a writer's policy bypass naming the owner", W, 'event', ev(23, 1, { asMaintainer: id(O.id) }), [10422], 'hideByMaint');
  }

  // ---------------- M4: event values on members-only targets ----------------
  if (want('m4')) {
    const I = 'M4';
    const memIss = need(await numbered(pub, I, "a writer's members-only issue", W, 'issue', { vis: 'public', aud: 1, enc: sealed(), epoch: 0, ...member(W, 1) }), 'the members-only issue');
    const mn = pub.n;
    const pubIss = need(await numbered(pub, I, "a writer's public issue", W, 'issue', { title: 'm4', vis: 'public' }), 'the public issue');
    const pn = pub.n;
    const ev = (iss, n, extra) => ({ repoId: R, targetId: docRef(iss), targetNumber: n, kind: 4, r: 1, ...extra });
    await no(I, 'a plaintext label on a members-only issue, tAud left out', W, 'event', ev(memIss, mn, { value: 'bug' }), WHERE_ANYOF);
    await no(I, 'a plaintext label on a members-only issue, tAud 1', W, 'event', ev(memIss, mn, { value: 'bug', tAud: 1 }), [10422], 'tAudSealed');
    await no(I, 'a sealed label claiming the wrong tAud (2)', W, 'event', ev(memIss, mn, { enc: sealed(), epoch: 0, tAud: 2 }), WHERE_ANYOF);
    await ok(I, 'a sealed label on a members-only issue (tAud 1)', W, 'event', ev(memIss, mn, { enc: sealed(), epoch: 0, tAud: 1 }));
    await ok(I, 'a sealed assignment on a members-only issue (tAud 1)', W, 'event', ev(memIss, mn, { kind: 6, refId: id(W.id), enc: sealed(), epoch: 0, tAud: 1 }));
    await ok(I, 'a value-free event on a members-only issue (review request, tAud 1)', W, 'event', ev(memIss, mn, { kind: 11, refId: id(O.id), tAud: 1 }));
    await ok(I, 'a plaintext label on a public issue (both absent agree)', W, 'event', ev(pubIss, pn, { value: 'bug' }));
    await no(I, 'a public issue claiming tAud 1', W, 'event', ev(pubIss, pn, { enc: sealed(), epoch: 0, tAud: 1 }), WHERE_ANYOF);
  }

  // ---------------- M3: author events ----------------
  if (want('m3')) {
    const I = 'M3';
    const memPr = need(await numbered(pub, I, "a writer's members-only PR", W, 'patch', { vis: 'public', aud: 1, enc: sealed(), epoch: 0, ...member(W, 1), ...prData(pub) }), 'the members-only PR');
    const mn = pub.n;
    const pubPr = need(await numbered(pub, I, "a writer's public PR", W, 'patch', { vis: 'public', title: 'm3', ...prData(pub) }), 'the public PR');
    const pn = pub.n;
    const ae = (pr, n, extra) => ({ repoId: R, targetId: docRef(pr), targetNumber: n, kind: 8, ...extra });
    await no(I, 'a plaintext retarget of a members-only PR, tAud left out', W, 'authorEvent', ae(memPr, mn, { value: 'refs/heads/dev' }), WHERE_ANYOF);
    await no(I, 'a plaintext retarget of a members-only PR, tAud 1', W, 'authorEvent', ae(memPr, mn, { value: 'refs/heads/dev', tAud: 1 }), [10422], 'tAudSealed');
    await no(I, 'a retarget with both value and enc', W, 'authorEvent', ae(memPr, mn, { value: 'refs/heads/dev', enc: sealed(), epoch: 0, tAud: 1 }), [10422], 'noPlain');
    await no(I, 'a retarget with neither value nor enc', W, 'authorEvent', ae(memPr, mn, { tAud: 1 }), [10422], 'retargetValue');
    await no(I, 'enc without epoch', W, 'authorEvent', ae(memPr, mn, { enc: sealed(), tAud: 1 }), SCHEMA);
    await ok(I, 'a sealed retarget of a members-only PR (tAud 1)', W, 'authorEvent', ae(memPr, mn, { enc: sealed(), epoch: 0, tAud: 1 }));
    await ok(I, 'a plaintext retarget of a public PR', W, 'authorEvent', ae(pubPr, pn, { value: 'refs/heads/dev' }));
    await no(I, "a non-author's sealed retarget", T, 'authorEvent', ae(memPr, mn, { enc: sealed(), epoch: 0, tAud: 1 }), [40120]);
  }

  // ---------------- B1: bot push grants ----------------
  if (want('b1')) {
    const I = 'B1';
    const PREFIX = 'refs/heads/bot/ci-bot/';
    // a grant's writer (its granter) is the identity that signs it
    const grant = (bot, extra) => ({ repoId: R, botId: id(bot.id), until: Date.now() + 30 * DAY, ...extra });
    const pGrant = need(await ok(I, 'the owner grants the bot a public prefix', O, 'pushGrant', grant(B, { prefix: PREFIX })), 'the prefix grant');
    const pUntil = Number(pGrant.toObject().until);
    const botRef = (name, g, until, extra = {}) => ({ repoId: R, refNameHash: refHash(name), refName: name, newOid: bytes(20, 9), vis: 'public', r: 4, pp: docRef(g), grantor: id(O.id), gp: PREFIX, gu: until, ...extra });
    await ok(I, 'the bot pushes refs/heads/bot/ci-bot/x under the prefix grant', B, 'refUpdate', botRef(`${PREFIX}x`, pGrant, pUntil));
    // its kind-0 pack, kind-1 browse index and kind-6 long body (Platform chunks, r 4)
    for (const [kind, label] of [[0, 'pack'], [1, 'browse index'], [6, 'long body']]) {
      const ph = bytes(32);
      const c = await ok(I, `the bot's chunk for its kind-${kind} ${label} (r 4)`, B, 'chunk', { repoId: R, packHash: ph, seq: 0, d0: bytes(200), r: 4 });
      if (c) {
        await sleep(A_BLOCK);
        await ok(I, `the bot's kind-${kind} ${label} manifest (r 4)`, B, 'packManifest', { repoId: R, packHash: ph, kind, sizeBytes: 200, objectCount: kind === 0 ? 1 : 0, chunkCount: 1, storage: 0, r: 4 });
      }
    }
    await no(I, "the bot's chunk claiming r 1", B, 'chunk', { repoId: R, packHash: bytes(32), seq: 0, d0: bytes(10), r: 1 }, [40127]);
    // refusals
    await no(I, 'a bot ref update with no grant (r 4)', B, 'refUpdate', { repoId: R, refNameHash: refHash(`${PREFIX}y`), refName: `${PREFIX}y`, newOid: bytes(20, 1), vis: 'public', r: 4 }, [10422], 'botGrant');
    await no(I, 'a bot ref update outside its prefix (refs/heads/main)', B, 'refUpdate', botRef('refs/heads/main', pGrant, pUntil), [10422], 'botGrant');
    await no(I, 'a bot ref update claiming r 1 (its row is role 4)', B, 'refUpdate', { repoId: R, refNameHash: refHash(`${PREFIX}z`), refName: `${PREFIX}z`, newOid: bytes(20, 1), vis: 'public', r: 1 }, [40127]);
    await no(I, 'a bot ref update naming a different until (gu)', B, 'refUpdate', botRef(`${PREFIX}x`, pGrant, pUntil + 1), [40127]);
    await no(I, "another bot pushes under the bot's grant", B2, 'refUpdate', botRef(`${PREFIX}x`, pGrant, pUntil), [40127]);
    await no(I, 'triage sends r 4 under the grant', T, 'refUpdate', botRef(`${PREFIX}x`, pGrant, pUntil), WHERE_ANYOF);
    await no(I, 'the reader sends r 4 under the grant', RD, 'refUpdate', botRef(`${PREFIX}x`, pGrant, pUntil), WHERE_ANYOF);
    await no(I, 'triage uploads a chunk with r 4', T, 'chunk', { repoId: R, packHash: bytes(32), seq: 0, d0: bytes(10), r: 4 }, [40127]);
    await no(I, 'triage uploads a chunk with its own r 2 (botChunk: r 1 or 4)', T, 'chunk', { repoId: R, packHash: bytes(32), seq: 0, d0: bytes(10), r: 2 }, [10422], 'botChunk');
    await no(I, 'a bot protected ref update', B, 'protectedRefUpdate', { repoId: R, refNameHash: refHash('refs/heads/main'), refName: 'refs/heads/main', newOid: bytes(20, 1), vis: 'public' }, [40120]);
    const bman = (kind, extra = {}) => ({ repoId: R, packHash: bytes(32), kind, sizeBytes: 100, objectCount: 0, chunkCount: 0, storage: 1, r: 4, ...extra });
    await no(I, 'a bot manifest of kind 3 (r 4)', B, 'packManifest', bman(3, { tips: bytes(20) }), [10422], 'botPack');
    for (const kind of [7, 8, 10, 11]) await no(I, `a bot manifest of kind ${kind} (r 4)`, B, 'packManifest', bman(kind), [10422], 'botPack');
    await no(I, 'a bot manifest claiming r 0', B, 'packManifest', bman(0, { r: 0 }), [40127]);
    await no(I, 'a bot manifest with supersedes', B, 'packManifest', bman(0, { supersedes: bytes(32) }), [10422], 'botPack');
    await ok(I, 'a bot kind-64 manifest (members-only pack, external)', B, 'packManifest', bman(64));
    await ok(I, 'a bot kind-65 manifest (members-only browse index)', B, 'packManifest', bman(65));
    await ok(I, 'a bot kind-70 manifest (members-only long body)', B, 'packManifest', bman(70));
    // grant shape
    await no(I, "a writer's grant", W, 'pushGrant', grant(B, { prefix: PREFIX }), [40120]);
    await no(I, 'a grant to a role-1 writer', O, 'pushGrant', grant(W, { prefix: PREFIX }), [40127]);
    await no(I, 'a grant to the reader', O, 'pushGrant', grant(RD, { prefix: PREFIX }), [40127]);
    await no(I, 'a grant to a stranger', O, 'pushGrant', grant(S, { prefix: PREFIX }), [40120]);
    await no(I, 'a grant with until 91 days ahead', O, 'pushGrant', grant(B, { prefix: PREFIX, until: Date.now() + 91 * DAY }), [10422], 'ttl90');
    await no(I, 'a grant with until in the past', O, 'pushGrant', grant(B, { prefix: PREFIX, until: Date.now() - 120000 }), [10422], 'ttl90');
    await no(I, 'a grant with both scope and prefix', O, 'pushGrant', grant(B, { prefix: PREFIX, scope: bytes(32) }), [10422], 'oneScope');
    await no(I, 'a grant with neither scope nor prefix', O, 'pushGrant', grant(B, {}), [10422], 'oneScope');
    await no(I, 'a grant with br 1', O, 'pushGrant', grant(B, { prefix: PREFIX, br: 1 }), SCHEMA);
    // an exact members-only grant (a synthetic branch-key HMAC until phase 3F)
    const scope = bytes(32);
    const xGrant = need(await ok(I, 'the owner grants the bot one exact members-only ref', O, 'pushGrant', grant(B, { scope })), 'the exact grant');
    const xUntil = Number(xGrant.toObject().until);
    const exact = (extra) => ({ repoId: R, refNameHash: scope, newOid: bytes(20, 8), vis: 'public', r: 4, pg: docRef(xGrant), grantor: id(O.id), gu: xUntil, ...extra });
    await ok(I, 'the bot pushes the exact members-only ref (sealed)', B, 'refUpdate', exact({ enc: sealed(1), epoch: 0 }));
    await no(I, 'a public update through the exact grant', B, 'refUpdate', exact({ refName: 'refs/heads/secret' }), [10422], 'botGrant');
    await no(I, 'an exact grant used for another ref', B, 'refUpdate', exact({ refNameHash: bytes(32), enc: sealed(1), epoch: 0 }), [40127]);
    await no(I, 'pp naming the exact grant (no gp)', B, 'refUpdate', { repoId: R, refNameHash: refHash(`${PREFIX}e`), refName: `${PREFIX}e`, newOid: bytes(20, 1), vis: 'public', r: 4, pp: docRef(xGrant), grantor: id(O.id), gu: xUntil }, [10422], 'botGrant');
    await no(I, 'pp naming the exact grant (with gp)', B, 'refUpdate', { repoId: R, refNameHash: refHash(`${PREFIX}e`), refName: `${PREFIX}e`, newOid: bytes(20, 1), vis: 'public', r: 4, pp: docRef(xGrant), grantor: id(O.id), gp: PREFIX, gu: xUntil }, [40127]);
    await no(I, 'pg naming the prefix grant', B, 'refUpdate', { repoId: R, refNameHash: refHash(`${PREFIX}x`), newOid: bytes(20, 1), vis: 'public', r: 4, pg: docRef(pGrant), grantor: id(O.id), gu: pUntil, enc: sealed(1), epoch: 0 }, [40127]);
    // a renewal: a new grant, then a push under it
    const renewed = await ok(I, 'the owner renews the prefix grant (a new grant, later until)', O, 'pushGrant', grant(B, { prefix: PREFIX, until: Date.now() + 60 * DAY }));
    if (renewed) await ok(I, 'the bot pushes under the renewal', B, 'refUpdate', botRef(`${PREFIX}x`, renewed, Number(renewed.toObject().until)));
    // the human push is unchanged and reads no grant
    await ok(I, "a writer's push (r 1, no grant)", W, 'refUpdate', { repoId: R, refNameHash: refHash('refs/heads/w'), refName: 'refs/heads/w', newOid: bytes(20, 3), vis: 'public' });
    await no(I, "a writer's push naming a grant (r 1)", W, 'refUpdate', { repoId: R, refNameHash: refHash(`${PREFIX}x`), refName: `${PREFIX}x`, newOid: bytes(20, 3), vis: 'public', pp: docRef(pGrant), grantor: id(O.id), gp: PREFIX, gu: pUntil }, [40127]);
    // client rules: consensus admits these (DESIGN §8.2 row 47)
    await ok(I, "consensus admits a bot's public update whose hash is not sha256(refName) (readers drop it)", B, 'refUpdate', botRef(`${PREFIX}x`, pGrant, pUntil, { refNameHash: bytes(32) }));
    // the granter removed: a grant by the second maintainer, then its row deleted
    const m2Grant = await ok(I, 'the second maintainer grants the bot the prefix', M2, 'pushGrant', grant(B, { prefix: PREFIX }));
    if (m2Grant) {
      const mU = Number(m2Grant.toObject().until);
      await ok(I, "the bot pushes under the second maintainer's grant", B, 'refUpdate', botRef(`${PREFIX}m`, m2Grant, mU, { grantor: id(M2.id) }));
      await no(I, "the bot names the owner as the second maintainer's grantor", B, 'refUpdate', botRef(`${PREFIX}m`, m2Grant, mU), [40127]);
      if (await deleteOk(I, "the owner removes the second maintainer's row", O, pub.rows.maint2)) {
        await sleep(A_BLOCK);
        await no(I, "the bot pushes under the removed granter's grant", B, 'refUpdate', botRef(`${PREFIX}m`, m2Grant, mU, { grantor: id(M2.id) }), [40120]);
      }
    }
    // a removed and re-added bot: consensus accepts its old grant (the runner and readers ignore it)
    const b2Prefix = 'refs/heads/bot/b2/';
    const b2Grant = await ok(I, 'the owner grants bot2 a prefix', O, 'pushGrant', grant(B2, { prefix: b2Prefix }));
    if (b2Grant) {
      const u = Number(b2Grant.toObject().until);
      const b2Ref = { repoId: R, refNameHash: refHash(`${b2Prefix}a`), refName: `${b2Prefix}a`, newOid: bytes(20, 4), vis: 'public', r: 4, pp: docRef(b2Grant), grantor: id(O.id), gp: b2Prefix, gu: u };
      await ok(I, 'bot2 pushes under its grant', B2, 'refUpdate', b2Ref);
      if (await deleteOk(I, "the owner removes bot2's row", O, pub.rows.bot2)) {
        await sleep(A_BLOCK);
        await no(I, 'the removed bot2 pushes under its grant', B2, 'refUpdate', { ...b2Ref, newOid: bytes(20, 5) }, [40120]);
        const reRow = await ok(I, 'the owner re-adds bot2 (role 4)', O, 'writer', { repoId: R, memberId: id(B2.id), vis: 'public', consentBy: id(B2.id), role: 4 });
        await sleep(A_BLOCK);
        const readded = await ok(I, 'consensus admits the re-added bot2 under its old grant (client rule ignores it)', B2, 'refUpdate', { ...b2Ref, newOid: bytes(20, 6) });
        // the role gate alone: bot2 demoted to triage keeps a live grant naming it, so only the
        // writer leaf's `where {role: r}` can refuse its r = 4
        if (readded && reRow && (await deleteOk(I, "the owner removes bot2's role-4 row again", O, reRow))) {
          await ok(I, 'the owner re-adds bot2 as triage (role 2)', O, 'writer', { repoId: R, memberId: id(B2.id), vis: 'public', consentBy: id(B2.id), role: 2 });
          await sleep(A_BLOCK);
          await no(I, 'bot2, now triage, sends r 4 under its own live grant', B2, 'refUpdate', { ...b2Ref, newOid: bytes(20, 7) }, [40127]);
          await no(I, 'bot2, now triage, sends r 2 under its grant', B2, 'refUpdate', { ...b2Ref, newOid: bytes(20, 7), r: 2 }, [10422], 'botGrant');
        }
      }
    }
    // expiry: a grant that ends in 2 minutes, outwaited
    const short = await ok(I, 'the owner grants the bot a prefix for 2 minutes', O, 'pushGrant', grant(B, { prefix: PREFIX, until: Date.now() + 120000 }));
    if (short) {
      const su = Number(short.toObject().until);
      await ok(I, 'the bot pushes before the short grant ends', B, 'refUpdate', botRef(`${PREFIX}s`, short, su));
      const wait = su + 45000 - Date.now();
      log(`waiting ${Math.round(wait / 1000)} s for the short grant to end`);
      if (wait > 0) await sleep(wait);
      await no(I, 'the bot pushes after until', B, 'refUpdate', botRef(`${PREFIX}s`, short, su), [10422], 'grantLive');
    }
  }

  // ---------------- layout: forge-meta ----------------
  if (want('layout')) {
    const I = 'D44';
    const label = await ok(I, 'a label (forge-meta)', O, 'label', { repoId: R, name: `l-${tag}`, color: '#00ff00', r: 1 });
    await readBack(I, 'the label read back from forge-meta', META, 'label', label);
    await ok(I, "triage's label (r 2)", T, 'label', { repoId: R, name: `t-${tag}`, r: 2 });
    await no(I, "a stranger's label", S, 'label', { repoId: R, name: `s-${tag}`, r: 1 }, [40120]);
    await no(I, "the reader's label (r 2)", RD, 'label', { repoId: R, name: `r-${tag}`, r: 2 }, [40127]);
    const topic = await ok(I, 'a topic (forge-meta)', O, 'topic', { repoId: R, name: `mv-${tag}`, vis: 'public' });
    await readBack(I, 'the topic read back', META, 'topic', topic);
    await no(I, 'a topic on a private repo', O, 'topic', { repoId: P, name: 'x', vis: 'public' }, [40127]);
    await no(I, "a topic by someone other than the repo's owner", M2, 'topic', { repoId: R, name: 'y', vis: 'public' }, [40127]);
    const mirror = await ok(I, "a stranger's pack mirror (forge-meta, vis public)", S, 'packMirror', { repoId: R, packHash: bytes(32), kind: 1, uris: ['https://mirror.example.com/p.pack'], vis: 'public' });
    await readBack(I, 'the pack mirror read back', META, 'packMirror', mirror);
    await no(I, 'a pack mirror of a private repo (mainnet_mirror_public)', S, 'packMirror', { repoId: P, packHash: bytes(32), kind: 1, uris: ['https://mirror.example.com/q.pack'], vis: 'public' }, [40127]);
    await no(I, 'a pack mirror of a repo that does not exist', S, 'packMirror', { repoId: bytes(32, 12), packHash: bytes(32), kind: 1, uris: ['https://mirror.example.com/r.pack'], vis: 'public' }, [40120]);
    const ban = await ok(I, 'a ban (forge-meta)', O, 'ban', { repoId: R, identityId: id(S.id), reason: 1 });
    await readBack(I, 'the ban read back', META, 'ban', ban);
    await no(I, "the writer's ban (maintainer only)", W, 'ban', { repoId: R, identityId: id(S.id) }, [40120]);
    const rk = await ok(I, 'a repo key wrap (forge-meta)', O, 'repoKey', { repoId: R, memberId: id(W.id), epoch: 1, recipientKeyId: W.encKeyId, senderKeyId: O.encKeyId, wrapped: bytes(48), mr: 1 });
    await readBack(I, 'the wrap read back', META, 'repoKey', rk);
    // profile and follow: one per identity (profile) or per pair (follow), so a rerun replaces or re-creates
    const mine = await sdk.documents.queryWithProof({ dataContractId: META, documentTypeName: 'profile', where: [['$ownerId', '==', S.id]], orderBy: [['$ownerId', 'asc']], limit: 1 }).then((q) => [...(q.data ?? q).values()].filter(Boolean)[0] ?? null).catch(() => null);
    if (mine) {
      const p = await replaceOk(I, "the stranger's profile replaced (forge-meta)", S, mine, { displayName: `mv ${tag}` });
      if (p) await readBack(I, 'the profile read back', META, 'profile', p);
    } else {
      const p = await ok(I, "the stranger's profile (forge-meta)", S, 'profile', { displayName: `mv ${tag}` });
      await readBack(I, 'the profile read back', META, 'profile', p);
    }
    const follows = await sdk.documents.queryWithProof({ dataContractId: META, documentTypeName: 'follow', where: [['$ownerId', '==', S.id]], orderBy: [['$ownerId', 'asc']], limit: 20 }).then((q) => [...(q.data ?? q).values()].filter(Boolean)).catch(() => []);
    for (const f of follows) await deleteOk(I, 'an earlier run\'s follow removed', S, f);
    const fo = await ok(I, 'a follow (forge-meta)', S, 'follow', { identityId: id(O.id) });
    // follow is indexOnly (no primary-key tree), so it is read back through its byOwner index
    try {
      let n = 0;
      for (let i = 0; i < 6 && !n; i++) {
        if (i) await sleep(2000);
        const q = await sdk.documents.queryWithProof({ dataContractId: META, documentTypeName: 'follow', where: [['$ownerId', '==', S.id], ['identityId', '==', O.id]], limit: 1 });
        n = [...(q.data ?? q).values()].filter(Boolean).length;
      }
      record({ item: I, label: 'the follow read back (byOwner index, proved)', expect: '1 entry in forge-meta', got: String(n), pass: Boolean(fo) && n === 1 });
    } catch (e) {
      record({ item: I, label: 'the follow read back (byOwner index, proved)', expect: '1 entry', got: `error ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
    }
    await no(I, 'following oneself (distinctFrom)', S, 'follow', { identityId: id(S.id) }, [10419]);

    // a key bound to the contract group signs forge-meta (and forge-core) writes
    const bound = await groupBoundKey(W);
    if (bound) {
      const fo2 = await ok(I, "a forge-meta write (label) signed by the writer's group-bound key", W, 'label', { repoId: R, name: `g-${tag}`, r: 1 }, bound);
      await readBack(I, 'the group-key label read back', META, 'label', fo2);
      await ok(I, 'a forge-core write (ref update) signed by the same key', W, 'refUpdate', { repoId: R, refNameHash: refHash('refs/heads/g'), refName: 'refs/heads/g', newOid: bytes(20, 1), vis: 'public' }, bound);
      await no(I, 'the same key signing for a contract outside the group (the live forge-community)', W, 'watch', { repoId: bytes(32) }, [20014], undefined, { ...bound, contract: LIVE.community });
    }
  }

  // ---------------- R6 live: a private repo made public (Code only, then Everything) ----------------
  if (want('convert')) await convertRepo();
  if (want('everything')) await publishEverything();

  // ---------------- fees ----------------
  if (want('fees')) await feeProbes();
} catch (e) {
  if (!(e instanceof InfraError)) throw e;
  stopped = e.message;
  log(`STOPPED: ${stopped}`);
}

/**
 * Store `bytes` as Platform chunks (three 4,900-byte parts each) and a manifest of `kind`. With
 * `tripwire`, every chunk after the first holds random bytes instead: the manifest still names
 * the real bytes' hash, so a reader that downloads the whole artifact sees a hash mismatch, and
 * one that skips it after reading its first chunk (§18.2) sees nothing wrong.
 */
async function storeArtifact(item, label, who, repoId, data, kind, r, extra = {}, { tripwire = false } = {}) {
  const packHash = sha256(data);
  const PART = 4900;
  const n = Math.ceil(data.length / (3 * PART));
  for (let seq = 0; seq < n; seq++) {
    const real = data.subarray(seq * 3 * PART, (seq + 1) * 3 * PART);
    const slice = tripwire && seq > 0 ? randomBytes(real.length) : real;
    const d = { repoId, packHash, seq, d0: slice.subarray(0, PART), r: r === 0 ? 1 : r };
    if (slice.length > PART) d.d1 = slice.subarray(PART, 2 * PART);
    if (slice.length > 2 * PART) d.d2 = slice.subarray(2 * PART);
    if (!(await ok(item, `${label}: chunk ${seq + 1} of ${n}`, who, 'chunk', d))) return null;
  }
  await sleep(A_BLOCK);
  return ok(item, `${label}: kind-${kind} manifest (${data.length} B, ${n} chunk(s))`, who, 'packManifest', { repoId, packHash, kind, sizeBytes: data.length, objectCount: extra.objectCount ?? 0, chunkCount: n, storage: 0, r, ...extra });
}

/**
 * DESIGN §4.10 steps 2-5 as raw documents, with real keys: the conversion tooling is phase 5A.
 * Private era: the epoch-0 anchor (settings TLV: default branch), a sealed pack of commit A0 and
 * sealed ref updates main and old -> A0. Seal-off: the epoch-1 anchor (its TLV links epoch 0 and
 * carries K_0, as a rotation does) and a sealed pack of commit B on `members`. Then the flip, the
 * plaintext config (the conversion marker) and a fresh plaintext pack of main (A1 over A0) with
 * its plaintext ref update. Member wraps are not written: R6's anonymous reader reads none, and
 * clients read wraps from forge-meta only from phase M-B.
 */
async function convertRepo() {
  const I = 'R6';
  if (!args.state || existsSync(String(args.state))) throw new Error('--only convert needs --state <file>, a new file (written 0600; read by --only everything)');
  const cv = await makeRepo(I, `mvx-${tag}`, 'private', [[W, 1]]);
  const repo = docRef(cv.repo);
  const owner = id(O.id);
  const K0 = randomBytes(32);
  const K1 = randomBytes(32);
  const dir = mkdtempSync(join(tmpdir(), 'mv-convert-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'mv', GIT_AUTHOR_EMAIL: 'mv@example.invalid', GIT_COMMITTER_NAME: 'mv', GIT_COMMITTER_EMAIL: 'mv@example.invalid' } }).trim();
    const commitFile = (file, text, msg) => { writeFileSync(join(dir, file), text); git('add', file); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
    const pack = (revs) => execFileSync('git', ['pack-objects', '--stdout', '--revs'], { cwd: dir, input: `${revs.join('\n')}\n` });
    const objects = (p) => p.readUInt32BE(8); // a git pack's header: PACK, version, object count
    git('init', '-q', '-b', 'main');
    // ~40 KB of incompressible bytes in each sealed pack: three chunks, so a reader that skips it
    // after its 36-byte head read leaves two chunks unread
    writeFileSync(join(dir, 'private.bin'), randomBytes(40000));
    git('add', 'private.bin');
    const A0 = commitFile('README.md', `# ${cv.repo.toObject().name}\nwritten while private\n`, 'private era');
    git('checkout', '-q', '-b', 'members');
    writeFileSync(join(dir, 'members.bin'), randomBytes(40000));
    git('add', 'members.bin');
    const Bc = commitFile('NOTES.md', 'members-only notes, pushed after the seal-off\n', 'members only');
    git('checkout', '-q', 'main');
    const A1 = commitFile('LICENSE', 'MIT\n', 'made public');
    const oid = (h) => Buffer.from(h, 'hex');

    // the private era, epoch 0
    await ok(I, 'epoch-0 anchor (sealed config, default branch in its TLV)', O, 'config', { repoId: repo, vis: 'private', epoch: 0, enc: seal.anchor(K0, repo, owner, 0, seal.tlv([6, Buffer.from('refs/heads/main')])) });
    const p0 = pack([A0]);
    await storeArtifact(I, 'private-era pack of A0 sealed under epoch 0 (DFPK)', O, repo, seal.pack(K0, repo, 0, p0), 0, 1, { objectCount: objects(p0) });
    for (const name of ['refs/heads/main', 'refs/heads/old']) {
      const h = seal.refHash(K0, repo, 0, name);
      await ok(I, `sealed ref update ${name} -> A0 (epoch 0)`, O, 'refUpdate', { repoId: repo, refNameHash: h, newOid: oid(A0), vis: 'private', enc: seal.refUpdate(K0, repo, owner, 0, h, oid(A0), name), epoch: 0 });
    }
    // seal-off rotation to epoch 1 (DESIGN §4.10 step 2), and members-only work under it
    await ok(I, 'seal-off: epoch-1 anchor (links epoch 0, carries K_0)', O, 'config', { repoId: repo, vis: 'private', epoch: 1, enc: seal.anchor(K1, repo, owner, 1, seal.tlv([6, Buffer.from('refs/heads/main')], [8, u32(0)], [9, K0])) });
    // never published: a tripwire, so a reader that downloads it past its first chunk fails its hash
    const p1 = pack([Bc, `^${A0}`]);
    await storeArtifact(I, 'members-only pack of B sealed under epoch 1 (chunks 2-3 a tripwire)', O, repo, seal.pack(K1, repo, 1, p1), 0, 1, { objectCount: objects(p1) }, { tripwire: true });
    const hb = seal.refHash(K1, repo, 1, 'refs/heads/members');
    await ok(I, 'sealed ref update members -> B (epoch 1)', O, 'refUpdate', { repoId: repo, refNameHash: hb, newOid: oid(Bc), vis: 'private', enc: seal.refUpdate(K1, repo, owner, 1, hb, oid(Bc), 'refs/heads/members'), epoch: 1 });
    // step 3: the flip; step 4: the plaintext config (the conversion marker); step 5: the fresh pack
    const flipped = await replaceOk(I, 'step 3: the owner flips the repo public', O, cv.repo, { visibility: 'public', defaultBranch: 'main' });
    if (!flipped) return;
    await sleep(A_BLOCK);
    await ok(I, 'step 4: the plaintext config (the conversion marker)', O, 'config', { repoId: repo, defaultBranch: 'main', vis: 'public' });
    await sleep(A_BLOCK);
    const fresh = pack([A1]);
    await storeArtifact(I, 'step 5: the fresh plaintext pack of main (A1 over A0)', O, repo, fresh, 0, 1, { objectCount: objects(fresh), tips: oid(A1) });
    await ok(I, 'step 5: plaintext ref update main -> A1', O, 'refUpdate', { repoId: repo, refNameHash: refHash('refs/heads/main'), refName: 'refs/heads/main', newOid: oid(A1), vis: 'public' });
    // K_0 only: `everything` publishes it; K_1 (the seal-off epoch) is never published, nor kept
    const state = { repoId: docId(cv.repo), name: cv.repo.toObject().name, owner: O.id, A0, A1, B: Bc, K0: K0.toString('hex') };
    writeFileSync(String(args.state), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    record({ item: I, label: 'Code only ready: clone with an R6 dg now, then run --only everything', expect: 'dash://owner/name', got: `dash://${O.id}/${state.name} main=${A1.slice(0, 12)} old=${A0.slice(0, 12)} members=${Bc.slice(0, 12)}`, pass: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** DESIGN §4.10 step 7: the owner's kind-7 bundle with an 0x06 entry for epoch 0 (below E' = 1). */
async function publishEverything() {
  const I = 'R6';
  if (!args.state) throw new Error('--only everything needs the --state <file> that --only convert wrote');
  const st = JSON.parse(readFileSync(String(args.state), 'utf8'));
  const repo = id(st.repoId);
  const bundle = seal.bundle([[6, repo, 0, Buffer.from(st.K0, 'hex')]], 'Everything written before the repository was made public.');
  await no(I, "a writer's make-public bundle (kind 7 is maintainer-only, C3)", W, 'packManifest', { repoId: repo, packHash: sha256(bundle), kind: 7, sizeBytes: bundle.length, objectCount: 0, chunkCount: 0, storage: 1, r: 1 }, [10422], 'maintKinds');
  await storeArtifact(I, "step 7: the owner's make-public bundle (0x06: K_0)", O, repo, bundle, 7, 0);
  record({ item: I, label: 'Everything ready: clone again with an R6 dg', expect: 'dash://owner/name', got: `dash://${st.owner}/${st.name}`, pass: true });
}

/**
 * The writer's AUTHENTICATION / HIGH key bound to this set's contract group: registered once
 * (an identity update signed by the MASTER key) and its private key kept beside the identity file
 * (`<name>.group-<group>.key`, 0600, never printed) so a rerun reuses it.
 */
async function groupBoundKey(who) {
  const keyFile = join(String(args.identities), `${who.name}.group-${GROUP}.key`);
  const rec = JSON.parse(readFileSync(identityFile(who.name), 'utf8'));
  try {
    const identity = await sdk.identities.fetch(who.id);
    let keyId; let wif;
    if (existsSync(keyFile)) ({ keyId, wif } = JSON.parse(readFileSync(keyFile, 'utf8')));
    if (keyId === undefined || !identity.publicKeys.some((k) => k.keyId === keyId && k.disabledAt == null)) {
      const master = PrivateKey.fromWIF(rec.identityKeys.find((x) => x.securityLevel === 'MASTER').privateKeyWif);
      const fresh = PrivateKey.fromBytes(randomBytes(32), 'testnet');
      keyId = Math.max(...identity.publicKeys.map((k) => k.keyId)) + 1;
      wif = fresh.toWIF();
      writeFileSync(keyFile, JSON.stringify({ keyId, wif }), { mode: 0o600 });
      chmodSync(keyFile, 0o600);
      const signer = new IdentitySigner();
      signer.addKey(master);
      signer.addKey(fresh);
      const key = new IdentityPublicKeyInCreation({ keyId, purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_secp256k1', data: fresh.getPublicKey().toBytes(), contractBounds: ContractBounds.ContractGroup(GROUP) });
      await sdk.identities.update({ identity, addPublicKeys: [key], signer });
      record({ item: 'D44', label: `the writer registers an AUTHENTICATION key bound to group ${GROUP.slice(0, 8)}…`, expect: 'ok', got: `ok key ${keyId}`, pass: true });
      await sleep(A_BLOCK);
    }
    const fresh = await sdk.identities.fetch(who.id);
    const k = fresh.publicKeys.find((x) => x.keyId === keyId);
    const bounds = k?.contractBounds?.toJSON?.();
    const isGroup = bounds?.$type === 'contractGroup' && bounds.id === GROUP;
    record({ item: 'D44', label: 'the key on chain is bound to the group', expect: `contractGroup ${GROUP}`, got: JSON.stringify(bounds ?? null), pass: isGroup });
    if (!isGroup) return null;
    const signer = new IdentitySigner();
    signer.addKey(PrivateKey.fromWIF(wif));
    return { key: k, signer };
  } catch (e) {
    record({ item: 'D44', label: 'a group-bound key', expect: 'registered', got: `error ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
    return null;
  }
}

/**
 * The M-C fee probes: the same documents written to the scratch set and to the live set (or two
 * forms on the scratch set), after one unpriced warm-up write of each, in alternating rounds.
 */
async function feeProbes() {
  const I = 'FEE';
  // the live contract of each type: the live forge-core still holds label, topic and packMirror
  const LIVE_OF = { [CORE]: LIVE.core, [COLLAB]: LIVE.collab, [COMM]: LIVE.community, [META]: LIVE.core };
  const onLive = (type) => ({ contract: LIVE_OF[CONTRACT[type]] });
  // one repo on each set, the owner its maintainer, the writer a role-1 writer
  const setUp = async (where, opts) => {
    const repo = need(await ok(I, `${where}: fee repo`, O, 'repo', { name: `mvf-${tag}`, visibility: 'public', defaultBranch: 'main' }, opts('repo')), `${where} fee repo`);
    const Rf = docRef(repo);
    await ok(I, `${where}: maintainer row`, O, 'maintainer', { repoId: Rf, memberId: id(O.id), vis: 'public' }, opts('maintainer'));
    await ok(I, `${where}: writer consents`, W, 'consent', { repoId: Rf }, opts('consent'));
    await ok(I, `${where}: writer row`, O, 'writer', { repoId: Rf, memberId: id(W.id), vis: 'public', consentBy: id(W.id), role: 1 }, opts('writer'));
    await sleep(A_BLOCK);
    const iss = need(await ok(I, `${where}: issue #1`, O, 'issue', { repoId: Rf, number: 1, tk: 0, title: 'fees', vis: 'public' }, opts('issue')), `${where} issue`);
    const pr = need(await ok(I, `${where}: PR #2`, O, 'patch', { repoId: Rf, number: 2, tk: 1, title: 'fees', vis: 'public', baseRefNameHash: refHash('refs/heads/main'), sourceRepoId: Rf, headOid: bytes(20, 2) }, opts('patch')), `${where} PR`);
    return { Rf, iss, pr };
  };
  const scratch = await setUp('scratch', () => ({}));
  const liveSet = await setUp('live', onLive);
  const body = 'x'.repeat(200);
  const docs = {
    comment: (s) => ({ who: S, data: { repoId: s.Rf, targetId: docRef(s.iss), body, vis: 'public' } }),
    review: (s) => ({ who: S, data: { repoId: s.Rf, patchId: docRef(s.pr), verdict: 3, commitOid: bytes(20, 2), body, vis: 'public' } }),
    refUpdate: (s) => ({ who: W, data: { repoId: s.Rf, refNameHash: refHash('refs/heads/main'), refName: 'refs/heads/main', newOid: bytes(20), vis: 'public', r: 1 } }),
    config: (s) => ({ who: O, data: { repoId: s.Rf, defaultBranch: 'main', vis: 'public' } }),
    label: (s, i) => ({ who: O, data: { repoId: s.Rf, name: `fee-${i}-${tag}`, color: '#123456', r: 1 } }),
    topic: (s, i) => ({ who: O, data: { repoId: s.Rf, name: `fee-${i}-${tag}`, vis: 'public' } }),
    // the live packMirror has no `vis` (mainnet_mirror_public is a mainnet item)
    packMirror: (s, i, isLive) => ({ who: S, data: { repoId: s.Rf, packHash: bytes(32), kind: 1, uris: [`https://mirror.example.com/${i}.pack`], ...(isLive ? {} : { vis: 'public' }) } }),
  };
  for (const [type, make] of Object.entries(docs)) {
    for (let i = 0; i <= N; i++) {
      // round 0 is the warm-up (a type's first write by an identity pays more), unpriced
      for (const isLive of i % 2 ? [true, false] : [false, true]) {
        const s = isLive ? liveSet : scratch;
        const { who, data } = make(s, i, isLive);
        await ok(I, `${type} on the ${isLive ? 'live' : 'scratch'} set, round ${i}`, who, type, data, { ...(isLive ? onLive(type) : {}), ...(i ? { fee: `${type}: ${isLive ? 'live' : 'scratch'}` } : {}) });
      }
    }
  }
  // a bot push under a prefix grant against a writer push, on the scratch set
  await ok(I, 'scratch: the bot consents', B, 'consent', { repoId: scratch.Rf });
  await ok(I, 'scratch: the bot as role 4', O, 'writer', { repoId: scratch.Rf, memberId: id(B.id), vis: 'public', consentBy: id(B.id), role: 4 });
  await sleep(A_BLOCK);
  const PREFIX = 'refs/heads/bot/ci-bot/';
  const g = need(await ok(I, 'scratch: a prefix grant', O, 'pushGrant', { repoId: scratch.Rf, botId: id(B.id), prefix: PREFIX, until: Date.now() + 30 * DAY }), 'the fee grant');
  const gu = Number(g.toObject().until);
  // the same ref-name length for both (refs/heads/bot/ci-bot/main vs refs/heads/aaaaaaaaaaaaaaaa)
  const botName = `${PREFIX}main`;
  const humanName = `refs/heads/${'a'.repeat(botName.length - 'refs/heads/'.length)}`;
  for (let i = 0; i <= N; i++) {
    const pairs = [
      ['bot push', B, { repoId: scratch.Rf, refNameHash: refHash(botName), refName: botName, newOid: bytes(20), vis: 'public', r: 4, pp: docRef(g), grantor: id(O.id), gp: PREFIX, gu }],
      ['writer push', W, { repoId: scratch.Rf, refNameHash: refHash(humanName), refName: humanName, newOid: bytes(20), vis: 'public', r: 1 }],
    ];
    for (const [what, who, data] of i % 2 ? pairs.reverse() : pairs) await ok(I, `${what}, round ${i}`, who, 'refUpdate', data, i ? { fee: `refUpdate: ${what} (scratch)` } : {});
  }
}

const passed = results.filter((r) => r.pass && !r.infra).length;
const infra = infraCases.length ? `${infraCases.length} case(s) without a verdict: ${infraCases.join('; ')}` : stopped;
const stats = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return { n: v.length, mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length), median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1] };
};
const feeSummary = Object.fromEntries(Object.entries(fees).map(([k, v]) => [k, stats(v)]));
const delta = (a, b) => (feeSummary[a] && feeSummary[b] ? Math.round(((feeSummary[a].mean - feeSummary[b].mean) / feeSummary[b].mean) * 10000) / 100 : null);
const feeDeltas = Object.fromEntries(['comment', 'review', 'refUpdate', 'config', 'label', 'topic', 'packMirror'].map((t) => [`${t}: scratch vs live (%)`, delta(`${t}: scratch`, `${t}: live`)]).concat([['refUpdate: bot push vs writer push (%)', delta('refUpdate: bot push (scratch)', 'refUpdate: writer push (scratch)')]]).filter(([, v]) => v !== null));
const report = { network: `devnet-${devnetName}`, scratch: { core: CORE, collab: COLLAB, community: COMM, meta: META, group: GROUP }, live: LIVE, run: tag, passed, total: results.length, infra, fees: feeSummary, feeDeltas, results };
if (args.report) writeFileSync(String(args.report), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed, total: results.length, infra, fees: feeSummary, feeDeltas, failed: results.filter((r) => !r.pass) }, null, 2));
process.exit(results.some((r) => !r.pass) ? 1 : infra ? 2 : 0);

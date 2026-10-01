// The RC1 live vectors: raw documents against the registered contracts, for every rule and
// reference a contract parse or the offline vectors cannot judge (forge-contracts/vectors/rc1
// covers the rest). It writes one fresh set of repos per run, owned by the run's identities, and
// prints (and with --report writes) one line per case.
//
//   (cd forge-contracts/sdk-v2 && npm ci)
//   node forge-contracts/scripts/rc1-live.mjs --devnet-name bonsia --identities <dir> [--report <file.json>] [--only <group,...>]
//
// <dir> holds owner/member/stranger/runner.identity.json (`QA_NETWORK=bonsia qa mint rc1 <name>`).
// Roles: `owner` owns the repos; `member` is a writer (after consenting), and for a moment a writer
// of the private repo; `stranger` is never a member; `runner` is a CI runner of the owner's repo.
//
// What it covers (dash-forge-qa beta6/RULES-PROPOSAL.md, OPPORTUNITIES.md, WIPE-PLAN §3.1):
//   refs      the registration `where` stamps, both ways (vis on member, ref, config, release, issue,
//             review, checkRun and webhook docs), consent (R-06, 40120), self-enrolment on someone
//             else's repo (40127), revocation (a deleted member doc: 40120), asMember (R-04)
//   state     dense numbering (issues and PRs), transitions c1..c5 (mod 16; kinds 1, 2, 11..17),
//             the lock bit c6 and lockGate on comments and reviews (R-15), a stranger's transition
//             (40120), an author's close, member verdicts (R-16), the grouped count / sum keying
//             (§3.1 1-2), set-once check-run fields (D-5 / RC2 M1, 40128), with RC2 S2/S3 the
//             proved review feeds (toAuthor, author), and with the QW-069 rider closes that say
//             why (not planned, a duplicate of #2)
//   threads   reply roots (R-14): a reply to a reply and a reply across threads are refused; with
//             the QW2-010 rider a mirrored review comment's hunk, which no replace changes (40128)
//   packs     platformChunks (R-09) incl. a missing and a stray seq, i64 sizeBytes (O-05), and a
//             raw push -> clone round trip of a real git pack under its identifier packHash
//   releases  oneLive (O-04): one live release per tag, unpublish, a sealed publish, no delete
//   topics    atMost20 (R-20) and public-only topics
//   ci        runner (O-02) and check sources (R-08), notFuture (R-17), private CI (R-18), outcome,
//             and with RC2 S1 a completed run's frozen evidence (40128)
//   social    starBeat where + distinctFrom (O-08), or with RC2 C1 the fused star (unstar and
//             star again inside the window), public-only webhooks (R-19), repoKey wraps
//             to members only (R-13), events and author events across contracts (O-01)
//   moderation with RC2 MOD (design/v5/MODERATION.md) a maintainer's hide / unhide (event kinds
//             24/25 naming its own maintainer document, asMaintainer), and the refusals: a
//             writer's hide (40120), a maintainer of another repo, a removed maintainer, and a
//             hide naming another maintainer (hideByMaint); the fees of a hide and of a plain
//             event (the fee gate: <= +10 % per hide)
//
// Every refusal is matched on the node's numeric code (and, for a rule, its name in the
// message), never on the decoded cause (IMPL-RULES: codes shifted between SDK builds).
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvoSdk } from './deploy-v2.mjs';
import { CONTRACTS, FUSED_STAR } from './lib/seed-io.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, t, i, a) => (t.startsWith('--') ? [...acc, [t.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]] : acc), []));
const devnetName = args['devnet-name'] || 'bonsia';
const only = args.only ? new Set(String(args.only).split(',')) : null;
const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);

const dep = JSON.parse(readFileSync(join(ROOT, 'deployments', `devnet-${devnetName}.json`), 'utf8'));
const CORE = dep.v2?.forgeCore?.contractId;
const COLLAB = dep.v2?.forgeCollab?.contractId;
const COMM = dep.v2?.forgeCommunity?.contractId;
if (!CORE || !COLLAB || !COMM) throw new Error(`devnet-${devnetName}.json records no RC1 forge-v2 contracts (core, collab and community)`);
// The RC2 items (schema/build.py flags) the registered schemas carry: the committed JSONs, which
// are what deploy-v2.mjs registered (FUSED_STAR too)
const EVIDENCE_FROZEN = CONTRACTS.community.documentSchemas.checkRun.immutable.some((e) => typeof e === 'object' && e.property === 'logUrl');
const REVIEW_INDEXES = new Set(CONTRACTS.collab.documentSchemas.review.indices.map((i) => i.name));
// The RC2 riders (design/v5/RIDERS.md): QW-069 close reasons, QW2-010 review-comment hunks
const CLOSE_REASON = 'reason' in CONTRACTS.collab.documentSchemas.transition.properties;
const REVIEW_HUNK = 'diffHunk' in CONTRACTS.collab.documentSchemas.comment.properties;
// RC2 moderation (design/v5/MODERATION.md): a hide proves its writer a maintainer
const HIDE_PROOF = 'asMaintainer' in CONTRACTS.community.documentSchemas.event.properties;

const evo = await loadEvoSdk();
const { EvoSDK, Document, IdentityPublicKey, IdentitySigner, PrivateKey, Identifier } = evo;
const connect = async () => {
  const fresh = new EvoSDK({ network: 'devnet', devnetName, trusted: true, addresses: dep.dapiAddresses, settings: { timeoutMs: 60000 } });
  await fresh.connect();
  return fresh;
};
// Replaced after a transport or proof failure: a new SDK reloads the quorum list (a devnet's
// quorums rotate faster than the trusted context's cache follows) and forgets banned addresses.
let sdk = await connect();
const version = sdk.version();

function loadIdentity(name) {
  const rec = JSON.parse(readFileSync(join(String(args.identities), `${name}.identity.json`), 'utf8'));
  const k = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === 'HIGH');
  const enc = rec.identityKeys.find((x) => x.purpose === 'ENCRYPTION');
  const identityKey = new IdentityPublicKey({ keyId: k.id, purpose: k.purpose, securityLevel: k.securityLevel, keyType: k.keyType, isReadOnly: false, data: Buffer.from(k.publicKeyHex, 'hex') });
  const signer = new IdentitySigner();
  signer.addKey(PrivateKey.fromWIF(k.privateKeyWif));
  return { name, id: rec.identityId, identityKey, signer, encKeyId: enc?.id };
}
const O = loadIdentity('owner');
const M = loadIdentity('member');
const S = loadIdentity('stranger');
const RN = loadIdentity('runner');

const id = (b58) => Buffer.from(Identifier.fromBase58(String(b58)).toBytes());
const bytes = (n, fill) => (fill === undefined ? randomBytes(n) : Buffer.alloc(n, fill));
const sha256 = (b) => createHash('sha256').update(b).digest();
const docId = (d) => d.id.toBase58();
const results = [];
const fees = {};

/**
 * A transport or proof failure: no verdict on the case. It is recorded as `infra` (neither pass
 * nor fail), the SDK is replaced, and the run goes on; a case that depends on it may then fail,
 * so rerun the groups that had one (`--only`). Each run writes fresh repos.
 */
class InfraError extends Error {}
const INFRA = /quorum not found|invalid quorum|no available addresses|deadline|timed? ?out|unavailable/i;
const infraCases = [];
async function noVerdict(item, label, e) {
  infraCases.push(label);
  record({ item, label, expect: 'a verdict', got: 'infra', note: e.message, pass: true, infra: true });
  await new Promise((r) => setTimeout(r, 15000));
  sdk = await connect();
}

async function balance(who) {
  try {
    return BigInt((await sdk.identities.balance(who.id)) ?? 0n);
  } catch (e) {
    throw INFRA.test(String(e?.message ?? e)) ? new InfraError(String(e?.message ?? e).slice(0, 300)) : e;
  }
}
/** The balance once two reads 2 s apart agree (a node can answer from the block before a write). */
async function settled(who, differentFrom) {
  let last = await balance(who);
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await balance(who);
    if (now === last && now !== differentFrom) return now;
    last = now;
  }
  return last;
}
/**
 * The credits one write costs its signer: settled balance before, minus settled balance after.
 * `credits` is null when it could not be measured (a balance read failed, or never moved).
 */
async function priced(who, fn) {
  let before = null;
  try {
    before = await settled(who);
  } catch { /* no measurement; the write still gets its verdict */ }
  const out = await fn();
  try {
    const after = before === null ? null : await settled(who, before);
    return { out, credits: after === null || after === before ? null : Number(before - after) };
  } catch {
    return { out, credits: null };
  }
}

// Types with a rule that reads a total (dense, c1..c6, lockGate, platformChunks, oneLive, atMost20):
// a write of one waits a block, so the node that checks it has applied the write before it.
const TOTALS = new Set(['issue', 'patch', 'transition', 'comment', 'review', 'packManifest', 'release', 'topic']);

async function create(who, contract, type, data) {
  if (TOTALS.has(type)) await sleep(A_BLOCK);
  const base = new Document({ properties: {}, documentTypeName: type, dataContractId: contract, ownerId: who.id });
  const document = Document.fromObject({ ...base.toObject(), ...data }, version);
  try {
    return await sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer });
  } catch (e) {
    if (codeOf(e) === null && INFRA.test(String(e?.message ?? e))) throw new InfraError(String(e?.message ?? e).slice(0, 300));
    throw e;
  }
}

function codeOf(e) {
  try {
    if (typeof e?.code === 'number' && e.code >= 10000) return e.code;
  } catch { /* freed wasm pointer */ }
  const m = /\b(10\d{3}|40\d{3})\b/.exec(String(e?.message ?? e));
  return m ? Number(m[1]) : null;
}

function record(r) {
  results.push(r);
  log(`${r.pass ? 'PASS' : 'FAIL'} [${r.item}] ${r.label}: ${r.got}${r.note ? ` (${r.note})` : ''}`);
}

/** A write that must land. `fee`: record its cost under that name. */
async function ok(item, label, who, contract, type, data, fee) {
  try {
    const { out, credits } = fee ? await priced(who, () => create(who, contract, type, data)) : { out: await create(who, contract, type, data) };
    if (fee && credits !== null) (fees[fee] ??= []).push(credits);
    record({ item, label, expect: 'ok', got: `ok ${docId(out)}${fee ? ` ${credits ?? 'unmeasured'} credits` : ''}`, pass: true });
    return out;
  } catch (e) {
    if (e instanceof InfraError) return noVerdict(item, label, e).then(() => null);
    record({ item, label, expect: 'ok', got: `refused ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
    return null;
  }
}

/** A write that must be refused with one of `codes` (and, when given, naming `rule`). */
async function no(item, label, who, contract, type, data, codes, rule) {
  try {
    const out = await create(who, contract, type, data);
    record({ item, label, expect: `refused ${codes.join('|')}`, got: `ACCEPTED ${docId(out)}`, pass: false });
  } catch (e) {
    if (e instanceof InfraError) return noVerdict(item, label, e);
    const code = codeOf(e);
    const msg = String(e?.message ?? e);
    const pass = codes.includes(code) && (!rule || msg.includes(rule));
    record({ item, label, expect: `refused ${codes.join('|')}${rule ? ` ${rule}` : ''}`, got: `refused ${code}`, note: msg.slice(0, 300), pass });
  }
}

/** An operation (a delete, a replace) that must be refused with one of `codes`, or a message matching `re`. */
async function refusedOp(item, label, fn, codes, re) {
  try {
    await fn();
    record({ item, label, expect: `refused ${codes.join('|')}`, got: 'ACCEPTED', pass: false });
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (codeOf(e) === null && INFRA.test(msg)) return noVerdict(item, label, new InfraError(msg.slice(0, 300)));
    const pass = codes.includes(codeOf(e)) || Boolean(re && re.test(msg));
    record({ item, label, expect: `refused ${codes.join('|')}`, got: `refused ${codeOf(e)}`, note: msg.slice(0, 300), pass });
  }
}
/** A document, created or replaced, as the next revision with `changes`. */
function revised(doc, changes) {
  const o = doc.toObject();
  return Document.fromObject({ ...o, ...changes, $revision: BigInt(o.$revision ?? 1) + 1n }, version);
}
const ownOps = (who) => ({ identityKey: who.identityKey, signer: who.signer });

const want = (group) => only === null || only.has(group);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A write confirmed by its proof can still be missing from the state another node checks the
// next transition against (CheckTx a block behind), and a read right after a write can come from
// the block before it: a rule that totals the chunks just written, or a proved read of them,
// waits a block first (clients do the same, or retry a `platformChunks` refusal once).
const A_BLOCK = 4000;
/** A proved read retried until `good` holds (a node may answer from the block before a write). */
async function eventually(read, good, tries = 6) {
  let v = await read();
  for (let i = 1; i < tries && !good(v); i++) {
    await sleep(2000);
    v = await read();
  }
  return v;
}
const tag = Date.now().toString(36);
// A single reference whose `where` fails reports 40127. An anyOf gate reports its LAST operand's
// error, often a 40120 "not found", so its failed `where` on an earlier operand shows as either.
const WHERE_ANYOF = [40127, 40120];
const need = (doc, what) => {
  if (!doc) throw new Error(`setup failed: ${what} was not written (see above); rerun`);
  return doc;
};

let infra = null;
try {
// ---------------- setup: repos and membership (refs) ----------------
log(`contracts core ${CORE} collab ${COLLAB} community ${COMM}; run ${tag}`);
const repo = need(await ok('R-02', 'public repo', O, CORE, 'repo', { name: `rc1-${tag}`, visibility: 'public', defaultBranch: 'main', description: 'RC1 live vectors' }, 'repo'), 'the public repo');
const R = id(docId(repo));
await ok('R-02', 'owner self-enrols as maintainer', O, CORE, 'maintainer', { repoId: R, memberId: id(O.id), vis: 'public' }, 'maintainer');
const priv = need(await ok('R-12', 'private repo', O, CORE, 'repo', { name: `rc1p-${tag}`, visibility: 'private' }), 'the private repo');
const P = id(docId(priv));
await ok('R-02', 'owner self-enrols in the private repo', O, CORE, 'maintainer', { repoId: P, memberId: id(O.id), vis: 'private' });
// Every group needs the member (--only): it consents, and the owner enrols it as a writer
await ok('R-06', 'member consents', M, CORE, 'consent', { repoId: R }, 'consent');
need(await ok('R-06', 'consented writer', O, CORE, 'writer', { repoId: R, memberId: id(M.id), vis: 'public', consentBy: id(M.id) }, 'writer'), "the member's writer document");

if (want('refs')) {
  await no('R-02', 'member document stamped private on a public repo', O, CORE, 'writer', { repoId: R, memberId: id(O.id), vis: 'private' }, [40127]);
  await no('R-02', 'member document stamped public on a private repo', O, CORE, 'writer', { repoId: P, memberId: id(O.id), vis: 'public' }, [40127]);
  await no('R-06', "a stranger enrols itself as maintainer of someone else's repo", S, CORE, 'maintainer', { repoId: R, memberId: id(S.id), vis: 'public' }, [40127]);
  await no('R-06', "a consented writer enrols itself as maintainer", M, CORE, 'maintainer', { repoId: R, memberId: id(M.id), vis: 'public', consentBy: id(M.id) }, [40127]);
  await no('R-06', 'writer naming a consent that does not exist', O, CORE, 'writer', { repoId: R, memberId: id(S.id), vis: 'public', consentBy: id(S.id) }, [40120]);
  await no('R-06', 'forced writer (no consentBy)', O, CORE, 'writer', { repoId: R, memberId: id(S.id), vis: 'public' }, [10422], 'ownerOrConsented');
  await no('R-06', 'a second consent for the same repo', M, CORE, 'consent', { repoId: R }, [40105]);
  await no('R-06', "consentBy naming another identity's consent", O, CORE, 'writer', { repoId: R, memberId: id(S.id), vis: 'public', consentBy: id(M.id) }, [10422], 'ownerOrConsented');
  await no('R-02', 'stranger ref update (not a member)', S, CORE, 'refUpdate', { repoId: R, refNameHash: bytes(32, 1), refName: 'refs/heads/main', newOid: bytes(20, 1), vis: 'public' }, [40120]);
  await no('R-02', 'member ref update stamped private', M, CORE, 'refUpdate', { repoId: R, refNameHash: bytes(32, 1), newOid: bytes(20, 1), vis: 'private', enc: bytes(61), epoch: 0 }, WHERE_ANYOF);
  await no('R-02', 'owner ref update stamped public on its private repo', O, CORE, 'refUpdate', { repoId: P, refNameHash: bytes(32, 1), refName: 'refs/heads/main', newOid: bytes(20, 1), vis: 'public' }, WHERE_ANYOF);
  await ok('R-02', 'member ref update', M, CORE, 'refUpdate', { repoId: R, refNameHash: sha256(Buffer.from('refs/heads/main')), refName: 'refs/heads/main', newOid: bytes(20, 1), vis: 'public' }, 'refUpdate');
  await no('R-02', 'config stamped private on a public repo', O, CORE, 'config', { repoId: R, vis: 'private', enc: bytes(61), epoch: 0 }, [40127]);
  await no('R-02', 'config stamped public on a private repo', O, CORE, 'config', { repoId: P, defaultBranch: 'main', vis: 'public' }, [40127]);
  await ok('R-02', 'config', O, CORE, 'config', { repoId: R, defaultBranch: 'main', vis: 'public' });
  await ok('R-02', 'sealed private config', O, CORE, 'config', { repoId: P, vis: 'private', enc: bytes(61), epoch: 0 });
  await no('R-12', 'public fork of a private repo', S, CORE, 'repo', { name: `rc1f-${tag}`, visibility: 'public', forkOf: P }, [40127]);
  await ok('R-12', 'public fork of a public repo', S, CORE, 'repo', { name: `rc1f-${tag}`, visibility: 'public', forkOf: R });
  // Revocation: deleting a member document takes its gates away at once (every gate is a
  // deletableDocument reference, re-judged on each write)
  await ok('R-13', 'member consents to the private repo', M, CORE, 'consent', { repoId: P });
  const mp = await ok('R-13', 'member becomes a writer of the private repo', O, CORE, 'writer', { repoId: P, memberId: id(M.id), vis: 'private', consentBy: id(M.id) });
  await ok('R-13', 'wrap epoch 0 to the member', O, COLLAB, 'repoKey', { repoId: P, memberId: id(M.id), epoch: 0, recipientKeyId: M.encKeyId, senderKeyId: O.encKeyId, wrapped: bytes(48) });
  await no('R-13', 'wrap to a non-encryption key of the member (40136)', O, COLLAB, 'repoKey', { repoId: P, memberId: id(M.id), epoch: 1, recipientKeyId: 1, senderKeyId: O.encKeyId, wrapped: bytes(48) }, [40136]);
  await no('R-13', "a writer's wrap (repoKey is maintainer-gated)", M, COLLAB, 'repoKey', { repoId: P, memberId: id(M.id), epoch: 1, recipientKeyId: M.encKeyId, senderKeyId: M.encKeyId, wrapped: bytes(48) }, [40120]);
  await ok('R-06', 'member ref update on the private repo (sealed)', M, CORE, 'refUpdate', { repoId: P, refNameHash: bytes(32, 5), newOid: bytes(20, 5), vis: 'private', enc: bytes(61), epoch: 0 });
  if (mp) {
    try {
      await sdk.documents.delete({ document: mp, ...ownOps(O) });
      record({ item: 'refs', label: 'revoke: the owner deletes the writer document', expect: 'ok', got: 'ok', pass: true });
    } catch (e) {
      record({ item: 'refs', label: 'revoke: the owner deletes the writer document', expect: 'ok', got: `refused ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
    }
    await sleep(A_BLOCK);
    await no('R-13', 'wrap epoch 1 to the revoked member', O, COLLAB, 'repoKey', { repoId: P, memberId: id(M.id), epoch: 1, recipientKeyId: M.encKeyId, senderKeyId: O.encKeyId, wrapped: bytes(48) }, [40120]);
    await no('R-02', "the revoked member's ref update", M, CORE, 'refUpdate', { repoId: P, refNameHash: bytes(32, 6), newOid: bytes(20, 6), vis: 'private', enc: bytes(61), epoch: 0 }, [40120]);
    await no('R-09', "the revoked member's chunk", M, CORE, 'chunk', { repoId: P, packHash: bytes(32), seq: 0, d0: bytes(100) }, [40120]);
  }
  await no('refs', 'a writer publishes a release (maintainer only)', M, CORE, 'release', { repoId: R, tagName: 'w1', vis: 'public', delta: 1 }, [40120]);
  await no('refs', 'a writer updates a protected ref (maintainer only)', M, CORE, 'protectedRefUpdate', { repoId: R, refNameHash: sha256(Buffer.from('refs/heads/main')), refName: 'refs/heads/main', newOid: bytes(20, 7), vis: 'public' }, [40120]);
}

// ---------------- issues, PRs, transitions, locks (state) ----------------
let I1; let I2; let PR3;
if (want('state') || want('threads') || want('moderation')) {
  await no('state', 'issue at the wrong number (dense)', S, COLLAB, 'issue', { repoId: R, number: 2, tk: 0, title: 'skip', vis: 'public' }, [10422], 'dense');
  I1 = await ok('state', 'issue #1 (stranger)', S, COLLAB, 'issue', { repoId: R, number: 1, tk: 0, title: 'first', body: 'b', vis: 'public' }, 'issue');
  await no('R-03', 'issue stamped private on a public repo', S, COLLAB, 'issue', { repoId: R, number: 2, tk: 0, vis: 'private', enc: bytes(61), epoch: 0 }, [40127]);
  await no('R-03', 'issue stamped public on a private repo', S, COLLAB, 'issue', { repoId: P, number: 1, tk: 0, title: 'leak', vis: 'public' }, [40127]);
  await no('R-04', "a stranger's imported issue with its own asMember", S, COLLAB, 'issue', { repoId: R, number: 2, tk: 0, title: 't', vis: 'public', imported: { url: 'https://github.com/x/y/issues/9' }, upstreamNumber: 9, asMember: id(S.id) }, [40120]);
  I2 = await ok('R-04', 'member import with asMember', M, COLLAB, 'issue', { repoId: R, number: 2, tk: 0, title: 'imported', vis: 'public', imported: { url: 'https://github.com/x/y/issues/9', createdAt: 1 }, upstreamNumber: 9, asMember: id(M.id) });
  await no('state', 'PR at the wrong number (dense)', M, COLLAB, 'patch', { repoId: R, number: 4, tk: 1, title: 'pr', vis: 'public', baseRefNameHash: sha256(Buffer.from('refs/heads/main')), sourceRepoId: R, headOid: bytes(20, 2) }, [10422], 'dense');
  PR3 = await ok('state', 'PR #3', M, COLLAB, 'patch', { repoId: R, number: 3, tk: 1, title: 'pr', vis: 'public', baseRefNameHash: sha256(Buffer.from('refs/heads/main')), baseRefName: 'refs/heads/main', sourceRepoId: R, sourceRefNameHash: sha256(Buffer.from('refs/heads/f')), sourceRefName: 'refs/heads/f', headOid: bytes(20, 2) }, 'patch');
}
const T = (target, n, targetKind, kind, delta, extra = {}) => ({ repoId: R, targetId: id(docId(target)), targetNumber: n, targetKind, kind, delta, asAuthor: 0, ...extra });
if (want('state') && I1 && I2 && PR3) {
  await no('state', "stranger closes someone else's issue", S, COLLAB, 'transition', T(I2, 2, 0, 1, 1), [40120]);
  await no('R-15', 'author locks (g_memberLock)', S, COLLAB, 'transition', T(I1, 1, 0, 3, 16, { asAuthor: 1 }), [10422], 'g_memberLock');
  await ok('state', "author closes its own issue (asAuthor = number)", S, COLLAB, 'transition', T(I1, 1, 0, 1, 1, { asAuthor: 1 }), 'transition: author close');
  await no('state', 'second close (c1)', M, COLLAB, 'transition', T(I1, 1, 0, 1, 1), [10422], 'c1_closedAfter');
  await ok('state', 'member reopens', M, COLLAB, 'transition', T(I1, 1, 0, 2, -1), 'transition: member reopen');
  await ok('R-15', 'member locks the issue', M, COLLAB, 'transition', T(I1, 1, 0, 3, 16), 'transition: member lock');
  await no('R-15', 'double lock (c6)', M, COLLAB, 'transition', T(I1, 1, 0, 3, 16), [10422], 'c6_lockedAfter');
  await ok('R-15', 'close while locked (c1 mod 16)', M, COLLAB, 'transition', T(I1, 1, 0, 1, 1), 'transition: member close');
  await no('R-15', "stranger's comment on a locked thread (lockGate)", S, COLLAB, 'comment', { repoId: R, targetId: id(docId(I1)), body: 'hi', vis: 'public' }, [10422], 'lockGate');
  await ok('R-15', "member's comment on a locked thread (asMember)", M, COLLAB, 'comment', { repoId: R, targetId: id(docId(I1)), body: 'hi', vis: 'public', asMember: id(M.id) });
  await ok('R-15', 'reopen while locked', M, COLLAB, 'transition', T(I1, 1, 0, 2, -1));
  await ok('R-15', 'unlock', M, COLLAB, 'transition', T(I1, 1, 0, 4, -16));
  await no('R-15', 'unlock an unlocked issue (c6)', M, COLLAB, 'transition', T(I1, 1, 0, 4, -16), [10422], 'c6_lockedAfter');
  await sleep(A_BLOCK);
  await ok('R-15', "stranger's comment after the unlock", S, COLLAB, 'comment', { repoId: R, targetId: id(docId(I1)), body: 'thanks', vis: 'public' }, 'comment');
  if (CLOSE_REASON) {
    // QW-069: a close says why (no rule reads it; its bounds are the offline vectors'), and a reopen clears it
    await ok('QW-069', 'close as not planned', M, COLLAB, 'transition', T(I1, 1, 0, 1, 1, { reason: 2 }), 'transition: close with a reason');
    await ok('QW-069', 'reopen', M, COLLAB, 'transition', T(I1, 1, 0, 2, -1));
    await ok('QW-069', 'close as a duplicate of #2', M, COLLAB, 'transition', T(I1, 1, 0, 1, 1, { reason: 3, dupNumber: 2 }), 'transition: close as a duplicate');
    await ok('QW-069', 'reopen after the duplicate close', M, COLLAB, 'transition', T(I1, 1, 0, 2, -1));
  }
  // PR: draft, ready, lock, review gate, merge, and the terminal merged state
  await ok('state', 'draft', M, COLLAB, 'transition', T(PR3, 3, 1, 14, 8), 'transition: member draft (first on the PR)');
  await no('state', 'merge a draft (c3)', M, COLLAB, 'transition', T(PR3, 3, 1, 13, 2, { oid: bytes(20, 3) }), [10422], 'c3_mergedAfter');
  await ok('state', 'ready', M, COLLAB, 'transition', T(PR3, 3, 1, 15, -8));
  await ok('R-15', 'PR lock', O, COLLAB, 'transition', T(PR3, 3, 1, 18, 16));
  await no('R-15', "stranger's review on a locked PR (lockGate)", S, COLLAB, 'review', { repoId: R, patchId: id(docId(PR3)), verdict: 4, commitOid: bytes(20, 2), body: 'lgtm', vis: 'public' }, [10422], 'lockGate');
  await ok('R-16', "the owner's approval on a locked PR (asMember)", O, COLLAB, 'review', { repoId: R, patchId: id(docId(PR3)), verdict: 1, commitOid: bytes(20, 2), vis: 'public', asMember: id(O.id) }, 'review');
  await no('R-16', "a stranger's approve claiming membership", S, COLLAB, 'review', { repoId: R, patchId: id(docId(PR3)), verdict: 1, commitOid: bytes(20, 2), vis: 'public', asMember: id(S.id) }, [40120]);
  await ok('R-15', 'PR unlock', O, COLLAB, 'transition', T(PR3, 3, 1, 19, -16));
  await sleep(A_BLOCK);
  await ok('R-16', "a stranger's approve (verdict 4)", S, COLLAB, 'review', { repoId: R, patchId: id(docId(PR3)), verdict: 4, commitOid: bytes(20, 2), vis: 'public' });
  await no('R-03', 'review stamped private on a public PR', S, COLLAB, 'review', { repoId: R, patchId: id(docId(PR3)), verdict: 3, commitOid: bytes(20, 2), vis: 'private' }, [40127]);
  // RC2 S2 / S3: the proved review feeds. PR #3 is the member's; the owner and the stranger
  // reviewed it above. A derived property is queried like any index property (v5 book
  // contract-keywords/derived-index-properties.md:96).
  // The identities are reused across runs, so each feed is read from this run's start on
  const runStart = Number.parseInt(tag, 36);
  const feed = async (item, label, index, where, want) => {
    try {
      const got = await eventually(async () => {
        const q = await sdk.documents.queryWithProof({ dataContractId: COLLAB, documentTypeName: 'review', where: [...where, ['$createdAt', '>=', runStart]], orderBy: [[where[0][0], 'asc'], ['$createdAt', 'asc']], limit: 100 });
        return [...(q.data ?? q).values()].filter(Boolean).map((d) => d.toObject()).filter(want).length;
      }, (n) => n > 0);
      record({ item, label: `${label} (${index})`, expect: 'at least one', got: String(got), pass: got > 0 });
    } catch (e) {
      record({ item, label: `${label} (${index})`, expect: 'at least one', got: `error ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
    }
  };
  const onPr3 = (r) => Buffer.from(r.patchId).equals(id(docId(PR3)));
  if (REVIEW_INDEXES.has('toAuthor')) await feed('S2', "reviews on the member's PRs", 'toAuthor', [['patchId.$ownerId', '==', M.id]], onPr3);
  if (REVIEW_INDEXES.has('author')) await feed('S3', "the stranger's reviews", 'author', [['$ownerId', '==', S.id]], onPr3);
  await ok('state', 'merge', M, COLLAB, 'transition', T(PR3, 3, 1, 13, 2, { oid: bytes(20, 3) }), 'transition: member merge');
  await no('state', 'reopen a merged PR (c2)', M, COLLAB, 'transition', T(PR3, 3, 1, 12, -1), [10422], 'c2_openAfter');
  await no('state', 'draft a merged PR (c4)', M, COLLAB, 'transition', T(PR3, 3, 1, 14, 8), [10422], 'c4_draftAfter');
  const PR4 = await ok('state', 'PR #4', M, COLLAB, 'patch', { repoId: R, number: 4, tk: 1, title: 'pr 4', vis: 'public', baseRefNameHash: sha256(Buffer.from('refs/heads/main')), sourceRepoId: R, headOid: bytes(20, 8) });
  if (PR4) {
    await no('state', 'draft-close of a PR that is no draft (c5)', M, COLLAB, 'transition', T(PR4, 4, 1, 16, 1), [10422], 'c5_draftClosedAfter');
    await ok('state', 'PR #4 draft', M, COLLAB, 'transition', T(PR4, 4, 1, 14, 8));
    await no('state', 'plain close of a draft (c1)', M, COLLAB, 'transition', T(PR4, 4, 1, 11, 1), [10422], 'c1_closedAfter');
    await ok('state', 'close while draft (kind 16)', M, COLLAB, 'transition', T(PR4, 4, 1, 16, 1));
    await ok('state', 'reopen while draft (kind 17)', M, COLLAB, 'transition', T(PR4, 4, 1, 17, -1));
    await ok('state', 'ready, then close (kind 11)', M, COLLAB, 'transition', T(PR4, 4, 1, 15, -8));
    await ok('state', 'PR close', M, COLLAB, 'transition', T(PR4, 4, 1, 11, 1));
  }
  // Grouped proved reads (WIPE-PLAN §3.1 1-2): record how the node keys them
  try {
    // I1: close(author), reopen, lock, close, reopen, unlock; PR3: draft, ready, lock, unlock, merge;
    // PR4: draft, close-while-draft, reopen-while-draft, ready, close. Keys: 0x80 | kind, hex.
    const want = { '81': 2, '82': 2, '83': 1, '84': 1, '8b': 1, '8d': 1, '8e': 2, '8f': 2, '90': 1, '91': 1, '92': 1, '93': 1 };
    const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    const c = await eventually(async () => {
      const counts = await sdk.documents.countWithProof({ dataContractId: COLLAB, documentTypeName: 'transition', where: [['repoId', '==', docId(repo)], ['kind', 'in', [1, 2, 3, 4, 11, 12, 13, 14, 15, 16, 17, 18, 19]]], groupBy: ['kind'] });
      return Object.fromEntries([...(counts.data ?? counts).entries()].map(([k, v]) => [k, Number(v)]));
    }, (x) => same(x, want));
    const sums = await sdk.documents.sumWithProof({ dataContractId: COLLAB, documentTypeName: 'transition', where: [['targetId', 'in', [docId(I1), docId(PR3)]]], groupBy: ['targetId'] }, 'delta');
    const s = Object.fromEntries([...(sums.data ?? sums).entries()].map(([k, v]) => [k, Number(v)]));
    const sumOf = (d) => s[Buffer.from(Identifier.fromBase58(docId(d)).toBytes()).toString('hex')];
    const pass = sumOf(I1) === 0 && sumOf(PR3) === 2 && same(c, want);
    record({ item: '§3.1', label: 'grouped count by kind (absent kinds absent) and sum by target, proved', expect: `counts ${JSON.stringify(want)}, issue 0, PR 2`, got: `counts ${JSON.stringify(c)} sums ${JSON.stringify(s)}`, pass });
  } catch (e) {
    record({ item: '§3.1', label: 'grouped count by kind and sum by target (proved)', expect: 'proved results', got: `error ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
  }
}

if (want('state') && !(I1 && I2 && PR3)) record({ item: 'state', label: 'state group', expect: 'run', got: 'SKIPPED: an issue or PR was not written', pass: false });

// ---------------- threads: reply roots (R-14) ----------------
if (want('threads') && !(I1 && I2)) record({ item: 'R-14', label: 'threads group', expect: 'run', got: 'SKIPPED: an issue was not written', pass: false });
if (want('threads') && I1 && I2) {
  const root = await ok('R-14', 'root comment', M, COLLAB, 'comment', { repoId: R, targetId: id(docId(I2)), body: 'root', vis: 'public' });
  const reply = root && await ok('R-14', 'reply to the root', S, COLLAB, 'comment', { repoId: R, targetId: id(docId(I2)), body: 're', vis: 'public', replyTo: id(docId(root)) });
  if (reply) await no('R-14', 'reply to a reply', S, COLLAB, 'comment', { repoId: R, targetId: id(docId(I2)), body: 're re', vis: 'public', replyTo: id(docId(reply)) }, [40127]);
  if (root) await no('R-14', "reply naming another issue's comment", S, COLLAB, 'comment', { repoId: R, targetId: id(docId(I1)), body: 'x', vis: 'public', replyTo: id(docId(root)) }, [40127]);
  await no('R-14', 'reply to a comment that does not exist', S, COLLAB, 'comment', { repoId: R, targetId: id(docId(I2)), body: 'x', vis: 'public', replyTo: bytes(32, 9) }, [40120]);
  if (REVIEW_HUNK) {
    // QW2-010: a mirrored review comment keeps its source hunk, which no replace may change
    const imported = { author: 'octocat', createdAt: 1700000000000, url: 'https://github.com/o/r/pull/1#discussion_r1' };
    const mirrored = await ok('QW2-010', 'imported review comment with a hunk', M, COLLAB, 'comment', {
      repoId: R, targetId: id(docId(I2)), body: 'nit', vis: 'public', path: 'src/a.rs', line: 3, side: 1,
      diffHunk: '@@ -1,2 +1,3 @@\n a\n+b\n c', imported, asMember: id(M.id),
    }, 'comment: with a diff hunk');
    if (mirrored) await refusedOp('QW2-010', 'a replace that changes the hunk (immutable)', () => sdk.documents.replace({ document: revised(mirrored, { diffHunk: '@@ -1 +1 @@\n+forged' }), ...ownOps(M) }), [40128]);
  }
}

// ---------------- packs: completeness, bytes, a raw push -> clone ----------------
if (want('packs')) {
  const H = bytes(32);
  const chunk = (seq, packHash = H) => ({ repoId: R, packHash, seq, d0: bytes(100) });
  await ok('R-09', 'chunk 0', M, CORE, 'chunk', chunk(0), 'chunk');
  await ok('R-09', 'chunk 1', M, CORE, 'chunk', chunk(1), 'chunk');
  const man = (n, size, packHash = H, extra = {}) => ({ repoId: R, packHash, kind: 0, sizeBytes: size, objectCount: 1, chunkCount: n, storage: 0, ...extra });
  await sleep(A_BLOCK);
  await no('R-09', 'manifest claiming 3 chunks over seqs {0,1}', M, CORE, 'packManifest', man(3, 200), [10422], 'platformChunks');
  const H2 = bytes(32);
  for (const seq of [0, 1, 5]) await ok('R-09', `stray-pack chunk ${seq}`, M, CORE, 'chunk', chunk(seq, H2));
  // the count clause holds (3 chunks) once a node sees all three: only the seq sum refuses then
  await eventually(async () => {
    const q = await sdk.documents.countWithProof({ dataContractId: CORE, documentTypeName: 'chunk', where: [['repoId', '==', docId(repo)], ['$ownerId', '==', M.id], ['packHash', '==', Identifier.fromBytes(H2).toBase58()]], groupBy: [] });
    return [...(q.data ?? q).values()].reduce((a, b) => a + Number(b), 0);
  }, (n) => n === 3);
  await sleep(A_BLOCK);
  await no('R-09', 'manifest over seqs {0,1,5} (n 3: sum 6 != 3)', M, CORE, 'packManifest', man(3, 300, H2), [10422], 'platformChunks');
  await ok('R-09', 'manifest over seqs {0,1}', M, CORE, 'packManifest', man(2, 200), 'packManifest');
  await ok('O-05', 'external pack of 50 GB (i64 sizeBytes)', M, CORE, 'packManifest', man(0, 50_000_000_000, bytes(32), { storage: 1 }));
  await ok('O-05', 'external pack of 1 TiB', M, CORE, 'packManifest', man(0, 1_099_511_627_776, bytes(32), { storage: 1 }));
  try {
    const total = BigInt(50_000_000_000 + 1_099_511_627_776);
    const v = await eventually(async () => {
      const q = await sdk.documents.sumWithProof({ dataContractId: CORE, documentTypeName: 'packManifest', where: [['repoId', '==', docId(repo)], ['storage', '==', 1], ['kind', 'in', [0, 1, 2, 3, 4]]], groupBy: ['kind'] }, 'sizeBytes');
      return [...(q.data ?? q).values()].reduce((a, b) => a + BigInt(b), 0n);
    }, (x) => x === total);
    record({ item: 'O-05', label: 'proved sizeBytes sum over storage 1', expect: String(50_000_000_000 + 1_099_511_627_776), got: String(v), pass: v === BigInt(50_000_000_000 + 1_099_511_627_776) });
  } catch (e) {
    record({ item: 'O-05', label: 'proved sizeBytes sum over storage 1', expect: 'a sum', got: `error ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
  }
  // A real git pack, pushed as Platform chunks under its identifier packHash, then cloned back
  const dir = mkdtempSync(join(tmpdir(), 'rc1-live-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'rc1', GIT_AUTHOR_EMAIL: 'rc1@example.com', GIT_COMMITTER_NAME: 'rc1', GIT_COMMITTER_EMAIL: 'rc1@example.com' } });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), `# RC1 live ${tag}\n${randomBytes(30000).toString('base64')}\n`); // ~40 KB: 3 chunks
    git('add', 'README.md');
    git('commit', '-q', '-m', 'rc1 live');
    const head = git('rev-parse', 'HEAD').trim();
    const pack = execFileSync('git', ['pack-objects', '--stdout', '--revs'], { cwd: dir, input: 'HEAD\n' });
    const packHash = sha256(pack);
    const PART = 4900;
    const n = Math.ceil(pack.length / (3 * PART));
    for (let seq = 0; seq < n; seq++) {
      const slice = pack.subarray(seq * 3 * PART, (seq + 1) * 3 * PART);
      const d = { repoId: R, packHash, seq, d0: slice.subarray(0, PART) };
      if (slice.length > PART) d.d1 = slice.subarray(PART, 2 * PART);
      if (slice.length > 2 * PART) d.d2 = slice.subarray(2 * PART);
      await ok('push', `pack chunk ${seq + 1} of ${n}`, M, CORE, 'chunk', d);
    }
    await sleep(A_BLOCK);
    await ok('push', 'pack manifest (identifier packHash)', M, CORE, 'packManifest', { repoId: R, packHash, kind: 0, sizeBytes: pack.length, objectCount: 3, chunkCount: n, storage: 0, tips: Buffer.from(head, 'hex') });
    await ok('push', 'ref update to the pushed head', M, CORE, 'refUpdate', { repoId: R, refNameHash: sha256(Buffer.from('refs/heads/main')), refName: 'refs/heads/main', newOid: Buffer.from(head, 'hex'), prevOid: bytes(20, 1), vis: 'public' });
    // clone: find the manifest by packHash, read its chunks in order, verify, index the pack
    const mans = await sdk.documents.queryWithProof({ dataContractId: CORE, documentTypeName: 'packManifest', where: [['repoId', '==', docId(repo)], ['packHash', '==', Identifier.fromBytes(packHash).toBase58()]], orderBy: [['packHash', 'asc']], limit: 5 });
    const m = [...(mans.data ?? mans).values()].find(Boolean);
    const chunksRes = await sdk.documents.queryWithProof({ dataContractId: CORE, documentTypeName: 'chunk', where: [['repoId', '==', docId(repo)], ['$ownerId', '==', M.id], ['packHash', '==', Identifier.fromBytes(packHash).toBase58()]], orderBy: [['seq', 'asc']], limit: 100 });
    const parts = [...(chunksRes.data ?? chunksRes).values()].filter(Boolean).map((d) => d.toObject());
    const joined = Buffer.concat(parts.flatMap((c) => ['d0', 'd1', 'd2'].filter((k) => c[k]).map((k) => Buffer.from(c[k]))));
    const clone = mkdtempSync(join(tmpdir(), 'rc1-clone-'));
    execFileSync('git', ['init', '-q', '--bare', clone]);
    execFileSync('git', ['index-pack', '--stdin', '--keep'], { cwd: clone, input: joined });
    const catHead = execFileSync('git', ['cat-file', '-t', head], { cwd: clone, encoding: 'utf8' }).trim();
    rmSync(clone, { recursive: true, force: true });
    const pass = Boolean(m) && sha256(joined).equals(packHash) && joined.length === pack.length && catHead === 'commit';
    record({ item: 'push', label: 'clone: manifest by identifier packHash, chunks in seq order, pack verifies and indexes', expect: `commit ${head.slice(0, 12)}`, got: `${parts.length} chunks, ${joined.length} B, sha ${sha256(joined).equals(packHash) ? 'ok' : 'MISMATCH'}, head ${catHead}`, pass });
  } catch (e) {
    record({ item: 'push', label: 'raw push -> clone round trip', expect: 'round trip', got: `error ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------- releases: one live per tag, no delete (O-04) ----------------
if (want('releases')) {
  const rel = (delta, extra = {}) => ({ repoId: R, tagName: 'v1.0.0', name: 'one', vis: 'public', delta, ...extra });
  const r1 = await ok('O-04', 'publish v1.0.0', O, CORE, 'release', rel(1), 'release');
  await no('O-04', 'second publish while live (oneLive)', O, CORE, 'release', rel(1), [10422], 'oneLive');
  await ok('O-04', 'edit (delta 0)', O, CORE, 'release', rel(0, { notes: 'edited' }));
  await ok('O-04', 'unpublish (delta -1)', O, CORE, 'release', rel(-1));
  await no('O-04', 'edit an unpublished tag (oneLive)', O, CORE, 'release', rel(0), [10422], 'oneLive');
  await no('O-04', 'unpublish again (oneLive)', O, CORE, 'release', rel(-1), [10422], 'oneLive');
  await ok('O-04', 'republish', O, CORE, 'release', rel(1));
  await no('R-02', 'release stamped private on a public repo', O, CORE, 'release', { repoId: R, tagName: '-Ab3_x9QkZ', vis: 'private', delta: 0, enc: bytes(61), epoch: 0 }, [40127]);
  await no('O-04', 'a sealed release that publishes (oneLive: sealed is delta 0)', O, CORE, 'release', { repoId: P, tagName: '-Ab3_x9QkZ', vis: 'private', delta: 1, enc: bytes(61), epoch: 0 }, [10422], 'oneLive');
  await ok('O-04', 'a sealed release (delta 0)', O, CORE, 'release', { repoId: P, tagName: '-Ab3_x9QkZ', vis: 'private', delta: 0, enc: bytes(61), epoch: 0 });
  if (r1) await refusedOp('O-04', 'delete a release', () => sdk.documents.delete({ document: r1, ...ownOps(O) }), [10404], /can not be deleted/);
}

// ---------------- topics: 20 per repo, public repos only (R-20) ----------------
if (want('topics')) {
  // (the reference cases first: a repo at its cap refuses on the count before the reference)
  await no('R-20', 'a topic on a private repo', O, CORE, 'topic', { repoId: P, name: 'x', vis: 'public' }, [40127]);
  await no('R-20', "a topic by someone other than the repo's owner", M, CORE, 'topic', { repoId: R, name: 'y', vis: 'public' }, [40127]);
  for (let t = 0; t < 20; t++) await ok('R-20', `topic ${t + 1}`, O, CORE, 'topic', { repoId: R, name: `t${t}`, vis: 'public' }, t === 0 ? 'topic' : undefined);
  await no('R-20', 'the 21st topic (atMost20)', O, CORE, 'topic', { repoId: R, name: 't20', vis: 'public' }, [10422], 'atMost20');
}

// ---------------- CI: runner, sources, times, private runs, outcome ----------------
if (want('ci')) {
  await ok('O-02', 'owner enrols a runner', O, COMM, 'runner', { repoId: R, memberId: id(RN.id) }, 'runner');
  await no('O-02', "a non-owner enrols a runner", M, COMM, 'runner', { repoId: R, memberId: id(S.id) }, [40127]);
  const now = Date.now();
  const run = (extra = {}) => ({ repoId: R, headOid: bytes(20, 2), name: 'build', status: 'completed', conclusion: 'success', startedAt: now - 60000, completedAt: now, outcome: 1, vis: 'public', ...extra });
  await ok('O-02', 'check run by the runner', RN, COMM, 'checkRun', run(), 'checkRun');
  await no('O-02', 'check run by a stranger', S, COMM, 'checkRun', run(), [40120]);
  await no('R-17', 'completedAt far in the future (notFuture)', RN, COMM, 'checkRun', run({ startedAt: now, completedAt: 9_000_000_000_000_000 }), [10422], 'notFuture');
  await no('R-18', 'check run stamped private on a public repo', RN, COMM, 'checkRun', run({ vis: 'private' }), [40127]);
  const q0 = await ok('O-07', 'queued run (outcome 0)', RN, COMM, 'checkRun', { repoId: R, headOid: bytes(20, 2), name: 'lint', status: 'queued', outcome: 0, vis: 'public' });
  // D-5 / RC2 M1: startedAt, completedAt, conclusion and externalId are set once (conditional
  // `immutable` entries, `{"present": "$old.<p>"}`)
  const d5 = await ok('D-5', 'queued run to advance', RN, COMM, 'checkRun', { repoId: R, headOid: bytes(20, 9), name: 'd5', status: 'queued', outcome: 0, vis: 'public' });
  if (d5) {
    let started = null;
    await sleep(A_BLOCK); // a replace checked by a node a block behind finds no document (40101)
    try {
      await sdk.documents.replace({ document: revised(d5, { status: 'in_progress', startedAt: now - 1000 }), ...ownOps(RN) });
      started = revised(d5, { status: 'in_progress', startedAt: now - 1000 });
      record({ item: 'D-5', label: 'queued -> in progress (sets startedAt)', expect: 'ok', got: 'ok', pass: true });
    } catch (e) {
      record({ item: 'D-5', label: 'queued -> in progress (sets startedAt)', expect: 'ok', got: `refused ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
    }
    if (started) {
      await sleep(A_BLOCK);
      await refusedOp('D-5', 'a replace that moves startedAt (set once)', () => sdk.documents.replace({ document: revised(started, { startedAt: now - 500 }), ...ownOps(RN) }), [40128]);
      // RC2 S1: the replace that completes the run writes its evidence; after it, the log stands
      const done = revised(started, { status: 'completed', completedAt: now, conclusion: 'success', outcome: 1, logUrl: 'https://logs.example.com/rc2.txt', logSha256: bytes(32, 6) });
      let completed = null;
      await sleep(A_BLOCK);
      try {
        await sdk.documents.replace({ document: done, ...ownOps(RN) });
        completed = done;
        record({ item: 'S1', label: 'in progress -> completed with its log', expect: 'ok', got: 'ok', pass: true });
      } catch (e) {
        record({ item: 'S1', label: 'in progress -> completed with its log', expect: 'ok', got: `refused ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
      }
      if (completed && EVIDENCE_FROZEN) {
        await sleep(A_BLOCK);
        await refusedOp('S1', "a completed run's logUrl replaced", () => sdk.documents.replace({ document: revised(completed, { logUrl: 'https://logs.example.com/forged.txt' }), ...ownOps(RN) }), [40128]);
      }
    }
  }
  await ok('R-08', 'policy pinning the runner and a maintainer', O, COMM, 'policy', { repoId: R, requiredApprovals: 1, requiredChecks: ['build', 'lint'], requiredCheckSources: [id(RN.id), id(O.id)], mergeMethods: 15 }, 'policy');
  await no('R-08', 'policy pinning a stranger', O, COMM, 'policy', { repoId: R, requiredApprovals: 0, requiredChecks: ['build'], requiredCheckSources: [id(S.id)] }, [40120]);
  try {
    const want = { '80': 1, '81': 1 }; // one pending (0), one passed (1); no failed (2) entry at all
    const c = await eventually(async () => {
      const q = await sdk.documents.countWithProof({ dataContractId: COMM, documentTypeName: 'checkRun', where: [['repoId', '==', docId(repo)], ['headOid', '==', bytes(20, 2).toString('base64')], ['outcome', 'in', [0, 1, 2]]], groupBy: ['outcome'] });
      return Object.fromEntries([...(q.data ?? q).entries()].map(([k, v]) => [k, Number(v)]));
    }, (x) => JSON.stringify(x) === JSON.stringify(want));
    record({ item: 'O-07', label: 'proved outcome count per head (groupBy outcome)', expect: JSON.stringify(want), got: JSON.stringify(c), pass: Boolean(q0) && JSON.stringify(c) === JSON.stringify(want) });
  } catch (e) {
    record({ item: 'O-07', label: 'proved outcome count per head', expect: 'counts', got: `error ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
  }
}

// ---------------- social, hooks, keys, events across contracts ----------------
if (want('social')) {
  if (!FUSED_STAR) {
    await ok('O-08', "a stranger's beat on the owner's repo", S, COMM, 'starBeat', { repoId: R, vis: 'public', repoOwner: id(O.id) }, 'starBeat');
    await no('O-08', "the owner's beat on its own repo (distinctFrom)", O, COMM, 'starBeat', { repoId: R, vis: 'public', repoOwner: id(O.id) }, [10419]);
    await no('O-08', 'a beat naming the wrong repo owner', M, COMM, 'starBeat', { repoId: R, vis: 'public', repoOwner: id(S.id) }, [40127]);
    await no('O-08', 'a beat on a private repo', S, COMM, 'starBeat', { repoId: P, vis: 'public', repoOwner: id(O.id) }, [40127]);
  }
  const star = await ok(FUSED_STAR ? 'C1' : 'COMM-9', FUSED_STAR ? 'star (the trending entry too)' : 'star', S, COMM, 'star', { repoId: R }, 'star');
  if (FUSED_STAR && star) {
    // RC2 C1: an unstar leaves the window entry (outlivesDelete), and a star again inside the
    // window writes over it instead of being refused as a duplicate (v5 book
    // contract-keywords/index-only.md:220-221)
    await sleep(A_BLOCK);
    try {
      await sdk.documents.delete({ document: star, ...ownOps(S) });
      record({ item: 'C1', label: 'unstar (a delete with no $createdAt)', expect: 'ok', got: 'ok', pass: true });
      await sleep(A_BLOCK);
      await ok('C1', 'star again inside the window', S, COMM, 'star', { repoId: R });
    } catch (e) {
      record({ item: 'C1', label: 'unstar (a delete with no $createdAt)', expect: 'ok', got: `refused ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
    }
  }
  await ok('COMM-9', 'watch', S, COMM, 'watch', { repoId: R }, 'watch');
  const hook = { repoId: R, hookId: bytes(32), url: 'https://hooks.example.com/rc1', events: ['push'], relayIdentityId: id(M.id), relayKeyId: M.encKeyId, senderKeyId: O.encKeyId, secret: bytes(48), vis: 'public' };
  await ok('R-19', 'webhook on a public repo', O, COMM, 'webhook', hook);
  await no('R-19', 'webhook stamped private', O, COMM, 'webhook', { ...hook, hookId: bytes(32), vis: 'private' }, [10422], 'publicOnly');
  await no('R-19', 'webhook stamped public on a private repo', O, COMM, 'webhook', { ...hook, repoId: P, hookId: bytes(32) }, [40127]);
  await ok('R-13', 'wrap the repo key to a member (the owner)', O, COLLAB, 'repoKey', { repoId: P, memberId: id(O.id), epoch: 0, recipientKeyId: O.encKeyId, senderKeyId: O.encKeyId, wrapped: bytes(48) }, 'repoKey');
  await no('R-13', 'wrap to a non-member', O, COLLAB, 'repoKey', { repoId: P, memberId: id(S.id), epoch: 0, recipientKeyId: S.encKeyId, senderKeyId: O.encKeyId, wrapped: bytes(48) }, [40120]);
  if (I1) {
    const ev = await ok('O-01', 'label event (community -> collab issue)', M, COMM, 'event', { repoId: R, targetId: id(docId(I1)), targetNumber: 1, kind: 4, value: 'bug' }, 'event');
    if (ev) await no('O-01', 'event naming the wrong number', M, COMM, 'event', { repoId: R, targetId: id(docId(I1)), targetNumber: 2, kind: 4, value: 'bug' }, WHERE_ANYOF);
    await ok('O-01', "author's resolve (authorEvent across contracts)", S, COMM, 'authorEvent', { repoId: R, targetId: id(docId(I1)), targetNumber: 1, kind: 11, refId: bytes(32, 4) });
    await no('O-01', "non-author's authorEvent", M, COMM, 'authorEvent', { repoId: R, targetId: id(docId(I1)), targetNumber: 1, kind: 11, refId: bytes(32, 4) }, [40120]);
    await ok('O-01', 'milestone in community', M, COMM, 'milestone', { repoId: R, title: 'v1' });
  }
}

// ---------------- moderation: hide / unhide (RC2 MOD) ----------------
if (want('moderation') && !I1) record({ item: 'MOD', label: 'moderation group', expect: 'run', got: 'SKIPPED: issue #1 was not written', pass: false });
if (want('moderation') && I1 && HIDE_PROOF) {
  // `extra` overrides a field, and undefined leaves it out
  const hide = (who, extra = {}) => Object.fromEntries(Object.entries({ repoId: R, targetId: id(docId(I1)), targetNumber: 1, kind: 24, refId: bytes(32, 5), asMaintainer: id(who.id), ...extra }).filter(([, v]) => v !== undefined));
  // The fee gate: a hide (its maintainer lookup, rule and 32 bytes) against the same event
  // without asMaintainer (kind 19 with a refId, which no reader reads there: what a hide costs
  // with the flag off)
  await ok('MOD', 'a member event with a refId (fee baseline)', O, COMM, 'event', { repoId: R, targetId: id(docId(I1)), targetNumber: 1, kind: 19, refId: bytes(32, 5) }, 'event: no asMaintainer (fee baseline)');
  await ok('MOD', "the owner hides a comment as spam", O, COMM, 'event', hide(O, { value: 'spam' }));
  await ok('MOD', 'the owner hides a comment', O, COMM, 'event', hide(O), 'event: hide (asMaintainer)');
  await ok('MOD', 'the owner unhides it', O, COMM, 'event', hide(O, { kind: 25 }));
  await ok('MOD', 'the owner hides the whole thread', O, COMM, 'event', hide(O, { refId: undefined }));
  await no('MOD', 'a hide without asMaintainer', O, COMM, 'event', hide(O, { asMaintainer: undefined }), [10422], 'hideByMaint');
  await no('MOD', "a writer's hide", M, COMM, 'event', hide(M), [40120]);
  await no('MOD', "a writer's hide naming the owner", M, COMM, 'event', hide(O), [10422], 'hideByMaint');
  await no('MOD', "a stranger's hide", S, COMM, 'event', hide(S), [40120]);
  const theirs = await ok('MOD', "the member's own repo", M, CORE, 'repo', { name: `rc1m-${tag}`, visibility: 'public' });
  if (theirs) {
    await ok('MOD', 'the member self-enrols as its maintainer', M, CORE, 'maintainer', { repoId: id(docId(theirs)), memberId: id(M.id), vis: 'public' });
    await sleep(A_BLOCK);
    await no('MOD', 'a maintainer of another repo hides here', M, COMM, 'event', hide(M), [40120]);
  }
  const promoted = await ok('MOD', 'the owner makes the member a maintainer', O, CORE, 'maintainer', { repoId: R, memberId: id(M.id), vis: 'public', consentBy: id(M.id) });
  if (promoted) {
    await sleep(A_BLOCK);
    await ok('MOD', 'the new maintainer hides a comment', M, COMM, 'event', hide(M));
    await no('MOD', 'a maintainer hide naming another maintainer', M, COMM, 'event', hide(O), [10422], 'hideByMaint');
    try {
      await sdk.documents.delete({ document: promoted, ...ownOps(O) });
      record({ item: 'MOD', label: "the owner removes the member's maintainer document", expect: 'ok', got: 'ok', pass: true });
      await sleep(A_BLOCK);
      await no('MOD', 'the removed maintainer hides', M, COMM, 'event', hide(M), [40120]);
    } catch (e) {
      record({ item: 'MOD', label: "the owner removes the member's maintainer document", expect: 'ok', got: `refused ${codeOf(e)}`, note: String(e?.message ?? e).slice(0, 300), pass: false });
    }
  }
}

} catch (e) {
  if (!(e instanceof InfraError)) throw e;
  infra = e.message;
  log(`STOPPED: ${infra}`);
}

const passed = results.filter((r) => r.pass && !r.infra).length;
if (infraCases.length) infra = `${infraCases.length} case(s) without a verdict: ${infraCases.join('; ')}`;
const feeSummary = Object.fromEntries(Object.entries(fees).map(([k, v]) => [k, Math.round(v.reduce((a, b) => a + b, 0) / v.length)]));
const report = { network: `devnet-${devnetName}`, contracts: { core: CORE, collab: COLLAB, community: COMM }, run: tag, passed, total: results.length, infra, fees: feeSummary, results };
if (args.report) writeFileSync(String(args.report), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed, total: results.length, infra, fees: feeSummary, failed: results.filter((r) => !r.pass) }, null, 2));
process.exit(results.some((r) => !r.pass) ? 1 : infra ? 2 : 0);

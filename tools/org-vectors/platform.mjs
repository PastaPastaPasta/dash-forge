// forge-contracts/fixtures/org/platform-v1.json: organizations on Platform (docs/design/organizations.md
// §10, §11), built on the ceremony in dti-2of3.json. Deterministic: rerunning it gives the same file.
//   node tools/org-vectors/gen.mjs <path to dash-threshold-identity> <its commit> platform > forge-contracts/fixtures/org/platform-v1.json
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(resolve(here, '../../forge-contracts/fixtures/org/dti-2of3.json'), 'utf8'));

export async function platformVectors(dtiPath, source) {
  const dti = (p) => import(pathToFileURL(resolve(dtiPath, p)).href);
  const { seedFromMnemonic, participantKeys } = await dti('src/derive.mjs');
  const { reduce } = await dti('src/state.mjs');
  const { recoverShares } = await dti('src/participant.mjs');
  const { envelopeId, sealEnvelope } = await dti('src/envelope.mjs');
  const { signShare, scalarToHex } = await dti('src/bls.mjs');
  const { canonical, hex, unhex, utf8 } = await dti('src/util.mjs');
  const { ed25519 } = await dti('node_modules/@noble/curves/ed25519.js');
  const { hkdf } = await dti('node_modules/@noble/hashes/hkdf.js');
  const { sha256 } = await dti('node_modules/@noble/hashes/sha2.js');
  const { xchacha20poly1305 } = await dti('node_modules/@noble/ciphers/chacha.js');
  const { base58 } = await dti('node_modules/@scure/base/index.js');

  const NETWORK = 'testnet';
  const ROOM = base.room;
  const CID = base.cid;
  const MAX_PART = 5120;
  const MAX_PARTS = 16;
  const MAX_PAYLOAD = 266240;
  const id32 = (label) => base58.encode(sha256(utf8(`forge org vector: ${label}`)));
  const ORG = id32('organization');
  const STRANGER = id32('stranger');
  const at = (ms) => new Date(Date.UTC(2026, 10, 28, 12, 0, 0) + ms).toISOString();
  const createdAt = (s) => Date.UTC(2026, 10, 28, 12, 0, 0) + s * 1000;

  const people = base.members.map((m, i) => {
    const seed = seedFromMnemonic(m.mnemonic, m.passphrase);
    return { ...m, seed, keys: participantKeys(seed), ownerId: id32(`member ${i + 1} forge identity`) };
  });
  const state0 = reduce(base.ceremonyMessages);
  const high = base.keys.high;

  // --- orgMember -----------------------------------------------------------------------------
  const proofMessage = (network, org, owner) => `dash-forge/org-member/1\n${network}\n${org}\n${owner}`;
  const proof = (p, network, org, owner) => hex(ed25519.sign(utf8(proofMessage(network, org, owner)), p.keys.authSecret));
  const verifyProof = (authPub, network, org, owner, sig) => {
    try {
      return ed25519.verify(unhex(sig), utf8(proofMessage(network, org, owner)), unhex(authPub));
    } catch {
      return false;
    }
  };

  // --- sealedShare ---------------------------------------------------------------------------
  const shareKey = (seed, network, org, cid) => hkdf(sha256, seed, utf8('dash-forge/org-share/1'), utf8(`${network}\n${org}\n${cid}`), 32);
  const NONCE = Uint8Array.from({ length: 24 }, (_, i) => i);
  const seal = (seed, share, nonce = NONCE, network = NETWORK, org = ORG) => {
    const ct = xchacha20poly1305(shareKey(seed, network, org, CID), nonce).encrypt(unhex(share));
    return hex(new Uint8Array([...nonce, ...ct]));
  };
  const open = (seed, sealed, network = NETWORK, org = ORG) => {
    const b = unhex(sealed);
    try {
      return hex(xchacha20poly1305(shareKey(seed, network, org, CID), b.slice(0, 24)).decrypt(b.slice(24)));
    } catch {
      return null;
    }
  };

  const members = people.map((p) => {
    const share = scalarToHex(recoverShares(p.seed, p.keys, state0, CID).shares.high);
    const sealed = seal(p.seed, share);
    if (open(p.seed, sealed) !== share) throw new Error('sealedShare does not round-trip');
    return {
      index: p.index,
      name: p.name,
      authPub: p.keys.authPub,
      seed: hex(p.seed),
      ownerId: p.ownerId,
      proofMessage: proofMessage(NETWORK, ORG, p.ownerId),
      proof: proof(p, NETWORK, ORG, p.ownerId),
      share,
      shareKey: hex(shareKey(p.seed, NETWORK, ORG, CID)),
      shareInfo: `${NETWORK}\n${ORG}\n${CID}`,
      sealedShare: sealed,
    };
  });
  const [m1, m2, m3] = members;
  const [p1, p2, p3] = people;

  const tampered = (h) => h.slice(0, -2) + (h.endsWith('00') ? '01' : '00');
  const sealedCases = [
    { name: 'opens with the member seed', seed: m1.seed, network: NETWORK, org: ORG, sealed: m1.sealedShare, share: m1.share },
    { name: 'another member seed does not open it', seed: m2.seed, network: NETWORK, org: ORG, sealed: m1.sealedShare, share: null },
    { name: 'another network does not open it', seed: m1.seed, network: 'devnet-x', org: ORG, sealed: m1.sealedShare, share: null },
    { name: 'another organization does not open it', seed: m1.seed, network: NETWORK, org: STRANGER, sealed: m1.sealedShare, share: null },
    { name: 'a changed tag does not open', seed: m1.seed, network: NETWORK, org: ORG, sealed: tampered(m1.sealedShare), share: null },
  ];
  for (const c of sealedCases) {
    const got = open(unhex(c.seed), c.sealed, c.network, c.org);
    if (got !== c.share) throw new Error(`sealed case ${c.name}`);
  }

  const outsider = { keys: participantKeys(seedFromMnemonic(base.members[0].mnemonic, 'not a member')) };
  const OUTSIDER_OWNER = id32('outsider');
  // orgMember documents as a reader sees them: which bind an identity to a member, and which not.
  const memberDocs = [
    { $id: id32('om1'), $ownerId: m1.ownerId, $createdAt: createdAt(1), org: ORG, room: ROOM, authPub: m1.authPub, proof: m1.proof },
    { $id: id32('om2'), $ownerId: m2.ownerId, $createdAt: createdAt(2), org: ORG, room: ROOM, authPub: m2.authPub, proof: m2.proof },
    { $id: id32('om3'), $ownerId: m3.ownerId, $createdAt: createdAt(3), org: ORG, room: ROOM, authPub: m3.authPub, proof: m3.proof },
    { $id: id32('om-copied'), $ownerId: STRANGER, $createdAt: createdAt(0), org: ORG, room: ROOM, authPub: m1.authPub, proof: m1.proof },
    { $id: id32('om-other-org'), $ownerId: id32('m2 second identity'), $createdAt: createdAt(4), org: ORG, room: ROOM, authPub: m2.authPub, proof: proof(p2, NETWORK, STRANGER, id32('m2 second identity')) },
    { $id: id32('om-other-net'), $ownerId: id32('m2 third identity'), $createdAt: createdAt(4), org: ORG, room: ROOM, authPub: m2.authPub, proof: proof(p2, 'devnet-x', ORG, id32('m2 third identity')) },
    ...[1, 2, 3, 4, 5].map((k) => {
      const owner = id32(`m3 extra identity ${k}`);
      return { $id: id32(`om3-extra-${k}`), $ownerId: owner, $createdAt: createdAt(10 + k), org: ORG, room: ROOM, authPub: m3.authPub, proof: proof(p3, NETWORK, ORG, owner) };
    }),
    { $id: id32('om1-also-m2'), $ownerId: m1.ownerId, $createdAt: createdAt(6), org: ORG, room: ROOM, authPub: m2.authPub, proof: proof(p2, NETWORK, ORG, m1.ownerId) },
    { $id: id32('om-outsider'), $ownerId: OUTSIDER_OWNER, $createdAt: createdAt(5), org: ORG, room: ROOM, authPub: outsider.keys.authPub, proof: proof(outsider, NETWORK, ORG, OUTSIDER_OWNER) },
  ];
  // orgShare documents: one per member identity per ceremony (unique org, $ownerId, cid).
  const shareDocs = [
    { $id: id32('os1'), $ownerId: m1.ownerId, $createdAt: createdAt(1), org: ORG, cid: CID, sealed: m1.sealedShare },
    { $id: id32('os3'), $ownerId: m3.ownerId, $createdAt: createdAt(3), org: ORG, cid: CID, sealed: m3.sealedShare },
  ];
  const MAX_PER_KEY = 4;
  const bound = {};
  const memberAuth = new Set(members.map((m) => m.authPub));
  for (const d of [...memberDocs].sort((a, b) => a.$createdAt - b.$createdAt || (a.$id < b.$id ? -1 : 1))) {
    if (d.org !== ORG || !memberAuth.has(d.authPub) || !verifyProof(d.authPub, NETWORK, ORG, d.$ownerId, d.proof)) continue;
    const list = (bound[d.authPub] ??= []);
    if (list.length < MAX_PER_KEY) list.push(d.$ownerId);
  }

  // --- the org roster ------------------------------------------------------------------------
  const order = members.map((m) => m.index).sort((a, b) => a - b);
  const roster = {
    room: ROOM,
    relay: 'https://multisig.dashhq.org',
    cid: CID,
    keyId: high.keyId,
    groupKey: high.groupPublicKey,
    threshold: base.threshold,
    members: order.map((i) => members.find((m) => m.index === i).authPub).join(''),
    pubShares: order.map((i) => high.publicShares[i]).join(''),
  };

  // --- orgMessage parts ----------------------------------------------------------------------
  const sha = (b) => hex(sha256(b));
  // deflate-raw that must end exactly at the payload's end (no trailing bytes, not truncated)
  const inflateWhole = (payload) => {
    const { buffer, engine } = inflateRawSync(payload, { maxOutputLength: MAX_PAYLOAD, info: true });
    if (engine.bytesWritten !== payload.length) throw new Error('bytes after the deflate stream');
    return new Uint8Array(buffer);
  };
  const encode = (envelope, fmt) => {
    const raw = utf8(canonical(envelope));
    const payload = fmt === 1 ? new Uint8Array(deflateRawSync(raw, { level: 9 })) : raw;
    const parts = [];
    for (let i = 0; i < payload.length; i += MAX_PART) parts.push(hex(payload.slice(i, i + MAX_PART)));
    if (parts.length > MAX_PARTS) throw new Error('too many parts');
    return { fmt, digest: sha(payload), parts };
  };
  const chooseFmt = (envelope) => {
    const raw = utf8(canonical(envelope));
    return deflateRawSync(raw, { level: 9 }).length < raw.length ? 1 : 0;
  };
  const decode = (fmt, partsHex) => {
    const payload = unhex(partsHex.join(''));
    const raw = fmt === 1 ? inflateWhole(payload) : payload;
    return JSON.parse(new TextDecoder().decode(raw));
  };

  const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
  const byTime = (a, b) => a.$createdAt - b.$createdAt || (a.$id < b.$id ? -1 : a.$id > b.$id ? 1 : 0);
  // The reader: orgMessage documents to [{ owner, envelope, t }] (one per complete message).
  const reassemble = (docs) => {
    const groups = new Map();
    for (const d of docs) {
      const k = `${d.$ownerId}|${d.digest}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }
    const out = [];
    for (const ds of groups.values()) {
      const chosen = new Map();
      for (const d of [...ds].sort(byTime)) if (!chosen.has(d.part)) chosen.set(d.part, d);
      const first = chosen.get(0);
      if (!first || ![0, 1].includes(first.fmt) || first.parts < 1 || first.parts > MAX_PARTS) continue;
      const list = [...chosen.values()].sort((a, b) => a.part - b.part);
      if (list.length !== first.parts || list.some((d, i) => d.part !== i || d.parts !== first.parts || d.fmt !== first.fmt)) continue;
      const payload = unhex(list.map((d) => d.body).join(''));
      if (sha(payload) !== first.digest) continue;
      let text;
      try {
        const raw = first.fmt === 1 ? inflateWhole(payload) : payload;
        if (raw.length > MAX_PAYLOAD) continue;
        text = utf8Fatal.decode(raw);
        const env = JSON.parse(text);
        if (canonical(env) !== text) continue;
        out.push({ owner: first.$ownerId, envelope: env, t: Math.max(...list.map((d) => d.$createdAt)) });
      } catch {
        continue;
      }
    }
    return out;
  };

  const room = ROOM;
  const sealAt = (p, type, body, ms) => sealEnvelope(p.keys, room, type, body, at(ms));
  const proposalBody = (signable, note, unsigned = '00') => ({
    network: NETWORK,
    intent: { type: 'test' },
    unsigned,
    signable,
    requirements: [{ cid: CID, slot: 'high' }],
    derived: {},
    ...(note === undefined ? {} : { note }),
  });
  const note = (group, seq, of, title) => JSON.stringify({ forge: 1, group, seq, of, title });
  const sharesOf = (people) => Object.fromEntries(people.map((p) => [p.index, recoverShares(p.seed, p.keys, state0, CID).shares.high]));
  const secret = sharesOf(people);
  const approveAt = (p, proposal, ms) => {
    const message = unhex(proposal.body.signable);
    return sealAt(p, 'approve', { proposalId: envelopeId(proposal), shares: { [`${CID}/high`]: { index: p.index, share: signShare(secret[p.index], message) } } }, ms);
  };

  const sigA = hex(utf8('forge platform vector: request A'));
  const propA = sealAt(p1, 'proposal', proposalBody(sigA, note('a1a1a1a1a1a1a1a1', 0, 1, 'Request A')), 1000);
  const apprA1 = approveAt(p1, propA, 1100);
  const apprA3 = approveAt(p3, propA, 1200);
  // deterministic pseudo-random hex that deflate cannot shrink below one part
  const noise = (label, bytes) => {
    let out = '';
    for (let i = 0; out.length < bytes * 2; i++) out += hex(sha256(utf8(`${label}:${i}`)));
    return out.slice(0, bytes * 2);
  };
  const bigProposal = sealAt(p2, 'proposal', proposalBody(hex(utf8('forge platform vector: big')), note('b2b2b2b2b2b2b2b2', 0, 1, 'A big one'), noise('big', 6000)), 1300);
  const bigCompressible = sealAt(p2, 'proposal', proposalBody(hex(utf8('forge platform vector: big repeated')), note('c3c3c3c3c3c3c3c3', 0, 1, 'Repeated'), '00'.repeat(6000)), 1400);
  const messageCases = [
    { name: 'an approve, plain', envelope: apprA1, ...encode(apprA1, 0) },
    { name: 'the same approve, deflated', envelope: apprA1, ...encode(apprA1, 1) },
    { name: 'a proposal over 5120 bytes, plain', envelope: bigProposal, ...encode(bigProposal, 0) },
    { name: 'a proposal over 5120 bytes deflated, still two parts', envelope: bigProposal, ...encode(bigProposal, 1) },
    { name: 'a repetitive proposal over 5120 bytes deflates to one part', envelope: bigCompressible, ...encode(bigCompressible, 1) },
  ];
  for (const c of messageCases) {
    if (canonical(decode(c.fmt, c.parts)) !== canonical(c.envelope)) throw new Error(`message case ${c.name}`);
    c.id = envelopeId(c.envelope);
    c.canonicalLength = utf8(canonical(c.envelope)).length;
    c.writerFmt = chooseFmt(c.envelope);
  }
  if (messageCases[2].parts.length < 2 || messageCases[3].parts.length < 2 || messageCases[4].parts.length !== 1) throw new Error('part counts');

  // --- reassembly: which orgMessage documents make a message ---------------------------------
  let docN = 0;
  const docsOf = (owner, enc, t, overrides = {}) =>
    enc.parts.map((body, part) => ({
      $id: id32(`msg-doc-${docN++}`),
      $ownerId: owner,
      $createdAt: createdAt(t + part),
      org: ORG,
      digest: enc.digest,
      part,
      parts: enc.parts.length,
      fmt: enc.fmt,
      body,
      ...((typeof overrides === 'function' ? overrides(part) : overrides) ?? {}),
    }));
  const big = messageCases[3];
  const small = messageCases[1];
  const reassembly = [
    { name: 'all parts present', docs: docsOf(m2.ownerId, big, 100), accepted: [big.id] },
    { name: 'parts arrive out of order', docs: docsOf(m2.ownerId, big, 100).reverse(), accepted: [big.id] },
    { name: 'a missing part', docs: docsOf(m2.ownerId, big, 100).slice(1), accepted: [] },
    { name: 'a part from another identity does not complete it', docs: docsOf(m2.ownerId, big, 100).map((d, i) => (i === 1 ? { ...d, $ownerId: m3.ownerId } : d)), accepted: [] },
    { name: 'a wrong digest', docs: docsOf(m1.ownerId, small, 100, { digest: sha(utf8('nope')) }), accepted: [] },
    { name: 'parts that disagree on the part count', docs: docsOf(m2.ownerId, big, 100, (part) => (part === 0 ? { parts: 3 } : {})), accepted: [] },
    { name: 'a repeated part with the same body is fine', docs: [...docsOf(m2.ownerId, big, 100), docsOf(m2.ownerId, big, 200)[0]], accepted: [big.id] },
    { name: 'a repeated part with another body: the earliest counts', docs: [...docsOf(m2.ownerId, big, 100), { ...docsOf(m2.ownerId, big, 50)[1], body: 'ff' }], accepted: [] },
    { name: 'fmt 0 bytes that are deflate', docs: docsOf(m1.ownerId, small, 100, { fmt: 0 }), accepted: [] },
    { name: 'bytes after the deflate stream', docs: docsOf(m1.ownerId, encodeRaw(new Uint8Array([...deflateRawSync(utf8(canonical(apprA1))), 0]), 1), 100), accepted: [] },
    { name: 'a truncated deflate stream', docs: docsOf(m1.ownerId, encodeRaw(new Uint8Array(deflateRawSync(utf8(canonical(apprA1)))).slice(0, -3), 1), 100), accepted: [] },
    { name: 'not canonical JSON', docs: docsOf(m1.ownerId, encodeRaw(utf8(JSON.stringify(apprA1, null, 1))), 100), accepted: [] },
  ];
  function encodeRaw(payload, fmt = 0) {
    return { fmt, digest: sha(payload), parts: [hex(payload)] };
  }
  for (const c of reassembly) {
    const got = reassemble(c.docs).map((m) => envelopeId(m.envelope));
    if (JSON.stringify(got) !== JSON.stringify(c.accepted)) throw new Error(`reassembly case ${c.name}: ${got}`);
  }

  // --- merge: envelopes from every member identity's log --------------------------------------
  const rejB = sealAt(p3, 'reject', { proposalId: envelopeId(bigProposal), reason: 'too big' }, 1500);
  const late = (owner, env, t) => docsOf(owner, encode(env, chooseFmt(env)), t);
  const mergeDocs = [
    ...late(m1.ownerId, propA, 10),
    ...late(m1.ownerId, apprA1, 12),
    ...late(m3.ownerId, apprA3, 11),
    ...late(m3.ownerId, apprA1, 9),
    ...late(m2.ownerId, bigProposal, 20),
    ...late(m3.ownerId, rejB, 30),
    ...late(id32('m2 not bound'), apprA3, 1),
  ];
  const boundOwners = { [m1.authPub]: [m1.ownerId], [m2.authPub]: [m2.ownerId], [m3.authPub]: [m3.ownerId] };
  const ownerAuth = {};
  for (const [a, os] of Object.entries(boundOwners)) for (const o of os) (ownerAuth[o] ??= new Set()).add(a);
  const seen = new Map();
  for (const m of reassemble(mergeDocs)) {
    if (!ownerAuth[m.owner]?.has(m.envelope.from)) continue;
    const id = envelopeId(m.envelope);
    if (!seen.has(id) || seen.get(id).t > m.t) seen.set(id, { t: m.t, env: m.envelope });
  }
  const merged = [...seen.entries()].sort((a, b) => a[1].t - b[1].t || (a[0] < b[0] ? -1 : 1));
  const mergeState = reduce([...base.ceremonyMessages, ...merged.map(([, { env }]) => env)], { room });
  const merge = {
    note: 'Envelopes count only from the log of an identity bound (orgMember) to the envelope `from`. A copy of a message is complete at its last part\'s $createdAt; each envelope is ordered by its earliest complete copy, then envelope id; that time is the `at` the request flow shows and orders approvals by.',
    boundOwners,
    docs: mergeDocs,
    order: merged.map(([id]) => id),
    at: Object.fromEntries(merged.map(([id, { t }]) => [id, new Date(t).toISOString()])),
    expected: {
      requestA: { proposal: envelopeId(propA), status: mergeState.proposals[envelopeId(propA)].status, shares: Object.keys(mergeState.proposals[envelopeId(propA)].requirements[0].shares).map(Number) },
      big: { proposal: envelopeId(bigProposal), status: mergeState.proposals[envelopeId(bigProposal)].status, rejections: Object.keys(mergeState.proposals[envelopeId(bigProposal)].rejections) },
    },
  };

  // --- request ids (§11.5) -------------------------------------------------------------------
  const G = 'd4d4d4d4d4d4d4d4';
  const H = 'e5e5e5e5e5e5e5e5';
  const r1 = sealAt(p1, 'proposal', proposalBody(hex(utf8('ids 1')), note(G, 0, 2, 'Two parts')), 2000);
  const r1b = sealAt(p1, 'proposal', proposalBody(hex(utf8('ids 2')), note(G, 1, 2, 'Two parts')), 2001);
  const r2 = sealAt(p2, 'proposal', proposalBody(hex(utf8('ids 3')), note(G, 0, 1, 'Same group, earlier')), 1);
  const r3 = sealAt(p3, 'proposal', proposalBody(hex(utf8('ids 4')), note(H, 0, 1, 'Alone')), 2002);
  const r4 = sealAt(p3, 'proposal', proposalBody(hex(utf8('ids 5')), undefined), 2003);
  const k16 = (p) => p.keys.authPub.slice(0, 16);
  const requestIds = {
    envelopes: [r1, r1b, r2, r3, r4],
    requests: [
      { id: `${G}-${k16(p1)}`, proposer: p1.keys.authPub, proposals: [envelopeId(r1), envelopeId(r1b)], forge: true },
      { id: `${G}-${k16(p2)}`, proposer: p2.keys.authPub, proposals: [envelopeId(r2)], forge: true },
      { id: `${H}-${k16(p3)}`, proposer: p3.keys.authPub, proposals: [envelopeId(r3)], forge: true },
      { id: envelopeId(r4), proposer: p3.keys.authPub, proposals: [envelopeId(r4)], forge: false },
    ],
    resolve: [
      { query: `${G}-${k16(p1)}`, id: `${G}-${k16(p1)}` },
      { query: H, id: `${H}-${k16(p3)}`, why: 'a bare group id resolves when exactly one proposer used it' },
      { query: G, id: null, why: 'two proposers used it' },
      { query: `${H}-${k16(p3)}`.slice(0, 10), id: `${H}-${k16(p3)}`, why: 'an unambiguous prefix of at least 4 characters' },
      { query: envelopeId(r4), id: envelopeId(r4) },
      { query: 'd4d4', id: null, why: 'an ambiguous prefix' },
    ],
  };

  // --- status (§11.3, §11.6): a pure function both clients implement --------------------------
  const part = (o) => ({ action: 'create', shares: 2, claim: false, nonceSpent: false, doc: 'absent', takenByOther: false, ...o });
  const statusCases = [
    { name: 'collecting', parts: [part({ shares: 1 })], expect: { parts: ['collecting'], status: 'collecting' } },
    { name: 'ready', parts: [part({})], expect: { parts: ['ready'], status: 'ready' } },
    { name: 'a claim alone is not done', parts: [part({ claim: true })], expect: { parts: ['ready'], status: 'ready' } },
    { name: 'a create is done when its document exists with its fields', parts: [part({ doc: 'same', nonceSpent: true })], expect: { parts: ['done'], status: 'done' } },
    { name: 'a create gone after a claim, nonce spent', parts: [part({ claim: true, nonceSpent: true })], expect: { parts: ['gone'], status: 'done', text: 'Done (no longer on Platform)' } },
    { name: 'a create gone without a claim is expired', parts: [part({ nonceSpent: true })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'another request landed with its nonce', parts: [part({ claim: true, nonceSpent: true, takenByOther: true })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'another request landed with its nonce, whatever its document shows', parts: [part({ doc: 'same', claim: true, nonceSpent: true, takenByOther: true })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'a create whose document exists with other fields, nonce spent', parts: [part({ doc: 'different', nonceSpent: true, claim: true })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'a create whose document exists with other fields, nonce free', parts: [part({ doc: 'different' })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'a create edited since (later revision), nonce spent, claimed', parts: [part({ doc: 'later', nonceSpent: true, claim: true })], expect: { parts: ['done'], status: 'done' } },
    { name: 'a create edited since (later revision), no claim', parts: [part({ doc: 'later', nonceSpent: true })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'a replace waiting to land: its document is at the revision it replaces', parts: [part({ action: 'replace', doc: 'base' })], expect: { parts: ['ready'], status: 'ready' } },
    { name: 'a replace whose document changed under it, nonce free', parts: [part({ action: 'replace', doc: 'different' })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'a replace whose document is gone', parts: [part({ action: 'replace', doc: 'absent' })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'a replace at its revision with the same fields', parts: [part({ action: 'replace', doc: 'same', nonceSpent: true })], expect: { parts: ['done'], status: 'done' } },
    { name: 'a replace at its revision with other fields', parts: [part({ action: 'replace', doc: 'different', nonceSpent: true, claim: true })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'a replace at a later revision, nonce spent, claimed', parts: [part({ action: 'replace', doc: 'later', nonceSpent: true, claim: true })], expect: { parts: ['done'], status: 'done' } },
    { name: 'a replace at a later revision, nonce spent, no claim', parts: [part({ action: 'replace', doc: 'later', nonceSpent: true })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'a replace at a later revision, nonce free', parts: [part({ action: 'replace', doc: 'later', claim: true })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'a delete: gone, nonce spent, claimed', parts: [part({ action: 'delete', doc: 'absent', nonceSpent: true, claim: true })], expect: { parts: ['done'], status: 'done' } },
    { name: 'a delete: gone, nonce spent, no claim', parts: [part({ action: 'delete', doc: 'absent', nonceSpent: true })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'a delete: gone, nonce free (someone else deleted it)', parts: [part({ action: 'delete', doc: 'absent', claim: true })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'a delete waiting to land', parts: [part({ action: 'delete', doc: 'present' })], expect: { parts: ['ready'], status: 'ready' } },
    { name: 'a delete: still there, nonce spent', parts: [part({ action: 'delete', doc: 'present', nonceSpent: true, claim: true })], expect: { parts: ['expired'], status: 'expired' } },
    { name: 'first part done, second waiting', parts: [part({ doc: 'same', nonceSpent: true }), part({ shares: 1 })], expect: { parts: ['done', 'collecting'], status: 'collecting' } },
    { name: 'first part done, second overtaken', parts: [part({ doc: 'same', nonceSpent: true }), part({ nonceSpent: true })], expect: { parts: ['done', 'expired'], status: 'expired' } },
    { name: 'declined: 2 of 3 declined', declined: 2, parts: [part({ shares: 1 })], expect: { parts: ['collecting'], status: 'declined', text: 'Declined: too many members declined it to reach 2 of 3.' } },
    { name: 'one decline still reaches 2 of 3', declined: 1, parts: [part({ shares: 1 })], expect: { parts: ['collecting'], status: 'collecting' } },
    { name: 'declined before expired', declined: 2, parts: [part({ shares: 0, nonceSpent: true })], expect: { parts: ['expired'], status: 'declined', text: 'Declined: too many members declined it to reach 2 of 3.' } },
    { name: 'a ready part is never declined', declined: 2, parts: [part({}), part({ shares: 1 })], expect: { parts: ['ready', 'collecting'], status: 'collecting' } },
    { name: 'invalid wins over declined', declined: 2, problems: ['it raises the fee'], parts: [part({ shares: 1 })], expect: { parts: ['collecting'], status: 'invalid', text: "Forge won't sign this: it raises the fee." } },
    { name: 'invalid wins over done', problems: ['its parts are missing, repeated, or from different members', 'it raises the fee'], parts: [part({ doc: 'same', nonceSpent: true })], expect: { parts: ['done'], status: 'invalid', text: "Forge won't sign this: its parts are missing, repeated, or from different members; it raises the fee." } },
  ];

  return {
    description: 'Organizations on Platform (organizations design §10, §11), on the ceremony of dti-2of3.json. Generated by tools/org-vectors/gen.mjs (platform); shared by forge-core::org and forge-web/lib/org.',
    source,
    base: 'dti-2of3.json',
    network: NETWORK,
    orgId: ORG,
    room: ROOM,
    cid: CID,
    threshold: base.threshold,
    size: members.length,
    limits: { maxPart: MAX_PART, maxParts: MAX_PARTS, maxPayload: MAX_PAYLOAD, maxIdentitiesPerKey: MAX_PER_KEY },
    rules: {
      proofMessage: 'UTF-8 of "dash-forge/org-member/1\\n<network>\\n<org base58>\\n<$ownerId base58>", Ed25519 by authPub',
      sealedShare: 'orgShare.sealed: XChaCha20-Poly1305, key HKDF-SHA256(ikm = 64-byte BIP-39 seed, salt "dash-forge/org-share/1", info "<network>\\n<org base58>\\n<cid hex>", 32 bytes), plaintext the 32-byte big-endian secret share of the signing slot, stored nonce(24) || ciphertext || tag(16)',
      payload: 'canonical JSON of the envelope as UTF-8; fmt 1 = deflate-raw of it, one stream ending exactly at the payload end; parts of at most maxPart bytes; digest = SHA-256 of the whole stored payload; inflated at most maxPayload bytes. Writers use fmt 1 when it is shorter. A message copy counts at its last part\'s $createdAt.',
      shares: 'a member opens the orgShare of one of its bound identities whose cid is the signing ceremony, and checks the opened share against its public share',
      memberIdentities: 'an orgMember counts when org matches, authPub is a roster member and proof verifies for its $ownerId (checked before the cap); at most maxIdentitiesPerKey per authPub, earliest $createdAt (then $id) first; one identity may bind several keys (byOrg is org, $ownerId, authPub)',
      requestIds: 'every Forge request id is <group>-<first 16 hex of the proposer auth key>; a bare group resolves when exactly one proposer used it; a proposal without a Forge note is its own request, id = proposal id',
      status: 'invalid (structural or review problems) > declined > done (every part done or gone) > expired (any part expired) > ready (every part ready, done or gone) > collecting',
    },
    members,
    sealedShares: sealedCases,
    memberDocs,
    boundIdentities: bound,
    shareDocs,
    roster,
    messages: messageCases,
    reassembly,
    merge,
    requestIds,
    status: { threshold: base.threshold, size: members.length, partRules: 'doc: absent; present (delete: the document exists); same / different (create: at revision 1 with / without the part\'s fields; replace: at the part\'s revision with / without them); base (replace: at the revision it replaces); later (past the part\'s revision). expired: takenByOther (wins over everything below). landed: create or replace same, or later with nonce spent and a claim; delete absent with nonce spent and a claim. done: landed. gone: create, claim, nonce spent, doc absent. expired: nonce spent, a create whose document has other fields, a replace whose document is not at base, or a delete whose document is gone. ready: shares >= N. else collecting.', cases: statusCases },
  };
}

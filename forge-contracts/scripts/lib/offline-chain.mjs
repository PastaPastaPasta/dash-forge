// offline-chain.mjs — an in-memory stand-in for evo-sdk and the chain behind it, so the seed and
// verify scripts can run with no network (`seed-offline.mjs`).
//
// It judges the rules that need chain state, which rs-dpp cannot judge offline
// (forge-contracts/vectors/rc1/README.md, "What the vectors don't judge"):
//   * every `refersTo` and `ownerRefersTo`, with `findBy` and `where`, against the documents
//     written so far (40120);
//   * every `propertyConstraints` rule that reads a total (`countOf` / `sumOf`: dense,
//     c1..c6, lockGate, platformChunks, oneLive, atMost20), counting the new document (10422);
//   * every rule that reads the time (`$createdAt` / `$updatedAt`: notFuture), against the clock;
//   * `distinctFrom` (10419) and unique indices (40105);
//   * a delete: `canBeDeleted` (10404) and `deleteConstraints`.
// The JSON schema, `maxBytes`, `immutable` and every other rule are left to rs-dpp: `seed-offline.mjs`
// and `rc1-live.mjs --offline` write each document as an rc1 vector for `contract-validate --vectors`.
//
// Documents are created and replaced as the scripts call `documents.create` / `replace`. Reads
// (`query`, `count`, `ranked`, and the proved forms rc1-live.mjs and rc1-empty-aggregates.mjs read:
// `queryWithProof`, `countWithProof`, `sumWithProof`, `averageWithProof`, grouped or not) answer from the same store with `==`, `in` and
// range filters.

import { createHash } from 'node:crypto';

import { CONTRACTS, CONTRACT_OF, b58decode, b58encode, contractsIn, expectedRefusal, isConsensusCode } from './seed-io.mjs';

const IDENTIFIER = 'application/x.dash.dpp.identifier';
const SYSTEM_IDS = new Set(['$id', '$ownerId']);

/**
 * An identifier property: the RC1 byte array tagged with the identifier media type, or the
 * four-contract set's `type: "identifier"`.
 */
const identifierSchema = (s) => s?.contentMediaType === IDENTIFIER || s?.type === 'identifier';
/**
 * A byte-array property: RC1 `byteArray` (identifiers carry it too, so callers test `identifierSchema`
 * first), or the mainnet set's `type: "bytes"`.
 */
const bytesSchema = (s) => s?.byteArray === true || s?.type === 'bytes';

/** The default set: the three devnet contracts (`contracts/forge-*.json`). */
const DEFAULT_SET = { contracts: CONTRACTS, contractOf: CONTRACT_OF };

/** The schema lookups over one contract set (`{ contracts, contractOf }`, see `contractsIn`). */
function lookups({ contracts, contractOf }) {
  const schemaOf = (type) => contracts[contractOf[type]].documentSchemas[type];
  /** A property schema with its `$ref` into the contract's `schemaDefs` resolved. */
  const resolveRef = (type, s) => {
    const ref = s?.$ref;
    if (!ref) return s;
    return contracts[contractOf[type]].schemaDefs[ref.replace('#/$defs/', '')];
  };
  const propSchema = (type, prop) => resolveRef(type, schemaOf(type).properties?.[prop]);
  const isIdentifier = (type, prop) => SYSTEM_IDS.has(prop) || identifierSchema(propSchema(type, prop));
  const isBytes = (type, prop) => bytesSchema(propSchema(type, prop));
  return { schemaOf, resolveRef, propSchema, isIdentifier, isBytes };
}

/** Bytes as lowercase hex, so identifiers and hashes compare as plain strings. */
function normalize(v) {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}
const hexOfId = (b58) => b58decode(b58).toString('hex');
const get = (view, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), view);
const compare = (p, q) => (p < q ? -1 : p > q ? 1 : 0);
/** Whether a rule reads chain state the vectors cannot give it: a total (`countOf` / `sumOf`) or the time. */
export const readsChainState = (expr) => /"(countOf|sumOf|\$createdAt|\$updatedAt)"/.test(JSON.stringify(expr));

/**
 * A document's data in the rc1 vector notation: identifiers as base58 `$id`, other bytes as `$hex`.
 * `set` is the contract set the type is in (the default devnet set, or `chain.set`).
 */
export function vectorDoc(type, data, set = DEFAULT_SET) {
  const { resolveRef, propSchema } = lookups(set);
  const enc = (schema, v) => {
    if (v instanceof Uint8Array) {
      return identifierSchema(schema) ? { $id: b58encode(v) } : { $hex: Buffer.from(v).toString('hex') };
    }
    if (Array.isArray(v)) return v.map((x) => enc(resolveRef(type, schema?.items), x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(resolveRef(type, schema?.properties?.[k]), x)]));
    return v;
  };
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(propSchema(type, k), v)]));
}

class Refusal extends Error {
  constructor(code, rule, detail) {
    super(`${code} ${rule}: ${detail}`);
    this.name = 'Refusal';
    this.code = code;
    this.rule = rule;
  }
}

export class OfflineChain {
  /**
   * `contractsDir` names the set the chain runs: the three devnet contracts by default, or a
   * directory such as `contracts/mainnet` (four, with an id for forge-meta).
   */
  constructor({ contractsDir } = {}) {
    /** The contracts the chain holds, `{ contracts, contractOf }`. */
    this.set = contractsDir ? contractsIn(contractsDir) : DEFAULT_SET;
    this.lookup = lookups(this.set);
    /** The contract ids a deployment file names, by contract. */
    this.ids = Object.fromEntries(Object.keys(this.set.contracts).map((c) => [c, b58encode(createHash('sha256').update(`offline contract ${c}`).digest())]));
    this.docs = [];
    this.records = [];
    this.script = 'unnamed';
    this.height = 1;
    this.built = 0;
  }

  live(type) {
    return this.docs.filter((d) => d.type === type && !d.deleted);
  }

  contractName(contractId) {
    const name = Object.keys(this.ids).find((c) => this.ids[c] === contractId);
    if (!name) throw new Error(`no offline contract ${contractId}`);
    return name;
  }

  /** The type, checked to live in the contract the caller named. */
  typeIn(contractId, type) {
    const contract = this.contractName(contractId);
    const home = this.set.contractOf[type];
    if (home !== contract) throw new Error(`${type} is in forge-${home}, not forge-${contract}`);
    return type;
  }

  // --- the rules that read chain state ------------------------------------------------

  /**
   * Null when `ref` (a refersTo / ownerRefersTo) finds a live document for `value` from `view`,
   * else the chain's code: 40120 when none is found, 40127 when one is found but its `where`
   * disagrees. An `anyOf` fails with its last operand's code. Identities are not modelled: an
   * identity reference always holds here.
   */
  refError(ref, value, view) {
    if (ref.anyOf) {
      let code = null;
      for (const r of ref.anyOf) {
        code = this.refError(r, value, view);
        if (code === null) return null;
      }
      return code;
    }
    if (ref.type === 'identity' || ref.type === 'identityPublicKey') return null;
    const found = this.live(ref.documentType).filter((t) =>
      ref.findBy
        ? Object.entries(ref.findBy).every(([k, e]) => get(t.view, k) === (e === '.' ? value : get(view, e)))
        : t.view.$id === value,
    );
    if (found.length === 0) return 40120;
    // A `where` entry is a property of the referring document (a path), or on a four-contract set
    // a literal test on the found document's: { const }, { in: [..] } or { greaterThanOrEqual },
    // whose bound is a path or { const: <number> } (PV14 refuses a bare number at registration;
    // book refers-to.md "Conditions"). The chain reads a literal on an identifier as base58 and on
    // a byte array as hex, which this view (hex ids, hex bytes) does not reproduce, so a literal on
    // either stops the run rather than mismatching silently.
    const unmodelled = (e) => new Error(`offline chain: where ${JSON.stringify(e)} is not modelled`);
    const holds = (k, v, e) => {
      if (typeof e === 'string') return v === get(view, e);
      const prop = this.lookup.propSchema(ref.documentType, k);
      if (bytesSchema(prop) || this.lookup.isIdentifier(ref.documentType, k)) throw unmodelled(e);
      if ('const' in e) return v === e.const;
      if ('in' in e) return e.in.includes(v);
      if ('greaterThanOrEqual' in e) {
        const b = e.greaterThanOrEqual;
        if (typeof b === 'string') return v !== undefined && get(view, b) !== undefined && v >= get(view, b);
        if (b !== null && typeof b === 'object' && typeof b.const === 'number') return v !== undefined && v >= b.const;
      }
      throw unmodelled(e);
    };
    const agrees = (t) => Object.entries(ref.where ?? {}).every(([k, e]) => holds(k, get(t.view, k), e));
    return found.some(agrees) ? null : 40127;
  }

  /** Evaluate a rule-language expression (the operators the total-reading rules use). */
  evaluate(x, view, pool) {
    const ev = (y) => this.evaluate(y, view, pool);
    if (typeof x === 'string') return get(view, x);
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return x;
    const [op, arg] = Object.entries(x)[0];
    const matches = (t, filter) => Object.entries(filter).every(([k, e]) => get(t.view, k) === get(view, e));
    const nums = () => arg.map(ev);
    switch (op) {
      case 'const': return arg;
      case 'present': return get(view, arg) !== undefined;
      case 'absent': return get(view, arg) === undefined;
      case 'count': {
        // A byte array is held as hex: two characters a byte.
        const v = get(view, arg);
        if (v === undefined) return 0;
        return typeof v === 'string' ? v.length / 2 : v.length;
      }
      case 'countOf': return pool(arg[0]).filter((t) => matches(t, arg[1])).length;
      case 'sumOf': return pool(arg[0]).filter((t) => matches(t, arg[2])).reduce((s, t) => s + (get(t.view, arg[1]) ?? 0), 0);
      case 'add': return nums().reduce((p, q) => p + q);
      case 'subtract': { const [p, q] = nums(); return p - q; }
      case 'multiply': return nums().reduce((p, q) => p * q);
      // rs-dpp divides and takes remainders the Euclidean way (checked_div_euclid / rem_euclid)
      case 'divide': { const [p, q] = nums(); return Math.floor(p / q) + (q < 0 && p % q !== 0 ? 1 : 0); }
      case 'modulo': { const [p, q] = nums(); return ((p % q) + Math.abs(q)) % Math.abs(q); }
      case 'min': return Math.min(...nums());
      case 'max': return Math.max(...nums());
      case 'ifAbsent': return get(view, arg[0]) ?? ev(arg[1]);
      case 'equal': { const [p, q] = nums(); return p === q; }
      case 'notEqual': { const [p, q] = nums(); return p !== q; }
      case 'lessThan': { const [p, q] = nums(); return p < q; }
      case 'lessThanOrEqual': { const [p, q] = nums(); return p <= q; }
      case 'greaterThan': { const [p, q] = nums(); return p > q; }
      case 'greaterThanOrEqual': { const [p, q] = nums(); return p >= q; }
      case 'in': return arg[1].includes(ev(arg[0]));
      case 'notIn': return !arg[1].includes(ev(arg[0]));
      case 'anyOf': return arg.some(ev);
      case 'allOf': return arg.every(ev);
      case 'not': return !ev(arg);
      case 'ifThen': return !ev(arg[0]) || ev(arg[1]);
      case 'ifThenElse': return ev(arg[0]) ? ev(arg[1]) : ev(arg[2]);
      default: throw new Error(`offline chain: rule operator ${op} is not modelled`);
    }
  }

  /**
   * The first chain-state rule `doc` breaks, as a Refusal, or null. The checks run in the
   * chain's order: the rules (by name), distinctFrom, unique indices, ownerRefersTo, then each
   * property's references. `replacing` is the stored document a replace writes over: it is not
   * counted beside its new revision.
   */
  judge(doc, replacing = undefined) {
    const { type, view } = doc;
    const schema = this.lookup.schemaOf(type);
    const others = (t) => this.live(t).filter((d) => d !== replacing);
    const pool = (t) => [...others(t), ...(t === type ? [doc] : [])];
    for (const [rule, expr] of Object.entries(schema.propertyConstraints ?? {}).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) {
      // (rs-dpp judges the rest offline; a total or the time needs the chain)
      if (!readsChainState(expr)) continue;
      if (!this.evaluate(expr, view, pool)) return new Refusal(10422, rule, `${type} breaks ${rule}`);
    }
    const props = Object.entries(schema.properties ?? {})
      .map(([prop, raw]) => [prop, this.lookup.resolveRef(type, raw)])
      .filter(([prop]) => view[prop] !== undefined);
    for (const [prop, s] of props) {
      if (s.distinctFrom && view[prop] === get(view, s.distinctFrom)) return new Refusal(10419, `${type}.${prop}`, `must differ from ${s.distinctFrom}`);
    }
    for (const index of schema.indices ?? []) {
      if (!index.unique) continue;
      const keys = index.properties.map((p) => Object.keys(p)[0]);
      if (keys.some((k) => get(view, k) === undefined)) continue;
      if (others(type).some((t) => keys.every((k) => get(t.view, k) === get(view, k)))) {
        return new Refusal(40105, `${type}.${index.name}`, 'a document with these values exists');
      }
    }
    if (schema.ownerRefersTo) {
      const code = this.refError(schema.ownerRefersTo, view.$ownerId, view);
      if (code) return new Refusal(code, `${type}.ownerRefersTo`, 'the signer holds none of the documents it needs');
    }
    for (const [prop, s] of props) {
      const ref = s.refersTo ?? s.items?.refersTo;
      if (!ref) continue;
      for (const v of s.refersTo ? [view[prop]] : view[prop]) {
        const code = this.refError(ref, v, view);
        if (code) return new Refusal(code, `${type}.${prop}`, `refers to no ${JSON.stringify(ref.documentType ?? ref.anyOf?.map((r) => r.documentType))} that agrees`);
      }
    }
    return null;
  }

  // --- the SDK surface the scripts use -------------------------------------------------

  create({ document }) {
    const { type: t, contractId, owner } = document.meta;
    const type = this.typeIn(contractId, t);
    const id = document.meta.id;
    const height = this.height++;
    const view = {
      ...normalize(document.data),
      $id: hexOfId(id),
      $ownerId: hexOfId(owner),
      $revision: 1,
      $createdAt: Date.now(),
      $updatedAt: Date.now(),
      $createdAtBlockHeight: height,
      $updatedAtBlockHeight: height,
    };
    const doc = { id, type, contractId, owner, data: document.data, view, revision: 1, seq: this.docs.length };
    const why = expectedRefusal();
    const refusal = this.judge(doc);
    this.records.push({ script: this.script, type, owner, data: document.data, why, refusal });
    if (refusal) throw refusal;
    // A refusal by a rule rs-dpp judges (a schema keyword or a rule name) is checked by
    // contract-validate on the exported vector; here the write simply does not land.
    if (why && !isConsensusCode(why)) throw new Refusal('offline', why, 'left to rs-dpp (contract-validate --vectors)');
    this.docs.push(doc);
    return this.view(doc);
  }

  /**
   * A replace of a stored document by its owner, as the next revision: the chain-state rules are
   * judged on the new data (`immutable` is rs-dpp's, judged on a replace vector).
   */
  replace({ document }) {
    const id = document.id?.toBase58?.() ?? document.meta?.id;
    const doc = this.docs.find((d) => d.id === id && !d.deleted);
    if (!doc) throw new Refusal(40101, 'replace', `no document ${id} to replace`);
    if (document.meta.owner !== doc.owner) throw new Refusal(40102, 'replace', 'only the owner replaces a document');
    const revision = doc.revision + 1;
    if (document.revision !== undefined && Number(document.revision) !== revision) throw new Refusal(40103, 'replace', `revision ${document.revision}, expected ${revision}`);
    const height = this.height++;
    const next = { ...doc, data: document.data, revision, view: { ...doc.view, ...normalize(document.data), $revision: revision, $updatedAt: Date.now(), $updatedAtBlockHeight: height } };
    for (const k of Object.keys(doc.data)) if (!(k in document.data)) delete next.view[k];
    const refusal = this.judge({ ...next, view: next.view }, doc);
    if (refusal) throw refusal;
    Object.assign(doc, next);
    return this.view(doc);
  }

  /** A delete by the owner: refused when the type cannot be deleted (10404) or a `deleteConstraints` rule fails. */
  delete({ document }) {
    const id = document.id?.toBase58?.() ?? document.id;
    const doc = this.docs.find((d) => d.id === id && !d.deleted);
    if (!doc) throw new Refusal(40101, 'delete', `no document ${id} to delete`);
    const schema = this.lookup.schemaOf(doc.type);
    if (schema.canBeDeleted === false) throw new Refusal(10404, `${doc.type}.canBeDeleted`, `a ${doc.type} can not be deleted`);
    for (const [rule, expr] of Object.entries(schema.deleteConstraints ?? {})) {
      if (!this.evaluate(expr, doc.view, (t) => this.live(t))) throw new Refusal('deleteConstraints', rule, `this ${doc.type} can not be deleted`);
    }
    doc.deleted = true;
  }

  view(doc) {
    const json = () => {
      const out = { $id: doc.id, $ownerId: doc.owner, $createdAt: doc.view.$createdAt };
      for (const [k, v] of Object.entries(doc.data)) {
        out[k] = v instanceof Uint8Array ? (this.lookup.isIdentifier(doc.type, k) ? b58encode(v) : Buffer.from(v).toString('base64')) : v;
      }
      return out;
    };
    // As evo-sdk's Document#toObject: the data with bytes as bytes, and what Document.fromObject
    // needs to rebuild it as the next revision (`$revision`)
    // (a snapshot: a later replace does not change a document already read)
    const { data, revision } = doc;
    const object = () => ({ __meta: { type: doc.type, contractId: doc.contractId, owner: doc.owner, id: doc.id }, ...data, $revision: BigInt(revision) });
    return { id: { toBase58: () => doc.id }, toJSON: json, toObject: object };
  }

  /**
   * A query operand as the chain stores it: an identifier from base58, a byte array from base64
   * (or base58, which the SDK takes for a 32-byte field too: the one that gives the field's size).
   */
  operand(type, f, v) {
    if (this.lookup.isIdentifier(type, f)) return hexOfId(v);
    if (!this.lookup.isBytes(type, f)) return v;
    if (typeof v !== 'string') return Buffer.from(v).toString('hex');
    const s = this.lookup.propSchema(type, f);
    const size = s.size ?? (s.minItems === s.maxItems ? s.minItems : undefined);
    const b64 = Buffer.from(v, 'base64');
    if (size === undefined || b64.length === size) return b64.toString('hex');
    return b58decode(v).toString('hex');
  }

  select({ dataContractId, documentTypeName, where = [], orderBy = [], startAfter, limit }) {
    const type = this.typeIn(dataContractId, documentTypeName);
    const test = { '==': (p, q) => p === q, '>': (p, q) => p > q, '>=': (p, q) => p >= q, '<': (p, q) => p < q, '<=': (p, q) => p <= q };
    let rows = this.live(type).filter((d) =>
      where.every(([f, op, v]) => {
        const got = get(d.view, f);
        if (op === 'in') return v.map((x) => this.operand(type, f, x)).includes(got);
        if (!test[op]) throw new Error(`offline chain: where operator ${op} is not modelled`);
        return got !== undefined && test[op](got, this.operand(type, f, v));
      }),
    );
    for (const [f, dir] of [...orderBy].reverse()) {
      const key = (d) => (f === '$createdAt' ? d.seq : get(d.view, f));
      rows = [...rows].sort((p, q) => compare(key(p), key(q)) * (dir === 'desc' ? -1 : 1));
    }
    if (startAfter) rows = rows.slice(rows.findIndex((d) => d.id === startAfter) + 1);
    return limit ? rows.slice(0, limit) : rows;
  }

  /**
   * A proved aggregate's map: one entry per `groupBy` value (absent groups absent), keyed as the
   * node keys it (hex: an identifier's or byte array's bytes, an integer's big-endian bytes, one
   * byte below 256) in key order, or one entry for an ungrouped query. `value(rows)` folds a group.
   */
  aggregate(q, value) {
    const type = this.typeIn(q.dataContractId, q.documentTypeName);
    const rows = this.select({ ...q, orderBy: [], limit: undefined });
    const groups = new Map();
    const keyOf = (d) => (q.groupBy ?? []).map((f) => {
      const v = get(d.view, f);
      if (typeof v === 'number') return v < 256 ? v.toString(16).padStart(2, '0') : BigInt(v).toString(16).padStart(16, '0');
      return this.lookup.isIdentifier(type, f) || this.lookup.isBytes(type, f) ? v : Buffer.from(String(v)).toString('hex');
    }).join('');
    for (const d of rows) groups.set(keyOf(d), [...(groups.get(keyOf(d)) ?? []), d]);
    if ((q.groupBy ?? []).length === 0 && groups.size === 0) groups.set('', []);
    return new Map([...groups].sort(([p], [q]) => compare(p, q)).map(([k, g]) => [k, value(g)]));
  }

  /** The evo-sdk module stand-in: the classes and the `EvoSDK` the scripts construct. */
  evo() {
    const chain = this;
    class Document {
      // Like evo-sdk, a document's id is fixed when it is built, so a resubmission keeps it.
      constructor({ documentTypeName, dataContractId, ownerId }, id = b58encode(createHash('sha256').update(`offline doc ${chain.built++}`).digest())) {
        this.meta = { type: documentTypeName, contractId: dataContractId, owner: ownerId, id };
        this.id = { toBase58: () => id };
        this.data = {};
      }
      toObject() {
        return { __meta: this.meta, ...this.data, ...(this.revision !== undefined ? { $revision: this.revision } : {}) };
      }
      static fromObject({ __meta, $revision, ...data }) {
        const d = new Document({ documentTypeName: __meta.type, dataContractId: __meta.contractId, ownerId: __meta.owner }, __meta.id);
        d.data = data;
        d.revision = $revision;
        return d;
      }
    }
    const sum = (rows, prop) => rows.reduce((s, d) => s + BigInt(d.view[prop] ?? 0), 0n);
    const documents = {
      create: async (args) => chain.create(args),
      query: async (q) => new Map(chain.select(q).map((d) => [d.id, chain.view(d)])),
      count: async (q) => new Map([['count', BigInt(chain.select(q).length)]]),
      replace: async (args) => chain.replace(args),
      delete: async (args) => chain.delete(args),
      queryWithProof: async (q) => ({ data: new Map(chain.select(q).map((d) => [d.id, chain.view(d)])) }),
      countWithProof: async (q) => ({ data: chain.aggregate(q, (g) => BigInt(g.length)) }),
      sumWithProof: async (q, prop) => ({ data: chain.aggregate(q, (g) => sum(g, prop)) }),
      averageWithProof: async (q, prop) => ({ data: chain.aggregate(q, (g) => ({ count: BigInt(g.length), sum: sum(g, prop) })) }),
      ranked: async ({ dataContractId, documentTypeName, groupBy }) => {
        const counts = new Map();
        for (const d of chain.select({ dataContractId, documentTypeName })) {
          const g = b58encode(Buffer.from(d.view[groupBy], 'hex'));
          counts.set(g, (counts.get(g) ?? 0n) + 1n);
        }
        const entries = [...counts].map(([groupValue, value]) => ({ groupValue, value }));
        return { entries: entries.sort((p, q) => compare(q.value, p.value)) };
      },
    };
    class EvoSDK {
      async connect() {}
      version() {
        return 14;
      }
      get documents() {
        return documents;
      }
      get contracts() {
        return { fetch: async (id) => ({ version: 1, schemas: chain.set.contracts[chain.contractName(id)].documentSchemas, getDocumentTypes: () => chain.set.contracts[chain.contractName(id)].documentSchemas }) };
      }
      /** Identities are not modelled: every balance is the same, so no fee is measured offline. */
      get identities() {
        return { balance: async () => 0n };
      }
    }
    class IdentityPublicKey {}
    class IdentitySigner {
      addKey() {}
    }
    const identifier = (b58) => ({ toBase58: () => b58, toBytes: () => new Uint8Array(b58decode(b58)) });
    const Identifier = { fromBase58: identifier, fromBytes: (bytes) => identifier(b58encode(Buffer.from(bytes))) };
    return { EvoSDK, Document, Identifier, IdentityPublicKey, IdentitySigner, PrivateKey: { fromWIF: () => ({}) } };
  }
}

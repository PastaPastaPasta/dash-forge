// offline-chain.mjs — an in-memory stand-in for evo-sdk and the chain behind it, so the seed and
// verify scripts can run with no network (`seed-offline.mjs`).
//
// It judges the rules that need chain state, which rs-dpp cannot judge offline
// (forge-contracts/vectors/rc1/README.md, "What the vectors don't judge"):
//   * every `refersTo` and `ownerRefersTo`, with `findBy` and `where`, against the documents
//     written so far (40120);
//   * every `propertyConstraints` rule that reads a total (`countOf` / `sumOf`: dense,
//     c1..c6, lockGate, platformChunks, oneLive, atMost20), counting the new document (10422);
//   * `distinctFrom` (10419) and unique indices (40105).
// The JSON schema, `maxBytes` and every other rule are left to rs-dpp: `seed-offline.mjs` writes
// each document as an rc1 vector for `contract-validate --vectors`.
//
// Documents are created as the scripts call `documents.create`. Reads (`query`, `count`,
// `ranked`) answer from the same store with `==` filters only.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONTRACT_OF, ROOT, b58decode, b58encode, expectedRefusal } from './seed-io.mjs';

const IDENTIFIER = 'application/x.dash.dpp.identifier';
const SYSTEM_IDS = new Set(['$id', '$ownerId']);

const contracts = Object.fromEntries(
  ['core', 'collab', 'community'].map((c) => [c, JSON.parse(readFileSync(join(ROOT, 'contracts', `forge-${c}.json`), 'utf8'))]),
);
const schemaOf = (type) => contracts[CONTRACT_OF[type]].documentSchemas[type];

/** A property schema with its `$ref` into the contract's `schemaDefs` resolved. */
function resolveRef(type, s) {
  const ref = s?.$ref;
  if (!ref) return s;
  return contracts[CONTRACT_OF[type]].schemaDefs[ref.replace('#/$defs/', '')];
}
const propSchema = (type, prop) => resolveRef(type, schemaOf(type).properties?.[prop]);
const isIdentifier = (type, prop) => SYSTEM_IDS.has(prop) || propSchema(type, prop)?.contentMediaType === IDENTIFIER;

/** Bytes as lowercase hex, so identifiers and hashes compare as plain strings. */
function normalize(v) {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}
const hexOfId = (b58) => b58decode(b58).toString('hex');
const get = (view, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), view);

/** A document's data in the rc1 vector notation: identifiers as base58 `$id`, other bytes as `$hex`. */
export function vectorDoc(type, data) {
  const enc = (schema, v) => {
    if (v instanceof Uint8Array) {
      return schema?.contentMediaType === IDENTIFIER ? { $id: b58encode(v) } : { $hex: Buffer.from(v).toString('hex') };
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
    this.code = code;
    this.rule = rule;
  }
}

export class OfflineChain {
  constructor() {
    /** The contract ids a deployment file names, by contract. */
    this.ids = Object.fromEntries(Object.keys(contracts).map((c) => [c, b58encode(createHash('sha256').update(`offline contract ${c}`).digest())]));
    this.docs = [];
    this.records = [];
    this.script = 'unnamed';
    this.height = 1;
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
    if (CONTRACT_OF[type] !== contract) throw new Error(`${type} is in forge-${CONTRACT_OF[type]}, not forge-${contract}`);
    return type;
  }

  // --- the rules that read chain state ------------------------------------------------

  /** Whether `ref` (a refersTo / ownerRefersTo) finds a live document for `value` from `view`. */
  refFound(ref, value, view) {
    if (ref.anyOf) return ref.anyOf.some((r) => this.refFound(r, value, view));
    if (ref.type === 'identity' || ref.type === 'identityPublicKey') return true;
    return this.live(ref.documentType).some((t) => {
      const found = ref.findBy
        ? Object.entries(ref.findBy).every(([k, e]) => get(t.view, k) === (e === '.' ? value : get(view, e)))
        : t.view.$id === value;
      return found && Object.entries(ref.where ?? {}).every(([k, e]) => get(t.view, k) === get(view, e));
    });
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
      case 'count': { const v = get(view, arg); return v === undefined ? 0 : typeof v === 'string' ? v.length / 2 : v.length; }
      case 'countOf': return pool(arg[0]).filter((t) => matches(t, arg[1])).length;
      case 'sumOf': return pool(arg[0]).filter((t) => matches(t, arg[2])).reduce((s, t) => s + (get(t.view, arg[1]) ?? 0), 0);
      case 'add': return nums().reduce((p, q) => p + q);
      case 'subtract': { const [p, q] = nums(); return p - q; }
      case 'multiply': return nums().reduce((p, q) => p * q);
      case 'divide': { const [p, q] = nums(); return Math.trunc(p / q); }
      case 'modulo': { const [p, q] = nums(); return p % q; }
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

  /** The first chain-state rule `doc` breaks, as a Refusal, or null. */
  judge(doc) {
    const { type, view } = doc;
    const schema = schemaOf(type);
    for (const [prop, raw] of Object.entries(schema.properties ?? {})) {
      const s = resolveRef(type, raw);
      const value = view[prop];
      if (value === undefined) continue;
      if (s.distinctFrom && value === get(view, s.distinctFrom)) return new Refusal(10419, `${type}.${prop}`, `must differ from ${s.distinctFrom}`);
      const refs = s.refersTo ? [value] : s.items?.refersTo ? value : [];
      const ref = s.refersTo ?? s.items?.refersTo;
      for (const v of refs) {
        if (!this.refFound(ref, v, view)) return new Refusal(40120, `${type}.${prop}`, `refers to no ${JSON.stringify(ref.documentType ?? ref.anyOf?.map((r) => r.documentType))}`);
      }
    }
    if (schema.ownerRefersTo && !this.refFound(schema.ownerRefersTo, view.$ownerId, view)) {
      return new Refusal(40120, `${type}.ownerRefersTo`, 'the signer holds none of the documents it needs');
    }
    for (const index of schema.indices ?? []) {
      if (!index.unique) continue;
      const keys = index.properties.map((p) => Object.keys(p)[0]);
      if (keys.some((k) => get(view, k) === undefined)) continue;
      if (this.live(type).some((t) => keys.every((k) => get(t.view, k) === get(view, k)))) {
        return new Refusal(40105, `${type}.${index.name}`, 'a document with these values exists');
      }
    }
    const pool = (t) => [...this.live(t), ...(t === type ? [doc] : [])];
    for (const [rule, expr] of Object.entries(schema.propertyConstraints ?? {})) {
      const text = JSON.stringify(expr);
      if (!text.includes('"countOf"') && !text.includes('"sumOf"')) continue;
      if (!this.evaluate(expr, view, pool)) return new Refusal(10422, rule, `${type} breaks ${rule}`);
    }
    return null;
  }

  // --- the SDK surface the scripts use -------------------------------------------------

  create({ document }) {
    const { type: t, contractId, owner } = document.meta;
    const type = this.typeIn(contractId, t);
    const id = b58encode(createHash('sha256').update(`offline doc ${this.docs.length} ${type} ${owner}`).digest());
    const height = this.height++;
    const view = {
      ...normalize(document.data),
      $id: hexOfId(id),
      $ownerId: hexOfId(owner),
      $createdAt: Date.now(),
      $updatedAt: Date.now(),
      $createdAtBlockHeight: height,
      $updatedAtBlockHeight: height,
    };
    const doc = { id, type, owner, data: document.data, view, seq: this.docs.length };
    const why = expectedRefusal();
    const refusal = this.judge(doc);
    this.records.push({ script: this.script, type, owner, data: document.data, why, refusal });
    if (refusal) throw refusal;
    // A refusal by a rule rs-dpp judges (a schema keyword or a rule name) is checked by
    // contract-validate on the exported vector; here the write simply does not land.
    if (why && !/^\d+$/.test(why)) throw new Refusal('offline', why, 'left to rs-dpp (contract-validate --vectors)');
    this.docs.push(doc);
    return this.view(doc);
  }

  view(doc) {
    const json = () => {
      const out = { $id: doc.id, $ownerId: doc.owner, $createdAt: doc.view.$createdAt };
      for (const [k, v] of Object.entries(doc.data)) {
        out[k] = v instanceof Uint8Array ? (isIdentifier(doc.type, k) ? b58encode(v) : Buffer.from(v).toString('base64')) : v;
      }
      return out;
    };
    return { id: { toBase58: () => doc.id }, toJSON: json };
  }

  select({ dataContractId, documentTypeName, where = [], orderBy = [], startAfter, limit }) {
    const type = this.typeIn(dataContractId, documentTypeName);
    const operand = (f, v) => {
      if (isIdentifier(type, f)) return hexOfId(v);
      if (propSchema(type, f)?.byteArray) return Buffer.from(v, 'base64').toString('hex');
      return v;
    };
    let rows = this.live(type).filter((d) =>
      where.every(([f, op, v]) => {
        if (op !== '==') throw new Error(`offline chain: where operator ${op} is not modelled`);
        return get(d.view, f) === operand(f, v);
      }),
    );
    for (const [f, dir] of [...orderBy].reverse()) {
      const key = (d) => (f === '$createdAt' ? d.seq : get(d.view, f));
      rows = [...rows].sort((p, q) => (key(p) < key(q) ? -1 : key(p) > key(q) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    if (startAfter) rows = rows.slice(rows.findIndex((d) => d.id === startAfter) + 1);
    return limit ? rows.slice(0, limit) : rows;
  }

  /** The evo-sdk module stand-in: the classes and the `EvoSDK` the scripts construct. */
  evo() {
    const chain = this;
    class Document {
      constructor({ documentTypeName, dataContractId, ownerId }) {
        this.meta = { type: documentTypeName, contractId: dataContractId, owner: ownerId };
        this.data = {};
      }
      toObject() {
        return { __meta: this.meta };
      }
      static fromObject({ __meta, ...data }) {
        const d = new Document({ documentTypeName: __meta.type, dataContractId: __meta.contractId, ownerId: __meta.owner });
        d.data = data;
        return d;
      }
    }
    const documents = {
      create: async (args) => chain.create(args),
      query: async (q) => new Map(chain.select(q).map((d) => [d.id, chain.view(d)])),
      count: async (q) => new Map([['count', BigInt(chain.select(q).length)]]),
      delete: async ({ document }) => {
        const id = document.id?.toBase58?.() ?? document.id;
        const doc = chain.docs.find((d) => d.id === id && !d.deleted);
        if (!doc) throw new Error(`offline chain: no document ${id} to delete`);
        if (schemaOf(doc.type).canBeDeleted === false) throw new Error(`offline chain: a ${doc.type} cannot be deleted`);
        doc.deleted = true;
      },
      ranked: async ({ dataContractId, documentTypeName, groupBy }) => {
        const counts = new Map();
        for (const d of chain.select({ dataContractId, documentTypeName })) {
          const g = b58encode(Buffer.from(d.view[groupBy], 'hex'));
          counts.set(g, (counts.get(g) ?? 0n) + 1n);
        }
        const entries = [...counts].map(([groupValue, value]) => ({ groupValue, value }));
        return { entries: entries.sort((p, q) => (q.value > p.value ? 1 : q.value < p.value ? -1 : 0)) };
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
        return { fetch: async (id) => ({ version: 1, getDocumentTypes: () => contracts[chain.contractName(id)].documentSchemas }) };
      }
    }
    class IdentityPublicKey {}
    class IdentitySigner {
      addKey() {}
    }
    return { EvoSDK, Document, IdentityPublicKey, IdentitySigner, PrivateKey: { fromWIF: () => ({}) } };
  }
}

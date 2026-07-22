// Query helpers for S0.8: resolve the byteArray query-operand encoding empirically,
// run queries, and extract refNameHash from result Documents.
import bs58 from 'bs58';
import { log } from './lib.mjs';

const FORMS = ['bytes', 'b64', 'arr', 'hex', 'b58'];

export function hashOperand(hex, form) {
  const buf = Buffer.from(hex, 'hex');
  switch (form) {
    case 'bytes': return new Uint8Array(buf);
    case 'b64': return buf.toString('base64');
    case 'arr': return Array.from(buf);
    case 'hex': return buf.toString('hex');
    case 'b58': return bs58.encode(buf);
    default: throw new Error(`unknown form ${form}`);
  }
}

// Normalize a returned refNameHash value (any shape) to hex.
export function toHex(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    // could be base64, hex, or base58
    if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
    try { const b = Buffer.from(v, 'base64'); if (b.length === 32) return b.toString('hex'); } catch { /* */ }
    try { const b = Buffer.from(bs58.decode(v)); if (b.length === 32) return b.toString('hex'); } catch { /* */ }
    return null;
  }
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (Array.isArray(v) && v.every((n) => typeof n === 'number')) return Buffer.from(v).toString('hex');
  return null;
}

export function docHashHex(doc) {
  let raw;
  try { raw = typeof doc?.toObject === 'function' ? doc.toObject() : doc; } catch { raw = doc; }
  const v = raw?.refNameHash;
  return toHex(v);
}

// Query and return the Document objects as an array (from the Map result).
export async function queryDocs(sdk, query) {
  const res = await sdk.documents.query(query);
  if (res instanceof Map) return [...res.values()].filter(Boolean);
  if (Array.isArray(res)) return res;
  return [];
}

// Find the operand form that makes an equality query on refNameHash return the doc(s).
export async function resolveForm(sdk, contractId, sampleHashHex) {
  for (const form of FORMS) {
    try {
      const docs = await queryDocs(sdk, {
        dataContractId: contractId,
        documentTypeName: 'refUpdate',
        where: [['refNameHash', '==', hashOperand(sampleHashHex, form)]],
        orderBy: [['refNameHash', 'asc'], ['$createdAt', 'asc']],
        limit: 5,
      });
      if (docs.length > 0) { log(`operand encoding resolved: '${form}' (== query returned ${docs.length})`); return form; }
      log(`  form '${form}': 0 rows`);
    } catch (e) {
      log(`  form '${form}': error ${e?.message || e}`);
    }
  }
  throw new Error('no working byteArray operand encoding found');
}

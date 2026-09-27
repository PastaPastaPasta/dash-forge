// DAPI Core client over gRPC-web (plain fetch, no extra dependencies).
//
// Every evonode serves `org.dash.platform.dapi.v0.Core` (dapi-grpc
// protos/core/v0/core.proto) next to Platform on its grpc-web port. Only the
// unary RPCs the mint needs are wrapped here:
//   broadcastTransaction  { bytes transaction = 1; bool allow_high_fees = 2; bool bypass_limits = 3 }
//                         -> { string transaction_id = 1 }
//   getTransaction        { string id = 1 }
//                         -> { bytes transaction = 1; bytes block_hash = 2; uint32 height = 3;
//                              uint32 confirmations = 4; bool is_instant_locked = 5; bool is_chain_locked = 6 }
//   getBestBlockHeight    {} -> { uint32 height = 1 }
// Core has no address-index RPC, so UTXO lookup stays with Insight or the
// local ledger (utxo-ledger.mjs).
import { concatBytes } from './bytes.mjs';

const SERVICE = 'org.dash.platform.dapi.v0.Core';
const CALL_TIMEOUT_MS = 20000;
const GRPC_NOT_FOUND = 5;
// Worth another node: CANCELLED, UNKNOWN, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE.
const RETRYABLE_STATUS = new Set([1, 2, 4, 8, 13, 14]);

export class DapiError extends Error {
  constructor(message, { code, node } = {}) {
    super(message);
    this.name = 'DapiError';
    this.code = code;
    this.node = node;
  }
}

// ---- minimal protobuf wire format ----
function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return new Uint8Array(out);
}

export function encodeField(field, value) {
  if (typeof value === 'string') value = new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return concatBytes(varint((field << 3) | 2), varint(value.length), value);
  if (typeof value === 'boolean') value = value ? 1 : 0;
  return concatBytes(varint(field << 3), varint(value));
}

/** Decode a flat message into { [field]: value } (varints as numbers, length-delimited as bytes). */
export function decodeMessage(buf) {
  const out = {};
  let i = 0;
  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated protobuf varint');
      const b = buf[i++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(readVarint());
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) out[field] = Number(readVarint());
    else if (wire === 2) {
      const len = Number(readVarint());
      if (i + len > buf.length) throw new Error('truncated protobuf field');
      out[field] = buf.slice(i, i + len);
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
  return out;
}

// ---- grpc-web framing ----
function frame(message) {
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(1, message.length);
  return concatBytes(header, message);
}

function parseTrailers(bytes) {
  const trailers = {};
  for (const line of new TextDecoder().decode(bytes).split('\r\n')) {
    const at = line.indexOf(':');
    if (at > 0) trailers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return trailers;
}

/** Split a grpc-web body into { message, trailers }. */
export function parseGrpcWebBody(body) {
  let message = new Uint8Array(0);
  let trailers = {};
  let i = 0;
  while (i + 5 <= body.length) {
    const flag = body[i];
    const len = new DataView(body.buffer, body.byteOffset + i + 1, 4).getUint32(0);
    const payload = body.slice(i + 5, i + 5 + len);
    if (flag & 0x80) trailers = { ...trailers, ...parseTrailers(payload) };
    else message = payload;
    i += 5 + len;
  }
  return { message, trailers };
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class DapiCoreClient {
  /** `addresses`: grpc-web base URLs (https://ip:1443). */
  constructor(addresses, { fetchImpl = fetch, timeoutMs = CALL_TIMEOUT_MS, maxNodes = 4 } = {}) {
    if (!addresses?.length) throw new Error('DAPI Core needs at least one node address');
    this.addresses = addresses;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxNodes = maxNodes;
  }

  async callNode(node, method, request) {
    let res;
    try {
      res = await this.fetch(`${node}/${SERVICE}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', accept: 'application/grpc-web+proto' },
        body: frame(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DapiError(`${method} to ${node} failed: ${err.message}`, { code: 14, node });
    }
    if (!res.ok) throw new DapiError(`${method} to ${node}: HTTP ${res.status}`, { code: 14, node });
    const { message, trailers } = parseGrpcWebBody(new Uint8Array(await res.arrayBuffer()));
    const status = Number(res.headers.get('grpc-status') ?? trailers['grpc-status'] ?? 0);
    if (status !== 0) {
      const detail = decodeURIComponent(res.headers.get('grpc-message') ?? trailers['grpc-message'] ?? '');
      throw new DapiError(`${method}: ${detail || `grpc status ${status}`}`, { code: status, node });
    }
    return decodeMessage(message);
  }

  /** Try up to `maxNodes` random nodes; only transport-level failures move on to the next node. */
  async call(method, request) {
    let lastError;
    for (const node of shuffle(this.addresses).slice(0, this.maxNodes)) {
      try {
        return await this.callNode(node, method, request);
      } catch (err) {
        lastError = err;
        if (!(err instanceof DapiError) || !RETRYABLE_STATUS.has(err.code)) throw err;
      }
    }
    throw lastError;
  }

  async getBestBlockHeight() {
    return (await this.call('getBestBlockHeight', new Uint8Array(0)))[1] ?? 0;
  }

  /** Broadcast raw tx bytes; returns the txid DAPI reports. */
  async broadcastTransaction(transactionBytes) {
    const res = await this.call('broadcastTransaction', encodeField(1, transactionBytes));
    return res[1] ? new TextDecoder().decode(res[1]) : undefined;
  }

  /**
   * Returns { transactionBytes, blockHash, height, confirmations, isInstantLocked,
   * isChainLocked, mined }, or null when no node knows the tx.
   */
  async getTransaction(txid) {
    let res;
    try {
      res = await this.call('getTransaction', encodeField(1, txid));
    } catch (err) {
      if (err instanceof DapiError && err.code === GRPC_NOT_FOUND) return null;
      throw err;
    }
    const blockHash = res[2] ?? new Uint8Array(0);
    const height = res[3] ?? 0;
    return {
      transactionBytes: res[1] ?? new Uint8Array(0),
      blockHash,
      height,
      confirmations: res[4] ?? 0,
      isInstantLocked: Boolean(res[5]),
      isChainLocked: Boolean(res[6]),
      mined: blockHash.length > 0 && height > 0,
    };
  }
}

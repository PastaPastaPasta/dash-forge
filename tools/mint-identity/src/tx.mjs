// Transaction serialization + asset-lock (type 8) + standard P2PKH builders and signing.
// Ported from mainnet-bridge src/transaction/{serialize,structures,builder,sighash}.ts + crypto/signing.ts.
import * as secp256k1 from '@noble/secp256k1';
import { concatBytes, hexToBytes, reverseBytes, base58CheckDecode } from './bytes.mjs';
import { hash160, hash256 } from './hash.mjs';

const TX_VERSION_ASSET_LOCK = 3;
const TX_TYPE_ASSET_LOCK = 8;
const TX_VERSION_STANDARD = 3;
const TX_TYPE_STANDARD = 0;
const SIGHASH_ALL = 0x01;

// ---- serialization primitives ----
export function serCompactSize(n) {
  if (n < 253) return new Uint8Array([n]);
  if (n < 0x10000) {
    const b = new Uint8Array(3);
    b[0] = 253;
    new DataView(b.buffer).setUint16(1, n, true);
    return b;
  }
  if (n < 0x100000000) {
    const b = new Uint8Array(5);
    b[0] = 254;
    new DataView(b.buffer).setUint32(1, n, true);
    return b;
  }
  const b = new Uint8Array(9);
  b[0] = 255;
  new DataView(b.buffer).setBigUint64(1, BigInt(n), true);
  return b;
}

export function serString(data) {
  return concatBytes(serCompactSize(data.length), data);
}

function serUint32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function serInt32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}

function serInt64(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return b;
}

function serByte(n) {
  return new Uint8Array([n & 0xff]);
}

// ---- structures ----
function serializeOutPoint(o) {
  return concatBytes(o.txid, serUint32(o.n));
}
function serializeTxIn(txin) {
  return concatBytes(serializeOutPoint(txin.prevout), serString(txin.scriptSig), serUint32(txin.sequence));
}
function serializeTxOut(txout) {
  return concatBytes(serInt64(txout.value), serString(txout.scriptPubKey));
}
function serializeAssetLockPayload(payload) {
  const parts = [serByte(payload.version), serCompactSize(payload.creditOutputs.length)];
  for (const o of payload.creditOutputs) parts.push(serializeTxOut(o));
  return concatBytes(...parts);
}

export function createP2PKHScript(pubKeyHash) {
  if (pubKeyHash.length !== 20) throw new Error('Public key hash must be 20 bytes');
  return new Uint8Array([0x76, 0xa9, 0x14, ...pubKeyHash, 0x88, 0xac]);
}
function createOpReturnScript() {
  return new Uint8Array([0x6a, 0x00]);
}

// P2PKH address -> scriptPubKey (for building standard outputs to arbitrary addresses).
export function addressToScript(address) {
  return createP2PKHScript(base58CheckDecode(address).slice(1));
}

// ---- transaction ----
export function serializeTransaction(tx) {
  const parts = [];
  const ver32bit = tx.version | (tx.txType << 16);
  parts.push(serInt32(ver32bit));
  parts.push(serCompactSize(tx.vin.length));
  for (const vin of tx.vin) parts.push(serializeTxIn(vin));
  parts.push(serCompactSize(tx.vout.length));
  for (const vout of tx.vout) parts.push(serializeTxOut(vout));
  parts.push(serUint32(tx.lockTime));
  if (tx.txType !== 0 && tx.extraPayload.length > 0) parts.push(serString(tx.extraPayload));
  return concatBytes(...parts);
}

export function calculateTxId(tx) {
  const hash = hash256(serializeTransaction(tx));
  return Array.from(reverseBytes(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function txInFromUtxo(utxo) {
  return {
    prevout: { txid: reverseBytes(hexToBytes(utxo.txid)), n: utxo.vout },
    scriptSig: new Uint8Array(0),
    sequence: 0xffffffff,
  };
}

// Type-8 asset-lock transaction (locks utxo minus fee to a credit output).
export function createAssetLockTransaction(utxo, assetLockPubKey, fee = 1000n) {
  const utxoAmount = BigInt(utxo.satoshis);
  const lockAmount = utxoAmount - fee;
  if (lockAmount <= 0n) throw new Error('Insufficient funds for asset lock');

  const vin = [txInFromUtxo(utxo)];
  const vout = [{ value: lockAmount, scriptPubKey: createOpReturnScript() }];
  const creditOutput = { value: lockAmount, scriptPubKey: createP2PKHScript(hash160(assetLockPubKey)) };
  const payload = { version: 1, creditOutputs: [creditOutput] };

  return {
    version: TX_VERSION_ASSET_LOCK,
    txType: TX_TYPE_ASSET_LOCK,
    vin,
    vout,
    lockTime: 0,
    extraPayload: serializeAssetLockPayload(payload),
  };
}

// Standard P2PKH spend: single input UTXO -> named outputs [{script, value}] + change.
// changeScript receives (utxo - sum(outputs) - fee).
export function createP2PKHTransaction(utxo, outputs, changeScript, fee = 10000n) {
  const utxoAmount = BigInt(utxo.satoshis);
  const outTotal = outputs.reduce((s, o) => s + BigInt(o.value), 0n);
  const change = utxoAmount - outTotal - fee;
  if (change < 0n) throw new Error('Insufficient funds for P2PKH transfer');

  const vout = outputs.map((o) => ({ value: BigInt(o.value), scriptPubKey: o.script }));
  if (change > 546n) vout.push({ value: change, scriptPubKey: changeScript });

  return {
    version: TX_VERSION_STANDARD,
    txType: TX_TYPE_STANDARD,
    vin: [txInFromUtxo(utxo)],
    vout,
    lockTime: 0,
    extraPayload: new Uint8Array(0),
  };
}

// ---- signing ----
function cloneTransaction(tx) {
  return {
    version: tx.version,
    txType: tx.txType,
    vin: tx.vin.map((v) => ({
      prevout: { txid: new Uint8Array(v.prevout.txid), n: v.prevout.n },
      scriptSig: new Uint8Array(v.scriptSig),
      sequence: v.sequence,
    })),
    vout: tx.vout.map((o) => ({ value: o.value, scriptPubKey: new Uint8Array(o.scriptPubKey) })),
    lockTime: tx.lockTime,
    extraPayload: new Uint8Array(tx.extraPayload),
  };
}

function signatureHash(tx, inputIndex, scriptCode, sighashType = SIGHASH_ALL) {
  const txCopy = cloneTransaction(tx);
  for (let i = 0; i < txCopy.vin.length; i++) txCopy.vin[i].scriptSig = new Uint8Array(0);
  txCopy.vin[inputIndex].scriptSig = scriptCode;
  const txBytes = serializeTransaction(txCopy);
  return hash256(concatBytes(txBytes, serUint32(sighashType)));
}

function derEncodeInteger(n) {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  if (bytes[0] >= 0x80) bytes.unshift(0x00);
  return new Uint8Array([0x02, bytes.length, ...bytes]);
}

function signatureToDER(r, s) {
  const rE = derEncodeInteger(r);
  const sE = derEncodeInteger(s);
  return concatBytes(new Uint8Array([0x30, rE.length + sE.length]), rE, sE);
}

async function signHash(hash, privateKey) {
  const sig = await secp256k1.signAsync(hash, privateKey, { lowS: true });
  return concatBytes(signatureToDER(sig.r, sig.s), new Uint8Array([SIGHASH_ALL]));
}

function createP2PKHScriptSig(signature, publicKey) {
  return concatBytes(new Uint8Array([signature.length]), signature, new Uint8Array([publicKey.length]), publicKey);
}

// Sign every input with the same key (all inputs P2PKH for the same address).
// utxos[i].scriptPubKey (hex) is used as the scriptCode.
export async function signTransaction(tx, utxos, privateKey, publicKey) {
  let signedTx = tx;
  for (let i = 0; i < tx.vin.length; i++) {
    const scriptCode = hexToBytes(utxos[i].scriptPubKey);
    const sighash = signatureHash(signedTx, i, scriptCode);
    const signature = await signHash(sighash, privateKey);
    const scriptSig = createP2PKHScriptSig(signature, publicKey);
    signedTx = {
      ...signedTx,
      vin: signedTx.vin.map((v, idx) => (idx === i ? { ...v, scriptSig } : v)),
    };
  }
  return signedTx;
}

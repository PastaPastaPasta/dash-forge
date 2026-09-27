// Offline tests for the Insight → DAPI Core fallback and the funding ledger:
// node --test. Insight and DAPI are fakes; nothing touches the network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveNetwork } from '../src/config.mjs';
import { fundFromKey, loadFundingKey, FUNDING_WIF_ENV } from '../src/funding.mjs';
import { ChainClient, resetInsightHealth } from '../src/chain.mjs';
import { InsightClient } from '../src/insight.mjs';
import { DapiCoreClient, encodeField, decodeMessage, parseGrpcWebBody } from '../src/dapi-core.mjs';
import { waitForDeposit } from '../src/deposit.mjs';
import { waitForTxHeight } from '../src/lock.mjs';
import { withLedger, defaultLedgerPath } from '../src/utxo-ledger.mjs';
import { addressToScript, createP2PKHTransaction, parseTransactionOutputs, serializeTransaction, signTransaction, calculateTxId } from '../src/tx.mjs';
import { generateKeyPair, publicKeyToAddress } from '../src/keys.mjs';
import { bytesToHex, privateKeyToWif, concatBytes } from '../src/bytes.mjs';

const MOUTAI = resolveNetwork({ network: 'devnet', devnetName: 'moutai' });

beforeEach(() => resetInsightHealth());

function fundingKey() {
  const kp = generateKeyPair();
  return loadFundingKey(MOUTAI, { env: { [FUNDING_WIF_ENV]: privateKeyToWif(kp.privateKey, MOUTAI) } });
}

/** A signed tx paying `duffs` to `address` (vout 0) and `change` back to `key` (vout 1). */
async function fundingTx(key, address, duffs, change) {
  const fakePrev = { txid: 'ab'.repeat(32), vout: 0, satoshis: duffs + change + 2000, scriptPubKey: bytesToHex(addressToScript(key.address)) };
  const tx = createP2PKHTransaction([fakePrev], [{ script: addressToScript(address), value: BigInt(duffs) }], addressToScript(key.address), 2000n);
  const signed = await signTransaction(tx, [fakePrev], key.privateKey, key.publicKey);
  return { bytes: serializeTransaction(signed), txid: calculateTxId(signed) };
}

/** An Insight that answers every request with 503 "Back-end server is at capacity". */
function insight503() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response('Back-end server is at capacity', { status: 503, statusText: 'Service Unavailable' });
  };
  return { client: new InsightClient(MOUTAI, { fetchImpl }), calls };
}

/** An in-memory DAPI Core: known txs by id, a mempool, and a broadcast log. */
function fakeDapi({ reject } = {}) {
  const txs = new Map();
  const broadcasts = [];
  return {
    txs,
    broadcasts,
    add(bytes, { height = 0, chainLocked = false } = {}) {
      const { txid } = parseTransactionOutputs(bytes);
      txs.set(txid, { transactionBytes: bytes, height, confirmations: height ? 1 : 0, isInstantLocked: false, isChainLocked: chainLocked, mined: height > 0 });
      return txid;
    },
    async getTransaction(txid) {
      return txs.get(txid) ?? null;
    },
    async broadcastTransaction(bytes) {
      const err = reject?.(bytes);
      if (err) throw new Error(err);
      broadcasts.push(bytes);
      return this.add(bytes);
    },
    async getBestBlockHeight() {
      return 100;
    },
  };
}

test('Insight 503: fund-from-key broadcasts through DAPI Core and spends the ledger', async () => {
  const key = fundingKey();
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const ledgerPath = join(dir, 'funding.utxos.json');
  const dapi = fakeDapi();
  const insight = insight503();
  const chain = new ChainClient(MOUTAI, { insight: insight.client, dapi });

  // Seed: an earlier funding tx whose change (vout 1) belongs to the funding key.
  const seed = await fundingTx(key, publicKeyToAddress(generateKeyPair().publicKey, MOUTAI), 1_000_000, 500_000_000);
  dapi.add(seed.bytes, { height: 90, chainLocked: true });

  const recipient = publicKeyToAddress(generateKeyPair().publicKey, MOUTAI);
  const { txid, paid } = await fundFromKey(key, [{ address: recipient, duffs: 200_000_000 }], MOUTAI, () => {}, {
    chain,
    ledgerPath,
    bootstrapTxids: [seed.txid],
    utxoFetchAttempts: 1,
  });

  assert.ok(insight.calls.some((u) => u.includes('/utxo')), 'Insight was tried first');
  assert.equal(dapi.broadcasts.length, 1, 'broadcast went to DAPI');
  assert.equal(paid[0].txid, txid);
  assert.equal(paid[0].vout, 0);
  const out = parseTransactionOutputs(dapi.broadcasts[0]);
  assert.equal(out.outputs[0].satoshis, 200_000_000);

  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.equal(statSync(ledgerPath).mode & 0o777, 0o600);
  assert.deepEqual(
    ledger.utxos.map((u) => `${u.txid}:${u.vout}`),
    [`${txid}:1`],
    'the seed change is spent and the new change is recorded'
  );
  assert.equal(ledger.payments[recipient].txid, txid);
  assert.ok(!existsSync(`${ledgerPath}.lock`), 'lock released');
});

test('Insight 503: parallel fundings chain change outputs instead of double-spending', async () => {
  const key = fundingKey();
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'funding.utxos.json');
  const spent = new Set();
  // A node that refuses a second spend of the same outpoint, like Core does.
  const dapi = fakeDapi({
    reject: (bytes) => {
      const hex = bytesToHex(bytes);
      const prev = hex.slice(10, 10 + 72);
      if (spent.has(prev)) return 'bad-txns-inputs-missingorspent';
      spent.add(prev);
      return null;
    },
  });
  const seed = await fundingTx(key, publicKeyToAddress(generateKeyPair().publicKey, MOUTAI), 1_000_000, 1_000_000_000);
  dapi.add(seed.bytes, { height: 90 });
  const make = () => new ChainClient(MOUTAI, { insight: insight503().client, dapi });
  const opts = { ledgerPath, bootstrapTxids: [seed.txid], utxoFetchAttempts: 1 };

  const recipients = [0, 1, 2].map(() => publicKeyToAddress(generateKeyPair().publicKey, MOUTAI));
  const results = await Promise.all(
    recipients.map((address) => fundFromKey(key, [{ address, duffs: 100_000_000 }], MOUTAI, () => {}, { ...opts, chain: make() }))
  );
  assert.equal(new Set(results.map((r) => r.txid)).size, 3);
  assert.equal(dapi.broadcasts.length, 3, 'no broadcast was rejected: each spent the previous change');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.equal(ledger.utxos.length, 1);
  assert.ok(results.some((r) => ledger.utxos[0].txid === r.txid));
});

test('Insight 503 with an empty ledger fails with how to seed it (no silent hang)', async () => {
  const key = fundingKey();
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'funding.utxos.json');
  const chain = new ChainClient(MOUTAI, { insight: insight503().client, dapi: fakeDapi() });
  await assert.rejects(
    fundFromKey(key, [{ address: key.address, duffs: 1000 }], MOUTAI, () => {}, { chain, ledgerPath, bootstrapTxids: [], utxoFetchAttempts: 1 }),
    /FORGE_FUNDING_BOOTSTRAP_TXIDS/
  );
});

test('a spent ledger input is dropped and the next one is used', async () => {
  const key = fundingKey();
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'funding.utxos.json');
  const a = await fundingTx(key, publicKeyToAddress(generateKeyPair().publicKey, MOUTAI), 1_000_000, 300_000_000);
  const b = await fundingTx(key, publicKeyToAddress(generateKeyPair().publicKey, MOUTAI), 2_000_000, 300_000_000);
  const dapi = fakeDapi({ reject: (bytes) => (bytesToHex(bytes).includes(bytesToHex(Uint8Array.from(Buffer.from(a.txid, 'hex')).reverse())) ? 'Missing inputs' : null) });
  dapi.add(a.bytes, { height: 1 });
  dapi.add(b.bytes, { height: 1 });
  await withLedger(ledgerPath, key.address, async (l) => {
    l.addOutputsOf(a.bytes, bytesToHex(addressToScript(key.address)));
    l.addOutputsOf(b.bytes, bytesToHex(addressToScript(key.address)));
  });
  const chain = new ChainClient(MOUTAI, { insight: insight503().client, dapi });
  // Both inputs cover the payment alone; pin the random pick to the first (`a`), which the
  // node refuses as spent, so the retry must move to `b`.
  const random = Math.random;
  Math.random = () => 0;
  let result;
  try {
    result = await fundFromKey(key, [{ address: key.address, duffs: 100_000_000 }], MOUTAI, () => {}, { chain, ledgerPath, utxoFetchAttempts: 1 });
  } finally {
    Math.random = random;
  }
  assert.equal(dapi.broadcasts.length, 1);
  assert.ok(bytesToHex(dapi.broadcasts[0]).includes(bytesToHex(Uint8Array.from(Buffer.from(b.txid, 'hex')).reverse())), 'the retry spent b');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.ok(!ledger.utxos.some((u) => u.txid === a.txid), 'the spent input is gone from the ledger');
  assert.ok(ledger.utxos.some((u) => u.txid === result.txid), 'the new change is recorded');
});

test('a healthy Insight is still used first (no DAPI call)', async () => {
  const key = fundingKey();
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'funding.utxos.json');
  const utxo = { txid: 'cd'.repeat(32), vout: 3, satoshis: 900_000_000, scriptPubKey: bytesToHex(addressToScript(key.address)), confirmations: 500 };
  const posted = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/utxo')) return Response.json([utxo]);
    if (url.endsWith('/tx/send')) {
      posted.push(JSON.parse(init.body).rawtx);
      return Response.json({ txid: 'x' });
    }
    return new Response('nope', { status: 404 });
  };
  const dapi = fakeDapi({ reject: () => 'DAPI must not be used' });
  const chain = new ChainClient(MOUTAI, { insight: new InsightClient(MOUTAI, { fetchImpl }), dapi });
  await fundFromKey(key, [{ address: key.address, duffs: 1000_000 }], MOUTAI, () => {}, { chain, ledgerPath });
  assert.equal(posted.length, 1);
  assert.equal(dapi.broadcasts.length, 0);
});

test('Insight 503: the deposit is found from its known outpoint and the height from DAPI', async () => {
  const key = fundingKey();
  const deposit = publicKeyToAddress(generateKeyPair().publicKey, MOUTAI);
  const tx = await fundingTx(key, deposit, 150_000_000, 50_000_000);
  const dapi = fakeDapi();
  dapi.add(tx.bytes, { height: 4242, chainLocked: true });
  const chain = new ChainClient(MOUTAI, { insight: insight503().client, dapi });

  const utxo = await waitForDeposit(chain, deposit, 100_000_000, { known: { txid: tx.txid, vout: 0 }, timeoutMs: 1000, pollIntervalMs: 10 });
  assert.deepEqual({ txid: utxo.txid, vout: utxo.vout, satoshis: utxo.satoshis }, { txid: tx.txid, vout: 0, satoshis: 150_000_000 });
  assert.equal(await waitForTxHeight(MOUTAI, tx.txid, { chain, timeoutMs: 1000, pollMs: 10 }), 4242);
  assert.deepEqual(await chain.getRawTransactionBytes(tx.txid), tx.bytes);
});

test('an Insight 404 is not an outage: no DAPI fallback', async () => {
  const fetchImpl = async () => new Response('not found', { status: 404 });
  const dapi = fakeDapi();
  const chain = new ChainClient(MOUTAI, { insight: new InsightClient(MOUTAI, { fetchImpl }), dapi });
  await assert.rejects(chain.getTransaction('ee'.repeat(32)), /404/);
});

test('ledger path sits next to a key file, and FORGE_FUNDING_LEDGER overrides it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keys-'));
  const keyFile = join(dir, 'moutai-funding.wif');
  writeFileSync(keyFile, 'x');
  assert.equal(defaultLedgerPath({ keyFile, address: 'y1', env: {} }), join(dir, 'moutai-funding.utxos.json'));
  assert.equal(defaultLedgerPath({ keyFile, address: 'y1', env: { FORGE_FUNDING_LEDGER: '/l.json' } }), '/l.json');
  assert.match(defaultLedgerPath({ keyFile: '/dev/null', address: 'y1', env: { XDG_STATE_HOME: '/s' } }), /^\/s\/dash-forge\/funding-y1\.utxos\.json$/);
});

test('DAPI Core client speaks grpc-web: request framing, reply, trailers and NOT_FOUND', async () => {
  const seen = [];
  const frameOf = (flag, payload) => {
    const h = new Uint8Array(5);
    h[0] = flag;
    new DataView(h.buffer).setUint32(1, payload.length);
    return concatBytes(h, payload);
  };
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    if (url.endsWith('/getTransaction')) {
      const id = new TextDecoder().decode(decodeMessage(init.body.slice(5))[1]);
      if (id === 'missing') return new Response(new Uint8Array(0), { headers: { 'grpc-status': '5', 'grpc-message': 'Transaction%20not%20found' } });
      const msg = concatBytes(encodeField(1, Uint8Array.of(1, 2, 3)), encodeField(2, new Uint8Array(32).fill(7)), encodeField(3, 88830), encodeField(4, 2), encodeField(6, true));
      return new Response(concatBytes(frameOf(0, msg), frameOf(0x80, new TextEncoder().encode('grpc-status:0\r\n'))));
    }
    if (url.endsWith('/broadcastTransaction')) {
      return new Response(frameOf(0, encodeField(1, 'abcd')));
    }
    return new Response(frameOf(0, encodeField(1, 88830)));
  };
  const dapi = new DapiCoreClient(['https://n1:1443'], { fetchImpl });
  assert.equal(await dapi.getBestBlockHeight(), 88830);
  const tx = await dapi.getTransaction('ff'.repeat(32));
  assert.deepEqual([...tx.transactionBytes], [1, 2, 3]);
  assert.equal(tx.height, 88830);
  assert.equal(tx.isChainLocked, true);
  assert.equal(tx.mined, true);
  assert.equal(await dapi.getTransaction('missing'), null);
  assert.equal(await dapi.broadcastTransaction(Uint8Array.of(9, 9)), 'abcd');
  const b = seen.find((s) => s.url.endsWith('/broadcastTransaction'));
  assert.equal(b.url, 'https://n1:1443/org.dash.platform.dapi.v0.Core/broadcastTransaction');
  assert.equal(b.headers['content-type'], 'application/grpc-web+proto');
  assert.deepEqual([...decodeMessage(b.body.slice(5))[1]], [9, 9]);
  assert.deepEqual(parseGrpcWebBody(frameOf(0x80, new TextEncoder().encode('grpc-status: 14\r\n'))).trailers, { 'grpc-status': '14' });
});

test('DAPI Core client moves to the next node on UNAVAILABLE but not on a rejection', async () => {
  let n = 0;
  const unavailable = async () => {
    n++;
    return new Response(null, { status: 503 });
  };
  await assert.rejects(new DapiCoreClient(['https://a', 'https://b', 'https://c'], { fetchImpl: unavailable }).getBestBlockHeight(), /HTTP 503/);
  assert.equal(n, 3, 'all nodes tried');
  n = 0;
  const invalid = async () => {
    n++;
    return new Response(new Uint8Array(0), { headers: { 'grpc-status': '3', 'grpc-message': 'bad-txns-inputs-missingorspent' } });
  };
  await assert.rejects(new DapiCoreClient(['https://a', 'https://b'], { fetchImpl: invalid }).broadcastTransaction(Uint8Array.of(1)), /missingorspent/);
  assert.equal(n, 1, 'a node rejection is final');
});

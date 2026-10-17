// Offline tests for the funding maturity rule: non-coinbase outputs need 1
// confirmation, coinbase outputs 101. Insight is a fake; nothing touches the network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TESTNET, resolveNetwork } from '../src/config.mjs';
import { fundFromKey, loadFundingKey, selectFundingUtxos, FUNDING_WIF_ENV } from '../src/funding.mjs';
import { ChainClient, resetInsightHealth } from '../src/chain.mjs';
import { InsightClient } from '../src/insight.mjs';
import { FundingLedger } from '../src/utxo-ledger.mjs';
import { addressToScript, createP2PKHTransaction, parseTransactionOutputs, serializeTransaction, signTransaction, calculateTxId } from '../src/tx.mjs';
import { generateKeyPair, publicKeyToAddress } from '../src/keys.mjs';
import { bytesToHex, concatBytes, privateKeyToWif } from '../src/bytes.mjs';

beforeEach(() => resetInsightHealth());

const u = (i, satoshis, confirmations) => ({ txid: String(i).padStart(64, '0'), vout: 0, satoshis, confirmations, scriptPubKey: '' });

test('selectFundingUtxos: 1 confirmation is spendable, 0 is not', () => {
  assert.deepEqual(selectFundingUtxos([u(1, 10e8, 1)], 1e8, 1).inputs.map((x) => x.txid), [u(1).txid]);
  assert.throws(() => selectFundingUtxos([u(1, 10e8, 0)], 1e8, 1), /cannot cover/);
});

test('selectFundingUtxos: a network floor (devnet: 101) skips shallower outputs', () => {
  assert.throws(() => selectFundingUtxos([u(1, 10e8, 100)], 1e8, 1, { minConfirmations: 101 }), /cannot cover/);
  assert.equal(selectFundingUtxos([u(1, 10e8, 101)], 1e8, 1, { minConfirmations: 101 }).inputs.length, 1);
  assert.equal(resolveNetwork({ network: 'devnet', devnetName: 'moutai' }).minFundingConfirmations, 101);
  assert.equal(TESTNET.minFundingConfirmations, undefined);
});

function fundingKey() {
  const kp = generateKeyPair();
  return loadFundingKey(TESTNET, { env: { [FUNDING_WIF_ENV]: privateKeyToWif(kp.privateKey, TESTNET) } });
}

const le32 = (n) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
const le64 = (n) => concatBytes(le32(Number(BigInt(n) & 0xffffffffn)), le32(Number(BigInt(n) >> 32n)));

/** A raw coinbase tx paying `satoshis` to `address` at vout 0. */
function coinbaseTx(address, satoshis, height = 1) {
  const script = addressToScript(address);
  const sigScript = Uint8Array.of(1, height);
  return concatBytes(
    le32(1),
    Uint8Array.of(1),
    new Uint8Array(32),
    le32(0xffffffff),
    Uint8Array.of(sigScript.length),
    sigScript,
    le32(0xffffffff),
    Uint8Array.of(1),
    le64(satoshis),
    Uint8Array.of(script.length),
    script,
    le32(0)
  );
}

/** An ordinary signed tx paying `satoshis` to `address` at vout 0. */
async function paymentTx(key, address, satoshis) {
  const prev = { txid: 'ab'.repeat(32), vout: 0, satoshis: satoshis + 2000, scriptPubKey: bytesToHex(addressToScript(key.address)) };
  const tx = createP2PKHTransaction([prev], [{ script: addressToScript(address), value: BigInt(satoshis) }], addressToScript(key.address), 2000n);
  return serializeTransaction(await signTransaction(tx, [prev], key.privateKey, key.publicKey));
}

test('parseTransactionOutputs flags coinbase transactions only', async () => {
  const key = fundingKey();
  assert.equal(parseTransactionOutputs(coinbaseTx(key.address, 5e8)).isCoinbase, true);
  assert.equal(parseTransactionOutputs(await paymentTx(key, key.address, 5e8)).isCoinbase, false);
});

/** Fund 1 DASH from `entries` ({ bytes, confirmations }); resolves to the raw txs posted to Insight. */
async function fundFrom(key, entries) {
  const raws = new Map();
  const utxos = entries.map(({ bytes, confirmations }) => {
    const { txid, outputs } = parseTransactionOutputs(bytes);
    raws.set(txid, bytes);
    return { txid, vout: 0, satoshis: outputs[0].satoshis, scriptPubKey: outputs[0].scriptPubKey, confirmations };
  });
  const posted = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith(`/addr/${key.address}/utxo`)) return Response.json(utxos);
    const raw = url.match(/\/rawtx\/([0-9a-f]{64})$/);
    if (raw && raws.has(raw[1])) return Response.json({ rawtx: bytesToHex(raws.get(raw[1])) });
    if (url.endsWith('/tx/send')) {
      posted.push(JSON.parse(init.body).rawtx);
      return Response.json({ txid: 'x' });
    }
    return new Response('nope', { status: 404 });
  };
  const chain = new ChainClient(TESTNET, { insight: new InsightClient(TESTNET, { fetchImpl }), dapi: null });
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'funding.utxos.json');
  const recipient = publicKeyToAddress(generateKeyPair().publicKey, TESTNET);
  const run = () => fundFromKey(key, [{ address: recipient, duffs: 100_000_000 }], TESTNET, () => {}, { chain, ledgerPath, utxoFetchAttempts: 1, resendDelayMs: 1 });
  return { run, posted };
}

test('fundFromKey spends a non-coinbase output at 1 confirmation', async () => {
  const key = fundingKey();
  const { run, posted } = await fundFrom(key, [{ bytes: await paymentTx(key, key.address, 5e8), confirmations: 1 }]);
  await run();
  assert.equal(posted.length, 1);
});

test('fundFromKey does not spend an unconfirmed output', async () => {
  const key = fundingKey();
  const { run, posted } = await fundFrom(key, [{ bytes: await paymentTx(key, key.address, 5e8), confirmations: 0 }]);
  await assert.rejects(run(), /cannot cover/);
  assert.equal(posted.length, 0);
});

test('fundFromKey rejects a coinbase output at 100 confirmations', async () => {
  const key = fundingKey();
  const { run, posted } = await fundFrom(key, [{ bytes: coinbaseTx(key.address, 5e8), confirmations: 100 }]);
  await assert.rejects(run(), /cannot cover/);
  assert.equal(posted.length, 0);
});

test('fundFromKey accepts a coinbase output at 101 confirmations', async () => {
  const key = fundingKey();
  const { run, posted } = await fundFrom(key, [{ bytes: coinbaseTx(key.address, 5e8), confirmations: 101 }]);
  await run();
  assert.equal(posted.length, 1);
});

/** Run `fn` with Math.random pinned to 0, so the single-output pick is the first covering UTXO. */
async function withFirstPick(fn) {
  const random = Math.random;
  Math.random = () => 0;
  try {
    return await fn();
  } finally {
    Math.random = random;
  }
}

const reversedTxid = (bytes) => bytesToHex(Uint8Array.from(Buffer.from(parseTransactionOutputs(bytes).txid, 'hex')).reverse());

test('fundFromKey skips an immature coinbase and reselects a spendable output', async () => {
  const key = fundingKey();
  const payment = await paymentTx(key, key.address, 2e8);
  const immature = coinbaseTx(key.address, 50e8);
  // Both cover 1 DASH alone; the pick is pinned to the first, so the immature one is always tried first.
  const { run, posted } = await fundFrom(key, [
    { bytes: immature, confirmations: 3 },
    { bytes: payment, confirmations: 2 },
  ]);
  await withFirstPick(run);
  assert.equal(posted.length, 1);
  assert.ok(posted[0].includes(reversedTxid(payment)), 'the payment output was spent');
  assert.ok(!posted[0].includes(reversedTxid(immature)));
});

test('fundFromKey gives up after repeated immature coinbase picks, without broadcasting', async () => {
  const key = fundingKey();
  const entries = Array.from({ length: 8 }, (_, h) => ({ bytes: coinbaseTx(key.address, 5e8, h + 1), confirmations: 50 }));
  const { run, posted } = await fundFrom(key, entries);
  await assert.rejects(withFirstPick(run), /too many immature coinbase outputs/);
  assert.equal(posted.length, 0);
});

test('the cannot-cover error says when immature coinbase outputs were excluded', async () => {
  const key = fundingKey();
  const { run } = await fundFrom(key, [{ bytes: coinbaseTx(key.address, 5e8), confirmations: 100 }]);
  await assert.rejects(run(), /cannot cover.*1 immature coinbase output\(s\) excluded/);
});

test('the funding ledger refuses a coinbase transaction (bootstrap txids)', async () => {
  const key = fundingKey();
  const ledger = new FundingLedger(key.address);
  const script = bytesToHex(addressToScript(key.address));
  assert.throws(() => ledger.addOutputsOf(coinbaseTx(key.address, 5e8), script), /coinbase/);
  ledger.addOutputsOf(await paymentTx(key, key.address, 5e8), script);
  assert.equal(ledger.utxos.length, 1);
});

// Offline unit tests (no network): node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNetwork, networkFromName, TESTNET } from '../src/config.mjs';
import { parseFundingKeyText, loadFundingKey, selectFundingUtxos, FUNDING_WIF_ENV } from '../src/funding.mjs';
import { createP2PKHTransaction, addressToScript, signTransaction, serializeTransaction } from '../src/tx.mjs';
import { generateKeyPair, publicKeyToAddress } from '../src/keys.mjs';
import { privateKeyToWif, bytesToHex } from '../src/bytes.mjs';
import { createRole } from '../src/flow.mjs';

test('resolveNetwork: testnet default, moutai devnet, and bad combinations', () => {
  assert.equal(resolveNetwork({}), TESTNET);
  const moutai = resolveNetwork({ network: 'devnet', devnetName: 'moutai' });
  assert.equal(moutai.name, 'devnet-moutai');
  assert.equal(moutai.lockProof, 'chain');
  assert.equal(moutai.faucetBaseUrl, undefined);
  assert.deepEqual(
    { network: moutai.sdk.network, trusted: moutai.sdk.trusted, devnetName: moutai.sdk.devnetName },
    { network: 'devnet', trusted: true, devnetName: 'moutai' }
  );
  assert.equal(moutai.sdk.quorumUrl, 'https://quorums.moutai.networks.dash.org');
  assert.ok(moutai.sdk.addresses.every((a) => /^https:\/\/[\d.]+:1443$/.test(a)));
  assert.throws(() => resolveNetwork({ network: 'devnet' }), /--devnet-name/);
  assert.throws(() => resolveNetwork({ network: 'devnet', devnetName: 'nope' }), /Unknown devnet/);
  assert.throws(() => resolveNetwork({ network: 'testnet', devnetName: 'moutai' }), /only valid/);
  assert.throws(() => resolveNetwork({ network: 'mainnet' }), /Unsupported/);
});

test('networkFromName round-trips the name written into identity files', () => {
  assert.equal(networkFromName('testnet'), TESTNET);
  assert.equal(networkFromName(undefined), TESTNET);
  assert.equal(networkFromName('devnet-moutai').name, 'devnet-moutai');
  assert.throws(() => networkFromName('mainnet'), /Unsupported/);
});

test('devnet roles derive testnet-prefixed (y...) deposit addresses and the 5-key set incl. ENCRYPTION', () => {
  const role = createRole('X', resolveNetwork({ network: 'devnet', devnetName: 'moutai' }));
  assert.match(role.depositAddress, /^y/);
  assert.deepEqual(
    role.identityKeys.map((k) => `${k.id}:${k.purpose}/${k.securityLevel}`),
    ['0:AUTHENTICATION/MASTER', '1:AUTHENTICATION/HIGH', '2:AUTHENTICATION/CRITICAL', '3:TRANSFER/CRITICAL', '4:ENCRYPTION/MEDIUM']
  );
});

test('parseFundingKeyText reads a devnet YAML faucet_privkey or a bare WIF', () => {
  const wif = privateKeyToWif(generateKeyPair().privateKey, TESTNET);
  assert.equal(parseFundingKeyText(`faucet_address: yabc\nfaucet_privkey: ${wif}\nother: 1\n`), wif);
  assert.equal(parseFundingKeyText(`faucet_privkey: "${wif}"\n`), wif);
  assert.equal(parseFundingKeyText(`  ${wif}\n`), wif);
  assert.throws(() => parseFundingKeyText('faucet_address: yabc\n'), /neither/);
});

test('loadFundingKey from env checks the network prefix and derives the address', () => {
  const kp = generateKeyPair();
  const key = loadFundingKey(TESTNET, { env: { [FUNDING_WIF_ENV]: privateKeyToWif(kp.privateKey, TESTNET) } });
  assert.equal(key.address, publicKeyToAddress(kp.publicKey, TESTNET));
  const mainnetWif = privateKeyToWif(kp.privateKey, { wifPrefix: 204 });
  assert.throws(() => loadFundingKey(TESTNET, { env: { [FUNDING_WIF_ENV]: mainnetWif } }), /prefix/);
  assert.throws(() => loadFundingKey(TESTNET, { env: {} }), /--funding-key-file/);
});

test('loadFundingKey never echoes a key file path (a WIF pasted as the path must not leak)', () => {
  const wif = privateKeyToWif(generateKeyPair().privateKey, TESTNET);
  assert.throws(() => loadFundingKey(TESTNET, { keyFile: wif }), (err) => !err.message.includes(wif) && /takes a path/.test(err.message));
  const missing = '/nonexistent/secret-dir/key.txt';
  assert.throws(() => loadFundingKey(TESTNET, { keyFile: missing }), (err) => !err.message.includes(missing) && /ENOENT/.test(err.message));
});

const utxo = (i, satoshis, confirmations = 500) => ({ txid: String(i).padStart(64, '0'), vout: 0, satoshis, confirmations, scriptPubKey: '' });

test('selectFundingUtxos prefers one covering UTXO, skips immature and excluded ones', () => {
  const utxos = [utxo(1, 10e8, 5), utxo(2, 100e8), utxo(3, 1e8)];
  const { inputs, fee } = selectFundingUtxos(utxos, 50e8, 9);
  assert.deepEqual(inputs.map((u) => u.txid), [utxo(2).txid]);
  assert.ok(fee >= 2000);
  assert.throws(() => selectFundingUtxos(utxos, 50e8, 9, { exclude: new Set([`${utxo(2).txid}:0`]) }), /cannot cover/);
});

test('selectFundingUtxos accumulates the largest UTXOs when none covers alone', () => {
  const utxos = [utxo(1, 2e8), utxo(2, 3e8), utxo(3, 1e8)];
  const { inputs } = selectFundingUtxos(utxos, 4.5e8, 1);
  assert.deepEqual(inputs.map((u) => u.satoshis), [3e8, 2e8]);
});

test('createP2PKHTransaction spends several inputs and returns change', async () => {
  const kp = generateKeyPair();
  const addr = publicKeyToAddress(kp.publicKey, TESTNET);
  const script = bytesToHex(addressToScript(addr));
  const inputs = [utxo(1, 2e8), utxo(2, 3e8)].map((u) => ({ ...u, scriptPubKey: script }));
  const tx = createP2PKHTransaction(inputs, [{ script: addressToScript(addr), value: 4e8 }], addressToScript(addr), 1000n);
  assert.equal(tx.vin.length, 2);
  assert.deepEqual(tx.vout.map((o) => o.value), [400000000n, 99999000n]);
  const signed = await signTransaction(tx, inputs, kp.privateKey, kp.publicKey);
  assert.ok(signed.vin.every((v) => v.scriptSig.length > 100));
  assert.ok(serializeTransaction(signed).length > 300);
  await assert.rejects(signTransaction(tx, inputs.slice(0, 1), kp.privateKey, kp.publicKey), /2 inputs but 1 utxos/);
  // A single UTXO (the original call shape) still works.
  assert.equal(createP2PKHTransaction(inputs[0], [], addressToScript(addr), 1000n).vin.length, 1);
});

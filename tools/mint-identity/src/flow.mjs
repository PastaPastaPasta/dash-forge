// Mint orchestration primitives shared by the CLI subcommands.
import { generateNewMnemonic, deriveAssetLockKeyPair } from './hd.mjs';
import { generateDefaultIdentityKeysHD, publicKeyToAddress } from './keys.mjs';
import { privateKeyToWif, bytesToHex } from './bytes.mjs';
import {
  createAssetLockTransaction,
  createP2PKHTransaction,
  addressToScript,
  signTransaction,
  serializeTransaction,
  calculateTxId,
} from './tx.mjs';
import { InsightClient } from './insight.mjs';
import { waitForInstantSendLock } from './islock.mjs';
import * as platform from './platform.mjs';

const ASSET_LOCK_FEE = 1000n;
const MIN_ASSET_LOCK_DUFFS = 300000; // 0.003 tDASH network minimum for an asset lock.

/** Build a role: mnemonic (given or fresh), asset-lock (deposit) key + address, 5 identity keys. */
export function createRole(label, network, mnemonic = generateNewMnemonic(128)) {
  const { privateKey, publicKey } = deriveAssetLockKeyPair(mnemonic, network.name);
  const assetLockKeyPair = { privateKey, publicKey };
  const depositAddress = publicKeyToAddress(publicKey, network);
  const identityKeys = generateDefaultIdentityKeysHD(network, mnemonic);
  return { label, mnemonic, assetLockKeyPair, depositAddress, identityKeys, txid: undefined, identityId: undefined };
}

/**
 * Asset-lock a role's deposit UTXO and register its identity on Platform.
 * Mutates role.txid / role.identityId. Returns { identityId, balance }.
 */
export async function assetLockAndRegister(role, utxo, network, log) {
  const insight = new InsightClient(network);
  const { privateKey, publicKey } = role.assetLockKeyPair;

  log(`[${role.label}] Building asset-lock (type 8) tx from ${utxo.txid}:${utxo.vout} (${(utxo.satoshis / 1e8).toFixed(8)} tDASH)`);
  const tx = createAssetLockTransaction(utxo, publicKey, ASSET_LOCK_FEE);
  const signed = await signTransaction(tx, [utxo], privateKey, publicKey);
  const txBytes = serializeTransaction(signed);
  const txHex = bytesToHex(txBytes);
  const localTxid = calculateTxId(signed);

  log(`[${role.label}] Broadcasting asset-lock tx ${localTxid}...`);
  const txid = await insight.broadcastTransaction(txHex);
  role.txid = txid;
  log(`[${role.label}] Broadcast accepted: ${txid}`);

  log(`[${role.label}] Waiting for InstantSend lock (can take 30-90s)...`);
  const islockBytes = await waitForInstantSendLock(network.rpcUrl, txid, { timeoutMs: 150000, log });

  log(`[${role.label}] Registering identity on Platform...`);
  const { identityId, balance } = await platform.registerIdentity({
    transactionBytes: txBytes,
    instantLockBytes: islockBytes,
    outputIndex: 0,
    assetLockPrivateKeyWif: privateKeyToWif(privateKey, network),
    identityKeys: role.identityKeys,
    log,
  });
  role.identityId = identityId;
  return { identityId, balance };
}

/**
 * Top up an existing identity: asset-lock a funded UTXO controlled by
 * `assetLockKeyPair` and call identities.topUp.
 */
export async function assetLockAndTopUp({ identityId, assetLockKeyPair }, utxo, network, log) {
  const insight = new InsightClient(network);
  const { privateKey, publicKey } = assetLockKeyPair;

  log(`Building asset-lock tx for top-up from ${utxo.txid}:${utxo.vout}`);
  const tx = createAssetLockTransaction(utxo, publicKey, ASSET_LOCK_FEE);
  const signed = await signTransaction(tx, [utxo], privateKey, publicKey);
  const txBytes = serializeTransaction(signed);

  const txid = await insight.broadcastTransaction(bytesToHex(txBytes));
  log(`Broadcast accepted: ${txid}`);
  log('Waiting for InstantSend lock (can take 30-90s)...');
  const islockBytes = await waitForInstantSendLock(network.rpcUrl, txid, { timeoutMs: 150000, log });

  const balance = await platform.topUpIdentity({
    identityId,
    transactionBytes: txBytes,
    instantLockBytes: islockBytes,
    outputIndex: 0,
    assetLockPrivateKeyWif: privateKeyToWif(privateKey, network),
    log,
  });
  return { txid, balance };
}

/**
 * Fund N deposit addresses from a single funded source UTXO with one L1 P2PKH
 * transaction (used by the pool command to avoid the faucet rate limit).
 * Returns the broadcast txid; waits for its InstantSend lock so the outputs
 * are immediately spendable by the asset-lock txs that follow.
 */
export async function fanOutFunds({ sourceUtxo, sourceKeyPair, recipients, perRoleDuffs, changeAddress }, network, log) {
  const insight = new InsightClient(network);
  const { privateKey, publicKey } = sourceKeyPair;

  const outputs = recipients.map((addr) => ({ script: addressToScript(addr), value: BigInt(perRoleDuffs) }));
  const changeScript = addressToScript(changeAddress);

  log(`Fan-out: sending ${(perRoleDuffs / 1e8).toFixed(8)} tDASH to ${recipients.length} deposit addresses, change -> ${changeAddress}`);
  // Keep the absolute fee low: public testnet nodes enforce -maxtxfee, which the
  // faucet/asset-lock path clears at ~1000 duffs. A 1-in-N-out P2PKH is ~500 B, so
  // 2000 duffs sits comfortably above min-relay yet under the node's max-tx-fee wall.
  const tx = createP2PKHTransaction(sourceUtxo, outputs, changeScript, 2000n);
  const signed = await signTransaction(tx, [sourceUtxo], privateKey, publicKey);
  const txHex = bytesToHex(serializeTransaction(signed));

  const txid = await insight.broadcastTransaction(txHex);
  log(`Fan-out broadcast accepted: ${txid}`);
  log('Waiting for fan-out InstantSend lock so outputs are spendable...');
  await waitForInstantSendLock(network.rpcUrl, txid, { timeoutMs: 150000, log });
  return txid;
}

export { MIN_ASSET_LOCK_DUFFS };

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
import { obtainAssetLock, waitForFundingTx } from './lock.mjs';
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
 * Build, sign and broadcast a type-8 asset-lock tx spending `utxo`.
 * Returns { txid, transactionBytes }.
 */
export async function broadcastAssetLock({ utxo, assetLockKeyPair, tag = '' }, network, log) {
  const insight = new InsightClient(network);
  const { privateKey, publicKey } = assetLockKeyPair;

  log(`${tag}Building asset-lock (type 8) tx from ${utxo.txid}:${utxo.vout} (${(utxo.satoshis / 1e8).toFixed(8)} DASH)`);
  const tx = createAssetLockTransaction(utxo, publicKey, ASSET_LOCK_FEE);
  const signed = await signTransaction(tx, [utxo], privateKey, publicKey);
  const transactionBytes = serializeTransaction(signed);

  const txid = calculateTxId(signed);
  log(`${tag}Broadcasting asset-lock tx ${txid}...`);
  try {
    await insight.broadcastTransaction(bytesToHex(transactionBytes));
  } catch (err) {
    // A lost response can hide an accepted broadcast; don't strand the deposit over it.
    if (!(await insight.getTransaction(txid).then(() => true, () => false))) throw err;
    log(`${tag}${txid} is known to the network despite the error (${err.message})`);
  }
  log(`${tag}Broadcast accepted: ${txid}`);
  return { txid, transactionBytes };
}

/**
 * Register the identity for a role whose asset-lock tx (role.txid) is already
 * broadcast: wait for its lock, then create the identity — unless an earlier,
 * interrupted run already did. `transactionBytes` is refetched from Insight
 * when not given (a resumed run). Mutates role.identityId.
 */
export async function registerRoleFromLockTx(role, network, log, transactionBytes) {
  const tag = `[${role.label}] `;
  const bytes = transactionBytes ?? (await new InsightClient(network).getRawTransactionBytes(role.txid));
  const lock = await obtainAssetLock(network, { txid: role.txid, transactionBytes: bytes, log });

  const expectedId = platform.identityIdFromLock(lock);
  const existing = await platform.getBalanceOrNull(network, expectedId, log);
  if (existing !== null) {
    log(`${tag}Identity ${expectedId} is already registered (balance ${existing}); not creating it again.`);
    role.identityId = expectedId;
    return { identityId: expectedId, balance: existing };
  }

  log(`${tag}Registering identity on Platform...`);
  const { identityId, balance } = await platform.registerIdentity({
    network,
    lock,
    assetLockPrivateKeyWif: privateKeyToWif(role.assetLockKeyPair.privateKey, network),
    identityKeys: role.identityKeys,
    log,
  });
  role.identityId = identityId;
  return { identityId, balance };
}

/**
 * Asset-lock a role's deposit UTXO and register its identity on Platform.
 * Mutates role.txid / role.identityId. Returns { identityId, balance }.
 * `onBroadcast(role)` runs once the asset-lock txid is known (to persist it).
 */
export async function assetLockAndRegister(role, utxo, network, log, onBroadcast = () => {}) {
  const { txid, transactionBytes } = await broadcastAssetLock(
    { utxo, assetLockKeyPair: role.assetLockKeyPair, tag: `[${role.label}] ` },
    network,
    log
  );
  role.txid = txid;
  onBroadcast(role);
  return registerRoleFromLockTx(role, network, log, transactionBytes);
}

/**
 * Top up an existing identity: asset-lock a funded UTXO controlled by
 * `assetLockKeyPair` and call identities.topUp. With `utxo` null, resume from
 * an asset-lock tx already broadcast (`resumeTxid`). `onBroadcast(txid)` runs
 * once the asset-lock txid is known (to persist it).
 */
export async function assetLockAndTopUp({ identityId, assetLockKeyPair, resumeTxid }, utxo, network, log, onBroadcast = () => {}) {
  let txid = resumeTxid;
  let transactionBytes;
  if (utxo) {
    ({ txid, transactionBytes } = await broadcastAssetLock({ utxo, assetLockKeyPair }, network, log));
    onBroadcast(txid);
  } else {
    log(`Resuming top-up from asset-lock tx ${txid}`);
    transactionBytes = await new InsightClient(network).getRawTransactionBytes(txid);
  }
  const lock = await obtainAssetLock(network, { txid, transactionBytes, log });
  try {
    const balance = await platform.topUpIdentity({
      network,
      identityId,
      lock,
      assetLockPrivateKeyWif: privateKeyToWif(assetLockKeyPair.privateKey, network),
      log,
    });
    return { txid, balance };
  } catch (err) {
    // Resuming after a top-up Platform already applied (the process died before
    // clearing its pending file): the one-time lock is spent, so we're done.
    if (utxo || !/already completely used/i.test(err?.message ?? '')) throw err;
    log(`Asset lock ${txid} was already consumed by an earlier run; treating the top-up as done.`);
    return { txid, balance: await platform.getBalance(network, identityId, log) };
  }
}

// Keep the fan-out fee low: public testnet nodes enforce -maxtxfee, which the
// faucet/asset-lock path clears at ~1000 duffs. A 1-in-N-out P2PKH is ~500 B, so
// 2000 duffs sits comfortably above min-relay yet under the node's max-tx-fee wall.
const FAN_OUT_FEE = 2000n;

/**
 * Fund N deposit addresses from a single funded source UTXO with one L1 P2PKH
 * transaction (used by the pool command to avoid the faucet rate limit).
 * Recipients get outputs 0..N-1 and the change (which must be big enough to
 * asset-lock) is output N. Returns the txid once its outputs are spendable.
 */
export async function fanOutFunds({ sourceUtxo, sourceKeyPair, recipients, perRoleDuffs, changeAddress }, network, log) {
  const insight = new InsightClient(network);
  const { privateKey, publicKey } = sourceKeyPair;

  const change = BigInt(sourceUtxo.satoshis) - BigInt(perRoleDuffs) * BigInt(recipients.length) - FAN_OUT_FEE;
  if (change < BigInt(MIN_ASSET_LOCK_DUFFS + 1000)) {
    throw new Error(`Fan-out change (${change} duffs) would be too small to asset-lock; lower --amount`);
  }
  const outputs = recipients.map((addr) => ({ script: addressToScript(addr), value: BigInt(perRoleDuffs) }));

  log(`Fan-out: sending ${(perRoleDuffs / 1e8).toFixed(8)} DASH to ${recipients.length} deposit addresses, change -> ${changeAddress}`);
  const tx = createP2PKHTransaction(sourceUtxo, outputs, addressToScript(changeAddress), FAN_OUT_FEE);
  const signed = await signTransaction(tx, [sourceUtxo], privateKey, publicKey);

  const txid = await insight.broadcastTransaction(bytesToHex(serializeTransaction(signed)));
  log(`Fan-out broadcast accepted: ${txid}`);
  await waitForFundingTx(network, txid, log);
  return txid;
}

export { MIN_ASSET_LOCK_DUFFS };

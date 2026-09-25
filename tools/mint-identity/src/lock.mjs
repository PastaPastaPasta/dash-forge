// Asset-lock proof data for a broadcast asset-lock (or any) transaction.
//
//   instant (testnet): the InstantSend lock, recovered by txid over JSON-RPC
//                      `getislocks` (see islock.mjs).
//   chain   (devnets, and testnet's fallback): no public getislocks endpoint
//                      exists on devnets, so wait for the tx to be mined and for
//                      Platform's chain-locked Core height to reach its block,
//                      then prove it with a ChainAssetLockProof at the tx's block
//                      height. Drive accepts that once
//                      tx height <= proof height <= its last committed core height.
import { InsightClient, sleep } from './insight.mjs';
import { waitForInstantSendLock } from './islock.mjs';
import * as platform from './platform.mjs';

const CHAIN_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const ISLOCK_TIMEOUT_MS = 150000;
const POLL_MS = 5000;

/** Wait until Insight reports `txid` mined; returns its block height. */
export async function waitForTxHeight(network, txid, { timeoutMs = CHAIN_LOCK_TIMEOUT_MS, log = () => {} } = {}) {
  const insight = new InsightClient(network);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tx = await insight.getTransaction(txid);
      if (tx.blockheight !== undefined) return tx.blockheight;
    } catch (err) {
      log(`  tx status poll error (${txid}): ${err.message}`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${txid} to be mined after ${timeoutMs}ms`);
}

/** Wait until Platform's chain-locked Core height is >= `height`. */
export async function waitForPlatformChainLock(network, height, { timeoutMs = CHAIN_LOCK_TIMEOUT_MS, log = () => {} } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      const clh = await platform.getCoreChainLockedHeight(network, log);
      if (clh !== undefined && clh >= height) return clh;
      if (clh !== last) log(`  Platform chain-locked core height ${clh}, waiting for ${height}`);
      last = clh;
    } catch (err) {
      log(`  Platform status poll error: ${err.message}`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for Platform to chain-lock core height ${height}`);
}

/**
 * Wait until `txid` is locked the way `network` proves locks. Returns the
 * lock data platform.buildAssetLockProof takes (outputIndex 0, the credit output).
 */
export async function obtainAssetLock(network, { txid, transactionBytes, log = () => {} }) {
  if (network.lockProof === 'instant') {
    log('Waiting for InstantSend lock (can take 30-90s)...');
    try {
      const instantLockBytes = await waitForInstantSendLock(network.rpcUrl, txid, { timeoutMs: ISLOCK_TIMEOUT_MS, log });
      return { type: 'instant', txid, transactionBytes, instantLockBytes, outputIndex: 0 };
    } catch (err) {
      // The tx is already broadcast; a chain-lock proof still spends it rather than stranding it.
      log(`InstantSend lock unavailable (${err.message}); falling back to a chain-lock proof.`);
    }
  }
  log(`Waiting for ${txid} to be mined and chain-locked on Platform (a few minutes)...`);
  const height = await waitForTxHeight(network, txid, { log });
  const clh = await waitForPlatformChainLock(network, height, { log });
  log(`${txid} mined at ${height}; Platform chain-locked height ${clh}`);
  return { type: 'chain', txid, coreChainLockedHeight: height, outputIndex: 0 };
}

/**
 * Wait until a plain funding tx's outputs can be spent by the asset-lock txs
 * that follow. Testnet waits for its InstantSend lock (as before) but carries
 * on if the islock endpoint fails: the lock only gates spendability, and an
 * asset lock may spend a mempool output. Devnets need no wait at all, since the
 * chain proof waits for both txs to be mined anyway.
 */
export async function waitForFundingTx(network, txid, log = () => {}) {
  if (network.lockProof === 'chain') return;
  log('Waiting for the funding tx InstantSend lock so outputs are spendable...');
  try {
    await waitForInstantSendLock(network.rpcUrl, txid, { timeoutMs: ISLOCK_TIMEOUT_MS, log });
  } catch (err) {
    log(`Funding tx InstantSend lock unavailable (${err.message}); continuing with the unlocked output.`);
  }
}

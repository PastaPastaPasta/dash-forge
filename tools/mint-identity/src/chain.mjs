// Core chain access for the mint: Insight first, DAPI Core (gRPC-web on the
// evonodes) when Insight is unavailable (5xx, 429, timeout, connection error).
//
// Insight is a single server; DAPI is every evonode. Broadcast and tx status
// work over either. Address UTXO lookup has no DAPI equivalent (Core keeps no
// address index), so getUTXOs stays Insight-only and callers fall back to the
// funding ledger (utxo-ledger.mjs) or to outpoints they recorded themselves.
import { bytesToHex, hexToBytes } from './bytes.mjs';
import { InsightClient, InsightError } from './insight.mjs';
import { DapiCoreClient } from './dapi-core.mjs';

// After Insight fails once, skip it for this long so every call doesn't pay its timeout again.
const INSIGHT_BACKOFF_MS = 5 * 60 * 1000;
const insightDownUntil = new Map();

export function isInsightUnavailable(err) {
  return err instanceof InsightError && err.unavailable;
}

/** Test hook: forget remembered Insight outages. */
export function resetInsightHealth() {
  insightDownUntil.clear();
}

export class ChainClient {
  constructor(network, { insight, dapi, log = () => {} } = {}) {
    this.insight = insight ?? new InsightClient(network);
    this.dapi = dapi !== undefined ? dapi : network.dapiAddresses?.length ? new DapiCoreClient(network.dapiAddresses) : null;
    this.log = log;
  }

  insightHealthy() {
    return (insightDownUntil.get(this.insight.baseUrl) ?? 0) <= Date.now();
  }

  /** Run `viaInsight`; on an Insight outage (and when DAPI is configured) run `viaDapi` instead. */
  async withFallback(what, viaInsight, viaDapi) {
    if (!this.dapi) return viaInsight();
    if (this.insightHealthy()) {
      try {
        return await viaInsight();
      } catch (err) {
        if (!isInsightUnavailable(err)) throw err;
        insightDownUntil.set(this.insight.baseUrl, Date.now() + INSIGHT_BACKOFF_MS);
        this.log(`Insight unavailable (${err.message}); using DAPI Core for ${what}`);
      }
    }
    return viaDapi();
  }

  /** Broadcast raw tx bytes; returns the txid. */
  async broadcastTransaction(transactionBytes) {
    return this.withFallback(
      'broadcast',
      () => this.insight.broadcastTransaction(bytesToHex(transactionBytes)),
      () => this.dapi.broadcastTransaction(transactionBytes)
    );
  }

  /**
   * Tx status: { txid, confirmations, blockheight (undefined until mined),
   * txlock, chainlock (undefined when the source doesn't say) }. Throws when unknown.
   */
  async getTransaction(txid) {
    return this.withFallback(
      'tx status',
      () => this.insight.getTransaction(txid),
      async () => {
        const tx = await this.dapi.getTransaction(txid);
        if (!tx) throw new Error(`Transaction ${txid} not found`);
        return {
          txid,
          confirmations: tx.confirmations,
          txlock: tx.isInstantLocked,
          chainlock: tx.isChainLocked,
          blockheight: tx.mined ? tx.height : undefined,
        };
      }
    );
  }

  /** True when the network knows `txid` (mempool or chain). */
  async isKnown(txid) {
    return this.getTransaction(txid).then(
      () => true,
      () => false
    );
  }

  async getRawTransactionBytes(txid) {
    return this.withFallback(
      'raw tx',
      () => this.insight.getRawTransactionBytes(txid),
      async () => {
        const tx = await this.dapi.getTransaction(txid);
        if (!tx) throw new Error(`Transaction ${txid} not found`);
        return tx.transactionBytes;
      }
    );
  }

  /** Insight-only (no DAPI address index); throws InsightError when Insight is down. */
  async getUTXOs(address) {
    if (this.dapi && !this.insightHealthy()) throw new InsightError('Insight marked unavailable (recent 5xx/timeout)', undefined);
    try {
      return await this.insight.getUTXOs(address);
    } catch (err) {
      if (isInsightUnavailable(err)) insightDownUntil.set(this.insight.baseUrl, Date.now() + INSIGHT_BACKOFF_MS);
      throw err;
    }
  }
}

export { hexToBytes };

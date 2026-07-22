// Insight API client: UTXO lookup, broadcast, tx status polling.
// Ported from mainnet-bridge/src/api/insight.ts (browser fetch -> Node fetch).
export class InsightClient {
  constructor(config) {
    this.baseUrl = config.insightApiUrl;
  }

  async getUTXOs(address) {
    const res = await fetch(`${this.baseUrl}/addr/${address}/utxo`);
    if (!res.ok) throw new Error(`Insight API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return data.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      satoshis: u.satoshis,
      scriptPubKey: u.scriptPubKey,
      confirmations: u.confirmations,
    }));
  }

  async broadcastTransaction(txHex) {
    const res = await fetch(`${this.baseUrl}/tx/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawtx: txHex }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Broadcast failed: ${res.status} - ${text}`);
    }
    const result = await res.json();
    return result.txid;
  }

  async getTransaction(txid) {
    const res = await fetch(`${this.baseUrl}/tx/${txid}`);
    if (!res.ok) throw new Error(`Failed to get transaction: ${res.status}`);
    const data = await res.json();
    const rawHeight = typeof data.blockheight === 'number' ? data.blockheight : undefined;
    return {
      txid: data.txid,
      confirmations: data.confirmations || 0,
      txlock: data.txlock || false,
      blockheight: rawHeight !== undefined && rawHeight >= 0 ? rawHeight : undefined,
    };
  }

  /**
   * Poll until `address` holds at least `minSatoshis` across its UTXOs.
   * Returns the largest UTXO. Throws on timeout.
   */
  async waitForUtxo(address, minSatoshis, { timeoutMs = 180000, pollIntervalMs = 4000, log = () => {} } = {}) {
    const start = Date.now();
    let lastTotal = 0;
    while (Date.now() - start < timeoutMs) {
      try {
        const utxos = await this.getUTXOs(address);
        const total = utxos.reduce((s, u) => s + u.satoshis, 0);
        if (total !== lastTotal) {
          log(`  ${address}: ${(total / 1e8).toFixed(8)} tDASH detected`);
          lastTotal = total;
        }
        if (total >= minSatoshis && utxos.length > 0) {
          return utxos.reduce((max, u) => (u.satoshis > max.satoshis ? u : max), utxos[0]);
        }
      } catch (err) {
        log(`  poll error (${address}): ${err.message}`);
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(`Timed out waiting for >= ${minSatoshis} duffs at ${address} (last seen ${lastTotal})`);
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

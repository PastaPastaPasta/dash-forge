// InstantSend lock retrieval via JSON-RPC (trpc.digitalcash.dev getislocks).
// Ported from mainnet-bridge/src/api/dapi.ts — the testnet path. This avoids
// the browser-oriented gRPC/dapi-client bloom-filter subscription entirely:
// the JSON-RPC endpoint can recover an islock by txid, so headless polling works.
import { hexToBytes } from './bytes.mjs';
import { sleep } from './insight.mjs';

/**
 * Poll `getislocks` until the InstantSend lock for `txid` is available.
 * Returns the raw islock bytes. Throws on timeout.
 */
export async function waitForInstantSendLock(rpcUrl, txid, { timeoutMs = 120000, pollIntervalMs = 3000, log = () => {} } = {}) {
  const start = Date.now();
  // The public endpoint rate-limits by connection rate: a tight 3s poll that
  // outlives the islock (or hits a slow block) gets the whole IP TLS-reset for
  // minutes, which then looks like a permanent outage. Back off on consecutive
  // failures (up to 30s) and reset the moment a request comes back clean.
  const maxIntervalMs = 30000;
  let consecutiveErrors = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'getislocks', params: [[txid]] }),
      });
      if (res.ok) {
        consecutiveErrors = 0;
        const data = await res.json();
        const entry = Array.isArray(data.result) ? data.result.find((r) => r && r.txid === txid && r.hex) : null;
        if (entry?.hex) {
          log(`InstantSend lock received for ${txid}`);
          return hexToBytes(entry.hex);
        }
      } else {
        consecutiveErrors++;
        log(`  islock poll HTTP ${res.status}`);
      }
    } catch (err) {
      consecutiveErrors++;
      log(`  islock poll error: ${err.message}`);
    }
    const backoff = Math.min(pollIntervalMs * 2 ** Math.min(consecutiveErrors, 4), maxIntervalMs);
    await sleep(consecutiveErrors === 0 ? pollIntervalMs : backoff);
  }
  throw new Error(`Timed out waiting for InstantSend lock for ${txid} after ${timeoutMs}ms`);
}

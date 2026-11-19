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

/** How far behind the chain tip the islock node may be before its getislocks is not trusted. */
export const ISLOCK_MAX_LAG_BLOCKS = 6;

/**
 * Whether `rpcUrl` can serve islocks for new transactions: its node must be within
 * ISLOCK_MAX_LAG_BLOCKS of `tipHeight` (a node stuck weeks behind answers every getislocks with
 * "None", so each lock would wait out its full timeout). Returns { ok, reason }.
 */
export async function checkIslockSource(rpcUrl, tipHeight, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  let height;
  try {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'getblockcount', params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `getblockcount HTTP ${res.status}` };
    height = (await res.json()).result;
  } catch (err) {
    return { ok: false, reason: `getblockcount failed: ${err.message}` };
  }
  if (!Number.isInteger(height)) return { ok: false, reason: 'getblockcount returned no height' };
  if (!Number.isInteger(tipHeight)) return { ok: true, reason: 'chain tip unknown' };
  const lag = tipHeight - height;
  if (lag > ISLOCK_MAX_LAG_BLOCKS) return { ok: false, reason: `its node is at block ${height}, ${lag} behind the tip ${tipHeight}` };
  return { ok: true, reason: `at block ${height}` };
}

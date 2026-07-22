// Faucet client (faucet.thepasta.org) with headless CAP support.
// Ported/adapted from mainnet-bridge/src/api/faucet.ts (browser CAP widget
// replaced by the Node PoW solver in cap.mjs).
import { solveCap } from './cap.mjs';

const REQUEST_TIMEOUT_MS = 30000;

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getFaucetStatus(baseUrl) {
  const res = await fetchWithTimeout(`${baseUrl}/api/status`);
  if (!res.ok) throw new Error(`Failed to fetch faucet status: ${res.status}`);
  return res.json();
}

function extractError(data, status) {
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string' && data.error) return data.error;
    if (typeof data.message === 'string' && data.message) return data.message;
    if (typeof data.detail === 'string' && data.detail) return data.detail;
    if (Array.isArray(data.detail) && data.detail[0]?.msg) return String(data.detail[0].msg);
  }
  return `Faucet request failed: ${status}`;
}

/**
 * Request testnet funds. Checks status first; if CAP is required, solves it
 * headlessly and attaches the token. Returns { txid, amount, address }.
 */
export async function requestTestnetFunds(baseUrl, address, { amount, log = () => {} } = {}) {
  const status = await getFaucetStatus(baseUrl);
  const requestAmount = amount ?? status.coreFaucetAmount ?? status.creditAmount ?? 1.0;

  let capToken;
  if (status.capEndpoint) {
    log('Faucet requires CAP proof-of-work; solving headlessly...');
    capToken = await solveCap(status.capEndpoint, log);
    log('CAP token obtained.');
  }

  const body = { address, amount: requestAmount };
  if (capToken) body.capToken = capToken;

  const res = await fetchWithTimeout(`${baseUrl}/api/core-faucet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) {
      const retryAfter = typeof data.retryAfter === 'number' ? data.retryAfter : undefined;
      const mins = retryAfter ? Math.ceil(retryAfter / 60) : undefined;
      throw new Error(
        `Faucet rate limit exceeded (max ${status.rateLimitPerHour ?? 3}/hour/IP)` +
          (mins ? `. Try again in ${mins} minute(s).` : '. Try again later.') +
          ' Use --skip-faucet --utxo-from <funded-address> to bypass.'
      );
    }
    throw new Error(extractError(data, res.status));
  }

  return res.json();
}

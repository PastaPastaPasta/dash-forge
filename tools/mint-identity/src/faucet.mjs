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
async function postFaucet(baseUrl, body) {
  return fetchWithTimeout(`${baseUrl}/api/core-faucet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Request testnet funds. Checks status first; if CAP is required, solves it
 * headlessly and attaches the token. On a 429 rate-limit (or when `hardCap` is
 * forced), solves the HARDER hard-cap challenge — whose token bypasses the
 * per-IP rate limit entirely (same PoW protocol, higher difficulty), matching
 * the website flow. Returns { txid, amount, address }.
 */
export async function requestTestnetFunds(baseUrl, address, { amount, log = () => {}, hardCap = false } = {}) {
  const status = await getFaucetStatus(baseUrl);
  const requestAmount = amount ?? status.coreFaucetAmount ?? status.creditAmount ?? 1.0;

  async function attempt(useHardCap) {
    const body = { address, amount: requestAmount };
    if (useHardCap && status.hardCapEndpoint) {
      log('Solving HARD CAP (bypasses rate limit; higher difficulty)...');
      body.hardCapToken = await solveCap(status.hardCapEndpoint, log);
      log('Hard-CAP token obtained.');
    } else if (status.capEndpoint) {
      log('Faucet requires CAP proof-of-work; solving headlessly...');
      body.capToken = await solveCap(status.capEndpoint, log);
      log('CAP token obtained.');
    }
    return postFaucet(baseUrl, body);
  }

  let res = await attempt(hardCap);

  // Auto-escalate to the rate-limit-bypassing hard cap on 429.
  if (!res.ok && res.status === 429 && !hardCap && status.hardCapEndpoint) {
    log('Rate-limited; escalating to hard-CAP to bypass the limit...');
    res = await attempt(true);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) {
      throw new Error(
        `Faucet rate limit exceeded and hard-CAP bypass failed. Try again later, ` +
          'or --skip-faucet --utxo-from <funded-address>.'
      );
    }
    throw new Error(extractError(data, res.status));
  }

  return res.json();
}

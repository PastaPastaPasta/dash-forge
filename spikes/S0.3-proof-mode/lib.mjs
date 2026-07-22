// Shared constants + stats helpers for the S0.3 proof-mode spike.
// evo-sdk resolved via the symlinked node_modules -> tools/mint-identity/node_modules
// (same pattern as S0.2-chunk-geometry).

export const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec'; // packages/dpns-contract/lib/systemIds.js
export const IDENTITY_ID = 'B72TJDCsaExkoET6enz6HZGvGcHiSRYupjgve9KARoGx'; // OWNER, tools/mint-identity test pool (real, registered testnet identity)
export const SETTINGS = { connectTimeoutMs: 20000, timeoutMs: 30000, retries: 2 };

export const DPNS_QUERY = {
  dataContractId: DPNS_CONTRACT_ID,
  documentTypeName: 'domain',
  where: [['normalizedParentDomainName', '==', 'dash']],
  orderBy: [['normalizedLabel', 'asc']],
  limit: 25,
};

export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export function p90(nums) {
  const s = [...nums].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const idx = Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1);
  return s[idx];
}

export function log(msg) {
  process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`);
}

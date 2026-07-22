// Testnet network parameters (ported from mainnet-bridge/src/config.ts TESTNET).
export const TESTNET = {
  type: 'testnet',
  name: 'testnet',
  insightApiUrl: 'https://insight.testnet.networks.dash.org/insight-api',
  addressPrefix: 140,
  wifPrefix: 239,
  minFee: 1000,
  dustThreshold: 546,
  platformHrp: 'tdash',
  faucetBaseUrl: 'https://faucet.thepasta.org',
  rpcUrl: 'https://trpc.digitalcash.dev',
};

// 1 DASH = 1e8 duffs (satoshis).
export const DUFFS_PER_DASH = 100_000_000;

export function dashToDuffs(dash) {
  return Math.round(Number(dash) * DUFFS_PER_DASH);
}

export function duffsToDash(duffs) {
  return Number(duffs) / DUFFS_PER_DASH;
}

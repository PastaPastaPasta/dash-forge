// Network parameters. TESTNET is ported from mainnet-bridge/src/config.ts; the
// DEVNETS registry mirrors the bridge's DEVNET_MOUTAI entry.
//
// Every network object carries the fields the rest of the tool reads:
//   type / name       'testnet' | 'devnet', and the name written into identity files
//   insightApiUrl     UTXO lookup, broadcast, tx status
//   addressPrefix / wifPrefix
//   faucetBaseUrl     headless CAP faucet (testnet only; devnets fund from a key)
//   rpcUrl            JSON-RPC with `getislocks` (testnet only)
//   lockProof         'instant' (islock via rpcUrl) or 'chain' (ChainAssetLockProof)
//   sdk               options for `new EvoSDK(...)`
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
  lockProof: 'instant',
  sdk: { network: 'testnet', trusted: true },
};

// Devnets share testnet's Core prefixes (address 140, WIF 239, coin type 1).
// None of them serve a public `getislocks` JSON-RPC, so asset locks are proven
// with a ChainAssetLockProof once Platform's chain-locked Core height reaches
// the asset-lock tx's block.
export const DEVNETS = {
  moutai: {
    chainId: 'dash-devnet-moutai',
    platformProtocolVersion: 14,
    insightApiUrl: 'https://insight.moutai.networks.dash.org/insight-api',
    quorumUrl: 'https://quorums.moutai.networks.dash.org',
    // The web faucet sits behind reCAPTCHA; headless funding uses --funding-key-file.
    webFaucetUrl: 'https://faucet.moutai.networks.dash.org',
    // HP masternodes from dash-network-configs devnet-moutai (DAPI grpc-web on 1443).
    dapiAddresses: [
      'https://68.67.122.254:1443',
      'https://68.67.122.207:1443',
      'https://68.67.122.192:1443',
      'https://68.67.122.194:1443',
      'https://68.67.122.195:1443',
      'https://68.67.122.196:1443',
      'https://68.67.122.253:1443',
      'https://68.67.122.198:1443',
      'https://68.67.122.199:1443',
      'https://68.67.122.84:1443',
    ],
  },
};

export function devnetConfig(devnetName) {
  const d = DEVNETS[devnetName];
  if (!d) {
    throw new Error(`Unknown devnet "${devnetName}". Known devnets: ${Object.keys(DEVNETS).join(', ')}`);
  }
  return {
    type: 'devnet',
    name: `devnet-${devnetName}`,
    devnetName,
    chainId: d.chainId,
    insightApiUrl: d.insightApiUrl,
    addressPrefix: 140,
    wifPrefix: 239,
    minFee: 1000,
    dustThreshold: 546,
    platformHrp: 'tdash',
    faucetBaseUrl: undefined,
    webFaucetUrl: d.webFaucetUrl,
    rpcUrl: undefined,
    lockProof: 'chain',
    dapiAddresses: d.dapiAddresses,
    sdk: {
      network: 'devnet',
      trusted: true,
      devnetName,
      quorumUrl: d.quorumUrl,
      addresses: d.dapiAddresses,
    },
  };
}

/** Resolve `--network testnet|devnet` + `--devnet-name <name>`. */
export function resolveNetwork({ network = 'testnet', devnetName } = {}) {
  if (network === 'testnet') {
    if (devnetName) throw new Error('--devnet-name is only valid with --network devnet');
    return TESTNET;
  }
  if (network === 'devnet') {
    if (!devnetName) throw new Error(`--network devnet requires --devnet-name (one of: ${Object.keys(DEVNETS).join(', ')})`);
    return devnetConfig(devnetName);
  }
  throw new Error(`Unsupported --network "${network}" (expected testnet or devnet)`);
}

/** Map the `network` field of an identity file ('testnet', 'devnet-moutai') back to its config. */
export function networkFromName(name) {
  if (!name || name === 'testnet') return TESTNET;
  if (name.startsWith('devnet-')) return devnetConfig(name.slice('devnet-'.length));
  throw new Error(`Unsupported network "${name}" in identity file`);
}

// 1 DASH = 1e8 duffs (satoshis).
export const DUFFS_PER_DASH = 100_000_000;

export function dashToDuffs(dash) {
  return Math.round(Number(dash) * DUFFS_PER_DASH);
}

export function duffsToDash(duffs) {
  return Number(duffs) / DUFFS_PER_DASH;
}

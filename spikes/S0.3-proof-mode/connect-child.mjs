// Run in a fresh child process (spawned by bench.mjs) so connect-time memory
// footprint isn't contaminated by prior SDK instances / repeated wasm inits
// in the same process. Usage: node connect-child.mjs <testnet|testnetTrusted>
// Prints one JSON line to stdout: { mode, connectMs, mem, readOk, readErr }
import { EvoSDK } from '@dashevo/evo-sdk';
import { DPNS_CONTRACT_ID, SETTINGS } from './lib.mjs';

const mode = process.argv[2];
if (!['testnet', 'testnetTrusted'].includes(mode)) {
  console.error('usage: node connect-child.mjs <testnet|testnetTrusted>');
  process.exit(2);
}

async function main() {
  const sdk = mode === 'testnet'
    ? EvoSDK.testnet({ settings: SETTINGS })
    : EvoSDK.testnetTrusted({ settings: SETTINGS });

  const t0 = performance.now();
  await sdk.connect();
  const connectMs = performance.now() - t0;

  const mem = process.memoryUsage();

  // Confirm whether this mode can actually serve a proof-bearing read at all
  // (testnet() / non-trusted connects fine but is expected to fail here —
  // see RESULTS.md "non-trusted mode is not supported in WASM").
  let readOk = false;
  let readErr = null;
  try {
    await sdk.contracts.fetch(DPNS_CONTRACT_ID);
    readOk = true;
  } catch (e) {
    readErr = e?.message || String(e);
  }

  console.log(JSON.stringify({ mode, connectMs, mem, readOk, readErr }));
}

main().catch((e) => {
  console.log(JSON.stringify({ mode, error: e?.message || String(e) }));
  process.exit(1);
});

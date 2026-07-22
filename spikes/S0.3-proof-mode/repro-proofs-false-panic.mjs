// Minimal repro: `{ proofs: false }` is NOT a safe "go faster, skip
// verification" toggle in @dashevo/evo-sdk@4.0.0 (wasm). It WASM-panics
// (unreachable trap, unrecoverable — kills the whole process, not a
// catchable JS error) on the very first query. See RESULTS.md "Finding 2".
//
// Run standalone: node repro-proofs-false-panic.mjs
// Expected output: a Rust panic message
//   "not implemented: queries without proofs are not supported yet"
// followed by a WASM `RuntimeError: unreachable`, then the process dies —
// confirming forge-web must never expose a `proofs:false` code path.
import { EvoSDK } from '@dashevo/evo-sdk';

const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';

const sdk = EvoSDK.testnetTrusted({
  proofs: false,
  settings: { connectTimeoutMs: 20000, timeoutMs: 30000, retries: 0 },
});
await sdk.connect();
console.log('connected; issuing plain contracts.fetch() under proofs:false ...');
await sdk.contracts.fetch(DPNS_CONTRACT_ID); // <-- panics here, process dies
console.log('unreachable: if you see this, the SDK behavior has changed');

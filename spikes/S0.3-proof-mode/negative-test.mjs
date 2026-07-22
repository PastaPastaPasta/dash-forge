// Negative-control test: point testnetTrusted() at a bogus quorumUrl so the
// prefetched quorum public keys are wrong/missing. If proof verification were
// silently skipped, this would have no effect on reads. If verification is
// real, either connect() itself fails (can't fetch quorum keys) or later
// reads fail proof verification against the wrong key material.
import { EvoSDK } from '@dashevo/evo-sdk';
import { DPNS_CONTRACT_ID, SETTINGS } from './lib.mjs';

async function main() {
  const sdk = EvoSDK.testnetTrusted({
    quorumUrl: 'https://example.invalid.nonexistent-host-xyz123',
    settings: { ...SETTINGS, connectTimeoutMs: 8000, retries: 0 },
  });
  try {
    await sdk.connect();
    console.log(JSON.stringify({ connectOk: true }));
    try {
      await sdk.contracts.fetch(DPNS_CONTRACT_ID);
      console.log(JSON.stringify({ readOk: true, note: 'UNEXPECTED: read succeeded with bogus quorumUrl' }));
    } catch (e) {
      console.log(JSON.stringify({ readOk: false, stage: 'read', error: e?.message || String(e) }));
    }
  } catch (e) {
    console.log(JSON.stringify({ connectOk: false, stage: 'connect', error: e?.message || String(e) }));
  }
}

main();

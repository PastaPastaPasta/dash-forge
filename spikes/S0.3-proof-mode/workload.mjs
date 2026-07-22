// Latency workload: one persistent testnetTrusted() connection (the only
// mode that can actually serve proof-bearing reads in wasm — see RESULTS.md),
// running each operation R times back-to-back and recording per-call latency.
// Compares the proof-verifying facade methods (*WithProof) against the plain
// facade methods, plus identities.fetchUnproved() (the one facade that offers
// a genuinely separate no-proof code path in evo-sdk@4.0.0).
// Prints one JSON blob to stdout: { op: [ms, ms, ...], ... }
import { EvoSDK } from '@dashevo/evo-sdk';
import { DPNS_CONTRACT_ID, IDENTITY_ID, DPNS_QUERY, SETTINGS, log } from './lib.mjs';

const REPS = Number(process.env.BENCH_REPS || 10);

async function timeReps(label, fn, reps = REPS) {
  const times = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  log(`${label}: ${times.map((t) => t.toFixed(0)).join(', ')} ms`);
  return times;
}

// Interleave two ops call-by-call (A, B, A, B, ...) instead of running each
// op's reps as a contiguous block. This cancels out any monotonic drift
// across the run (connection pool warmup, testnet load variation) that would
// otherwise bias whichever op happens to run first/second.
async function timeInterleaved(labelA, fnA, labelB, fnB, reps = REPS) {
  const a = [];
  const b = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await fnA();
    a.push(performance.now() - t0);
    const t1 = performance.now();
    await fnB();
    b.push(performance.now() - t1);
  }
  log(`${labelA}: ${a.map((t) => t.toFixed(0)).join(', ')} ms`);
  log(`${labelB}: ${b.map((t) => t.toFixed(0)).join(', ')} ms`);
  return { a, b };
}

async function main() {
  log('Connecting (testnetTrusted)...');
  const sdk = EvoSDK.testnetTrusted({ settings: SETTINGS });
  const tc0 = performance.now();
  await sdk.connect();
  log(`Connected in ${(performance.now() - tc0).toFixed(0)} ms`);

  // Warm up the connection pool once per op before timing (untimed), so the
  // first timed rep of whichever op runs first isn't penalized by connection
  // setup that has nothing to do with proof verification.
  log('Warming up...');
  await sdk.contracts.fetch(DPNS_CONTRACT_ID);
  await sdk.contracts.fetchWithProof(DPNS_CONTRACT_ID);
  await sdk.documents.query(DPNS_QUERY);
  await sdk.documents.queryWithProof(DPNS_QUERY);
  await sdk.identities.fetch(IDENTITY_ID);
  await sdk.identities.fetchUnproved(IDENTITY_ID);
  await sdk.identities.fetchWithProof(IDENTITY_ID);

  const results = {};

  const contractPair = await timeInterleaved(
    'contract.fetch (plain)', () => sdk.contracts.fetch(DPNS_CONTRACT_ID),
    'contract.fetchWithProof', () => sdk.contracts.fetchWithProof(DPNS_CONTRACT_ID),
  );
  results['contract.fetch'] = contractPair.a;
  results['contract.fetchWithProof'] = contractPair.b;

  const docsPair = await timeInterleaved(
    'documents.query (plain)', () => sdk.documents.query(DPNS_QUERY),
    'documents.queryWithProof', () => sdk.documents.queryWithProof(DPNS_QUERY),
  );
  results['documents.query'] = docsPair.a;
  results['documents.queryWithProof'] = docsPair.b;

  const idPair = await timeInterleaved(
    'identity.fetch (plain)', () => sdk.identities.fetch(IDENTITY_ID),
    'identity.fetchWithProof', () => sdk.identities.fetchWithProof(IDENTITY_ID),
  );
  results['identity.fetch'] = idPair.a;
  results['identity.fetchWithProof'] = idPair.b;

  results['identity.fetchUnproved'] = await timeReps('identity.fetchUnproved', () => sdk.identities.fetchUnproved(IDENTITY_ID));

  // Capture proof-shape evidence once (not timed) — proves the WithProof path
  // really carries a GroveDB merkle proof + quorum BLS signature, not just an
  // echoed flag.
  const proofSample = await sdk.contracts.fetchWithProof(DPNS_CONTRACT_ID);
  const proofShape = {
    grovedbProofBytes: proofSample.proof.grovedbProof?.length,
    quorumType: proofSample.proof.quorumType,
    quorumHashHex: Buffer.from(proofSample.proof.quorumHash).toString('hex'),
    signatureBytes: proofSample.proof.signature?.length,
    metadataHeight: String(proofSample.metadata.height),
  };

  console.log(JSON.stringify({ results, proofShape }));
}

main().catch((e) => {
  console.error('ERR', e?.message || String(e));
  process.exit(1);
});

// S0.6 — construct each Forge contract with fullValidation and report:
//   pass/fail (+ error), serialized byte size vs the 16384 estimate,
//   and per-doc-type property counts vs the 100 max.
// Local construction/validation only — no testnet.
import init, * as sdk from '/Users/pasta/workspace/platform/packages/wasm-sdk/dist/sdk.js';
import { readFileSync, existsSync } from 'node:fs';

const PV = 9;               // V1 contracts (tokens/groups) activate at platform version 9
const LIMIT = 16384;        // estimated_contract_max_serialized_size
const OUT = '/Users/pasta/workspace/dash-forge/forge-contracts';

await init();

function check(label, path) {
  if (!existsSync(path)) { console.log(`\n### ${label}\n  (missing ${path})`); return null; }
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const types = Object.keys(json.documentSchemas);
  console.log(`\n### ${label}  (${path.split('/').slice(-2).join('/')})`);
  console.log(`  doc types: ${types.length}${json.tokens ? `, tokens: ${Object.keys(json.tokens).length}` : ''}${json.groups ? `, groups: ${Object.keys(json.groups).length}` : ''}`);
  let dc;
  try {
    dc = sdk.DataContract.fromJSON(json, true, PV);   // fullValidation = true
  } catch (e) {
    console.log(`  VALIDATION: FAIL`);
    console.log(`  error: ${(e.message || e).toString()}`);
    return { label, ok:false };
  }
  const bytes = dc.toBytes(PV).length;
  const withinLimit = bytes <= LIMIT;
  console.log(`  VALIDATION: PASS`);
  console.log(`  serialized size: ${bytes} bytes  (limit ${LIMIT}) -> ${withinLimit ? 'WITHIN' : 'OVER'}`);
  // per-doc-type property counts (declared props; system props like $createdAt not counted, matching meta maxProperties:100)
  let maxProps = 0;
  for (const t of types) {
    const n = Object.keys(json.documentSchemas[t].properties).length;
    maxProps = Math.max(maxProps, n);
    console.log(`    ${t.padEnd(20)} ${String(n).padStart(3)} props  (max 100)`);
  }
  console.log(`  max props in any type: ${maxProps} / 100`);
  dc.free();
  return { label, ok:true, bytes, withinLimit, types:types.length, maxProps };
}

console.log('='.repeat(70));
console.log('Dash Forge S0.6 — contract construction + fullValidation (local)');
console.log('='.repeat(70));

const results = [];
results.push(check('REGISTRY', `${OUT}/contracts/registry.json`));
results.push(check('REPO-V1 (single template)', `${OUT}/templates/repo-v1.json`));
results.push(check('REPO-CORE (split fallback)', `${OUT}/templates/repo-core.json`));
results.push(check('REPO-COLLAB (split fallback)', `${OUT}/templates/repo-collab.json`));

console.log(`\n${'='.repeat(70)}\nSUMMARY`);
for (const r of results.filter(Boolean)) {
  console.log(`  ${r.label.padEnd(30)} ${r.ok ? 'PASS' : 'FAIL'}${r.ok ? `  ${String(r.bytes).padStart(6)}B  ${r.withinLimit ? 'fits' : 'OVER 16KiB'}` : ''}`);
}
const repo = results.find(r => r && r.label.startsWith('REPO-V1'));
console.log(`\nSPLIT DECISION: ${repo && repo.ok && repo.withinLimit
  ? 'single repo-v1.json fits under 16 KiB — NO split required.'
  : 'repo-v1.json exceeds 16 KiB — use repo-core.json + repo-collab.json.'}`);

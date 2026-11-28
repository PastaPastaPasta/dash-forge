// What multisig.dashhq.org's `dti review` says of each vector in forge-contracts/fixtures/org/cross-sdk.json:
// it rebuilds the transition from the intent with dash-threshold-identity's own code and compares
// the bytes, the bytes to sign and the derived ids. Needs a dash-threshold-identity checkout with
// its node_modules installed:
//   node tools/org-vectors/cross-sdk/dti-review.mjs <dti checkout> <its commit> [--write]
// --write records the results under that commit in the fixture.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [dir, commit, flag] = process.argv.slice(2);
if (!dir || !commit) throw new Error('usage: dti-review.mjs <dash-threshold-identity checkout> <its commit> [--write]');
const fixturePath = fileURLToPath(new URL('../../../forge-contracts/fixtures/org/cross-sdk.json', import.meta.url));
const dti = (p) => import(pathToFileURL(resolve(dir, p)).href);
const { buildTransition, validateIntent, requirementsFor } = await dti('src/platform/transitions.mjs');
const { canonical } = await dti('src/util.mjs');
const sdk = JSON.parse(readFileSync(resolve(dir, 'node_modules/@dashevo/evo-sdk/package.json'), 'utf8')).version;
const key = `${commit} (evo-sdk ${sdk})`;

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
for (const v of fixture.vectors) {
  const problems = [];
  try {
    validateIntent(v.intent);
    const rebuilt = await buildTransition(v.intent);
    if (rebuilt.unsigned !== v.unsigned) problems.push('bytes differ');
    if (rebuilt.signable !== v.signable) problems.push('bytes to sign differ');
    if (canonical(rebuilt.derived ?? {}) !== canonical(v.derived)) problems.push(`derived differs (${JSON.stringify(rebuilt.derived)})`);
    if (canonical(requirementsFor(v.intent)) !== canonical([{ cid: v.intent.signer.cid, slot: v.intent.signer.slot }])) problems.push('requirements differ');
  } catch (e) {
    problems.push(`no rebuild: ${e.message}`);
  }
  const result = problems.length === 0 ? 'pass' : problems.join('; ');
  console.log(`${v.label.padEnd(32)} ${result}`);
  v.dtiReview = { ...v.dtiReview, [key]: result };
}
if (flag === '--write') {
  fixture.dtiReview = { ...fixture.dtiReview, [key]: `dash-threshold-identity ${commit}, src/platform/transitions.mjs buildTransition (what \`dti review\` rebuilds with)` };
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
}

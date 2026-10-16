#!/usr/bin/env node
// `pnpm audit --prod` with a commented ignore file.
//
//   node tools/audit/pnpm-audit.mjs <package-dir> [<ignore-file>]
//
// Fails (exit 1) when the production dependency tree of <package-dir> has an advisory of
// high or critical severity that is not listed in the ignore file. Lower severities are
// printed as a count only. The ignore file holds one GHSA id per line with a `# reason`; see
// forge-web/audit-ignore.txt. Entries that no longer match an advisory are reported as stale
// (a warning, not a failure) so the list shrinks when fixes land.
//
// pnpm's own `auditConfig.ignoreGhsas` lives in pnpm-workspace.yaml, which the SDK-bump script
// rewrites; a separate file keeps the reasons next to the ids without that coupling.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FAIL_ON = new Set(['high', 'critical']);

const [dir, ignorePath] = process.argv.slice(2);
if (!dir) {
  console.error('usage: pnpm-audit.mjs <package-dir> [<ignore-file>]');
  process.exit(2);
}

const ignored = new Map();
if (ignorePath) {
  for (const raw of readFileSync(resolve(ignorePath), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [id, ...comment] = line.split('#');
    ignored.set(id.trim(), comment.join('#').trim());
  }
}

// pnpm exits non-zero when it finds anything, so read the JSON instead of the exit code.
const run = spawnSync('pnpm', ['audit', '--prod', '--json'], {
  cwd: resolve(dir),
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error(`pnpm audit produced no JSON (exit ${run.status}); the registry may be unreachable.`);
  console.error(run.stdout.slice(0, 2000));
  console.error(run.stderr.slice(0, 2000));
  process.exit(2);
}
if (!report.advisories || typeof report.advisories !== 'object') {
  console.error('unexpected pnpm audit output:', JSON.stringify(report).slice(0, 2000));
  process.exit(2);
}

const seen = new Set();
const failing = [];
let belowThreshold = 0;
let ignoredCount = 0;
for (const adv of Object.values(report.advisories)) {
  const id = adv.github_advisory_id;
  seen.add(id);
  if (!FAIL_ON.has(adv.severity)) {
    belowThreshold += 1;
  } else if (ignored.has(id)) {
    ignoredCount += 1;
  } else {
    failing.push(adv);
  }
}

for (const adv of failing) {
  const paths = (adv.findings ?? []).flatMap((f) => f.paths ?? []).slice(0, 3).join(', ');
  console.error(
    `${adv.severity.toUpperCase()} ${adv.github_advisory_id} ${adv.module_name} ${adv.vulnerable_versions}` +
      ` (fixed in ${adv.patched_versions}): ${adv.title}\n    via ${paths}\n    ${adv.url}`,
  );
}
for (const id of ignored.keys()) {
  if (!seen.has(id)) console.warn(`stale ignore entry (no matching advisory any more): ${id}`);
}

console.log(
  `pnpm audit --prod in ${dir}: ${failing.length} failing, ${ignoredCount} ignored (high/critical), ` +
    `${belowThreshold} below high.`,
);
process.exit(failing.length > 0 ? 1 : 0);

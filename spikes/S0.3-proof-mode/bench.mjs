// S0.3 orchestrator: runs connect-child.mjs N times per mode (fresh process
// each, for clean memory readings), runs workload.mjs once (persistent
// connection, repeated read ops), runs negative-test.mjs once, and prints a
// consolidated JSON report to stdout (redirect to raw-results.json).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { median, p90, log } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONNECT_RUNS = Number(process.env.BENCH_CONNECT_RUNS || 5);

function runChild(script, args = []) {
  const out = execFileSync(process.execPath, [join(__dirname, script), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // Script may print progress lines to stderr (inherited) and exactly one
  // JSON line to stdout — take the last non-empty stdout line.
  const lines = out.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

async function benchConnect(mode) {
  log(`=== connect+memory: ${mode} (${CONNECT_RUNS} fresh-process runs) ===`);
  const runs = [];
  for (let i = 0; i < CONNECT_RUNS; i++) {
    const r = runChild('connect-child.mjs', [mode]);
    log(`  run ${i + 1}: connect=${r.connectMs?.toFixed(0)}ms rss=${(r.mem?.rss / 1e6).toFixed(1)}MB readOk=${r.readOk} ${r.readErr ? `err="${r.readErr.slice(0, 80)}"` : ''}`);
    runs.push(r);
  }
  const connectTimes = runs.map((r) => r.connectMs);
  const rss = runs.map((r) => r.mem.rss);
  const heapUsed = runs.map((r) => r.mem.heapUsed);
  const external = runs.map((r) => r.mem.external);
  return {
    mode,
    connectMedianMs: median(connectTimes),
    connectP90Ms: p90(connectTimes),
    rssMedianMB: median(rss) / 1e6,
    heapUsedMedianMB: median(heapUsed) / 1e6,
    externalMedianMB: median(external) / 1e6,
    readOk: runs[0].readOk,
    readErrSample: runs.find((r) => r.readErr)?.readErr || null,
    raw: runs,
  };
}

async function main() {
  const connectTestnet = await benchConnect('testnet');
  const connectTrusted = await benchConnect('testnetTrusted');

  log('=== read workload (persistent testnetTrusted connection) ===');
  const workload = runChild('workload.mjs');

  log('=== negative control: bogus quorumUrl ===');
  const negative = runChild('negative-test.mjs');

  const opStats = {};
  for (const [op, times] of Object.entries(workload.results)) {
    opStats[op] = { medianMs: median(times), p90Ms: p90(times), n: times.length };
  }

  const report = {
    connect: { testnet: connectTestnet, testnetTrusted: connectTrusted },
    opStats,
    proofShape: workload.proofShape,
    negativeControl: negative,
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error('BENCH FAILED', e);
  process.exit(1);
});

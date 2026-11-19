#!/usr/bin/env node
// Balance pre-flight for the live e2e suites: one line per fixture identity and funding wallet,
// and a non-zero exit naming every one that is below what a run needs.
//
//   node credits.mjs [--network testnet] --identity OWNER=<file>=<min DASH> [--identity ...]
//                    [--funding <wif file>=<min DASH>] [--out <json>] [--before <json>]
//
// --out records the balances read; --before <json> (an earlier --out) reports what was spent since
// instead of checking minimums, so a run's cost is measured on every run. A balance that cannot be
// read (DAPI or Insight down) is a warning, never a shortfall: the suite then reports the network.
// Writes GitHub annotations and a step summary when GITHUB_STEP_SUMMARY is set.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CREDITS_PER_DASH = 1e11;
export const DUFFS_PER_DASH = 1e8;

/** `<name>=<file>=<min>` (named) or `<file>=<min>`; the file may itself contain `=`. */
export function parseSpec(spec, what, { named = true } = {}) {
  const s = String(spec);
  const last = s.lastIndexOf('=');
  const first = named ? s.indexOf('=') : -1;
  const minText = s.slice(last + 1);
  const min = /^\d+(\.\d+)?$/.test(minText) ? Number(minText) : NaN;
  const file = s.slice(first + 1, last);
  const name = named ? s.slice(0, first) : undefined;
  if (last < 0 || (named && (first === last || !name)) || !file || !Number.isFinite(min) || min < 0) {
    throw new Error(`${what} must be ${named ? '<name>=' : ''}<file>=<min DASH>`);
  }
  return { name, file, min };
}

/** Rows [{ label, id, dash|null, min }] → { short: [...], unknown: [...] }. */
export function evaluate(rows) {
  const short = [];
  const unknown = [];
  for (const r of rows) {
    if (r.dash === null) unknown.push(r);
    else if (r.dash < r.min) short.push({ ...r, shortfall: r.min - r.dash });
  }
  return { short, unknown };
}

export function fmt(dash) {
  return dash === null ? 'unreadable' : `${dash.toFixed(5)} tDASH`;
}

function parseArgs(argv) {
  const args = { identity: [], network: 'testnet' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--identity') args.identity.push(v);
    else if (a === '--funding' || a === '--out' || a === '--before' || a === '--network') args[a.slice(2)] = v;
    else throw new Error(`unknown argument ${a}`);
    i++;
  }
  return args;
}

async function retry(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

async function readRows(args, log) {
  const { resolveNetwork } = await import('./src/config.mjs');
  const platform = await import('./src/platform.mjs');
  const network = resolveNetwork({ network: args.network });
  const rows = [];
  for (const spec of args.identity) {
    const { name: label, file, min } = parseSpec(spec, '--identity');
    let id;
    try {
      id = JSON.parse(readFileSync(file, 'utf8')).identityId;
    } catch {
      throw new Error(`${label}: ${file} is not a readable identity file`);
    }
    if (typeof id !== 'string' || !id) throw new Error(`${label}: ${file} has no identityId`);
    let dash = null;
    try {
      dash = (await retry(() => platform.getBalance(network, id, log))) / CREDITS_PER_DASH;
    } catch (err) {
      log(`cannot read ${label}'s balance: ${err.message}`);
    }
    rows.push({ label, id, dash, min });
  }
  if (args.funding) {
    const { file, min } = parseSpec(args.funding, '--funding', { named: false });
    const { loadFundingKey } = await import('./src/funding.mjs');
    const { ChainClient } = await import('./src/chain.mjs');
    const { address } = loadFundingKey(network, { keyFile: file });
    let dash = null;
    try {
      const chain = new ChainClient(network, { log });
      dash = (await retry(() => chain.insight.getBalance(address))) / DUFFS_PER_DASH;
    } catch (err) {
      log(`cannot read the funding wallet's balance: ${err.message}`);
    }
    rows.push({ label: 'funding wallet', id: address, dash, min });
  }
  await platform.disconnectSdk().catch(() => {});
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (m) => process.stderr.write(`${m}\n`);
  const rows = await readRows(args, log);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  const gh = Boolean(process.env.GITHUB_ACTIONS);
  const md = [];

  if (args.out) writeFileSync(args.out, JSON.stringify(rows, null, 2));

  if (args.before) {
    const before = new Map(JSON.parse(readFileSync(args.before, 'utf8')).map((r) => [r.label, r]));
    md.push('### Testnet spend this run', '', '| who | before | after | spent |', '|---|---|---|---|');
    for (const r of rows) {
      const b = before.get(r.label)?.dash ?? null;
      const spent = b === null || r.dash === null ? 'n/a' : `${(b - r.dash).toFixed(5)} tDASH`;
      md.push(`| ${r.label} \`${r.id.slice(0, 8)}…\` | ${fmt(b)} | ${fmt(r.dash)} | ${spent} |`);
      log(`${r.label.padEnd(15)} ${fmt(b)} -> ${fmt(r.dash)} (spent ${spent})`);
    }
    if (summary) appendFileSync(summary, `${md.join('\n')}\n`);
    return;
  }

  const { short, unknown } = evaluate(rows);
  md.push('### Testnet balance pre-flight', '', '| who | balance | needs |', '|---|---|---|');
  for (const r of rows) {
    md.push(`| ${r.label} \`${r.id}\` | ${fmt(r.dash)} | ≥ ${r.min} tDASH |`);
    log(`${r.label.padEnd(15)} ${r.id}  ${fmt(r.dash).padStart(20)}  (needs >= ${r.min})`);
  }
  for (const r of unknown) {
    if (gh) log(`::warning title=Balance unreadable::${r.label} ${r.id}: balance could not be read; running anyway`);
  }
  if (short.length) {
    const msg = short
      .map((r) => `${r.label} ${r.id} has ${fmt(r.dash)}, needs ${r.min} (short ${r.shortfall.toFixed(5)} tDASH)`)
      .join('; ');
    md.push('', `**Out of testnet funds:** ${msg}. Top up with \`tools/mint-identity\` (\`node mint.mjs topup\`) or the faucet; the suite was not run.`);
    log(gh ? `::error title=Testnet fixtures out of funds::${msg}` : `out of testnet funds: ${msg}`);
    process.exitCode = 1;
  }
  if (summary) appendFileSync(summary, `${md.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`credits: ${err.message}\n`);
    process.exit(2);
  });
}

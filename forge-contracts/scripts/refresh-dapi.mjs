#!/usr/bin/env node
// refresh-dapi.mjs -- rebuild, or check, a network's `dapiAddresses` so it holds only Platform
// nodes that run protocol 14 and are at the chain tip (M-DAPI; TEST-04, CONT-12, WEB-V-02).
//
// Source: the trusted quorum service's `/masternodes` list, the same service forge-core reads its
// quorum keys from and rs-sdk's address discovery reads. Its own filter (`ENABLED` and
// `versionCheck: success`) still admits a node that answers from an older release: the testnet
// list carries one on 4.1.2 (protocol 13), and the web's fetch gate, Core funding and quorum
// second source draw it about one time in nine. So a candidate must also report a `driveVersion`
// at or above the network's (--min-drive, default 5.0), and, unless --no-probe, answer a
// `getStatus` of its own with protocol >= 14, the network's chain id, and a block height within
// --max-lag blocks of the median (a stuck node on the right version).
//
//   node scripts/refresh-dapi.mjs --network testnet|mainnet            print the list (read-only)
//   node scripts/refresh-dapi.mjs --network testnet --write [--min 8]  replace dapiAddresses in deployments/<network>.json
//   node scripts/refresh-dapi.mjs --network testnet --check            probe the RECORDED list; exit 1 naming each bad seed
//
// Options: --no-probe (skip getStatus; the candidate filter alone), --chain-id <id> (else the
// record's `chainId`, else the majority answer), --min-drive <major.minor>, --max-lag <blocks>
// (default 20), --concurrency <n> (default 6), --timeout <ms> (default 8000).
//
// Read-only on the network: one GET to the quorum service and one getStatus per node. --write
// touches only the `dapiAddresses` key of the local deployment file. Mainnet does not run
// protocol 14 yet, so for mainnet the list comes up empty (and --write refuses) until it does.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROTOCOL_VERSION, loadEvoSdk, writeDep } from './deploy-v2.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NETWORKS = ['testnet', 'mainnet'];
export const DEFAULTS = { minDrive: '5.0', maxLag: 20, concurrency: 6, timeoutMs: 8000, min: 8 };

const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);

/** The quorum service for a network (parity with forge-core `network.rs` and forge-web `quorumEndpoint`). */
export const masternodesUrl = (network) => `https://quorums.${network}.networks.dash.org/masternodes`;

/** `[major, minor]` of a `5.0.0-rc.3`-style version, or null when it is not one. */
export function versionParts(v) {
  const m = /^v?(\d+)\.(\d+)(?:\.|$|-)/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Whether version `v` is at least `min` (both `major.minor[...]`); a missing or odd `v` is not. */
export function versionAtLeast(v, min) {
  const have = versionParts(v);
  const want = versionParts(min);
  if (!want) throw new Error(`bad version floor "${min}": expected major.minor`);
  if (!have) return false;
  return have[0] !== want[0] ? have[0] > want[0] : have[1] >= want[1];
}

/** `host:port` or a URL as an `https://host:port` string; null when it is neither. */
function httpsUrl(hostPort) {
  if (typeof hostPort !== 'string' || hostPort === '') return null;
  const bare = hostPort.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return /^[A-Za-z0-9.-]+:\d+$/.test(bare) ? `https://${bare}` : null;
}

/**
 * The Platform HTTPS endpoint of one `/masternodes` entry: `addresses.platform_https[0]` when it
 * is listed, else the host of `address` with the entry's own `platformHTTPPort` (the port differs
 * per node: 1443 and 22822 both occur).
 */
export function platformUrl(node) {
  const listed = httpsUrl(node?.addresses?.platform_https?.[0]);
  if (listed) return listed;
  const host = typeof node?.address === 'string' ? node.address.replace(/:\d+$/, '') : '';
  return Number.isInteger(node?.platformHTTPPort) ? httpsUrl(`${host}:${node.platformHTTPPort}`) : null;
}

/** Sort `https://a.b.c.d:port` strings by address, numerically. */
export const sortUrls = (urls) => [...urls].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

/**
 * The candidates in a `/masternodes` body: ENABLED, versionCheck success, and a `driveVersion`
 * at least `minDrive` (a node with none, or an older one, is out). Returns `{ urls, skipped }`:
 * the sorted, de-duplicated endpoints, and the entries that passed the status filter but were
 * dropped for their version or for having no endpoint, for the log.
 */
export function candidates(body, { minDrive = DEFAULTS.minDrive } = {}) {
  if (!body || body.success !== true || !Array.isArray(body.data)) throw new Error('the quorum service answered an unexpected /masternodes body');
  const urls = new Set();
  const skipped = [];
  for (const node of body.data) {
    if (node?.status !== 'ENABLED' || node?.versionCheck !== 'success') continue;
    const url = platformUrl(node);
    if (!url) skipped.push({ proTxHash: node.proTxHash, reason: 'no Platform HTTPS endpoint' });
    else if (!versionAtLeast(node.driveVersion, minDrive)) {
      skipped.push({ url, reason: `drive ${node.driveVersion ?? 'unreported'} < ${minDrive}` });
    } else urls.add(url);
  }
  return { urls: sortUrls(urls), skipped };
}

/** The median of a non-empty list of numbers (the lower middle for an even count). */
export function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** The most common value of a list, or undefined for an empty one. */
function majority(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Judge probe results `{ url, protocol, chainId, height } | { url, error }`: keep a node that
 * runs protocol >= `minProtocol`, reports `chainId` (given, else the majority answer) and whose
 * height is within `maxLag` of the median height of every node that answered. Returns
 * `{ kept, rejected: [{ url, reason }], chainId, medianHeight }`.
 */
export function judgeProbes(results, { chainId, maxLag = DEFAULTS.maxLag, minProtocol = PROTOCOL_VERSION } = {}) {
  const answered = results.filter((r) => !r.error);
  const expectedChain = chainId ?? majority(answered.map((r) => r.chainId));
  const heights = answered.map((r) => r.height).filter((h) => Number.isFinite(h) && h > 0);
  const medianHeight = heights.length > 0 ? median(heights) : undefined;
  const kept = [];
  const rejected = [];
  for (const r of results) {
    let reason = null;
    if (r.error) reason = `no answer (${r.error})`;
    else if (!(r.protocol >= minProtocol)) reason = `protocol ${r.protocol} < ${minProtocol}`;
    else if (r.chainId !== expectedChain) reason = `chain ${r.chainId} != ${expectedChain}`;
    else if (medianHeight === undefined || !(Math.abs(r.height - medianHeight) <= maxLag)) {
      reason = `height ${r.height} is not within ${maxLag} of the median ${medianHeight}`;
    }
    if (reason) rejected.push({ url: r.url, reason });
    else kept.push(r.url);
  }
  return { kept: sortUrls(kept), rejected, chainId: expectedChain, medianHeight };
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms).unref())]);

/**
 * The production probe: a short-lived evo-sdk connection pinned to the one address (as
 * deploy-v2.mjs pins a devnet's), then `system.status()`. Never throws; an unreachable or
 * misbehaving node comes back as `{ url, error }`.
 */
export function makeProbe(evo, { network, timeoutMs = DEFAULTS.timeoutMs }) {
  return async (url) => {
    try {
      const sdk = new evo.EvoSDK({
        network,
        trusted: true,
        version: PROTOCOL_VERSION,
        addresses: [url],
        settings: { connectTimeoutMs: timeoutMs, timeoutMs, retries: 0 },
      });
      const status = await withTimeout(
        (async () => {
          await sdk.connect();
          return sdk.system.status();
        })(),
        timeoutMs,
        'getStatus',
      );
      return {
        url,
        protocol: Number(status.version.protocol.drive.current),
        chainId: String(status.network.chain_id),
        height: Number(status.chain.latest_block_height),
        drive: status.version.software.drive,
      };
    } catch (e) {
      // (the SDK throws a WasmSdkError, which is not an Error but carries a message)
      return { url, error: typeof e?.message === 'string' ? e.message : String(e) };
    }
  };
}

async function fetchMasternodes(network, { fetchFn = fetch, timeoutMs = DEFAULTS.timeoutMs } = {}) {
  const resp = await fetchFn(masternodesUrl(network), { signal: AbortSignal.timeout(timeoutMs * 2) });
  if (!resp.ok) throw new Error(`${masternodesUrl(network)} answered HTTP ${resp.status}`);
  return resp.json();
}

/**
 * The refreshed list for `network`: the candidate filter, then (unless `probe` is null) the
 * probe and its judgement. `fetchFn` and `probe` are injectable so tests need no network.
 */
export async function refreshList({ network, minDrive, maxLag, concurrency, chainId, fetchFn, probe, timeoutMs }) {
  const body = await fetchMasternodes(network, { fetchFn, timeoutMs });
  const { urls, skipped } = candidates(body, { minDrive });
  if (probe === null) return { urls, skipped, rejected: [], chainId, medianHeight: undefined };
  const results = await mapLimit(urls, concurrency, probe);
  const verdict = judgeProbes(results, { chainId, maxLag });
  return { urls: verdict.kept, skipped, rejected: verdict.rejected, chainId: verdict.chainId, medianHeight: verdict.medianHeight };
}

/** The recorded list in `deployments/<network>.json` and the record's chain id, if any. */
export function readRecorded(file) {
  if (!existsSync(file)) throw new Error(`no deployment file ${file}`);
  const dep = JSON.parse(readFileSync(file, 'utf8'));
  return { dep, addresses: Array.isArray(dep.dapiAddresses) ? dep.dapiAddresses : [], chainId: typeof dep.chainId === 'string' ? dep.chainId : undefined };
}

/** What `--write` changes: hosts added and removed (as URLs). */
export function diffLists(before, after) {
  const was = new Set(before);
  const now = new Set(after);
  return { added: after.filter((u) => !was.has(u)), removed: before.filter((u) => !now.has(u)) };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    const next = argv[i + 1];
    out[argv[i].slice(2)] = next !== undefined && !next.startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const intArg = (v, name, fallback) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} needs a non-negative integer`);
  return n;
};

/**
 * The command. `deps` lets a test inject `fetchFn`, `probe` and the deployments directory; the
 * return value is the exit code, and what the command prints on stdout is returned as `stdout`.
 */
export async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  const network = args.network;
  if (!NETWORKS.includes(network)) throw new Error(`--network ${network ?? '(missing)'}: expected testnet or mainnet`);
  if (args.write && args.check) throw new Error('--write and --check are exclusive');
  const opts = {
    network,
    minDrive: typeof args['min-drive'] === 'string' ? args['min-drive'] : DEFAULTS.minDrive,
    maxLag: intArg(args['max-lag'], 'max-lag', DEFAULTS.maxLag),
    concurrency: Math.max(1, intArg(args.concurrency, 'concurrency', DEFAULTS.concurrency)),
    timeoutMs: intArg(args.timeout, 'timeout', DEFAULTS.timeoutMs),
    fetchFn: deps.fetchFn,
  };
  const file = join(deps.deploymentsDir ?? join(ROOT, 'deployments'), `${network}.json`);
  const recorded = args.write || args.check ? readRecorded(file) : null;
  const chainId = typeof args['chain-id'] === 'string' ? args['chain-id'] : recorded?.chainId;
  const probe = args['no-probe'] ? null : (deps.probe ?? makeProbe(await (deps.loadEvo ?? loadEvoSdk)(), opts));
  const stdout = [];

  if (args.check) {
    // The launch smoke check (CONT-12): every recorded seed answers, on protocol 14, at the tip.
    if (recorded.addresses.length === 0) {
      log(`${file} records no dapiAddresses`);
      return { code: 1, stdout };
    }
    let verdict;
    if (probe === null) {
      const body = await fetchMasternodes(network, opts);
      const { urls } = candidates(body, opts);
      const ok = new Set(urls);
      verdict = { kept: recorded.addresses.filter((u) => ok.has(u)), rejected: recorded.addresses.filter((u) => !ok.has(u)).map((url) => ({ url, reason: `not an ENABLED drive >= ${opts.minDrive} node in the quorum service list` })) };
    } else {
      const results = await mapLimit(recorded.addresses, opts.concurrency, probe);
      verdict = judgeProbes(results, { chainId, maxLag: opts.maxLag });
      log(`chain ${verdict.chainId}, median height ${verdict.medianHeight}`);
    }
    for (const r of verdict.rejected) log(`FAIL ${r.url}: ${r.reason}`);
    log(`${verdict.kept.length}/${recorded.addresses.length} recorded seeds pass`);
    return { code: verdict.rejected.length === 0 ? 0 : 1, stdout };
  }

  const result = await refreshList({ ...opts, chainId, probe });
  for (const s of result.skipped) log(`skip ${s.url ?? s.proTxHash}: ${s.reason}`);
  for (const r of result.rejected) log(`reject ${r.url}: ${r.reason}`);
  if (result.chainId) log(`chain ${result.chainId}${result.medianHeight ? `, median height ${result.medianHeight}` : ''}`);
  log(`${result.urls.length} nodes kept`);

  if (!args.write) {
    stdout.push(...result.urls);
    return { code: 0, stdout };
  }
  const min = intArg(args.min, 'min', DEFAULTS.min);
  if (result.urls.length < min) {
    log(`refusing to write ${result.urls.length} seeds (< --min ${min}); ${file} is unchanged`);
    return { code: 1, stdout };
  }
  const { added, removed } = diffLists(recorded.addresses, result.urls);
  writeDep(file, { ...recorded.dep, dapiAddresses: result.urls });
  log(`wrote ${result.urls.length} seeds to ${file}`);
  for (const u of added) log(`  + ${u}`);
  for (const u of removed) log(`  - ${u}`);
  return { code: 0, stdout };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2))
    .then(({ code, stdout }) => {
      for (const line of stdout) console.log(line);
      process.exit(code); // the SDK keeps sockets open
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    });
}

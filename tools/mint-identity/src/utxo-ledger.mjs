// Local UTXO ledger for a funding key, so fund-from-key keeps working when the
// Insight explorer (the only address index) is down: DAPI Core can broadcast
// and fetch transactions by id but cannot list an address's outputs.
//
// After every funding transaction the ledger records its change output (and
// drops the inputs it spent), so the next run spends that change. Parallel
// runs serialise through a lock file, which chains each change output into the
// next funding transaction. A UTXO some other spender took is dropped the first
// time a broadcast using it is rejected as spent. Same idea as the QA harness's
// DAPI-backed Insight shim (a known-transaction set), made concurrency-safe.
//
// File (0600): { version, address, utxos: [{ txid, vout, satoshis, scriptPubKey }],
//                payments: { <address>: { txid, vout, satoshis, scriptPubKey, at } } }
// `payments` remembers what each recent funding tx paid where, so a resumed
// mint finds its deposit without an address lookup. The ledger holds no keys.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { parseTransactionOutputs } from './tx.mjs';
import { sleep } from './insight.mjs';

export const LEDGER_ENV = 'FORGE_FUNDING_LEDGER';
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 20 * 60 * 1000;
const MAX_PAYMENTS = 500;

const outpointKey = (u) => `${u.txid}:${u.vout}`;

/**
 * Where the ledger for `address` lives: `$FORGE_FUNDING_LEDGER`, else next to
 * a regular key file (`secrets/moutai-funding.wif` → `secrets/moutai-funding.utxos.json`),
 * else `$XDG_STATE_HOME/dash-forge/funding-<address>.utxos.json`.
 */
export function defaultLedgerPath({ keyFile, address, env = process.env } = {}) {
  if (env[LEDGER_ENV]) return env[LEDGER_ENV];
  if (keyFile) {
    try {
      if (statSync(keyFile).isFile()) return join(dirname(keyFile), `${basename(keyFile, extname(keyFile))}.utxos.json`);
    } catch {
      /* not a regular file (e.g. /dev/fd/N): fall through */
    }
  }
  const state = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(state, 'dash-forge', `funding-${address}.utxos.json`);
}

export class FundingLedger {
  constructor(address, data = {}) {
    if (data.address && data.address !== address) {
      throw new Error(`Funding ledger belongs to ${data.address}, not ${address}`);
    }
    this.address = address;
    this.utxos = [...(data.utxos ?? [])];
    this.payments = { ...(data.payments ?? {}) };
  }

  toJSON() {
    return { version: 1, address: this.address, utxos: this.utxos, payments: this.payments };
  }

  /** Forget outpoints (spent by us, or found spent by someone else). */
  markSpent(outpoints) {
    const gone = new Set(outpoints.map(outpointKey));
    this.utxos = this.utxos.filter((u) => !gone.has(outpointKey(u)));
  }

  /** Add every output of raw tx `bytes` paying `script` (hex): the funding address's change. */
  addOutputsOf(bytes, script) {
    const { txid, outputs } = parseTransactionOutputs(bytes);
    const known = new Set(this.utxos.map(outpointKey));
    for (const o of outputs) {
      if (o.scriptPubKey !== script || known.has(`${txid}:${o.vout}`)) continue;
      this.utxos.push({ txid, vout: o.vout, satoshis: o.satoshis, scriptPubKey: o.scriptPubKey });
    }
    return txid;
  }

  recordPayment(address, utxo) {
    this.payments[address] = { ...utxo, at: new Date().toISOString() };
    const entries = Object.entries(this.payments);
    if (entries.length > MAX_PAYMENTS) {
      entries.sort((a, b) => a[1].at.localeCompare(b[1].at));
      this.payments = Object.fromEntries(entries.slice(-MAX_PAYMENTS));
    }
  }

  paymentTo(address) {
    return this.payments[address];
  }
}

function readLedger(path, address) {
  if (!existsSync(path)) return new FundingLedger(address);
  return new FundingLedger(address, JSON.parse(readFileSync(path, 'utf8')));
}

function writeLedger(path, ledger) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Take `${path}.lock` (O_EXCL), breaking it when its holder died or it is older than 10 minutes. */
async function acquireLock(lockPath, { waitMs = LOCK_WAIT_MS, log = () => {} } = {}) {
  const start = Date.now();
  let announced = false;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let holder = {};
    try {
      holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {
      /* half-written: treat by age */
    }
    const age = Date.now() - (holder.at ?? statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    if ((holder.pid && !pidAlive(holder.pid)) || age > LOCK_STALE_MS) {
      log(`funding ledger: breaking stale lock (pid ${holder.pid ?? '?'}, ${Math.round(age / 1000)}s old)`);
      try {
        unlinkSync(lockPath);
      } catch {
        /* someone else broke it */
      }
      continue;
    }
    if (Date.now() - start > waitMs) throw new Error(`Timed out waiting for the funding ledger lock ${lockPath}`);
    if (!announced) {
      log(`funding ledger: another mint (pid ${holder.pid ?? '?'}) is funding; waiting for it`);
      announced = true;
    }
    await sleep(250 + Math.floor(Math.random() * 500));
  }
}

/**
 * Run `fn(ledger)` holding the ledger's lock; saves the ledger afterwards
 * (also when `fn` throws, so spent-input discoveries persist).
 */
export async function withLedger(path, address, fn, { log = () => {}, waitMs } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  await acquireLock(lockPath, { waitMs, log });
  try {
    const ledger = readLedger(path, address);
    try {
      return await fn(ledger);
    } finally {
      writeLedger(path, ledger);
    }
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

/** Read-only view (no lock): the recorded payment to `address`, if any. */
export function recordedPayment(path, fundingAddress, address) {
  try {
    return readLedger(path, fundingAddress).paymentTo(address);
  } catch {
    return undefined;
  }
}

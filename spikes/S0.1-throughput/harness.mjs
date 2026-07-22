// Core throughput harness for S0.1.
// Confirmation is via polling identity-contract nonce (waitForResponse is unusable
// in this Node/wasm build: it panics "time not implemented on this platform").
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { getSdk, loadIdentity, pickAuthKey, buildKeyAndSigner, buildChunkCreateSt, log, errStr, PUT_SETTINGS, randomBytes } from './lib.mjs';

const contract = JSON.parse(readFileSync(new URL('./contract.json', import.meta.url)));
export const dataContractId = contract.contractId;
const rec = loadIdentity();
export const ownerId = rec.identityId;

// Broadcast-only settings: keep retries modest so a transient bad DAPI node
// doesn't silently re-send (which could double-apply if the first actually landed).
export const BROADCAST_SETTINGS = { connectTimeoutMs: 15000, timeoutMs: 30000, retries: 2 };

const STATE_FILE = new URL('./created-docs.json', import.meta.url);
export function loadCreated() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE)) : { docs: [] };
}
export function saveCreated(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function setup() {
  const sdk = await getSdk();
  const { publicKey, priv } = buildKeyAndSigner(pickAuthKey(rec, 'HIGH'));
  return { sdk, publicKey, priv };
}

// DIP-30: the identity-contract nonce returned by DAPI may carry high bits above
// the low-40-bit sequence. Some nodes return the raw value, some already-masked.
// ALWAYS mask with (2^40 - 1) to get the usable sequence. (Reusable WriteEngine rule.)
export const NONCE_MASK = (1n << 40n) - 1n;
export async function contractNonce(sdk) {
  const raw = (await sdk.identities.contractNonce(ownerId, dataContractId)) ?? 0n;
  return raw & NONCE_MASK;
}

// Poll contractNonce until it reaches `target` or timeout. Returns landing curve
// samples [{t, cn}] measured from `t0`.
export async function pollUntil(sdk, target, t0, timeoutMs = 180000, intervalMs = 1000) {
  const curve = [];
  const deadline = Date.now() + timeoutMs;
  let last = -1n;
  while (Date.now() < deadline) {
    let cn;
    try { cn = await contractNonce(sdk); } catch (e) { await sleep(intervalMs); continue; }
    if (cn !== last) { curve.push({ t: Date.now() - t0, cn: Number(cn) }); last = cn; }
    if (cn >= target) break;
    await sleep(intervalMs);
  }
  return curve;
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Broadcast N chunk-create STs with `window` max concurrent broadcasts, manual
// sequential nonces base+1..base+N. Returns per-broadcast records + timing.
export async function broadcastBatch({ sdk, publicKey, priv, N, window, base, packHash }) {
  const tasks = [];
  for (let i = 0; i < N; i++) {
    const nonce = base + 1n + BigInt(i);
    const built = buildChunkCreateSt({ ownerId, dataContractId, packHash, seq: i, nonce, priv, publicKey });
    tasks.push({ i, nonce, ...built, sent: null, ok: null, err: null });
  }
  const t0 = Date.now();
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next++];
      const s = Date.now();
      try {
        await sdk.stateTransitions.broadcastStateTransition(task.st, BROADCAST_SETTINGS);
        task.ok = true;
      } catch (e) {
        task.ok = false; task.err = errStr(e);
      }
      task.sent = Date.now() - t0;
      task.sendMs = Date.now() - s;
    }
  }
  await Promise.all(Array.from({ length: window }, () => worker()));
  const broadcastMs = Date.now() - t0;
  return { tasks, t0, broadcastMs };
}

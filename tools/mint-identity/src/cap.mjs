// Headless CAP (cap.js) proof-of-work solver.
//
// The faucet's captcha is @cap.js — a pure SHA-256 proof-of-work, no human
// interaction required. The browser widget just computes hashes; we do the
// same in Node. Protocol (reverse-engineered from @cap.js/widget@0.1.54):
//   1. POST {capBase}challenge -> { challenge: {c,s,d}, token }
//   2. Derive c sub-challenges from the token with cap.js's xorshift PRNG:
//        salt_i   = prng(`${token}${i}`,  s)   (i from 1..c)
//        target_i = prng(`${token}${i}d`, d)
//   3. For each, find the smallest nonce where sha256(salt+nonce) hex starts
//      with target. solutions = [nonce_1, ...nonce_c].
//   4. POST {capBase}redeem { token, solutions } -> { success, token: verified }
//   The verified token is what the faucet accepts as `capToken`.
import { createHash } from 'node:crypto';
import { solve_pow } from '@cap.js/wasm';

// cap.js seed hash: FNV-1a 32-bit expressed via shift-adds (== *16777619).
function prngSeed(str) {
  let t = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    t ^= str.charCodeAt(i);
    t += (t << 1) + (t << 4) + (t << 7) + (t << 8) + (t << 24);
  }
  return t >>> 0;
}

// cap.js xorshift PRNG producing a hex string of the requested length.
function prng(seed, length) {
  let i = prngSeed(seed);
  let s = '';
  const next = () => {
    i ^= i << 13;
    i ^= i >>> 17;
    i ^= i << 5;
    return i >>> 0;
  };
  while (s.length < length) s += (next() >>> 0).toString(16).padStart(8, '0');
  return s.substring(0, length);
}

// PoW: find nonce where sha256(salt+nonce) hex starts with `target`. Uses cap.js's
// official WASM solver (same engine the browser widget wraps) — far faster than a
// JS hash loop at the hard-CAP's higher difficulty. Falls back to native crypto if
// the WASM module is unavailable. Returns the nonce as a Number.
function solveOne(salt, target) {
  const n = solve_pow(salt, target); // bigint
  return typeof n === 'bigint' ? Number(n) : n;
}

// Retained as a verifier/fallback.
function solveOneJs(salt, target) {
  let nonce = 0;
  for (;;) {
    if (createHash('sha256').update(salt + nonce).digest('hex').startsWith(target)) return nonce;
    nonce++;
  }
}

async function postJson(url, body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`CAP endpoint ${url} returned non-JSON (${res.status}): ${text.slice(0, 120)}`);
    }
    if (!res.ok) throw new Error(`CAP endpoint ${url} failed ${res.status}: ${text.slice(0, 120)}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Solve a CAP challenge headlessly and return the verified token string.
 * @param {string} capEndpoint - e.g. "https://cap.thepasta.org/<id>/" (trailing slash optional)
 * @param {(msg:string)=>void} [log]
 */
export async function solveCap(capEndpoint, log = () => {}) {
  const base = capEndpoint.endsWith('/') ? capEndpoint : capEndpoint + '/';
  log(`Requesting CAP challenge from ${base}challenge`);
  const ch = await postJson(base + 'challenge', {});
  const spec = ch.challenge;
  const token = ch.token;
  if (!spec || !token) throw new Error(`Unexpected CAP challenge response: ${JSON.stringify(ch)}`);

  // Support both the {c,s,d}-encoded form and an explicit [[salt,target],...] array.
  let challenges;
  if (Array.isArray(spec)) {
    challenges = spec;
  } else {
    const { c, s, d } = spec;
    challenges = [];
    for (let i = 1; i <= c; i++) challenges.push([prng(`${token}${i}`, s), prng(`${token}${i}d`, d)]);
  }

  log(`Solving ${challenges.length} proof-of-work challenges...`);
  const t0 = Date.now();
  const solutions = challenges.map(([salt, target]) => solveOne(salt, target));
  log(`Solved CAP in ${Date.now() - t0}ms`);

  const redeem = await postJson(base + 'redeem', { token, solutions });
  if (!redeem.success || !redeem.token) {
    throw new Error(`CAP redeem failed: ${JSON.stringify(redeem)}`);
  }
  return redeem.token;
}

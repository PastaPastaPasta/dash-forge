#!/usr/bin/env node
// seed-trending.mjs — the data forge-web/e2e/trending.spec.ts ranks: three new repos starred by
// three identities so that Trending has a known shape (3, 2 and 1 new stargazers). Each star
// comes with its trending beat, and the exact `$createdAt` of every beat is read back from the
// chain.
//
//   node forge-contracts/scripts/seed-trending.mjs --out <seed.json> --owner <D.identity.json> \
//        --identity <A.identity.json> --identity <B.identity.json> --identity <C.identity.json> \
//        [--network devnet --devnet-name bonsia] [--deployment <file>]
//
// Writes RC1 documents; needs `npm ci` in forge-contracts/sdk-v2 (evo-sdk 4.2.0-beta.7). The
// network defaults to DASH_FORGE_NETWORK / DASH_FORGE_DEVNET_NAME, else devnet bonsia.
//
// Four identities, all minted for the run (`qa mint`), never the shared fixtures:
//   * `--owner` creates the repos;
//   * the three `--identity`s star them.
// A repo's owner may not beat its own repo (starBeat `repoOwner` is distinctFrom the signer), so
// the owner never stars.
//
// Idempotent: a rerun with the same --out reuses the repos it recorded and writes only the stars
// and beats still missing (a beat is once per identity and repo, ever).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { VIS, idBytes, loadIdentity, log, membership, openSession, parseArgs, runIfMain, until } from './lib/seed-io.mjs';

export async function main(argv, injected) {
  const opt = parseArgs(argv, ['identity']);
  if (!opt.out || !opt.owner || opt.identity.length !== 3) {
    throw new Error('usage: --out <seed.json> --owner <D> --identity <A> --identity <B> --identity <C> (the owner makes the repos and never stars them)');
  }
  const { evo, write, read } = await openSession(opt, injected);
  const D = loadIdentity(evo, opt.owner, 'D');
  const [A, B, C] = opt.identity.map((f, i) => loadIdentity(evo, f, 'ABC'[i]));
  if (new Set([D, A, B, C].map((w) => w.id)).size !== 4) throw new Error('the owner and the three stargazers must be four different identities');

  const state = existsSync(opt.out) ? JSON.parse(readFileSync(opt.out, 'utf8')) : { repos: [], beats: [] };
  if (state.owner && state.owner !== D.id) throw new Error(`${opt.out} records repos of ${state.owner}, not of --owner ${D.id}`);
  state.owner = D.id;
  const save = () => writeFileSync(opt.out, `${JSON.stringify(state, null, 2)}\n`);

  // No index gives a beat's exact `$createdAt` back (`byWeek` keeps only bucket starts, `byOwner`
  // no time), so the seed brackets it between the clock before the write and after it was seen.
  // The recount needs the day only (the grid steps at 00:00 UTC), so the bracket decides it
  // unless the write straddles midnight, which the seed refuses.
  async function beat(w, repoId) {
    if (state.beats.some((b) => b.repoId === repoId && b.owner === w.id)) return;
    const own = (type) => read.owns(w, type, repoId);
    const before = Date.now();
    if (!(await own('star'))) await write(w, 'star', { repoId: idBytes(repoId) });
    if (!(await own('starBeat'))) await write(w, 'starBeat', { repoId: idBytes(repoId), vis: VIS, repoOwner: idBytes(D.id) });
    if (!(await until(() => own('starBeat')))) throw new Error(`the beat of ${w.id} on ${repoId} did not land`);
    const after = Date.now();
    const day = 86_400_000;
    if (Math.floor(before / day) !== Math.floor(after / day)) throw new Error('the beat straddled 00:00 UTC; rerun (the window test needs its day)');
    state.beats.push({ repoId, repoHex: idBytes(repoId).toString('hex'), owner: w.id, createdAt: Math.round((before + after) / 2) });
    save();
    log(`beat ${w.id.slice(0, 6)} -> ${repoId.slice(0, 6)}`);
  }

  const run = state.run ?? Date.now().toString(36);
  state.run = run;
  for (const suffix of ['a', 'b', 'c']) {
    const name = `trend-${run}-${suffix}`;
    if (state.repos.some((r) => r.name === name)) continue;
    const repo = await write(D, 'repo', { name, visibility: VIS, description: 'Trending e2e fixture (forge-web/e2e/trending.spec.ts)' });
    const id = repo.id.toBase58();
    await write(D, 'maintainer', membership(idBytes(id), D.id, D.id));
    state.repos.push({ id, name });
    save();
    log(`repo ${name} ${id}`);
  }
  const [ra, rb, rc] = state.repos.map((r) => r.id);
  // 3, 2 and 1 new stargazers
  for (const w of [A, B, C]) await beat(w, ra);
  for (const w of [A, B]) await beat(w, rb);
  await beat(A, rc);
  const summary = { out: opt.out, owner: D.id, repos: state.repos, beats: state.beats.length };
  console.log(JSON.stringify(summary));
  return summary;
}

runIfMain(import.meta.url, main);

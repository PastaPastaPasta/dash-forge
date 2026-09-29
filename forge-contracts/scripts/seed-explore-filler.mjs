#!/usr/bin/env node
// seed-explore-filler.mjs — N public repos (`explore-fill-01`..`N`) owned by one scratch
// identity, so Explore's "recent repos" has more than one 24-repo page (forge-web e2e g2).
//
//   node forge-contracts/scripts/seed-explore-filler.mjs --identity <explore-filler.identity.json> \
//        [--count 25] [--network devnet --devnet-name bonsia] [--deployment <file>] [--pace-ms 700]
//
// Writes RC1 documents; needs `npm ci` in forge-contracts/sdk-v2 (evo-sdk 4.2.0-beta.7). The
// network defaults to DASH_FORGE_NETWORK / DASH_FORGE_DEVNET_NAME, else devnet bonsia. Each repo
// is what `dg repo create <name> --storage platform` writes for a public repo with nothing
// pushed: the repo and its owner's own maintainer enrolment.
//
// Idempotent: a repo the identity already owns under that name is skipped (its enrolment is
// written if it is missing). Cost: about 0.001 DASH per repo.
import { VIS, connect, documentWriter, idBytes, loadIdentity, log, membership, parseArgs, resolveNetwork, runIfMain, sdkModule, sleep } from './lib/seed-io.mjs';

export async function main(argv, injected) {
  const a = { count: '25', 'pace-ms': '700', ...parseArgs(argv) };
  if (!a.identity) throw new Error('--identity <file> is required');
  const count = Number(a.count);
  const pace = Number(a['pace-ms']);
  const net = resolveNetwork(a);
  const evo = await sdkModule(injected);
  const sdk = await connect(net, evo);
  const write = documentWriter(sdk, evo, net);
  const me = loadIdentity(evo, a.identity, 'FILLER');
  const version = sdk.version();
  const first = async (contract, type, where) => {
    const rows = await sdk.documents.query({ dataContractId: net.ids[contract], documentTypeName: type, where, limit: 1 });
    return [...rows.values()].find(Boolean)?.toJSON(version);
  };

  const repos = [];
  for (let i = 1; i <= count; i++) {
    const name = `explore-fill-${String(i).padStart(2, '0')}`;
    let repoId = (await first('core', 'repo', [['$ownerId', '==', me.id], ['name', '==', name]]))?.$id;
    if (!repoId) {
      repoId = (await write(me, 'repo', { name, visibility: VIS, description: 'Explore paging filler (forge-web e2e g2)' })).id.toBase58();
      await sleep(pace);
    }
    if (!(await first('core', 'maintainer', [['repoId', '==', repoId], ['memberId', '==', me.id]]))) {
      await write(me, 'maintainer', membership(idBytes(repoId), me.id, me.id));
      await sleep(pace);
    }
    repos.push({ name, repoId });
    log(`${name} ${repoId}`);
  }
  const summary = { network: net.key, owner: me.id, repos: repos.length };
  console.log(JSON.stringify(summary));
  return summary;
}

runIfMain(import.meta.url, main);

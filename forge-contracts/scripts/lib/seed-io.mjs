// seed-io.mjs — what the seed and verify scripts share: the network they write to, the identities
// they sign with, the contract each document type lives in, and the RC1 document forms that are
// the same in every script (docs/contracts/forge-v2.md; dash-forge-qa design/RC1-CLIENT-BRIEF.md).
//
// Every script exports `main(argv, evo)` and runs it only when invoked directly, so
// `seed-offline.mjs` can run each one against an in-memory chain (`offline-chain.mjs`) and check
// every document it writes against RC1 without a network.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { b58decode, b58encode, loadEvoSdk } from '../deploy-v2.mjs';

export { b58decode, b58encode };

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACTS = ['core', 'collab', 'community'];

export const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An identifier's 32 bytes, from its base58 form. */
export const idBytes = (b58) => b58decode(b58);

/** The contract (`core`, `collab`, `community`) that holds each document type, from the RC1 JSONs. */
export const CONTRACT_OF = Object.fromEntries(
  CONTRACTS.flatMap((c) =>
    Object.keys(JSON.parse(readFileSync(join(ROOT, 'contracts', `forge-${c}.json`), 'utf8')).documentSchemas).map((t) => [t, c]),
  ),
);

/**
 * `--key value` pairs; a key named in `multi` may repeat and collects into an array. A flag
 * with no value (`--dry-run`) is `true`.
 */
export function parseArgs(argv, multi = []) {
  const out = Object.fromEntries(multi.map((k) => [k, []]));
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    const k = argv[i].slice(2);
    const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    if (multi.includes(k)) out[k].push(v);
    else out[k] = v;
  }
  return out;
}

/**
 * The network to write to: `--network` / `--devnet-name`, else `DASH_FORGE_NETWORK` /
 * `DASH_FORGE_DEVNET_NAME`, else devnet bonsia. Its contract ids come from
 * `deployments/<network>.json` (or `--deployment <file>`), which must record all three RC1
 * contracts. moutai is refused: it runs the beta.6 contracts, which refuse every RC1 document.
 */
export function resolveNetwork(a, env = process.env) {
  const network = a.network ?? env.DASH_FORGE_NETWORK ?? 'devnet';
  const devnetName = network === 'devnet' ? (a['devnet-name'] ?? env.DASH_FORGE_DEVNET_NAME ?? 'bonsia') : null;
  const key = devnetName ? `devnet-${devnetName}` : network;
  if (devnetName === 'moutai') {
    throw new Error('devnet moutai runs the beta.6 contracts, which refuse the RC1 documents these scripts write; use --devnet-name bonsia (DASH_FORGE_DEVNET_NAME may still say moutai until the cut-over)');
  }
  const file = a.deployment ?? join(ROOT, 'deployments', `${key}.json`);
  const dep = JSON.parse(readFileSync(file, 'utf8'));
  const ids = {
    core: dep.v2?.forgeCore?.contractId,
    collab: dep.v2?.forgeCollab?.contractId,
    community: dep.v2?.forgeCommunity?.contractId,
  };
  if (!ids.core || !ids.collab || !ids.community) {
    throw new Error(`${file} records no RC1 deployment (forge-core, forge-collab and forge-community under v2); deploy-v2.mjs writes it`);
  }
  return { network, devnetName, key, dep, ids };
}

/** A connected SDK for the network (evo-sdk 4.2.0-beta.7, protocol 14; or the offline chain). */
export async function connect(net, evo) {
  const sdk = new evo.EvoSDK({
    network: net.network,
    trusted: true,
    version: 14,
    ...(net.devnetName ? { devnetName: net.devnetName } : {}),
    ...(net.dep.dapiAddresses ? { addresses: net.dep.dapiAddresses } : {}),
    settings: { connectTimeoutMs: 10000, timeoutMs: 60000, retries: 3 },
  });
  await sdk.connect();
  return sdk;
}

/** The SDK module: the injected one (the offline chain), else the pinned evo-sdk. */
export const sdkModule = async (evo) => evo ?? (await loadEvoSdk());

/** An identity from a `mint-identity` file, with its HIGH authentication key as the signer. */
export function loadIdentity(evo, file, name = undefined) {
  const rec = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const k = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === 'HIGH');
  if (!k) throw new Error(`${file}: no HIGH authentication key`);
  const identityKey = new evo.IdentityPublicKey({
    keyId: k.id,
    purpose: k.purpose,
    securityLevel: k.securityLevel,
    keyType: k.keyType,
    isReadOnly: false,
    data: Buffer.from(k.publicKeyHex, 'hex'),
  });
  const signer = new evo.IdentitySigner();
  signer.addKey(evo.PrivateKey.fromWIF(k.privateKeyWif));
  return { name: name ?? rec.label ?? rec.identityId.slice(0, 6), id: rec.identityId, identityKey, signer };
}

/**
 * `create(who, type, data)`: one document create signed by `who`, in the contract that holds
 * `type`. Resolves to the created document (its id is `.id.toBase58()`).
 */
export function documentWriter(sdk, evo, net) {
  const version = sdk.version();
  return async (who, type, data) => {
    const contract = CONTRACT_OF[type];
    if (!contract) throw new Error(`no RC1 contract holds a ${type}`);
    const base = new evo.Document({ properties: {}, documentTypeName: type, dataContractId: net.ids[contract], ownerId: who.id });
    const document = evo.Document.fromObject({ ...base.toObject(), ...data }, version);
    return sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer });
  };
}

// ---------------------------------------------------------------------------------------------
// RC1 document forms
// ---------------------------------------------------------------------------------------------

/** The visibility stamp every repo-scoped write carries; the seeds write public repos only. */
export const VIS = 'public';

/** `transition.kind` (forge-v2.md §3.1): 1-4 issue, 11-19 PR; `delta` is pinned per kind. */
export const TRANSITION = {
  issueClose: 1, issueReopen: 2, issueLock: 3, issueUnlock: 4,
  prClose: 11, prReopen: 12, merge: 13, draft: 14, ready: 15, draftClose: 16, draftReopen: 17, prLock: 18, prUnlock: 19,
};
const DELTA = { 1: 1, 2: -1, 3: 16, 4: -16, 11: 1, 12: -1, 13: 2, 14: 8, 15: -8, 16: 1, 17: -1, 18: 16, 19: -16 };

/**
 * A `transition` on `target` (`{id, number}`, an issue for kinds 1-4, a patch for 11-19). A
 * member writes `asAuthor = 0`; the target's author (a non-member) writes its number, which the
 * contract matches against the author's own issue or patch.
 */
export function transition(repoId, target, kind, { byAuthor = false, oid } = {}) {
  if (DELTA[kind] === undefined) throw new Error(`no transition kind ${kind}`);
  return {
    repoId,
    targetId: idBytes(target.id),
    targetNumber: target.number,
    targetKind: Math.floor(kind / 10),
    kind,
    delta: DELTA[kind],
    asAuthor: byAuthor ? target.number : 0,
    ...(oid ? { oid } : {}),
  };
}

/** `event.kind` / `authorEvent.kind` (community): the non-state thread events. */
export const EVENT = {
  labelAdd: 4, assign: 6, threadResolve: 11, reviewRequest: 13, reviewDismiss: 15, headUpdate: 16, milestoneSet: 17, pin: 19,
};

/**
 * A `maintainer` / `writer` enrolment written by the repo owner. Anyone but the owner must have
 * written `consent{repoId}` first, and the enrolment names it through `consentBy` = the member.
 */
export function membership(repoId, ownerId, memberId) {
  return { repoId, memberId: idBytes(memberId), vis: VIS, ...(memberId === ownerId ? {} : { consentBy: idBytes(memberId) }) };
}

/** `checkRun.outcome`: 0 until completed, 1 for success / neutral / skipped, 2 for any other conclusion. */
export function checkOutcome(status, conclusion) {
  if (status !== 'completed') return 0;
  return ['success', 'neutral', 'skipped'].includes(conclusion) ? 1 : 2;
}

// ---------------------------------------------------------------------------------------------
// Expected refusals
// ---------------------------------------------------------------------------------------------

let expecting = null;

/** The refusal the running `expectRefused` call expects (read by the offline chain). */
export const expectedRefusal = () => expecting;

/**
 * Run a write that consensus must refuse: resolves to the refusal message, or null when it was
 * accepted. `why` names the reason (the rule, the schema keyword, or the consensus code) so the
 * offline run can check the refusal and export the document as a refuse vector.
 */
export async function expectRefused(why, fn) {
  expecting = why;
  try {
    await fn();
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  } finally {
    expecting = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

/** Run `main` when the module is the process entry point; exit 1 on an error. */
export function runIfMain(url, main) {
  if (url !== pathToFileURL(resolve(process.argv[1] ?? '')).href) return;
  main(process.argv.slice(2)).then(
    (code) => process.exit(typeof code === 'number' ? code : 0),
    (e) => {
      console.error(e?.stack ?? e?.message ?? String(e));
      process.exit(1);
    },
  );
}

// seed-io.mjs — what the seed and verify scripts share: the network they write to, the identities
// they sign with, the contract each document type lives in, and the RC1 document forms that are
// the same in every script (docs/contracts/forge-v2.md; dash-forge-qa design/RC1-CLIENT-BRIEF.md).
//
// Every script exports `main(argv, evo)` and runs it only when invoked directly, so
// `seed-offline.mjs` can run each one against an in-memory chain (`offline-chain.mjs`) and check
// every document it writes against RC1 without a network.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { b58decode, b58encode, loadEvoSdk } from '../deploy-v2.mjs';

export { b58decode, b58encode };

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An identifier's 32 bytes, from its base58 form. */
export const idBytes = (b58) => b58decode(b58);

/** The RC1 contract JSONs (contracts/forge-{core,collab,community}.json), by contract. */
export const CONTRACTS = Object.fromEntries(
  ['core', 'collab', 'community'].map((c) => [c, JSON.parse(readFileSync(join(ROOT, 'contracts', `forge-${c}.json`), 'utf8'))]),
);

/**
 * RC2 C1 (schema/build.py `fused_star`): the star itself sits in the trending window (its
 * `byWeek` index outlives an unstar), and starBeat is gone. Read from the committed schema, the
 * one deploy-v2.mjs registers; a fee probe that fails turns the flag off and brings starBeat back.
 * The same test as forge-web's `lib/repo/star-shape.ts` and `e2e/trending.spec.ts`: the star has
 * a time-window index.
 */
export const FUSED_STAR = (CONTRACTS.community.documentSchemas.star?.indices ?? []).some((index) => index.timeRange !== undefined);

/** The contract (`core`, `collab`, `community`) that holds each document type. */
export const CONTRACT_OF = Object.fromEntries(
  Object.entries(CONTRACTS).flatMap(([c, json]) => Object.keys(json.documentSchemas).map((t) => [t, c])),
);

/** The id, on `net`, of the contract that holds `type`. */
function contractIdOf(net, type) {
  const contract = CONTRACT_OF[type];
  if (!contract) throw new Error(`no RC1 contract holds a ${type}`);
  return net.ids[contract];
}

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

/**
 * The network the arguments name (`resolveNetwork`) and a connected SDK for it, with a writer
 * and a reader bound to it. `injected` is the SDK module to use (the offline chain), else the
 * pinned evo-sdk (5.0.0-beta.1, protocol 14). The reader waits `pace` ms between pages.
 *
 * The connection is not fixed: a quorum rotation the trusted connection's prefetched keys have
 * gone stale against, or a node-banning storm that leaves the SDK with none left, cannot be
 * recovered on the same connection (forge-web's `lib/sdk/service.ts` documents why -- from JS
 * the only fix is a new one), so `write` and `read` rebuild it on a matching failure. An op they
 * don't cover (a delete, a count, a bare `contracts.fetch`) goes through `retry(op)`, which
 * hands `op` the current connection on every attempt and retries it like `retryOp`.
 */
export async function openSession(a, injected, { pace = 0 } = {}) {
  const net = resolveNetwork(a);
  const evo = injected ?? (await loadEvoSdk());
  const connect = async () => {
    const built = new evo.EvoSDK({
      network: net.network,
      trusted: true,
      version: 14,
      ...(net.devnetName ? { devnetName: net.devnetName } : {}),
      ...(net.dep.dapiAddresses ? { addresses: net.dep.dapiAddresses } : {}),
      settings: { connectTimeoutMs: 10000, timeoutMs: 60000, retries: 3 },
    });
    await built.connect();
    return built;
  };
  const box = { sdk: await connect() };
  const reconnect = async () => {
    box.sdk = await connect();
  };
  return {
    net,
    evo,
    retry: (op) => retryOp(() => op(box.sdk), reconnect),
    write: documentWriter(box, evo, net, reconnect),
    read: documentReader(box, net, pace, reconnect),
  };
}

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

const TRANSIENT = /timeout|timed out|unavailable|ResourceExhausted|rate.?limit|too many requests/i;

/**
 * A connection this quorum rotation or node-banning storm has made unusable, not a blip an
 * ordinary retry on the same connection would ride out: the quorum service has not caught up
 * with a rotation ("Quorum not found" / "Failed to find quorum" / "invalid quorum" -- a trusted
 * connection fetches its keys once, at connect, and never refreshes them for a read), or the
 * SDK banned every node it knows and has none left ("no available addresses"). From JS the only
 * fix is a new connection (`openSession`'s `reconnect`; forge-web's `lib/sdk/service.ts` is
 * built around the same fact, and `lib/sdk/unreachable.ts`'s `isStaleConnectionError` names the
 * same two phrases).
 */
const STALE_CONNECTION = /quorum not found|failed to find quorum|invalid quorum|no available address/i;

/**
 * The numeric consensus code `e` carries, or null. wasm-sdk (4.2.0-beta.6, platform#5112) puts it
 * on `.code`; a freed wasm pointer can make reading that throw, so the message (`Protocol error:
 * <text>`) is the fallback, same as rc1-live.mjs's `codeOf` and forge-web's `consensusCodeOf`.
 */
function codeOf(e) {
  try {
    if (typeof e?.code === 'number' && e.code >= 10000 && e.code < 50000) return e.code;
  } catch { /* freed wasm pointer */ }
  const m = /\b(10\d{3}|40\d{3})\b/.exec(String(e?.message ?? e));
  return m ? Number(m[1]) : null;
}

/**
 * The `propertyConstraints` rule a 10422 refusal's text names (`… breaks its propertyConstraints
 * rule "c1_closedAfter": …`), or null: mirrors forge-web's `lib/rules/transition.ts`'s
 * `refusedRule`. A fallback for `lagging`, below -- the offline chain's `Refusal` carries the
 * rule directly as `.rule`, which live wasm-sdk errors never set.
 */
function refusedRule(message) {
  return /rule \\?"([A-Za-z0-9_]+)\\?"/.exec(message)?.[1] ?? null;
}

/**
 * The `propertyConstraints` rules that read a total (`countOf` / `sumOf`), by document type:
 * mirrors `crates/forge-core/src/platform/mod.rs`'s `TOTAL_READING_RULES`. A node one block
 * behind the writes that feed the total (the writer's own pack chunks, a revision just
 * published) judges it without them and refuses a correct write with 10422; every other rule's
 * 10422 is a real violation that keeps refusing.
 */
const TOTAL_READING_RULES = new Set([
  'packManifest:platformChunks', 'release:oneLive', 'topic:atMost20', 'issue:dense', 'patch:dense',
  'transition:c1_closedAfter', 'transition:c2_openAfter', 'transition:c3_mergedAfter',
  'transition:c4_draftAfter', 'transition:c5_draftClosedAfter', 'transition:c6_lockedAfter',
  'comment:lockGate', 'review:lockGate',
]);

/**
 * Whether `e` is a refusal worth one retry once the state it read has caught up, rather than a
 * real rejection: 40101 always -- a delete or replace whose target a lagging node's CheckTx does
 * not find yet, moments after it was created (forge-contracts/scripts/rc1-live.mjs's comment at
 * its one replace, "a replace checked by a node a block behind finds no document"); 10422
 * (`DocumentPropertyConstraintViolated`) only when `type` names a document type and the refused
 * rule is one of `TOTAL_READING_RULES` for it -- every other rule's 10422 is final, and a caller
 * with no `type` (a delete, a count, a bare query -- 10422 is a create/replace-time check, so
 * none of them should ever see one) never retries it either.
 */
function lagging(e, type) {
  const code = codeOf(e);
  if (code === 40101) return true;
  if (code !== 10422 || type === undefined) return false;
  let rule;
  try {
    rule = e?.rule;
  } catch { /* freed wasm pointer */ }
  rule ??= refusedRule(String(e?.message ?? e));
  return TOTAL_READING_RULES.has(`${type}:${rule}`);
}

/** How long a lagging node (`lagging`) gets to catch up: about one block. */
const LAG_PAUSE_MS = 4000;

/**
 * How long to wait before rebuilding the connection: the quorum service a rotation left it
 * stale against may not have caught up yet, and reconnecting at once would likely fetch the same
 * stale keys (forge-web's `lib/sdk/service.ts` waits out the same rotation before reconnecting).
 */
const RECONNECT_PAUSE_MS = 8000;

/**
 * After attempt `attempt` (from 0) of an op labelled `label` failed with `e`, get ready to try it
 * again, or rethrow `e` when it is out of `retries` or is not a failure a retry fixes: a stale
 * connection waits `RECONNECT_PAUSE_MS` and reconnects (a failed reconnect is logged and treated
 * as this attempt's blip -- the next attempt tries again on whatever connection `box.sdk` still
 * holds), a lagging node (`lagging`) waits a flat `LAG_PAUSE_MS`, a transient blip waits `pauseMs`
 * times the attempt number. `type`, when given, is the document type a create's rule refusal
 * named, so `lagging` can tell a real violation from a stale total.
 */
async function prepareRetry(e, attempt, label, reconnect, { retries, pauseMs, type }) {
  if (attempt >= retries) throw e;
  const msg = String(e?.message ?? e);
  const why = msg.slice(0, 120);
  if (STALE_CONNECTION.test(msg)) {
    log(`${label}: reconnecting after: ${why}`);
    await sleep(RECONNECT_PAUSE_MS);
    try {
      await reconnect();
    } catch (re) {
      log(`${label}: reconnect failed, retrying as a blip: ${String(re?.message ?? re).slice(0, 120)}`);
    }
    return;
  }
  let pause;
  if (lagging(e, type)) pause = LAG_PAUSE_MS;
  else if (TRANSIENT.test(msg)) pause = pauseMs * (attempt + 1);
  else throw e;
  log(`${label}: retry ${attempt + 1} after: ${why}`);
  await sleep(pause);
}

/**
 * `write(who, type, data)`: one document create signed by `who`, in the contract that holds
 * `type`. Resolves to the created document (its id is `.id.toBase58()`).
 *
 * The document is built once, and evo-sdk fixes its `$id` and `$entropy` at construction. A
 * transient failure (a timeout, an unavailable node, a rate limit) is retried with that same
 * document, `retries` times with a growing pause; a lagging node's stale total or missed create
 * waits a flat `LAG_PAUSE_MS`; a stale connection (`STALE_CONNECTION`) instead waits
 * `RECONNECT_PAUSE_MS` and reconnects (the new connection is the fix, not more time on the old
 * one). When a retry fails, the document is looked up by its own id: an earlier attempt may have
 * landed, and a repeat of it is refused (as already present, or first by a rule such as `dense`
 * or c1..c6, which the chain judges before that).
 */
export function documentWriter(box, evo, net, reconnect, { retries = 3, pauseMs = 15000 } = {}) {
  return async (who, type, data) => {
    const version = box.sdk.version();
    const base = new evo.Document({ properties: {}, documentTypeName: type, dataContractId: contractIdOf(net, type), ownerId: who.id });
    const document = evo.Document.fromObject({ ...base.toObject(), ...withRole(type, data) }, version);
    for (let attempt = 0; ; attempt++) {
      try {
        return await box.sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer });
      } catch (e) {
        if (attempt > 0 && document.id) {
          const landed = await box.sdk.documents
            .query({ dataContractId: contractIdOf(net, type), documentTypeName: type, where: [['$id', '==', document.id.toBase58()]], limit: 1 })
            .catch(() => null);
          if (landed && [...landed.values()].some(Boolean)) return { id: document.id };
        }
        await prepareRetry(e, attempt, type, reconnect, { retries, pauseMs, type });
      }
    }
  };
}

/**
 * Run `fn` (a query, or a delete or replace, which `documentWriter` does not cover), retrying
 * `retries` times on the same failures `documentWriter` does (`prepareRetry`). Unlike a create,
 * `fn` is not checked for having landed before a retry -- a delete or replace is not built once
 * and resent unchanged, so there is no fixed id to look it up by; an op that would double-apply
 * unsafely must not be passed here.
 */
async function retryOp(fn, reconnect, { label = 'sdk', retries = 3, pauseMs = 4000, type } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      await prepareRetry(e, attempt, label, reconnect, { retries, pauseMs, type });
    }
  }
}

/**
 * Where a rerun looks for a document of a type with no unique index whose repeat a rule
 * refuses: a second close or merge (c1..c6), a second publish of a tag (oneLive).
 */
const REPEAT_REFUSED = { transition: ['targetId'], release: ['repoId', 'tagName'] };

/**
 * Queries in the contract that holds each type; documents come back as JSON. Every query retries
 * like `documentWriter`'s create does -- a stale connection waits and reconnects (`reconnect`), a
 * transient blip or a lagging node's stale total waits and retries -- since a read this deep in
 * a paging loop (`all`) failing outright would otherwise abort a whole seed run over one hiccup a
 * retry would have ridden out.
 */
export function documentReader(box, net, pace = 0, reconnect) {
  const query = (type, q) =>
    retryOp(() => box.sdk.documents.query({ dataContractId: contractIdOf(net, type), documentTypeName: type, ...q }), reconnect, { label: `${type} query`, type });
  const ownRows = (who, type, repoId) =>
    query(type, { where: [['$ownerId', '==', who.id], ['repoId', '==', repoId]], orderBy: [['$ownerId', 'asc']], limit: 1 });
  /** Every document of `type` that matches, in pages of 100 queried `pace` ms apart. */
  async function all(type, where, orderBy) {
    const out = [];
    let startAfter;
    for (;;) {
      const res = await query(type, { where, orderBy, limit: 100, ...(startAfter ? { startAfter } : {}) });
      const page = [...res.values()].filter(Boolean).map((d) => d.toJSON(box.sdk.version()));
      out.push(...page);
      if (page.length < 100) return out;
      startAfter = page[page.length - 1].$id;
      await sleep(pace);
    }
  }
  return {
    all,
    /**
     * The id of a document `who` already wrote with `data`'s values, or null. It is found
     * through one of the type's unique indices, or through `REPEAT_REFUSED` for a type whose
     * repeat a rule refuses. This is how a write that landed after its confirmation failed is
     * adopted: writing it again would be refused.
     */
    async existing(who, type, data) {
      const view = { ...data, $ownerId: who.id };
      const operand = (v) => (v instanceof Uint8Array ? b58encode(v) : v);
      const lookups = (CONTRACTS[CONTRACT_OF[type]].documentSchemas[type].indices ?? [])
        .filter((index) => index.unique)
        .map((index) => index.properties.map((p) => Object.keys(p)[0]));
      if (REPEAT_REFUSED[type]) lookups.push(REPEAT_REFUSED[type]);
      for (const keys of lookups) {
        if (keys.some((k) => view[k] === undefined)) continue;
        const rows = await all(type, keys.map((k) => [k, '==', operand(view[k])]));
        // Plain values must agree; bytes and nested objects are left out of the comparison.
        const same = rows.find((d) => d.$ownerId === who.id && Object.entries(data).every(([k, v]) => (v !== null && typeof v === 'object') || d[k] === v));
        if (same) return same.$id;
      }
      return null;
    },
    /** The first document of `type` that matches, or undefined. */
    async first(type, where) {
      const rows = await query(type, { where, limit: 1 });
      return [...rows.values()].find(Boolean)?.toJSON(box.sdk.version());
    },
    /**
     * The rows (at most one, as SDK documents) of `who`'s own index-only entry (`star`,
     * `starBeat`, `watch`) on a repo, which has no id to look it up by.
     */
    ownRows,
    /** Whether `who` holds its own index-only entry of `type` on the repo. */
    owns: async (who, type, repoId) => (await ownRows(who, type, repoId)).size > 0,
  };
}

/**
 * Check `f`, then re-check it up to `retries` times, `ms` apart, until it holds: resolves to
 * whether it did. A node answering a read may lag the one that confirmed a write.
 */
export async function until(f, retries = 12, ms = 2500) {
  for (let i = 0; ; i++) {
    if (await f()) return true;
    if (i === retries) return false;
    await sleep(ms);
  }
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

/** RC2 member roles (forge-v2.md §2.1): the committed contracts carry `writer.role` and a claimed `r`. */
export const MEMBER_ROLES = 'role' in CONTRACTS.core.documentSchemas.writer.properties;
const ROLE_GATED = new Set(['refUpdate', 'packManifest', 'chunk', 'label', 'transition', 'event', 'milestone', 'checkRun']);

/**
 * `data` with the role fields the contracts require and it leaves out: a `writer` enrolment is
 * role 1 (writer), and a role-gated write claims `r` 1, what a maintainer, an author, a runner or
 * a role-1 writer sends (every seed identity is one of those). A value `data` names is kept.
 */
export function withRole(type, data) {
  if (!MEMBER_ROLES) return data;
  if (type === 'writer' && data.role === undefined) return { ...data, role: 1 };
  if (ROLE_GATED.has(type) && data.r === undefined) return { ...data, r: 1 };
  return data;
}

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

/** Whether an expected refusal is named by its consensus code: a rule that reads chain state. */
export const isConsensusCode = (why) => /^\d+$/.test(why);

/** Run a write: resolves to its refusal message, or null when it was accepted. */
export async function refusalOf(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

/**
 * Run a write that consensus must refuse: resolves to the refusal message, or null when it was
 * accepted. `why` names the reason (the rule, the schema keyword, or the consensus code) so the
 * offline run can check the refusal and export the document as a refuse vector.
 */
export async function expectRefused(why, fn) {
  expecting = why;
  try {
    return await refusalOf(fn);
  } finally {
    expecting = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

/**
 * Run `main` when the module is the process entry point; exit 1 on an error. Both paths are
 * compared as real paths, because Node reports a module's URL with symlinks resolved (macOS
 * /tmp is one).
 */
export function runIfMain(url, main) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  if (!process.argv[1] || real(fileURLToPath(url)) !== real(resolve(process.argv[1]))) return;
  main(process.argv.slice(2)).then(
    (code) => process.exit(typeof code === 'number' ? code : 0),
    (e) => {
      console.error(e?.stack ?? e?.message ?? String(e));
      process.exit(1);
    },
  );
}

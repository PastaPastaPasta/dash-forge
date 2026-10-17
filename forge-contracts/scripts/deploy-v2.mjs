// Register the forge-v2 contracts (forge-core, forge-collab, forge-community, and forge-meta when
// the set has it) in one PV14 contract group.
//
//   (cd forge-contracts/sdk-v2 && npm ci)           # the @dashevo/evo-sdk sdk-v2/package.json pins
//   node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
//        --network devnet --devnet-name sakura [--addresses https://ip:1443,...] [--dry-run]
//        [--only collab|community|meta] [--force-new [--same-group]] [--update core|collab|community|meta|all]
//        [--set devnet|mainnet | --contracts <dir> --record <scratch-record.json>]
//   node forge-contracts/scripts/deploy-v2.mjs --network testnet --set mainnet --identity <deployer.identity.json> \
//        --expect-sha256 <signed sums> [--deployer-created-height <n>] [--dry-run]
//   node forge-contracts/scripts/deploy-v2.mjs --network testnet --set mainnet --identity <restored deployer.identity.json> \
//        --replay --replay-from-chain <the record's chainId> --expect-sha256 <signed sums> [--dry-run]
//   node forge-contracts/scripts/deploy-v2.mjs --print-sha256 [--set mainnet]    # the sums the owner signs
//   node forge-contracts/scripts/deploy-v2.mjs --self-test [--contracts <dir>]   # offline: ids, schemas, group fields
//
// --set names a committed contract set: `devnet` is forge-contracts/contracts (the three contracts
// a devnet runs, the default on a devnet), `mainnet` forge-contracts/contracts/mainnet (the four
// contracts, build.py --mainnet). It writes the network's own record, deployments/<network>.json,
// which records the set it was registered from (`v2.contractsSet`): a later run naming another set
// is refused, so a four-contract record can never be updated from the three-contract files.
// Testnet and mainnet always need --set mainnet.
//
// --contracts <dir> registers the contract JSON in <dir> instead: a scratch set such as the
// four-contract mainnet build (`python3 forge-contracts/schema/build.py --mainnet --out <dir>`),
// registered on a devnet with a scratch deployer before mainnet (DESIGN rev 4.1 phase M-C). A
// scratch set (and `--set mainnet --record <path>`, the committed set as a rehearsal) needs --record
// <path>, the deployment record it writes instead of deployments/<network>.json. No file under
// forge-contracts/deployments/ (any network's record, the contract snapshots) is accepted as a
// --record, a scratch record naming the network's own forge-core or contract group is refused, and
// a recorded contract registered from another schema stops the run, so a scratch run never touches
// or extends the live deployment. Its DAPI addresses come from --addresses, else the scratch
// record, else (read only) the network's record. --devnet-name is lower-case letters, digits and
// dashes; --addresses is for a devnet only (testnet and mainnet use SDK discovery).
//
// A scratch --record on testnet or mainnet (the P2 rehearsal of the committed set) registers
// permanent contracts on a production chain and spends its deployer's nonces there, so it also
// needs --scratch-on <network> (the value must equal --network; a dry run included). It is
// refused when the deployer identity is any identity deployments/<network>.json names (the
// deployer, a contract's or the group's owner, a superseded deployer, the key-exchange owner),
// and it prints a loud warning: a scratch rehearsal must never use the production deployer. While
// the live record names no deployer yet, the identity cannot be checked, which the warning says.
//
// Registering into the live testnet or mainnet record (CONT-02, CNT-04, CNT-15) refuses, before
// anything is broadcast, unless: the set's files match git HEAD (what is registered is in git),
// HEAD is on a branch of origin, build.py --check passes, --expect-sha256 <file> (sha256sum lines
// for the set's files, the sums the owner signed; --print-sha256 prints them, every --dry-run too)
// matches every file, every create transition leaves >= 2,000 B under max_state_transition_size
// (D44), and the chain id is proved (a DPNS proof agreeing with the node's status) and is the
// network's (`dash-testnet-<n>`, `evo1`); a devnet warns. The set's files are read once, so the
// sums checked are of the bytes registered. A preflight pass builds and sizes every transition
// before the first broadcast. --force-new there also needs --abandon-live-set <network>: it
// supersedes the contract set every client reads.
// The record gains `network`, `chainId` (a run against another chain stops), per contract
// `sourceFile`, `sourceSha256`, `gitCommit`, `gitCommitPushed`, `registeredSchemaHash`,
// `documentsHash` (what a fetched contract's documentSchemas and schemaDefs hash to),
// `transitionSha256` (the signed transition's bytes), `roomBytes` and `provedAt` (the block
// metadata of the first proof after confirmation: an upper bound on the registration block),
// `v2.deployer` (another deployer's block moves to v2.deployerSuperseded) and `v2.nonceLedger`
// (every transition the deployer signed, written before its broadcast; a settled entry is never
// rewritten). Something else that signed with the deployer's identity nonce stops the next create
// until it is named: --acknowledge-nonce <n> --note "<what it was>" (refused for a nonce that
// created a contract, unless it is the record's keyExchange). A record is one deployer's: another
// identity only registers a new set into it (--force-new, which supersedes every recorded contract
// and archives the ledger, as a chain change does). The contract group must have no admins. --deployer-created-height <n>
// records the escrowed identity's creation height.
//
// A node that reports the deployer's identity nonce below the last one the record shows signed is
// behind: it is asked again for a while, then the run stops (nothing is reserved from a stale
// nonce). A reservation found on chain is completed only when no other record names its id and the
// contract's schema is the reservation's; a dependent's reservation left by an interrupted run is
// settled against the chain when --force-new supersedes the forge-core it names. A run that writes holds `<record>.lock` (created
// exclusively, removed when the run ends); one left by a killed run is deleted by hand.
//
// --replay is the same-id restore after a Platform reset that kept Core (CNT-02, CNT-15): once
// `node tools/mint-identity/mint.mjs restore` has re-created the deployer from its original asset
// lock (same identity id), it re-registers the record's live contracts on the new chain at their
// recorded identity nonces, so every contract and the group get the ids clients embed. It replays
// v2.nonceLedger in order: each live contract's create at its recorded nonce, built from the bytes
// it was registered from (contracts/registered/<network>/<name>.v1.json when it exists, else `git
// show <gitCommit>:<sourceFile>`), with its sha256 equal to `sourceSha256`, its schema hash to
// `registeredSchemaHash` and the derived contract and group ids to the recorded ones, all checked
// for every step before the first is signed; then each recorded update. Superseded, abandoned and
// external entries are not replayed: they leave nonce gaps, each at most MAX_NONCE_GAP (24),
// else a same-id restore is impossible and a new set is the only way (--force-new
// --abandon-live-set). An external transition (a key rotation) is not redone; the run lists it.
// --replay-from-chain echoes the record's chainId. The production refusals apply (git, build.py
// --check, HEAD on origin, a proved chain id, room), and --expect-sha256 is checked against the
// recorded sums (the ones the owner signed at registration). A rerun resumes: a contract on chain
// at its recorded id is not sent again. The end appends v2.restores and moves `chainId` to the
// new chain; ids, ledger entries and registeredSchemaHash are unchanged.
//
// forge-meta (DESIGN rev 4.1 D44): when <dir> holds forge-meta.json it is registered fourth, after
// forge-community, like the others: its schema names forge-core's id (FORGE_CORE_CONTRACT_ID), and
// its create transition enrols it in the group. `--only meta` registers it alone against the
// recorded forge-core and group (an earlier run that registered the three).
//
// --only collab (or --only community) registers that contract alone, against the forge-core and
// contract group already recorded (and found on chain); it never touches forge-core or the other
// one. --force-new (with --only) registers a NEW one when the recorded one was registered from a
// different schema: every record carries `schemaHash` (sha256 of the schema JSON after
// placeholder substitution), and only a registered record whose hash differs from the current
// schema's is superseded. The old record moves to v2.forgeCollabSuperseded (or
// v2.forgeCommunitySuperseded) and the new one takes the next identity nonce, so it gets a new
// id. The new contract joins the EXISTING contract group (keys bound to it can then sign for it
// too), so this needs --same-group as well. Rerunning the same command after it succeeded, or
// after a crash, therefore registers nothing new. That is how a schema change the update rules
// refuse (e.g. narrowing an ownerRefersTo) ships; documents under the old contract stay where
// they are, under its id.
//
// --update core updates the recorded forge-core IN PLACE (a DataContractUpdate: same id, same
// group, every document kept) to the current forge-core.json, as the next version. Protocol 14
// accepts only additive changes (new document types, new optional properties); indexes,
// references, `required` system fields and `dependentRequired` are frozen, and the node refuses
// anything else. Check first with `tools/contract-validate forge-core.json --expect-update
// <registered schema>`. The record keeps the registration's fields and gains `version`,
// `schemaHash` (now the updated schema's), and an `updates` list (version, nonce, size, cost,
// the previous schema hash). A rerun after it landed finds the on-chain version already at the
// target and the hash already recorded, and broadcasts nothing. --update collab and --update
// community do the same for forge-collab and forge-community (the recorded ids replace their
// placeholders), and --update all updates the three in registration order (UPDATE-1, roadmap D4;
// check each with contract-validate --expect-update registered/<contract>.v1.json first).
//
// --force-new without --only does the same for the set: when the recorded forge-core was
// registered from a different schema (a change such as a new `required` system field, which the
// update rules refuse), its record moves to v2.forgeCoreSuperseded, the recorded group to
// v2.contractGroupSuperseded, and a new forge-core (registering a new contract group) and a new
// forge-collab and forge-community against it are registered. Their substituted schemas name
// forge-core's id, so a new forge-core always supersedes the recorded ones too. Rerunning it
// after it succeeded registers nothing new.
//
// Steps, each skipped when deployments/<network>.json shows it already done and the chain
// confirms it (so a failed run is resumed by running the same command again):
//   1. forge-core: a DataContractCreate v1 that registers the contract group AND enrols
//      forge-core in it (the group id derives from the owner and the same nonce, so the
//      transition can name the group it creates);
//   2. forge-collab, then 3. forge-community: substitute the ids of the contracts registered
//      before it for their placeholders (forge-core's for FORGE_CORE_CONTRACT_ID, and in
//      forge-community also forge-collab's for FORGE_COLLAB_CONTRACT_ID: its events refer to
//      collab's issues and PRs), then a DataContractCreate v1 enrolling it in the group. The
//      order is fixed: each takes the deployer's next identity nonce (1, 2, 3 for a deployer
//      with no earlier transitions), and the ids derive from those nonces. With --only
//      community, forge-collab's recorded id is substituted; a forge-collab re-registered with
//      --only collab --force-new leaves forge-community naming the old one until forge-community
//      is re-registered too (--only community --force-new --same-group).
// All are signed with the deployer's CRITICAL authentication key (contract create needs
// CRITICAL or HIGH; CRITICAL is used). The deployer owns the
// contracts and the group; no moderation, not readonly. Both are fixed at registration: an update
// can never set readonly (rs-dpp data_contract/config/methods/validate_update/v0), and staying
// writable is what lets later additive updates (new optional properties and types) land.
//
// Before anything is broadcast, the script checks the network runs protocol 14, rebuilds every
// contract with full validation locally (the same rs-dpp as the network, compiled to wasm), and
// prints the transition sizes. --dry-run stops there.
//
// Protocol notes: the contract id is hash_double(owner || nonce) and the group id
// hash_double("contract_group" || owner || nonce) (rs-dpp contract_group::generate_contract_group_id).
// The JS below derives the group id itself because evo-sdk exposes no helper; the Rust validator
// (tools/contract-validate) prints a known-answer vector that --self-test checks.
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, openSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(ROOT, '..');
const DEPLOYMENTS_ROOT = join(ROOT, 'deployments');
// The pinned protocol-14 SDK lives in sdk-v2/ (`npm ci` there). The package is ESM-only.
const EVO_SDK_DIR = join(ROOT, 'sdk-v2', 'node_modules', '@dashevo', 'evo-sdk');
const EVO_SDK_ENTRY = join(EVO_SDK_DIR, 'dist', 'evo-sdk.module.js');
/** `<name>@<version>` of the installed SDK package (the deployment record's `sdk`). */
export function installedSdk(packageJson = join(EVO_SDK_DIR, 'package.json')) {
  const { name, version } = JSON.parse(readFileSync(packageJson, 'utf8'));
  if (!name || !version) throw new Error(`${packageJson} names no package version`);
  return `${name}@${version}`;
}
export async function loadEvoSdk() {
  if (!existsSync(EVO_SDK_ENTRY)) throw new Error('run `npm ci` in forge-contracts/sdk-v2 first');
  const evo = await import(pathToFileURL(EVO_SDK_ENTRY).href);
  // The wasm module is initialized lazily; the offline classes (DataContract, PrivateKey, ...)
  // need it before any SDK connects, and this is the one public call that runs the init.
  await evo.EvoSDK.getLatestVersionNumber();
  return evo;
}
export const PROTOCOL_VERSION = 14;
const MAX_STATE_TRANSITION_SIZE = 20480;
/** `forge-core` -> `FORGE_CORE_CONTRACT_ID`: the placeholder a later schema names a contract by. */
export const placeholderFor = (schemaName) => `${schemaName.toUpperCase().replace(/-/g, '_')}_CONTRACT_ID`;
const PLACEHOLDER = placeholderFor('forge-core');
const GROUP = { name: 'dash-forge' };
/**
 * The group's description names every contract of the set: "Dash Forge v2: forge-core,
 * forge-collab and forge-community" (what sakura registered), "…, forge-community and forge-meta"
 * for the four-contract set. tools/contract-validate sizes the transition with the same string.
 */
export function groupDescription(schemaNames) {
  const init = schemaNames.slice(0, -1);
  const list = init.length ? `${init.join(', ')} and ${schemaNames.at(-1)}` : (schemaNames[0] ?? '');
  return `Dash Forge v2: ${list}`;
}
// The contracts that name forge-core's id, registered after it in this order. `key` is the
// record's name under `v2` (its superseded list is `${key}Superseded`), `only` the --only value.
export const DEPENDENT_CONTRACTS = [
  { key: 'forgeCollab', schemaName: 'forge-collab', only: 'collab' },
  { key: 'forgeCommunity', schemaName: 'forge-community', only: 'community' },
];
// The fourth contract (DESIGN rev 4.1 D44), registered last when the set has it
export const META_CONTRACT = { key: 'forgeMeta', schemaName: 'forge-meta', only: 'meta' };
export const DEFAULT_CONTRACTS_DIR = join(ROOT, 'contracts');
/**
 * The committed contract sets `--set` names: `devnet` is the three-contract set every devnet runs,
 * `mainnet` the four-contract set testnet (then mainnet) registers (build.py --mainnet writes it,
 * build.py --check compares it).
 */
export const SETS = { devnet: DEFAULT_CONTRACTS_DIR, mainnet: join(ROOT, 'contracts', 'mainnet') };
/** The room a create transition must leave under max_state_transition_size (DESIGN rev 4.1 D44; build.py's constant). */
export const ROOM_MIN = 2000;
/** The DPNS system contract: on every network, so a proof of it shows which chain a node serves. */
const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';
/** The contracts registered after forge-core for the set in `dir`: forge-meta last, when it has one. */
export function dependentsIn(dir = DEFAULT_CONTRACTS_DIR) {
  return existsSync(join(dir, `${META_CONTRACT.schemaName}.json`)) ? [...DEPENDENT_CONTRACTS, META_CONTRACT] : DEPENDENT_CONTRACTS;
}
/** A schema file's text from the set in `dir`. */
export function schemaText(name, dir = DEFAULT_CONTRACTS_DIR) {
  return readFileSync(join(dir, `${name}.json`), 'utf8');
}
// Protocol 14 limits on the group's registration fields (rs-platform-version system_limits).
const MAX_GROUP_NAME = 64;
const MAX_GROUP_DESCRIPTION = 256;
const PUT_SETTINGS = { connectTimeoutMs: 10000, timeoutMs: 90000, retries: 3 };
const CREDITS_PER_DASH = 1e11;

const defaultLog = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);

// flags that may be given more than once (their values collect into an array)
const REPEATABLE = new Set(['acknowledge-nonce']);
export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) throw new Error(`unexpected argument: ${t}`);
    const k = t.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    if (REPEATABLE.has(k)) (a[k] ??= []).push(v);
    else a[k] = v;
  }
  return a;
}

// ---- base58 + id derivation (rs-dpp hash_double = sha256(sha256(x))) ----
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error(`bad base58: ${s}`);
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}
function b58encode(buf) {
  let n = BigInt(`0x${Buffer.from(buf).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = `1${out}`; else break; }
  return out;
}
const sha256 = (b) => createHash('sha256').update(b).digest();
const sha256Hex = (bytes) => sha256(bytes).toString('hex');
const hashDouble = (b) => sha256(sha256(b));
const u64be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
export function contractId(ownerB58, nonce) {
  return b58encode(hashDouble(Buffer.concat([b58decode(ownerB58), u64be(nonce)])));
}
export function contractGroupId(ownerB58, nonce) {
  return b58encode(hashDouble(Buffer.concat([Buffer.from('contract_group'), b58decode(ownerB58), u64be(nonce)])));
}

// Offline checks, run before every deploy and alone with --self-test: the id derivation against
// rs-dpp's known answer, every schema of the set in `dir` loading with the earlier contracts' ids
// substituted, the group fields, and the record a scratch set may write.
function selfTest(dir = DEFAULT_CONTRACTS_DIR, log = defaultLog) {
  // Printed by tools/contract-validate for owner 0x07 * 32, nonce 1
  const owner = b58encode(Buffer.alloc(32, 7));
  const want = { contract: '4xQ1gLbVttHSnHSNAexse7ByXJd7BQCRLgLYuPevrcTW', group: 'EjmhECjYE4T5yC24xyU852tpWTmwwmAphwLLnJrShYkH' };
  const got = { contract: contractId(owner, 1), group: contractGroupId(owner, 1) };
  if (got.contract !== want.contract || got.group !== want.group) {
    throw new Error(`id derivation self-test failed: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  }
  log('id derivation self-test: ok (matches rs-dpp)');
  const dependents = dependentsIn(dir);
  const description = groupDescription(['forge-core', ...dependents.map((c) => c.schemaName)]);
  if (groupDescription(['forge-core', 'forge-collab', 'forge-community']) !== 'Dash Forge v2: forge-core, forge-collab and forge-community') {
    throw new Error('the three-contract group description is not the one sakura registered');
  }
  if (GROUP.name.length > MAX_GROUP_NAME || description.length > MAX_GROUP_DESCRIPTION) {
    throw new Error('contract group name or description over the protocol limit');
  }
  const core = loadSchema('forge-core', {}, schemaText('forge-core', dir));
  if (JSON.stringify(core).includes(PLACEHOLDER)) throw new Error('forge-core must not name its own id');
  if (!schemaText('forge-community', dir).includes(placeholderFor('forge-collab'))) {
    throw new Error('forge-community names no FORGE_COLLAB_CONTRACT_ID: its events would not refer to this forge-collab');
  }
  const ids = { [PLACEHOLDER]: want.contract };
  for (const { schemaName } of dependents) {
    const raw = schemaText(schemaName, dir);
    if (!raw.includes(PLACEHOLDER)) throw new Error(`${schemaName} names no ${PLACEHOLDER}: it would not refer to this forge-core`);
    // Only a contract registered before it may be named (loadSchema refuses an unresolved one)
    loadSchema(schemaName, ids, raw);
    ids[placeholderFor(schemaName)] = want.contract;
  }
  // Nothing registered before forge-meta may name it: a reference reaches only an earlier contract
  for (const name of ['forge-core', ...DEPENDENT_CONTRACTS.map((c) => c.schemaName)]) {
    if (schemaText(name, dir).includes(placeholderFor(META_CONTRACT.schemaName))) throw new Error(`${name} names forge-meta, which is registered after it`);
  }
  log(`schemas self-test: ok (forge-core + ${dependents.map((c) => c.schemaName).join(', ')}; group "${description}")`);
  // A scratch set writes its own record, never the network's deployment file or a snapshot
  const live = depPath('devnet', 'sakura');
  const scratch = join(tmpdir(), 'scratch-sakura.json');
  const refused = (opts) => { try { recordPath(opts); return false; } catch { return true; } };
  if (recordPath({ network: 'devnet', devnetName: 'sakura', set: 'devnet', contractsDir: SETS.devnet }) !== live) throw new Error('the default record moved');
  if (recordPath({ network: 'devnet', devnetName: 'sakura', record: scratch, contractsDir: tmpdir() }) !== scratch) throw new Error('--record ignored');
  if (!refused({ network: 'devnet', devnetName: 'sakura', contractsDir: tmpdir() })) throw new Error('a scratch set without --record was accepted');
  if (!refused({ network: 'devnet', devnetName: 'sakura', record: live, contractsDir: tmpdir() })) throw new Error('--record naming the live record was accepted');
  for (const file of [join('contracts', 'devnet-sakura.json'), 'testnet.json', 'devnet-bonsia.json', 'scratch.json']) {
    if (!refused({ network: 'devnet', devnetName: 'sakura', record: join(ROOT, 'deployments', file) })) throw new Error(`--record deployments/${file} was accepted`);
  }
  // a case-folding filesystem would alias it to the live record
  if (!refused({ network: 'devnet', devnetName: 'sakura', record: join(ROOT, 'Deployments', 'Devnet-Sakura.json') })) throw new Error('a case alias of the live record was accepted');
  const liveDep = { v2: { forgeCore: { contractId: 'A', contractGroupId: 'G' }, contractGroupId: 'G' } };
  if (!scratchRecordError({ v2: { forgeCore: { contractId: 'A' } } }, liveDep) || !scratchRecordError({ v2: { contractGroupId: 'G' } }, liveDep)
      || scratchRecordError({}, liveDep) || scratchRecordError({ v2: { forgeCore: { contractId: 'B', contractGroupId: 'H' } } }, liveDep)) {
    throw new Error('scratchRecordError misjudged a scratch record');
  }
  // a named committed set writes the network's live record, an arbitrary --contracts dir still needs --record
  if (recordPath({ network: 'testnet', set: 'mainnet', contractsDir: SETS.mainnet }) !== depPath('testnet')) throw new Error('--set mainnet does not write the live testnet record');
  if (!refused({ network: 'testnet', contractsDir: tmpdir() }) || !refused({ network: 'testnet', contractsDir: SETS.mainnet }) || !refused({ network: 'testnet', contractsDir: SETS.devnet })
      || !refused({ network: 'devnet', devnetName: 'sakura', contractsDir: SETS.devnet }) || !refused({ network: 'testnet', set: 'devnet', contractsDir: SETS.mainnet })) {
    throw new Error('a scratch --contracts set without --record was accepted');
  }
  if (!CHAIN_IDS.testnet.test('dash-testnet-51') || CHAIN_IDS.testnet.test('dash-devnet-sakura') || !CHAIN_IDS.mainnet.test('evo1') || CHAIN_IDS.mainnet.test('evo10')
      || !DEVNET_NAME.test('sakura') || DEVNET_NAME.test('a/../testnet')) {
    throw new Error('the network chain ids or the devnet name pattern misjudged a name');
  }
  log('record self-test: ok (a scratch set writes only its --record)');
  // the sums the owner signs: round trip, and every way they can differ from the files
  const sums = setSums(dir);
  const names = Object.keys(sums);
  if (names[0] !== 'forge-core.json' || names.length !== 1 + dependents.length) throw new Error(`setSums listed ${names}`);
  if (JSON.stringify(parseSums(formatSums(sums))) !== JSON.stringify(sums)) throw new Error('sha256 sums do not round-trip');
  const wrong = { ...sums, [names[1]]: '0'.repeat(64) };
  if (sumsProblems(sums, sums).length !== 0 || sumsProblems(wrong, sums).length !== 1 || sumsProblems({ ...sums, 'x.json': '1'.repeat(64) }, sums).length !== 1
      || sumsProblems(Object.fromEntries(Object.entries(sums).slice(1)), sums).length !== 1) {
    throw new Error('sumsProblems misjudged the signed sums');
  }
  if (recordedSet({}) !== null || recordedSet({ v2: { forgeCore: {} } }) !== 'devnet' || recordedSet({ v2: { forgeMeta: {} } }) !== 'mainnet' || recordedSet({ v2: { contractsSet: 'devnet', forgeMeta: {} } }) !== 'devnet') {
    throw new Error('recordedSet misjudged a record');
  }
  log(`sums self-test: ok (${names.length} files)`);
  // The record names the SDK the run used, read from the installed package (never a literal)
  const tmp = mkdtempSync(join(tmpdir(), 'deploy-v2-'));
  try {
    const pkg = join(tmp, 'package.json');
    writeFileSync(pkg, JSON.stringify({ name: '@dashevo/evo-sdk', version: '5.0.0-beta.1' }));
    if (installedSdk(pkg) !== '@dashevo/evo-sdk@5.0.0-beta.1') throw new Error(`installedSdk read ${installedSdk(pkg)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  log(`sdk self-test: ok${existsSync(EVO_SDK_DIR) ? ` (installed: ${installedSdk()})` : ' (sdk-v2 not installed)'}`);
}

// ---- deployment record ----
function depPath(network, devnetName, deploymentsRoot = DEPLOYMENTS_ROOT) {
  return join(deploymentsRoot, `${network === 'devnet' ? `devnet-${devnetName}` : network}.json`);
}
/** A path with its deepest existing directory resolved (symlinks) and folded to lower case (APFS and NTFS fold case). */
export function canonical(path) {
  let dir = dirname(path);
  const rest = [basename(path)];
  while (!existsSync(dir) && dirname(dir) !== dir) {
    rest.unshift(basename(dir));
    dir = dirname(dir);
  }
  return join(existsSync(dir) ? realpathSync(dir) : dir, ...rest).toLowerCase();
}
/** Whether `path` is inside `dir`, by real path and without case: a symlink or a case alias does not escape it. */
export function isUnder(path, dir) {
  return canonical(path).startsWith(`${canonical(dir)}/`);
}
/**
 * The record a run writes: deployments/<network>.json for a committed set (`set` names one of
 * SETS and `contractsDir` is its directory), else `record`. A scratch set (any other
 * `contractsDir`, a bare --contracts included) must name one, and no record may be a file under forge-contracts/deployments/
 * (any network's record, the contract snapshots), so a scratch run never touches a live deployment.
 */
export function recordPath({ network, devnetName, record, set, contractsDir = DEFAULT_CONTRACTS_DIR, deploymentsRoot = DEPLOYMENTS_ROOT }) {
  const live = depPath(network, devnetName, deploymentsRoot);
  if (record === undefined) {
    // (a bare --contracts is a scratch set even when it names a committed directory: only --set writes the live record)
    const committed = set !== undefined && resolve(contractsDir) === resolve(SETS[set]);
    if (!committed) {
      throw new Error(`--contracts ${contractsDir} registers a scratch set: name its record with --record <path> (never ${live})`);
    }
    return live;
  }
  const path = resolve(String(record));
  if (isUnder(path, deploymentsRoot)) {
    throw new Error(`--record ${record}: a scratch record lives outside forge-contracts/deployments/ (the networks' records and snapshots)`);
  }
  return path;
}
/** A scratch record must not name the network's own forge-core or contract group: it would extend the live deployment. */
export function scratchRecordError(scratch, live) {
  const groupOf = (dep) => dep?.v2?.contractGroupId ?? dep?.v2?.forgeCore?.contractGroupId;
  const core = scratch?.v2?.forgeCore?.contractId;
  const group = groupOf(scratch);
  if (core && core === live?.v2?.forgeCore?.contractId) return `the scratch record names the network's forge-core ${core}: start it empty`;
  if (group && group === groupOf(live)) return `the scratch record names the network's contract group ${group}: start it empty`;
  return null;
}
function readDep(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}
export function writeDep(file, dep) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(dep, null, 2)}\n`);
  renameSync(tmp, file); // never leave a half-written record behind
}

export { b58decode, b58encode, depPath, selfTest };

// ---- the committed set's files: sums, record identity, git state ----
/** The file names of the set in `dir`, in registration order: forge-core first, forge-meta last when the set has it. */
export function setFileNames(dir = DEFAULT_CONTRACTS_DIR) {
  return ['forge-core', ...dependentsIn(dir).map((c) => c.schemaName)].map((n) => `${n}.json`);
}
/** `{ 'forge-core.json': <the file's bytes>, ... }`, read once: a run hashes and registers this copy. */
export function readSet(dir = DEFAULT_CONTRACTS_DIR) {
  return Object.fromEntries(setFileNames(dir).map((f) => [f, readFileSync(join(dir, f))]));
}
/** `{ 'forge-core.json': <sha256 of the file's bytes>, ... }`: what the owner signs at G2. */
export function setSums(dir = DEFAULT_CONTRACTS_DIR, bytes = readSet(dir)) {
  return Object.fromEntries(Object.entries(bytes).map(([f, b]) => [f, sha256Hex(b)]));
}
/** `sha256sum` format, one `<hex>  <name>` line per file. */
export const formatSums = (sums) => Object.entries(sums).map(([f, h]) => `${h}  ${f}\n`).join('');
/** Parse `sha256sum` output (`<hex>  <name>` or `<hex> *<name>`; blank lines and # comments are skipped). */
export function parseSums(text) {
  const out = {};
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`line ${i + 1} is not a sha256sum line: ${line.slice(0, 80)}`);
    const name = basename(m[2]);
    if (name in out) throw new Error(`${name} is listed twice`);
    out[name] = m[1].toLowerCase();
  }
  return out;
}
/** How the sums the owner signed differ from the set's files (every file must match, no extra lines); [] when they agree. */
export function sumsProblems(expected, actual) {
  const problems = [];
  for (const [f, h] of Object.entries(actual)) {
    if (!(f in expected)) problems.push(`${f}: no sum in --expect-sha256`);
    else if (expected[f] !== h) problems.push(`${f}: sha256 ${h.slice(0, 12)}… is not the signed ${expected[f].slice(0, 12)}…`);
  }
  for (const f of Object.keys(expected)) if (!(f in actual)) problems.push(`${f}: signed, but not a file of this set`);
  return problems;
}
/**
 * The committed set a record was registered from: its `contractsSet`, else inferred (a record
 * with a forge-meta is the four-contract `mainnet` set, one with only forge-core..community is the
 * `devnet` set sakura registered), else null for a record that registers nothing yet.
 */
export function recordedSet(dep) {
  return dep?.v2?.contractsSet ?? (dep?.v2?.forgeMeta ? 'mainnet' : dep?.v2?.forgeCore ? 'devnet' : null);
}
/**
 * Every identity a record names, as a Map of id -> where (`v2.deployer.identityId`): any `ownerId`,
 * `identityId`, `owner` or `deployer` string, and any group admin, anywhere in it (the deployer, each
 * contract's and the group's owner, superseded ones, an archived ledger's deployer, the key-exchange owner).
 */
export function recordedIdentities(dep) {
  const found = new Map();
  const note = (id, where) => { if (typeof id === 'string' && id && !found.has(id)) found.set(id, where); };
  const walk = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const here = path ? `${path}.${k}` : k;
        if (['ownerId', 'identityId', 'owner', 'deployer'].includes(k)) note(x, here);
        else if (k === 'admins' && Array.isArray(x)) x.forEach((id, i) => note(id, `${here}[${i}]`));
        else walk(x, here);
      }
    }
  };
  walk(dep, '');
  return found;
}
/** A path relative to the repository (posix separators), or absolute when outside it. */
function repoPath(path) {
  const rel = relative(REPO_ROOT, resolve(path));
  return rel.startsWith('..') ? resolve(path) : rel.split(sep).join('/');
}
/** The git and build.py calls the production preconditions need; a run's tests inject their own. */
function defaultGit() {
  const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    head: () => run('git', ['rev-parse', 'HEAD']).trim(),
    porcelain: (path) => run('git', ['status', '--porcelain', '--', path]).trim(),
    // (the remote-tracking branches as last fetched: a commit on one of origin's is on origin)
    pushed: (commit) => run('git', ['branch', '-r', '--contains', commit]).split('\n').some((b) => b.trim().startsWith('origin/')),
    // a file's bytes at a commit (--replay rebuilds a registration from them)
    show: (commit, path) => execFileSync('git', ['show', `${commit}:${path}`], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }),
    buildCheck: () => {
      try {
        run('python3', [join(ROOT, 'schema', 'build.py'), '--check']);
        return { ok: true, output: '' };
      } catch (e) {
        return { ok: false, output: `${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim() };
      }
    },
  };
}
const formatBytes = (n) => Number(n).toLocaleString('en-US');

/**
 * A deployment record's forge-community id: its own, or forge-collab's on a deployment that
 * predates the three-contract split (the community types were in forge-collab there).
 */
export function communityId(dep) {
  return dep?.v2?.forgeCommunity?.contractId ?? dep?.v2?.forgeCollab?.contractId;
}

export function loadSchema(name, substitutions = {}, text = readFileSync(join(ROOT, 'contracts', `${name}.json`), 'utf8')) {
  for (const [k, v] of Object.entries(substitutions)) text = text.split(k).join(v);
  if (text.includes('_CONTRACT_ID"')) throw new Error(`${name}: unresolved contract id placeholder`);
  return JSON.parse(text);
}

// The identity of what a record was registered from: sha256 of the substituted schema,
// re-serialized compactly so whitespace and formatting do not count as a change.
export function schemaHash(json) {
  return sha256Hex(JSON.stringify(json));
}
// What a fetched contract shows of its schema, comparable with the JSON it was built from: sha256
// of the documentSchemas and schemaDefs with every object's keys sorted (freeze-c1-check compares
// the same blocks the same way; a node keeps neither key order nor the config as written).
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
export function documentsHash(json) {
  return sha256Hex(JSON.stringify(sortKeys({ documentSchemas: json?.documentSchemas ?? {}, schemaDefs: json?.schemaDefs ?? {} })));
}

// The chain ids of the production networks (dashmate configs/defaults: testnet `dash-testnet-<n>`,
// renumbered by a Platform reset; mainnet `evo1`)
export const CHAIN_IDS = { testnet: /^dash-testnet-[0-9]+$/, mainnet: /^evo1$/ };
/** A devnet name is one path segment of lower-case letters, digits and dashes (it names deployments/devnet-<name>.json). */
export const DEVNET_NAME = /^[a-z0-9-]+$/;

/**
 * Take the lock next to a record: `<record>.lock`, created exclusively, so two runs never write
 * one record. Returns its path (the caller removes it); a lock that is there already is refused.
 */
export function takeLock(recordFile, { now = () => new Date() } = {}) {
  const lock = `${recordFile}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  let fd;
  try {
    fd = openSync(lock, 'wx');
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    let held = '';
    try { held = readFileSync(lock, 'utf8').trim(); } catch { /* removed meanwhile */ }
    throw new Error(
      `${lock} exists${held ? ` (${held})` : ''}: another deploy-v2 run is writing ${basename(recordFile)}. ` +
        'If none is running (a run killed by a signal leaves its lock), check the record first (a contract left `broadcasting` is settled by the next run), then delete the lock by hand. Nothing was broadcast.'
    );
  }
  try {
    writeFileSync(fd, `pid ${process.pid} on ${hostname()} since ${now().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
  return lock;
}

// ---- the same-id restore (--replay; CNT-02, CNT-15) ----
/**
 * How far past an identity's nonce Platform takes the next one: rs-dpp identity_nonce.rs
 * MAX_MISSING_IDENTITY_REVISIONS (validate_identity_nonce_update refuses `new - current > 24`;
 * checked at v5.0.0-rc.3, 0f38a693). A fresh identity's nonce is 0 (drive add_new_identity), so
 * a replayed forge-core needs nonce <= 24, and each later replayed create at most 24 past the one
 * before it.
 */
export const MAX_NONCE_GAP = 24n;
const SCHEMA_OF_KEY = Object.fromEntries([{ key: 'forgeCore', schemaName: 'forge-core' }, ...DEPENDENT_CONTRACTS, META_CONTRACT].map((c) => [c.key, c.schemaName]));

/**
 * What --replay re-registers from a record, or a refusal: the live contracts (every one
 * `registered`, in the set's group, each with exactly one registered create in the ledger), and
 * the ledger's creates and updates of them in ledger order (`ops`). `sums` are the recorded
 * sha256 of the files the creates were built from (what --expect-sha256 is checked against);
 * `skipped` the identity nonces the replay leaves as gaps (external, superseded, abandoned).
 * `fromChain` must be the record's chainId, or the one the record's last restore came from (a
 * finished replay, run again).
 */
export function planReplay(dep, { recordKeys, fromChain, recordName = 'the record' }) {
  const v2 = dep?.v2 ?? {};
  const refuse = (m) => { throw new Error(`--replay: ${recordName} ${m}. Nothing was broadcast.`); };
  const ledger = v2.nonceLedger ?? [];
  if (!ledger.some((e) => e.kind === 'dataContractCreate')) refuse('has no nonceLedger to replay (a record registered before the ledger existed cannot be restored with the same ids)');
  if (!v2.deployer?.identityId) refuse('records no v2.deployer');
  if (!dep.chainId) refuse('records no chainId, so the chain it was registered on cannot be named');
  const lastRestore = v2.restores?.at(-1);
  const finished = Boolean(lastRestore && dep.chainId === lastRestore.toChainId && fromChain === lastRestore.fromChainId);
  if (fromChain !== dep.chainId && !finished) refuse(`was registered on chain ${dep.chainId}, not ${fromChain} (--replay-from-chain names the record's chainId)`);
  const stray = Object.keys(SCHEMA_OF_KEY).filter((k) => v2[k] && !recordKeys.includes(k));
  if (stray.length > 0) refuse(`records ${stray.map((k) => `v2.${k}`).join(', ')}, which the set has no file for`);
  const keys = recordKeys.filter((k) => v2[k]);
  if (!keys.includes('forgeCore')) refuse('records no forgeCore');
  const group = v2.contractGroupId ?? v2.forgeCore.contractGroupId;
  if (!group) refuse('records no contract group');
  const createOf = {};
  for (const key of keys) {
    const rec = v2[key];
    if (rec.status !== 'registered') refuse(`has v2.${key} ${rec.status}, not registered: only a complete set is replayed`);
    if (rec.pendingUpdate) refuse(`has a pending update of v2.${key}: the record cannot say which version is on chain`);
    if (rec.ownerId !== v2.deployer.identityId) refuse(`has v2.${key} owned by ${rec.ownerId}, not the deployer ${v2.deployer.identityId}`);
    if (rec.contractGroupId !== group) refuse(`has v2.${key} in contract group ${rec.contractGroupId}, not the set's ${group}`);
    const creates = ledger.filter((e) => e.kind === 'dataContractCreate' && e.contractId === rec.contractId && e.status === 'registered' && !e.supersededAt);
    if (creates.length !== 1 || creates[0].key !== key || creates[0].identityNonce !== rec.identityNonce) {
      refuse(`has ${creates.length} registered ledger creates of v2.${key} ${rec.contractId} (at identity nonce ${rec.identityNonce}), not one`);
    }
    createOf[key] = creates[0];
    const updates = ledger.filter((e) => e.kind === 'dataContractUpdate' && e.contractId === rec.contractId);
    const open = updates.find((e) => e.status !== 'updated');
    if (open) refuse(`has an update of v2.${key} to version ${open.version} left ${open.status}`);
    if (updates.length !== (rec.updates?.length ?? 0)) refuse(`has v2.${key} with ${rec.updates?.length ?? 0} updates but ${updates.length} in the ledger`);
  }
  const open = ledger.find((e) => e.status === 'broadcasting');
  if (open) refuse(`has a ${open.kind} of ${open.key} still broadcasting (nonce ${open.identityNonce ?? open.contractNonce}): whether it landed is unknown`);
  // The ledger's own order is the order things were signed: an update can precede a later create
  // that refers to what it added
  const ops = [];
  const created = new Set();
  let prev = 0n;
  for (const e of ledger) {
    const key = keys.find((k) => v2[k].contractId === e.contractId);
    if (!key) continue;
    if (e === createOf[key]) {
      const nonce = BigInt(e.identityNonce);
      if (nonce <= prev) refuse(`has the creates out of identity-nonce order (v2.${key} at ${nonce} after ${prev})`);
      if (ops.length === 0 && key !== 'forgeCore') refuse(`registers v2.${key} before forge-core, which registers the group`);
      prev = nonce;
      created.add(key);
      ops.push({ kind: 'create', key, schemaName: SCHEMA_OF_KEY[key], entry: e, nonce });
    } else if (e.kind === 'dataContractUpdate') {
      if (!created.has(key)) refuse(`has an update of v2.${key} before its create`);
      ops.push({ kind: 'update', key, schemaName: SCHEMA_OF_KEY[key], entry: e });
    }
  }
  const replayedNonces = new Set(ops.filter((o) => o.kind === 'create').map((o) => o.entry.identityNonce));
  const skipped = ledger.filter((e) => e.identityNonce !== undefined && e.kind !== undefined && !(e.kind === 'dataContractCreate' && replayedNonces.has(e.identityNonce) && e.status === 'registered' && !e.supersededAt))
    .map((e) => ({ identityNonce: e.identityNonce, kind: e.kind, ...(e.key ? { key: e.key } : {}), ...(e.status ? { status: e.status } : {}), ...(e.supersededAt ? { superseded: true } : {}), ...(e.note ? { note: e.note } : {}) }));
  const sums = Object.fromEntries(keys.map((k) => [`${SCHEMA_OF_KEY[k]}.json`, v2[k].sourceSha256]));
  return { fromChain, group, keys, ops, sums, skipped, finished };
}

/** The first nonce gap a replay of `creates` (ascending identity nonces) cannot make from `chain`, or null. */
export function nonceGapProblem(creates, chain) {
  let prev = BigInt(chain);
  for (const { key, nonce } of creates) {
    if (nonce <= prev) return `${key}'s identity nonce ${nonce} is not past the deployer's ${prev} on this chain: something else signed with the restored deployer first, so ${key} cannot get its recorded id`;
    if (nonce - prev > MAX_NONCE_GAP) return `${key} needs identity nonce ${nonce} but the deployer's is ${prev}: nonce gap ${nonce - prev} exceeds the protocol's window of ${MAX_NONCE_GAP}`;
    prev = nonce;
  }
  return null;
}

/**
 * The bytes a replayed transition is built from, which must hash to the recorded `sourceSha256`:
 * the frozen registered copy when one exists (`frozen`, a create), else the file at the recorded
 * commit, else (a scratch set outside the repository, recorded by absolute path) the file itself.
 */
export function replaySource({ what, sourceFile, gitCommit, sourceSha256, frozen }, git) {
  const check = (bytes, from) => {
    const got = sha256Hex(bytes);
    if (got !== sourceSha256) throw new Error(`--replay: ${what} from ${from} has sha256 ${got.slice(0, 12)}…, not the recorded ${String(sourceSha256).slice(0, 12)}…: not the bytes registered. Nothing was broadcast.`);
    return bytes;
  };
  if (!/^[0-9a-f]{64}$/.test(String(sourceSha256))) throw new Error(`--replay: ${what} records no sourceSha256. Nothing was broadcast.`);
  if (frozen && existsSync(frozen)) return check(readFileSync(frozen), repoPath(frozen));
  if (!sourceFile) throw new Error(`--replay: ${what} records no sourceFile. Nothing was broadcast.`);
  if (sourceFile.startsWith('/')) {
    if (!existsSync(sourceFile)) throw new Error(`--replay: ${what} was registered from ${sourceFile}, which is gone (a scratch set outside the repository). Nothing was broadcast.`);
    return check(readFileSync(sourceFile), sourceFile);
  }
  if (!gitCommit) throw new Error(`--replay: ${what} records no gitCommit to read ${sourceFile} at. Nothing was broadcast.`);
  let bytes;
  try {
    bytes = git.show(gitCommit, sourceFile);
  } catch (e) {
    throw new Error(`--replay: git cannot show ${gitCommit.slice(0, 12)}:${sourceFile} (${String(e?.stderr ?? e?.message ?? e).trim().split('\n')[0]}); fetch origin first. Nothing was broadcast.`);
  }
  return check(Buffer.from(bytes), `${gitCommit.slice(0, 12)}:${sourceFile}`);
}

// Whether --force-new supersedes a record. Only a completed registration from a different
// schema is superseded. A `broadcasting` record is the new contract of an interrupted
// --force-new run (or an interrupted first run): registerContract completes it if it landed, or
// retries its nonce if it did not. A registered record from this very schema is already the
// contract wanted. Either way, rerunning the same command never registers another copy. A record
// without a hash predates schemaHash and cannot be shown to match, so it is superseded.
export function supersedes(rec, currentHash) {
  return rec?.status === 'registered' && rec.schemaHash !== currentHash;
}

// A superseded forge-collab / forge-community joins the EXISTING contract group when forge-core
// is kept, which widens every key bound to that group: that needs an explicit --same-group. With
// a new forge-core the new contract joins the new group, which no key is bound to yet.
export function dependentSupersedeError({ key, schemaName, contractId, coreSuperseded, sameGroup }) {
  if (coreSuperseded || sameGroup) return null;
  return `${key}: ${contractId} was registered from another schema but forge-core was not, so --force-new would add a new ${schemaName} ` +
    'to the existing contract group, widening every key bound to it; re-run with --same-group to confirm';
}

function pickKey(rec, purpose, level) {
  const k = rec.identityKeys.find((x) => x.purpose === purpose && x.securityLevel === level);
  if (!k) throw new Error(`deployer identity has no ${level} ${purpose} key`);
  return k;
}

/**
 * Run the script. `injected` replaces what a test cannot use: `evo` (the loaded evo-sdk module,
 * else loadEvoSdk()), `git` ({ head, porcelain, pushed, buildCheck, show }), `now`, `log`, `print` (stdout),
 * `sdkId` (the record's `sdk`), `deploymentsRoot` (the directory the networks' records live in) and
 * `registeredRoot` (contracts/registered, where --replay looks for a network's frozen copies).
 * The record's lock (a run that writes takes one) is released however the run ends.
 */
export async function main(argv = process.argv.slice(2), injected = {}) {
  const locks = [];
  try {
    return await deploy(argv, injected, locks);
  } finally {
    for (const lock of locks) rmSync(lock, { force: true });
  }
}

async function deploy(argv, injected, locks) {
  const log = injected.log ?? defaultLog;
  const now = injected.now ?? (() => new Date());
  const stamp = () => now().toISOString();
  const git = injected.git ?? defaultGit();
  const print = injected.print ?? ((text) => process.stdout.write(text));
  const deploymentsRoot = injected.deploymentsRoot ?? DEPLOYMENTS_ROOT;
  const args = parseArgs(argv);
  for (const flag of ['contracts', 'record', 'set', 'expect-sha256', 'abandon-live-set', 'scratch-on', 'deployer-created-height', 'note']) {
    if (args[flag] === true) throw new Error(`--${flag} takes a value`);
  }
  if (args.contracts !== undefined && args.set !== undefined) {
    throw new Error('--set names a committed contract set and --contracts a scratch one: pass only one of them');
  }
  if (args.set !== undefined && !Object.hasOwn(SETS, args.set)) throw new Error(`--set accepts ${Object.keys(SETS).map((s) => `"${s}"`).join(' or ')}, got ${args.set}`);
  const contractsDir = args.contracts !== undefined ? resolve(String(args.contracts)) : args.set !== undefined ? SETS[args.set] : DEFAULT_CONTRACTS_DIR;
  selfTest(contractsDir, log);
  if (args['self-test']) return;
  // The set's files are read once: the sums checked and recorded are of the bytes registered
  const setBytes = readSet(contractsDir);
  const fileSums = setSums(contractsDir, setBytes);
  if (args['print-sha256']) {
    print(formatSums(fileSums));
    return;
  }
  const DEPENDENTS = dependentsIn(contractsDir);
  const RECORD_KEYS = ['forgeCore', ...DEPENDENTS.map((c) => c.key)];
  const load = (name, substitutions = {}) => loadSchema(name, substitutions, setBytes[`${name}.json`].toString('utf8'));
  const GROUP_DESCRIPTION = groupDescription(['forge-core', ...DEPENDENTS.map((c) => c.schemaName)]);

  const network = args.network || 'devnet';
  const devnetName = network === 'devnet' ? (args['devnet-name'] || 'sakura') : undefined;
  if (!['devnet', 'testnet', 'mainnet'].includes(network)) throw new Error(`unknown network ${network}`);
  if (devnetName !== undefined && !DEVNET_NAME.test(String(devnetName))) {
    throw new Error(`--devnet-name ${devnetName}: lower-case letters, digits and dashes only (it names deployments/devnet-<name>.json)`);
  }
  // Testnet and mainnet are reached through SDK discovery only: a list of addresses could be anyone's nodes
  if (network !== 'devnet' && args.addresses !== undefined) throw new Error(`--addresses is for a devnet; ${network} uses SDK discovery`);
  // Testnet and mainnet register a committed set (the four-contract one), never the devnets' three
  let setName = args.set ?? null;
  if (args.contracts === undefined) {
    if (network !== 'devnet') {
      if (setName === null) throw new Error(`${network} registers a committed set: pass --set mainnet (the four-contract set, forge-contracts/contracts/mainnet)`);
      if (setName === 'devnet') throw new Error(`${network} registers the four-contract set (--set mainnet); the three-contract set is for devnets`);
    } else {
      setName ??= 'devnet';
    }
  }
  if (!args.identity || args.identity === true) throw new Error('--identity <deployer.identity.json> required');
  const dryRun = Boolean(args['dry-run']);
  const only = args.only === undefined ? null : String(args.only);
  const onlyValues = DEPENDENTS.map((c) => c.only);
  if (only !== null && !onlyValues.includes(only)) throw new Error(`--only accepts ${onlyValues.map((v) => `"${v}"`).join(' or ')}, got ${only}`);
  const update = args.update === undefined ? null : String(args.update);
  const updateValues = ['core', ...onlyValues, 'all'];
  if (update !== null && !updateValues.includes(update)) throw new Error(`--update accepts ${updateValues.map((v) => `"${v}"`).join(', ')}, got ${update}`);
  if (update !== null && (only !== null || args['force-new'])) throw new Error('--update runs alone: no --only, no --force-new');
  const forceNew = Boolean(args['force-new']);
  // A new contract registered into the EXISTING group adds a member that every key already bound
  // to the group can sign for, and a group never drops members. dg accepts superseded contracts
  // the deployment file lists in the same group, but the default for a schema change is a new set
  // in a new group (--force-new without --only). Adding to the old group needs an explicit
  // --same-group.
  if (only !== null && forceNew && !args['same-group']) {
    throw new Error(
      `--only ${only} --force-new adds a new forge-${only} to the existing contract group, widening every key bound to it; ` +
        're-run with --same-group to confirm, or use --force-new without --only for a new set in a new group'
    );
  }
  const acknowledged = (args['acknowledge-nonce'] ?? []).flatMap((v) => String(v).split(',')).map((v) => {
    if (!/^[1-9][0-9]*$/.test(v)) throw new Error(`--acknowledge-nonce takes an identity nonce (a positive integer), got ${v}`);
    return BigInt(v);
  });
  if (acknowledged.length > 0 && (args.note === undefined || !String(args.note).trim())) {
    throw new Error('--acknowledge-nonce records what consumed the nonce: add --note "<what it was>"');
  }
  if (acknowledged.length === 0 && args.note !== undefined) throw new Error('--note goes with --acknowledge-nonce <n>');
  const createdHeight = args['deployer-created-height'] === undefined ? null : Number(args['deployer-created-height']);
  if (createdHeight !== null && !(Number.isSafeInteger(createdHeight) && createdHeight > 0)) {
    throw new Error(`--deployer-created-height takes the block height the deployer identity was created at (digits only), got ${args['deployer-created-height']}`);
  }
  if (args['abandon-live-set'] !== undefined && !forceNew) throw new Error('--abandon-live-set goes with --force-new (the only way to leave the live contract set)');
  // --replay (the same-id restore) re-registers the recorded set as it was: it runs alone
  const replay = Boolean(args.replay);
  if (args.replay !== undefined && args.replay !== true) throw new Error('--replay takes no value (the chain it restores from is --replay-from-chain <chain id>)');
  if (replay) {
    if (only !== null || update !== null || forceNew || acknowledged.length > 0) throw new Error('--replay runs alone: no --only, --update, --force-new or --acknowledge-nonce');
    if (args['replay-from-chain'] === undefined || args['replay-from-chain'] === true) {
      throw new Error("--replay needs --replay-from-chain <chain id>: the record's chainId, the chain the set was registered on (the reset one)");
    }
  } else if (args['replay-from-chain'] !== undefined) {
    throw new Error('--replay-from-chain goes with --replay');
  }

  // The record: the network's own for a committed set, else the scratch --record. A devnet's DAPI
  // addresses: --addresses, else the record's `dapiAddresses` (as deploy-key-exchange.mjs reads
  // them), else SDK discovery; testnet and mainnet always use SDK discovery.
  const depFile = recordPath({ network, devnetName, record: args.record, set: setName ?? undefined, contractsDir, deploymentsRoot });
  const liveFile = depPath(network, devnetName, deploymentsRoot);
  const scratch = depFile !== liveFile;
  // Production is the live testnet or mainnet record: a devnet run that names one is refused
  if (network === 'devnet' && ['testnet', 'mainnet'].some((n) => canonical(depFile) === canonical(depPath(n, undefined, deploymentsRoot)))) {
    throw new Error(`${depFile} is a production record; --network devnet never writes it`);
  }
  const production = !scratch && network !== 'devnet';
  // A scratch registration on testnet or mainnet is a rehearsal on a production network: its contracts
  // are permanent there and it spends its deployer's nonces on that chain. Say so by name (CONT-V-01
  // for the registration tool), and use a throwaway deployer (checked below, once the identity is read)
  const scratchOnProduction = scratch && network !== 'devnet';
  if (scratchOnProduction && args['scratch-on'] !== network) {
    throw new Error(
      `--record ${args.record} registers a SCRATCH set on ${network}, a production network: the contracts are permanent there and the ` +
        `run spends its deployer's nonces on the ${network} chain. A rehearsal must use its own throwaway deployer identity, never the ` +
        `production deployer. If that is the intent, re-run with --scratch-on ${network}. Nothing was broadcast.`
    );
  }
  if (!scratchOnProduction && args['scratch-on'] !== undefined) {
    throw new Error(`--scratch-on ${args['scratch-on']} goes with a scratch --record on testnet or mainnet; this run ${scratch ? 'is on a devnet' : `writes the live ${network} record`}`);
  }
  // One run at a time writes a record (a dry run writes nothing)
  if (!dryRun) locks.push(takeLock(depFile, { now }));
  const dep = readDep(depFile);
  const recordName = scratch ? depFile : `deployments/${basename(depFile)}`;
  // A scratch record without addresses borrows the network's (read only)
  const live = scratch ? readDep(liveFile) : dep;
  if (scratch) {
    const refused = scratchRecordError(dep, live);
    if (refused) throw new Error(`--record ${args.record}: ${refused}`);
  }
  const addresses = typeof args.addresses === 'string'
    ? args.addresses.split(',').map((s) => s.trim()).filter(Boolean)
    : (devnetName && (dep.dapiAddresses ?? dep.v2?.devnet?.addresses ?? live.dapiAddresses ?? live.v2?.devnet?.addresses)) || undefined;
  if (scratch) log(`scratch record ${depFile}${setName ? ` (set ${setName})` : ` (set ${contractsDir})`}`);

  // Refusals on the record, before anything connects (each names the file)
  const recorded = recordedSet(dep);
  if (setName !== null && recorded !== null && recorded !== setName) {
    throw new Error(`${recordName} was registered from the "${recorded}" set; --set ${setName} would register or update a different set into it. Use --set ${recorded}, or a scratch --record for another set.`);
  }
  if (dep.network !== undefined && dep.network !== network) throw new Error(`${recordName} records network ${dep.network}, not ${network}`);
  if (devnetName && dep.devnetName !== undefined && dep.devnetName !== devnetName) throw new Error(`${recordName} records devnet ${dep.devnetName}, not ${devnetName}`);
  // CNT-04: --force-new on the live testnet or mainnet record abandons the contract set every client reads
  if (forceNew && production && args['abandon-live-set'] !== network) {
    throw new Error(
      `--force-new on ${network} supersedes the live contract set in ${recordName}: every repository, issue and key ` +
        'binding under it stops being read, and every client needs a new release (docs/VERSIONING.md). ' +
        `If that is the decision (release plan 2.11), re-run with --abandon-live-set ${network}.`
    );
  }

  // --replay: the record must be a complete set with its ledger, registered on the chain named
  const replayPlan = replay ? planReplay(dep, { recordKeys: RECORD_KEYS, fromChain: String(args['replay-from-chain']), recordName }) : null;

  // What is registered must be in git, be the current build, and be what the owner signed
  // (testnet and mainnet refuse; a devnet only warns), with room under the transition limit
  // (checked once the transitions exist, below)
  const safe = (fn) => { try { return fn(); } catch { return undefined; } };
  const gitCommit = safe(git.head) ?? null;
  const problems = [];
  if (setName !== null) {
    const dirty = safe(() => git.porcelain(repoPath(contractsDir)));
    if (dirty === undefined) problems.push(`git cannot report on ${repoPath(contractsDir)}: the set's files cannot be shown to match HEAD`);
    else if (dirty) problems.push(`the set's files differ from git HEAD; commit them first: what is registered must be in git (${dirty.split('\n')[0].trim()})`);
    const build = safe(git.buildCheck);
    if (!build?.ok) problems.push(`${repoPath(contractsDir)} is not the current build (build.py --check failed); regenerate and commit it${build?.output ? `: ${build.output.split('\n')[0]}` : ''}`);
  }
  if (args['expect-sha256'] !== undefined) {
    // (a replay re-registers the recorded bytes: the sums are checked against those)
    problems.push(...sumsProblems(parseSums(readFileSync(resolve(String(args['expect-sha256'])), 'utf8')), replayPlan?.sums ?? fileSums).map((p) => `--expect-sha256: ${p}`));
  } else if (production) {
    problems.push(`--expect-sha256 <file> is required to register on ${network}: the sums the owner signed (--print-sha256 prints them)`);
  }
  if (gitCommit === null && setName !== null) problems.push('git cannot report HEAD: the commit being registered cannot be recorded');
  // The recorded commit must be one anyone can fetch: on a branch of origin
  const gitCommitPushed = gitCommit === null ? null : (safe(() => git.pushed(gitCommit)) ?? null);
  if (gitCommit !== null && setName !== null && gitCommitPushed !== true) {
    problems.push(gitCommitPushed === false
      ? `HEAD ${gitCommit.slice(0, 12)} is on no branch of origin: push it first, so the recorded gitCommit can be fetched`
      : 'git cannot report whether HEAD is on origin: the recorded gitCommit cannot be shown to be fetchable');
  }
  if (problems.length > 0) {
    if (production && !dryRun) throw new Error(`${network} ${replay ? 'replay' : 'registration'} refused, nothing was broadcast:\n  - ${problems.join('\n  - ')}`);
    for (const p of problems) log(`WARNING ${p}`);
  }

  const rec = JSON.parse(readFileSync(resolve(String(args.identity)), 'utf8'));
  const ownerId = rec.identityId;
  // A rehearsal must not spend the nonces the live deployer's registration is planned on, nor use any
  // identity the live record names (the deployer, a contract's owner, the group's owner, a superseded
  // deployer, the key-exchange owner)
  if (scratchOnProduction) {
    const named = recordedIdentities(live).get(ownerId);
    if (named) {
      throw new Error(`--record ${args.record}: ${ownerId} is recorded in deployments/${basename(liveFile)} (${named}); a scratch registration on ${network} uses its own throwaway deployer identity. Nothing was broadcast.`);
    }
    log(`WARNING SCRATCH registration on ${network}: its contracts are permanent on the ${network} chain and ${ownerId}'s nonces are spent there. A scratch rehearsal must NEVER use the production deployer.`);
    if (!live.v2?.deployer && !live.v2?.forgeCore) {
      log(`WARNING deployments/${basename(liveFile)} records no deployer yet, so ${ownerId} cannot be checked against the production deployer: confirm it is a throwaway identity that was never the offline-escrow one.`);
    }
  }
  // One deployer per record (the ledger is that identity's nonces): another one only registers a
  // new set into it (--force-new, which supersedes every recorded contract and archives the ledger)
  const recordedDeployer = dep.v2?.forgeCore?.ownerId ?? dep.v2?.deployer?.identityId;
  const deployerChanged = Boolean(recordedDeployer && recordedDeployer !== ownerId);
  if (deployerChanged && !(forceNew && only === null)) {
    throw new Error(`${recordName} was registered by ${recordedDeployer}; ${ownerId} can only register a new set into it (--force-new without --only). Nothing was broadcast.`);
  }
  if (replayPlan && dep.v2.deployer.identityId !== ownerId) {
    throw new Error(`--replay: ${recordName} was registered by ${dep.v2.deployer.identityId}, not ${ownerId}: restore that deployer (mint.mjs restore) and pass its file. Nothing was broadcast.`);
  }
  const critKey = pickKey(rec, 'AUTHENTICATION', 'CRITICAL');

  const evo = injected.evo ?? await loadEvoSdk();
  const { EvoSDK, DataContract, DataContractCreateTransition, DataContractUpdateTransition, PrivateKey, IdentityPublicKey } = evo;
  const sdkOptions = { network, trusted: true, settings: PUT_SETTINGS, version: PROTOCOL_VERSION };
  if (devnetName) sdkOptions.devnetName = devnetName;
  if (addresses) sdkOptions.addresses = addresses;
  const sdk = new EvoSDK(sdkOptions);
  log(`connecting (${network}${devnetName ? `/${devnetName}` : ''}, ${addresses ? `${addresses.length} addresses` : 'discovered addresses'})...`);
  await sdk.connect();

  const status = await sdk.system.status();
  const current = status.version.protocol.drive.current;
  if (current < PROTOCOL_VERSION) {
    throw new Error(`network runs protocol ${current}; forge-v2 needs ${PROTOCOL_VERSION} (contract groups, ownerRefersTo)`);
  }
  log(`network protocol ${current}, drive ${status.version.software.drive ?? '?'}`);

  // Which chain this is: the node's status, cross-checked with a proof (DPNS exists on every chain)
  // before anything is broadcast. A record of another chain means Platform was reset or the
  // network is not the one registered.
  const decodeChain = (bytes) => (bytes && bytes.length ? new TextDecoder().decode(bytes) : null);
  const statusChain = status.network?.chain_id ?? status.network?.chainId ?? safe(() => status.toJSON?.()?.network?.chainId) ?? null;
  let chainId = statusChain;
  try {
    const provedChain = decodeChain((await sdk.contracts.fetchWithProof(DPNS_CONTRACT_ID))?.metadata?.chainId);
    if (!provedChain) throw new Error('the proof names no chain id');
    if (statusChain && provedChain !== statusChain) {
      throw Object.assign(new Error(`proved chain id ${provedChain} differs from the node's status ${statusChain}`), { definite: true });
    }
    chainId ??= provedChain;
  } catch (e) {
    if (e?.definite) throw e;
    // testnet and mainnet: the chain is proved, or nothing is registered on it
    if (production) throw new Error(`could not prove the chain id of ${network} (${e?.message ?? e}); ${network} registration refused, nothing was broadcast`);
    log(`WARNING could not prove the chain id (${e?.message ?? e}); using the node's status`);
  }
  if (chainId === null) log('WARNING the node reports no chain id: the record cannot pin one');
  // (production has a proved chain id here: the catch above refused otherwise)
  if (production && !CHAIN_IDS[network].test(chainId)) {
    throw new Error(`the node serves chain ${chainId}, which is not a ${network} chain id (${CHAIN_IDS[network].source}); nothing was broadcast`);
  }
  const chainChanged = Boolean(dep.chainId && chainId && dep.chainId !== chainId);
  // (a replay is what moves a record to the new chain)
  if (chainChanged && !replay) {
    if (!forceNew) {
      throw new Error(
        `${recordName} records chain ${dep.chainId} but the network reports ${chainId}: ` +
          (network === 'devnet'
            ? 'the devnet was reset or this is another network. Move the record aside to start over, or use a new --record. Nothing was broadcast.'
            : 'Platform was reset or this is another network. To restore the same contract ids run the same-id restore ' +
              `(deploy-v2.mjs --replay); to register a new set: --force-new --abandon-live-set ${network}. Nothing was broadcast.`)
      );
    }
    if (only !== null) throw new Error(`${recordName} records chain ${dep.chainId} but the network reports ${chainId}: --only cannot move a set to another chain; use --force-new without --only`);
    log(`WARNING ${recordName} records chain ${dep.chainId}, the network reports ${chainId}: --force-new abandons every recorded contract`);
  }

  const identity = await sdk.identities.fetch(ownerId);
  if (!identity) {
    // A dry run only builds and sizes the transitions, which needs no identity on chain
    if (!dryRun) {
      throw new Error(`deployer identity ${ownerId} not found on ${network}${replay ? ': restore it from escrow first (node tools/mint-identity/mint.mjs restore --identity <escrowed deployer.identity.json>)' : ''}`);
    }
    log(`deployer ${ownerId} is not on this network; dry run continues with nonce 1`);
  } else {
    const onChainKey = identity.getPublicKeyById(critKey.id);
    if (!onChainKey || String(onChainKey.data).toLowerCase() !== critKey.publicKeyHex.toLowerCase()) {
      throw new Error(`key ${critKey.id} of ${ownerId} on chain does not match the identity file`);
    }
    if (onChainKey.disabledAt != null) {
      throw new Error(`key ${critKey.id} of ${ownerId} was disabled at ${onChainKey.disabledAt}; it cannot sign`);
    }
  }

  const publicKey = new IdentityPublicKey({
    keyId: critKey.id,
    purpose: critKey.purpose,
    securityLevel: critKey.securityLevel,
    keyType: critKey.keyType,
    isReadOnly: false,
    data: Buffer.from(critKey.publicKeyHex, 'hex'),
  });
  const privateKey = PrivateKey.fromWIF(critKey.privateKeyWif);

  const balance = async () => BigInt((await sdk.identities.balance(ownerId)) ?? 0n);
  // Identity nonces carry recent-document bits above bit 40; the contract id derives from the
  // low 40 bits (rs-dpp IDENTITY_NONCE_VALUE_FILTER), so mask whatever the query returns.
  const NONCE_MASK = 0xFFFFFFFFFFn;
  const chainNonce = async () => (identity ? BigInt((await sdk.identities.nonce(ownerId)) ?? 0n) & NONCE_MASK : 0n);
  const sourceOf = (schemaName) => ({
    sourceFile: repoPath(join(contractsDir, `${schemaName}.json`)),
    sourceSha256: fileSums[`${schemaName}.json`],
  });

  /**
   * One pass over the work against the record `d`. A dry pass works on a copy and never writes: it
   * builds, signs and sizes everything a real pass would broadcast. `prefix` marks the log of a
   * preflight pass; `roomProblems` collects the create transitions with too little room.
   */
  async function run({ dryRun, d, prefix = '', roomProblems = [] }) {
    const say = (m) => log(`${prefix}${m}`);
    d.v2 ??= {};
    const v2 = d.v2;
    const record = () => { if (!dryRun) writeDep(depFile, d); };
    const report = { network: devnetName ? `devnet-${devnetName}` : network, ownerId, steps: [] };
    if (dryRun) report.sha256 = fileSums;
    const used = new Set(); // acknowledged nonces this pass explained

    // The network's identity at the top of the record, then the chain it was registered on
    const stampTop = () => {
      const want = { network, ...(devnetName ? { devnetName } : {}), ...(chainId ? { chainId } : {}) };
      const missing = Object.keys(want).filter((k) => d[k] === undefined);
      if (missing.length > 0) {
        const rest = { ...d };
        for (const k of Object.keys(d)) delete d[k];
        Object.assign(d, Object.fromEntries(missing.map((k) => [k, want[k]])), rest);
      }
      // (set at the first write, so a crash after the first contract still names the set it is registering)
      if (setName !== null) v2.contractsSet ??= setName;
      else v2.contractsDir ??= repoPath(contractsDir);
    };

    // ---- the nonce ledger (CNT-02): every transition the deployer signed, in order ----
    const ledger = () => (v2.nonceLedger ??= []);
    // A transition's entries: a create by its identity nonce, an update by its contract and that
    // contract's own nonce (every contract's identity-contract nonce starts at 1)
    const entriesAt = (kind, key, nonceField, nonce, id) => (v2.nonceLedger ?? []).filter((e) =>
      e.kind === kind && e.key === key && e[nonceField] === String(nonce) && (kind !== 'dataContractUpdate' || e.contractId === id));
    // The open (`broadcasting`) entry of a transition: the one a step settles
    const entryFor = (...at) => entriesAt(...at).find((e) => e.status === 'broadcasting');
    const settle = (entry, patch) => { if (entry) Object.assign(entry, patch); };
    // Rewrite the entry of a reservation at the same nonce (one still `broadcasting`), else append
    // a new one. A settled entry (registered, updated, abandoned, superseded) is history: never rewritten.
    const writeEntry = (nonceField, entry) => {
      const same = entriesAt(entry.kind, entry.key, nonceField, entry[nonceField], entry.contractId);
      const settled = same.find((e) => e.status !== 'broadcasting' || e.supersededAt);
      if (settled) {
        throw new Error(`${entry.key}: the ledger already holds a ${settled.status}${settled.supersededAt ? ' (superseded)' : ''} ${entry.kind} at ${nonceField} ${entry[nonceField]}; a reservation never rewrites a settled entry. Nothing was broadcast.`);
      }
      if (same.length > 0) Object.assign(same[0], entry);
      else ledger().push(entry);
    };
    // The highest identity nonce of the ledger entries `counts` keeps (an abandoned reservation's
    // nonce went elsewhere and never counts)
    // After a same-id restore the chain holds, of the ledger before it, only the creates it replayed
    // (an external transition or a superseded contract of the old chain never happened on this one)
    const lastSigned = (counts) => {
      const restore = v2.restores?.at(-1);
      let last = 0n;
      for (const [i, e] of (v2.nonceLedger ?? []).entries()) {
        if (e.identityNonce === undefined || e.status === 'abandoned' || !counts(e)) continue;
        if (restore?.ledgerLength !== undefined && i < restore.ledgerLength && !restore.replayedNonces?.includes(e.identityNonce)) continue;
        if (BigInt(e.identityNonce) > last) last = BigInt(e.identityNonce);
      }
      return last;
    };
    const openCreate = (e) => e.kind === 'dataContractCreate' && e.status === 'broadcasting';
    // The ledger's last identity nonce: a reservation whose contract never landed and whose nonce
    // the chain has passed is not counted (the nonce went elsewhere)
    const ledgerLast = (staleKey, chain) => lastSigned((e) => !(staleKey && openCreate(e) && e.key === staleKey && chain >= BigInt(e.identityNonce)));
    // The highest identity nonce the record shows landed: the ledger's settled entries (a
    // reservation still `broadcasting` is not known to have landed) and every contract recorded
    // registered (a devnet record may predate the ledger). The chain's nonce is never below it; a
    // node that answers lower is behind, and a nonce chosen from its answer would be one already used.
    const recordedLast = (key) => {
      let last = lastSigned((e) => !openCreate(e));
      for (const k of RECORD_KEYS) {
        const n = k !== key && v2[k]?.status === 'registered' ? v2[k].identityNonce : undefined;
        if (n !== undefined && BigInt(n) > last) last = BigInt(n);
      }
      return last;
    };
    // The deployer's identity nonce, from a node that has caught up with the record: a lagging
    // node is asked again (as settledBalance does), then refused
    async function caughtUpNonce(key) {
      let chain = await chainNonce();
      if (!identity) return chain; // (a dry run without the deployer on chain: nonce 1)
      const floor = recordedLast(key);
      for (let i = 0; chain < floor && i < (injected.settleTries ?? 10); i++) {
        await new Promise((r) => setTimeout(r, injected.settleMs ?? 2000));
        chain = await chainNonce();
      }
      if (chain < floor) {
        throw new Error(
          `${key}: the node reports the deployer's identity nonce as ${chain}, but the record shows nonce ${floor} signed: ` +
            'the node is behind. Retry when it has caught up (or against other nodes). Nothing was broadcast.'
        );
      }
      return chain;
    }
    // Before a create is reserved: nothing else may have signed with the deployer since the ledger's
    // last entry, unless the operator said what it was
    async function checkLedger(key, chain, staleReservation) {
      // A devnet record without a ledger (sakura) starts one with this run. The live testnet or
      // mainnet record starts with a fresh deployer: whatever it signed before is unexplained.
      if (!production && !v2.nonceLedger?.some((e) => e.identityNonce !== undefined)) return;
      const last = ledgerLast(staleReservation ? key : null, chain);
      const unexplained = [];
      for (let n = last + 1n; n <= chain; n++) unexplained.push(n);
      const missing = unexplained.filter((n) => !acknowledged.includes(n));
      if (missing.length > 0) {
        throw new Error(
          `the deployer's identity nonce is ${chain} on chain but the ledger ends at ${last}: something else signed with the deployer ` +
            `(a key change or a transfer?${staleReservation ? ` Or the reserved ${key} ${v2[key].contractId} did land and is not visible yet: check it first.` : ''}). ` +
            'The same-id restore replays this ledger in nonce order (CNT-02), so record it: ' +
            `--acknowledge-nonce ${missing.join(' --acknowledge-nonce ')} --note "<what it was>". Nothing was broadcast.`
        );
      }
      const stray = acknowledged.filter((n) => !unexplained.includes(n) && !used.has(n));
      if (stray.length > 0) {
        throw new Error(`--acknowledge-nonce ${stray.join(', ')}: only the nonces after the ledger's last (${last}) up to the chain's (${chain}) can be acknowledged`);
      }
      // A nonce that created a contract was the deployer's contract create (one of the set's that
      // landed unseen?), not something else's transition: it is never recorded as `external`. The
      // one exception is the record's own key-exchange contract (deploy-key-exchange.mjs, on a devnet).
      for (const n of unexplained.filter((x) => !used.has(x))) {
        const id = contractId(ownerId, n);
        if (id !== d.keyExchange?.contractId && await sdk.contracts.fetch(id)) {
          throw new Error(
            `--acknowledge-nonce ${n}: identity nonce ${n} created contract ${id}, a contract create of the deployer's (not the record's keyExchange), so it is no external transition. ` +
              `Check whether it is a reservation of this set (${RECORD_KEYS.map((k) => `v2.${k}`).join(', ')}) and settle the record by hand. Nothing was broadcast.`
          );
        }
      }
      for (const n of unexplained) {
        if (!dryRun) ledger().push({ identityNonce: n.toString(), kind: 'external', note: String(args.note), at: stamp() });
        used.add(n);
      }
    }

    // The metadata a proof of the contract carries: an upper bound on its registration block
    // (evo-sdk's wait result has no height, and a contract keeps no history)
    async function provedAt(id) {
      try {
        const m = (await sdk.contracts.fetchWithProof(id))?.metadata;
        if (!m) return null;
        const proved = decodeChain(m.chainId);
        if (proved && chainId && proved !== chainId) say(`WARNING ${id} was proved on chain ${proved}, the node's status says ${chainId}`);
        return { height: String(m.height), coreChainLockedHeight: m.coreChainLockedHeight, epoch: m.epoch, timeMs: String(m.timeMs), protocolVersion: m.protocolVersion };
      } catch (e) {
        say(`WARNING could not read the proof metadata of ${id}: ${e?.message ?? e}`);
        return null;
      }
    }

    // Everything else in the record that names contract `id`: another contract's record, another
    // create in the ledger, or (on this chain) a superseded record. A chain change archives the
    // ledger, and the new chain's ids repeat the old ones, so the superseded lists count only
    // while the record has never changed chain (a same-chain supersede also marks its ledger entry).
    const claimsOn = (key, id) => {
      const claims = RECORD_KEYS.filter((k) => k !== key && v2[k]?.contractId === id).map((k) => `v2.${k}`);
      for (const e of v2.nonceLedger ?? []) {
        if (e.kind === 'dataContractCreate' && e.contractId === id && e.status !== 'abandoned' && (e.key !== key || e.supersededAt)) {
          claims.push(`the ledger's ${e.key} create at nonce ${e.identityNonce}${e.supersededAt ? ' (superseded)' : ''}`);
        }
      }
      if (!v2.nonceLedgerSuperseded?.length) {
        for (const k of RECORD_KEYS) if ((v2[`${k}Superseded`] ?? []).some((s) => s.contractId === id)) claims.push(`v2.${k}Superseded`);
      }
      return claims;
    };

    // A step whose recorded contract is on chain is finished; bring its record up to date
    // (a crash between broadcast and the final write leaves it `broadcasting`, without cost).
    async function reconcile(key, json) {
      const currentHash = schemaHash(json);
      const existing = v2[key];
      if (!existing?.contractId) return null;
      const claims = claimsOn(key, existing.contractId);
      if (claims.length > 0) {
        throw new Error(
          `${key}: the record names ${existing.contractId}, which ${claims.join(' and ')} also names: one nonce was reserved for two contracts ` +
            '(a node answered a stale identity nonce). Settle the record by hand against the chain. Nothing was broadcast.'
        );
      }
      const onChain = await sdk.contracts.fetch(existing.contractId);
      if (onChain) {
        if (existing.status !== 'registered') {
          // A reservation is completed only with the contract it built: the schema on chain must be
          // the reservation's (one without its own documentsHash is of the current schema, or unprovable)
          let want = existing.documentsHash ?? null;
          if (want === null && existing.schemaHash === currentHash) want = documentsHash(json);
          const got = documentsHash(onChain.toJSON?.());
          if (want === null || got !== want) {
            const why = want === null ? 'the reservation records no schema it can be compared with' : `its schema (${got.slice(0, 12)}…) is not the reservation's (${want.slice(0, 12)}…)`;
            throw new Error(`${key}: ${existing.contractId} is on chain, but ${why}: it is not the contract this reservation broadcast. Settle the record by hand against the chain. Nothing was broadcast.`);
          }
        }
        if (existing.schemaHash && existing.schemaHash !== currentHash) {
          // a scratch set is registered whole from its own schemas: a stale one is never reused
          if (scratch) throw new Error(`${key}: ${existing.contractId} in the scratch record was registered from another schema; start a new --record`);
          const dependent = DEPENDENTS.find((c) => c.key === key);
          say(`${key}: WARNING ${existing.contractId} was registered from a different schema (${existing.schemaHash.slice(0, 12)}… != ${currentHash.slice(0, 12)}…); it is left as is${dependent ? ` (--only ${dependent.only} --force-new --same-group registers the current one)` : ''}`);
        }
        if (existing.status !== 'registered') {
          const cost = existing.balanceBefore != null ? BigInt(existing.balanceBefore) - (await balance()) : null;
          const proved = await provedAt(existing.contractId);
          v2[key] = {
            ...existing,
            ownerId,
            status: 'registered',
            confirmedAt: stamp(),
            ...(proved ? { provedAt: proved } : {}),
            ...(cost != null ? { costCredits: cost.toString(), costDash: Number(cost) / CREDITS_PER_DASH, costNote: 'balance delta since the recorded pre-broadcast balance' } : {}),
          };
          settle(entryFor('dataContractCreate', key, 'identityNonce', existing.identityNonce), { status: 'registered' });
          record();
          say(`${key}: found ${existing.contractId} on chain; record updated to registered`);
        } else {
          say(`${key}: already registered as ${existing.contractId}`);
        }
        report.steps.push({ key, ...v2[key], resumed: true });
        return existing.contractId;
      }
      if (existing.status === 'registered') {
        throw new Error(`${key}: the record says ${existing.contractId} is registered but the network does not have it (devnet reset?). Move deployments/${report.network}.json aside to start over.`);
      }
      // Reserved but never landed: the nonce it named is either still free (reused below, same
      // id) or was consumed by something else (a fresh nonce, a fresh id). Either way the next
      // nonce is read from the chain, and the record is rewritten with it before broadcasting.
      say(`${key}: a previous run reserved nonce ${existing.identityNonce} (${existing.contractId}) but it never landed`);
      return null;
    }

    // The contract JSON a transition carries: the schema file's parts under this id and version.
    const contractJson = (json, id, version) => ({
      $formatVersion: '1',
      id,
      ownerId,
      version,
      ...(json.config ? { config: json.config } : {}),
      ...(json.description ? { description: json.description } : {}),
      ...(json.keywords ? { keywords: json.keywords } : {}),
      schemaDefs: json.schemaDefs,
      documentSchemas: json.documentSchemas,
    });
    // A node can answer the balance query from the block before the one that applied the
    // transition (the moutai deploy recorded forge-collab at 0 this way), so wait for it to move.
    async function settledBalance(before) {
      let after = await balance();
      for (let i = 0; after === before && i < (injected.settleTries ?? 10); i++) {
        await new Promise((r) => setTimeout(r, injected.settleMs ?? 2000));
        after = await balance();
      }
      return after;
    }

    // In a dry run nothing is broadcast, so the next contract's nonce is one past this one's
    let dryRunNextNonce = null;

    // The group a contract enrols in: owned by the deployer, no admins (Forge clients refuse a group
    // with admins, docs/contracts/forge-v2.md rule 1), and the description it was registered with
    // (the recorded one, else this set's). `optional`: an absent group is not an error (checked
    // ahead of the broadcasts, for a group an earlier run registered).
    async function verifyGroup(groupId, { optional = false } = {}) {
      const info = await sdk.contractGroups.info(groupId);
      if (!info && optional) return null;
      if (!info || info.ownerId !== ownerId) throw new Error(`contract group ${groupId} not found or not owned by ${ownerId}`);
      const admins = Array.isArray(info.adminIds) ? [...info.adminIds] : null;
      if (admins === null) {
        const m = `the SDK reports no admin list for contract group ${groupId}: its admins cannot be checked`;
        if (production) throw new Error(m);
        say(`WARNING ${m}`);
      } else if (admins.length > 0) {
        throw new Error(`contract group ${groupId} has admins ${admins.join(', ')}; Forge clients refuse a group with admins (forge-v2.md rule 1)`);
      }
      const wantDescription = v2.contractGroup?.description ?? GROUP_DESCRIPTION;
      if (info.description !== wantDescription) {
        const m = `contract group ${groupId} has description ${JSON.stringify(info.description)}, not ${JSON.stringify(wantDescription)}`;
        if (production) throw new Error(m);
        say(`WARNING ${m}`);
      }
      return { info, admins: admins ?? [] };
    }

    // Build, check and (unless --dry-run) broadcast one contract create. The nonce, contract id
    // and (for forge-core) the contract group id derived from THAT nonce are recorded together
    // BEFORE broadcasting, so a crash after broadcast resumes against the right ids.
    async function registerContract({ key, schemaName, substitutions, registerGroup, groupIdFor }) {
      const json = load(schemaName, substitutions);
      const hash = schemaHash(json);
      const docsHash = documentsHash(json);
      const done = await reconcile(key, json);
      if (done) return done;
      const reservation = v2[key]?.status === 'broadcasting' ? v2[key] : null;

      // (never below the record's last signed nonce: a node that answers lower is refused; a dry
      // pass past its first create takes the next nonce after the one it would have spent, below)
      const chain = dryRunNextNonce !== null ? await chainNonce() : await caughtUpNonce(key);
      await checkLedger(key, chain, reservation !== null);
      const nonce = dryRunNextNonce ?? chain + 1n;
      if (dryRun) dryRunNextNonce = nonce + 1n;
      const id = contractId(ownerId, nonce);
      const groupId = groupIdFor(nonce);

      // Full validation, the same parse a node's action transform runs (a cross-contract
      // reference is resolved only at registration, against state)
      const contract = DataContract.fromJSON(contractJson(json, id, 1), true, PROTOCOL_VERSION);
      if (contract.id.toString() !== id) throw new Error(`${key}: contract id mismatch ${contract.id} != ${id}`);

      const transition = new DataContractCreateTransition(contract, nonce, PROTOCOL_VERSION);
      if (registerGroup) transition.setContractGroup({ admins: [], name: GROUP.name, description: GROUP_DESCRIPTION });
      transition.setContractGroupMemberships([{ contractGroupId: b58decode(groupId), member: 'contract' }]);
      const st = transition.toStateTransition();
      st.sign(privateKey, publicKey);
      const stBytes = st.toBytes();
      const transitionSha256 = sha256Hex(stBytes);
      const size = stBytes.length;
      const room = MAX_STATE_TRANSITION_SIZE - size;
      say(`${key}: id ${id}, nonce ${nonce}, group ${groupId}, signed create transition ${size} B (limit ${MAX_STATE_TRANSITION_SIZE}, room ${room} B)`);
      if (size > MAX_STATE_TRANSITION_SIZE) throw new Error(`${key}: transition exceeds max_state_transition_size`);
      if (room < ROOM_MIN) {
        const message = `${schemaName}: create transition ${formatBytes(size)} B leaves ${formatBytes(room)} B of room, under the ${formatBytes(ROOM_MIN)} B floor (D44)`;
        roomProblems.push(message);
        if (production && !dryRun) throw new Error(message);
        say(`WARNING ${message}`);
      }
      if (dryRun) {
        report.steps.push({ key, contractId: id, nonce: nonce.toString(), contractGroupId: groupId, sizeBytes: size, roomBytes: room, schemaHash: hash, documentsHash: docsHash, ...sourceOf(schemaName), dryRun: true });
        return id;
      }

      const before = await balance();
      stampTop();
      v2[key] = {
        contractId: id,
        ownerId,
        identityNonce: nonce.toString(),
        contractGroupId: groupId,
        status: 'broadcasting',
        sizeBytes: size,
        roomBytes: room,
        schemaHash: hash,
        registeredSchemaHash: hash,
        documentsHash: docsHash,
        ...sourceOf(schemaName),
        transitionSha256,
        gitCommit,
        gitCommitPushed,
        balanceBefore: before.toString(),
      };
      // The ledger entry is written with the reservation. A reservation that never landed and
      // whose nonce is not the one chosen now is abandoned, one at the same nonce is rewritten.
      if (reservation && reservation.identityNonce !== nonce.toString()) {
        settle(entryFor('dataContractCreate', key, 'identityNonce', reservation.identityNonce), { status: 'abandoned', abandonedAt: stamp() });
      }
      const entry = {
        identityNonce: nonce.toString(),
        kind: 'dataContractCreate',
        key,
        contractId: id,
        contractGroupId: groupId,
        registersGroup: Boolean(registerGroup),
        schemaHash: hash,
        documentsHash: docsHash,
        sourceSha256: fileSums[`${schemaName}.json`],
        transitionSha256,
        gitCommit,
        gitCommitPushed,
        status: 'broadcasting',
        at: stamp(),
      };
      writeEntry('identityNonce', entry);
      record();

      await sdk.stateTransitions.broadcastAndWait(st, PUT_SETTINGS);
      const after = await settledBalance(before);
      const fetched = await sdk.contracts.fetch(id);
      if (!fetched) throw new Error(`${key}: broadcast confirmed but ${id} cannot be fetched`);
      const proved = await provedAt(id);
      const costCredits = before - after;
      v2[key] = {
        ...v2[key],
        status: 'registered',
        deployedAt: stamp(),
        costCredits: costCredits.toString(),
        costDash: Number(costCredits) / CREDITS_PER_DASH,
        ...(proved ? { provedAt: proved } : {}),
      };
      settle(entryFor('dataContractCreate', key, 'identityNonce', nonce), { status: 'registered' });
      record();
      say(`${key}: registered; cost ${(Number(costCredits) / CREDITS_PER_DASH).toFixed(6)} DASH`);
      report.steps.push({ key, ...v2[key] });
      return id;
    }

    // --update <core|collab|community|all>: an in-place DataContractUpdate of each recorded contract
    // to its current schema, as the next version (in registration order: core, collab, community).
    // Returns the step to report; resumable (see the header).
    async function updateContract({ key, schemaName, substitutions }) {
      const rec = v2[key];
      if (!rec?.contractId || rec.status !== 'registered') throw new Error(`--update: no registered ${schemaName} recorded for this network`);
      const json = load(schemaName, substitutions);
      const hash = schemaHash(json);
      const onChain = await sdk.contracts.fetch(rec.contractId);
      if (!onChain) throw new Error(`--update: ${rec.contractId} is recorded but not on chain`);
      const chainVersion = Number(onChain.version);
      // Close an update out: the version and schema it took the contract to, and what it cost.
      const complete = (pending, cost, extra) => {
        rec.updates = [...(rec.updates ?? []), { ...pending, status: 'updated', costCredits: cost.toString(), costDash: Number(cost) / CREDITS_PER_DASH, ...extra }];
        rec.version = pending.version;
        rec.schemaHash = pending.schemaHash;
        delete rec.pendingUpdate;
        settle(entryFor('dataContractUpdate', key, 'contractNonce', pending.identityNonce, rec.contractId), { status: 'updated' });
        record();
      };
      // An earlier run's broadcast is settled first, and only for the schema it broadcast: with the
      // schema edited since, or the chain past the version it named, the record cannot say what is
      // on chain, so the run stops rather than broadcast another version or mark the wrong one done.
      const pending = rec.pendingUpdate;
      if (pending) {
        if (pending.schemaHash !== hash) throw new Error(`${key}: an earlier --update broadcast version ${pending.version} of schema ${pending.schemaHash.slice(0, 12)}…, not the current one; check the chain and settle v2.${key}.pendingUpdate by hand`);
        if (chainVersion > pending.version) throw new Error(`${key}: the chain is at version ${chainVersion}, past the pending update's ${pending.version}; settle v2.${key}.pendingUpdate by hand`);
        if (chainVersion === pending.version) {
          // It landed; finish the record.
          complete(pending, BigInt(pending.balanceBefore) - (await balance()), { confirmedAt: stamp(), costNote: 'balance delta since the recorded pre-broadcast balance' });
          say(`${key}: found version ${chainVersion} on chain; record completed`);
          return { key, ...rec, resumed: true };
        }
        say(`${key}: the pending update to version ${pending.version} did not land; broadcasting it again`);
      } else if (rec.schemaHash === hash) {
        say(`${key}: ${rec.contractId} is already at the current schema (version ${chainVersion}); nothing to update`);
        return { key, ...rec, resumed: true };
      }
      const version = chainVersion + 1;
      const contract = DataContract.fromJSON(contractJson(json, rec.contractId, version), true, PROTOCOL_VERSION);
      // A contract update is checked against the identity-CONTRACT nonce (drive-abci
      // data_contract_update/identity_contract_nonce), not the identity nonce registration uses: a
      // deployer with more than 23 transitions would be refused with the wrong one.
      const nonce = ((BigInt((await sdk.identities.contractNonce(ownerId, rec.contractId)) ?? 0n)) & NONCE_MASK) + 1n;
      const st = new DataContractUpdateTransition(contract, nonce, PROTOCOL_VERSION).toStateTransition();
      st.sign(privateKey, publicKey);
      const stBytes = st.toBytes();
      const transitionSha256 = sha256Hex(stBytes);
      const size = stBytes.length;
      say(`${key}: update ${rec.contractId} v${chainVersion} -> v${version}, nonce ${nonce}, signed transition ${size} B (limit ${MAX_STATE_TRANSITION_SIZE})`);
      if (size > MAX_STATE_TRANSITION_SIZE) throw new Error(`${key}: update transition exceeds max_state_transition_size`);
      if (dryRun) return { key, contractId: rec.contractId, update: { from: chainVersion, to: version }, sizeBytes: size, schemaHash: hash, ...sourceOf(schemaName), dryRun: true };
      const before = await balance();
      stampTop();
      // (`identityNonce` below is the identity-contract nonce, as earlier records spell it)
      rec.pendingUpdate = { version, identityNonce: nonce.toString(), sizeBytes: size, transitionSha256, schemaHash: hash, previousSchemaHash: rec.schemaHash ?? null, ...sourceOf(schemaName), gitCommit, gitCommitPushed, balanceBefore: before.toString() };
      const entry = { contractNonce: nonce.toString(), kind: 'dataContractUpdate', key, contractId: rec.contractId, version, schemaHash: hash, previousSchemaHash: rec.schemaHash ?? null, sourceSha256: fileSums[`${schemaName}.json`], transitionSha256, gitCommit, gitCommitPushed, status: 'broadcasting', at: stamp() };
      writeEntry('contractNonce', entry);
      record();
      try {
        await sdk.stateTransitions.broadcastAndWait(st, PUT_SETTINGS);
      } catch (e) {
        // evo-sdk proves a contract update by the state it affected, and its strict wait refuses
        // that result ("affected state only"): the update landed; the version check below decides.
        if (!/affected state only|VerifiedDataContract snapshot/i.test(String(e?.message ?? e))) throw e;
      }
      const after = await settledBalance(before);
      // The SDK cached the contract fetched above: drop it, so the check reads the new version
      sdk.wasm?.removeCachedContract?.(onChain.id);
      const fetched = await sdk.contracts.fetch(rec.contractId);
      if (!fetched || Number(fetched.version) !== version) throw new Error(`${key}: update broadcast but the chain shows version ${fetched ? fetched.version : 'none'}`);
      complete(rec.pendingUpdate, before - after, { updatedAt: stamp() });
      say(`${key}: updated to version ${version}; cost ${(Number(before - after) / CREDITS_PER_DASH).toFixed(6)} DASH`);
      return { key, ...rec };
    }
    if (update !== null) {
      // The recorded ids stand in for the placeholders (a dependent's schema names the earlier ones)
      const all = [{ key: 'forgeCore', schemaName: 'forge-core', only: 'core' }, ...DEPENDENTS];
      const ids = Object.fromEntries(all.filter((c) => v2[c.key]?.contractId).map((c) => [placeholderFor(c.schemaName), v2[c.key].contractId]));
      for (const c of all.filter((x) => update === 'all' || x.only === update)) {
        report.steps.push(await updateContract({ key: c.key, schemaName: c.schemaName, substitutions: c.key === 'forgeCore' ? {} : ids }));
      }
      return report;
    }

    // --replay: the same-id restore. Every step is checked (bytes, schema hash, derived ids) before
    // the first is signed; then the ledger's creates and updates of the live set are sent in its
    // order, each skipped when the chain already has it (a resumed replay).
    async function replayLedger() {
      const { ops, group, keys, skipped, fromChain } = replayPlan;
      const frozenDir = scratch ? null : join(injected.registeredRoot ?? join(ROOT, 'contracts', 'registered'), basename(depFile, '.json'));
      const ids = Object.fromEntries(keys.map((k) => [placeholderFor(SCHEMA_OF_KEY[k]), v2[k].contractId]));
      // 1. Check everything first
      const steps = [];
      const finalHash = {};
      for (const op of ops) {
        const rec = v2[op.key];
        const at = op.kind === 'create'
          ? { sourceFile: rec.sourceFile, gitCommit: rec.gitCommit ?? op.entry.gitCommit, frozen: frozenDir && join(frozenDir, `${op.schemaName}.v1.json`) }
          : { sourceFile: rec.updates?.find((u) => u.version === op.entry.version)?.sourceFile ?? rec.sourceFile, gitCommit: op.entry.gitCommit };
        const what = `${op.key} ${op.kind === 'create' ? `create (nonce ${op.nonce})` : `update to version ${op.entry.version}`}`;
        const bytes = replaySource({ what, ...at, sourceSha256: op.kind === 'create' ? rec.sourceSha256 : op.entry.sourceSha256 }, git);
        // (a create names only the contracts registered before it, an update every recorded one, as --update does)
        const names = op.kind === 'create' ? Object.fromEntries(Object.entries(ids).filter(([, id]) => steps.some((s) => s.kind === 'create' && s.id === id))) : ids;
        const json = loadSchema(op.schemaName, names, bytes.toString('utf8'));
        const want = op.kind === 'create' ? (rec.registeredSchemaHash ?? op.entry.schemaHash) : op.entry.schemaHash;
        if (schemaHash(json) !== want || (op.kind === 'create' && op.entry.schemaHash !== want)) {
          throw new Error(`--replay: ${what}: its schema with the recorded ids hashes to ${schemaHash(json).slice(0, 12)}…, not the recorded ${String(want).slice(0, 12)}… (does it name a superseded contract the replay does not re-create?). Nothing was broadcast.`);
        }
        if (op.kind === 'create') {
          const id = contractId(ownerId, op.nonce);
          if (id !== rec.contractId) throw new Error(`--replay: ${op.key}: nonce ${op.nonce} of ${ownerId} derives ${id}, not the recorded ${rec.contractId}. Nothing was broadcast.`);
          if (op.key === 'forgeCore' && (contractGroupId(ownerId, op.nonce) !== group || !op.entry.registersGroup)) {
            throw new Error(`--replay: forge-core's nonce ${op.nonce} derives contract group ${contractGroupId(ownerId, op.nonce)}, not the recorded ${group} (or its create did not register it). Nothing was broadcast.`);
          }
          steps.push({ ...op, id, json, docsHash: documentsHash(json) });
        } else {
          if (op.entry.previousSchemaHash && op.entry.previousSchemaHash !== finalHash[op.key]) {
            throw new Error(`--replay: ${what} follows schema ${String(op.entry.previousSchemaHash).slice(0, 12)}…, but the replay has the contract at ${String(finalHash[op.key]).slice(0, 12)}…. Nothing was broadcast.`);
          }
          steps.push({ ...op, id: rec.contractId, json });
        }
        finalHash[op.key] = want;
      }
      for (const k of keys) {
        if (finalHash[k] !== v2[k].schemaHash) throw new Error(`--replay: replaying the ledger leaves ${k} at schema ${String(finalHash[k]).slice(0, 12)}…, not the recorded ${String(v2[k].schemaHash).slice(0, 12)}…. Nothing was broadcast.`);
      }

      // 2. What this chain has already: nothing (a fresh reset), or the start of an interrupted replay
      const onChain = {};
      for (const k of keys) onChain[k] = await sdk.contracts.fetch(v2[k].contractId);
      for (const s of steps.filter((x) => x.kind === 'create' && onChain[x.key])) {
        const c = onChain[s.key];
        if (Number(c.version) === 1 && documentsHash(c.toJSON?.()) !== s.docsHash) {
          throw new Error(`--replay: ${s.key}: ${s.id} is on this chain with another schema than the one recorded: settle it by hand. Nothing was broadcast.`);
        }
      }
      const sameChain = Boolean(chainId) && chainId === d.chainId;
      if (sameChain) {
        const missing = keys.filter((k) => !onChain[k]);
        if (missing.length === 0 && keys.every((k) => Number(onChain[k].version) === (v2[k].version ?? 1))) {
          say(`nothing to replay: the network is still ${chainId}, and every recorded contract is on it at its recorded version`);
          report.replay = { nothingToReplay: true, chainId };
          return report;
        }
        // A testnet reset renumbers dash-testnet-<n>; a devnet such as sakura keeps its chain id
        if (network !== 'devnet') {
          throw new Error(`--replay: the network still reports ${chainId}, the record's chain, yet ${missing.join(', ') || 'a recorded update'} is not on it: this is no Platform reset (one renumbers the chain id). Nothing was broadcast.`);
        }
        say(`WARNING the devnet still reports chain ${chainId} (a devnet keeps its chain id across a reset); ${missing.join(', ')} not on it: replaying`);
      }
      const chain = await chainNonce();
      const gap = nonceGapProblem(steps.filter((s) => s.kind === 'create' && !onChain[s.key]), chain);
      if (gap) {
        throw new Error(`--replay: ${gap}. A same-id restore is impossible; register a new set instead (--force-new --abandon-live-set ${network}). Nothing was broadcast.`);
      }
      for (const e of skipped) say(`identity nonce ${e.identityNonce}: ${e.kind}${e.key ? ` ${e.key}` : ''}${e.superseded ? ' (superseded)' : e.status ? ` (${e.status})` : ''}${e.note ? `: ${e.note}` : ''}: not replayed (a gap)`);
      const external = skipped.filter((e) => e.kind === 'external');
      if (external.length > 0) say(`WARNING ${external.length} external transition(s) of the old chain are not redone (${external.map((e) => `nonce ${e.identityNonce}: ${e.note ?? '?'}`).join('; ')}): redo any that still matter (a key rotation) by hand`);

      // 3. Send them, in the ledger's order
      const description = v2.contractGroup?.description ?? GROUP_DESCRIPTION;
      let updatesReplayed = 0;
      // each contract's version as this pass leaves it (a dry pass sends nothing, so it counts)
      const version = Object.fromEntries(keys.map((k) => [k, onChain[k] ? Number(onChain[k].version) : 0]));
      for (const s of steps) {
        if (s.kind === 'create') {
          if (onChain[s.key]) {
            say(`${s.key}: ${s.id} is on this chain already (a resumed replay)`);
            continue;
          }
          version[s.key] = 1;
          const contract = DataContract.fromJSON(contractJson(s.json, s.id, 1), true, PROTOCOL_VERSION);
          if (contract.id.toString() !== s.id) throw new Error(`${s.key}: contract id mismatch ${contract.id} != ${s.id}`);
          const transition = new DataContractCreateTransition(contract, s.nonce, PROTOCOL_VERSION);
          if (s.key === 'forgeCore') transition.setContractGroup({ admins: [], name: GROUP.name, description });
          transition.setContractGroupMemberships([{ contractGroupId: b58decode(group), member: 'contract' }]);
          const st = transition.toStateTransition();
          st.sign(privateKey, publicKey);
          const stBytes = st.toBytes();
          const size = stBytes.length;
          const room = MAX_STATE_TRANSITION_SIZE - size;
          const same = sha256Hex(stBytes) === s.entry.transitionSha256;
          say(`${s.key}: replay create of ${s.id} at nonce ${s.nonce}, group ${group}, ${size} B (room ${room} B${same ? ', the bytes registered' : ''})`);
          if (size > MAX_STATE_TRANSITION_SIZE) throw new Error(`${s.key}: transition exceeds max_state_transition_size`);
          if (room < ROOM_MIN) {
            const message = `${s.schemaName}: create transition ${formatBytes(size)} B leaves ${formatBytes(room)} B of room, under the ${formatBytes(ROOM_MIN)} B floor (D44)`;
            roomProblems.push(message);
            if (production && !dryRun) throw new Error(message);
            say(`WARNING ${message}`);
          }
          if (dryRun) {
            report.steps.push({ key: s.key, contractId: s.id, nonce: s.nonce.toString(), contractGroupId: group, sizeBytes: size, roomBytes: room, replay: true, dryRun: true });
            continue;
          }
          await sdk.stateTransitions.broadcastAndWait(st, PUT_SETTINGS);
          const fetched = await sdk.contracts.fetch(s.id);
          if (!fetched) throw new Error(`${s.key}: broadcast confirmed but ${s.id} cannot be fetched`);
          onChain[s.key] = fetched;
          v2[s.key].restoredAt = stamp();
          record();
          report.steps.push({ key: s.key, contractId: s.id, nonce: s.nonce.toString(), replay: true });
          say(`${s.key}: ${s.id} registered again`);
          continue;
        }
        // an update: the contract must be at the version before it (or past it, a resumed replay)
        const current = dryRun ? null : await sdk.contracts.fetch(s.id);
        const chainVersion = current ? Number(current.version) : version[s.key];
        if (chainVersion >= s.entry.version) {
          say(`${s.key}: version ${s.entry.version} is on this chain already (a resumed replay)`);
          continue;
        }
        if (chainVersion !== s.entry.version - 1) throw new Error(`--replay: ${s.key} is at version ${chainVersion} on this chain; the next recorded update is to ${s.entry.version}`);
        const contract = DataContract.fromJSON(contractJson(s.json, s.id, s.entry.version), true, PROTOCOL_VERSION);
        const nonce = ((BigInt((await sdk.identities.contractNonce(ownerId, s.id)) ?? 0n)) & NONCE_MASK) + 1n;
        const st = new DataContractUpdateTransition(contract, nonce, PROTOCOL_VERSION).toStateTransition();
        st.sign(privateKey, publicKey);
        const size = st.toBytes().length;
        say(`${s.key}: replay update of ${s.id} to version ${s.entry.version}, contract nonce ${nonce}, ${size} B`);
        if (size > MAX_STATE_TRANSITION_SIZE) throw new Error(`${s.key}: update transition exceeds max_state_transition_size`);
        version[s.key] = s.entry.version;
        if (dryRun) {
          report.steps.push({ key: s.key, contractId: s.id, update: { to: s.entry.version }, sizeBytes: size, replay: true, dryRun: true });
          continue;
        }
        try {
          await sdk.stateTransitions.broadcastAndWait(st, PUT_SETTINGS);
        } catch (e) {
          // (evo-sdk's strict wait refuses an update's proof, as in --update: the version check decides)
          if (!/affected state only|VerifiedDataContract snapshot/i.test(String(e?.message ?? e))) throw e;
        }
        if (current) sdk.wasm?.removeCachedContract?.(current.id);
        const fetched = await sdk.contracts.fetch(s.id);
        if (!fetched || Number(fetched.version) !== s.entry.version) throw new Error(`${s.key}: update broadcast but the chain shows version ${fetched ? fetched.version : 'none'}`);
        updatesReplayed += 1;
        report.steps.push({ key: s.key, contractId: s.id, update: { to: s.entry.version }, replay: true });
        say(`${s.key}: updated to version ${s.entry.version} again`);
      }
      if (dryRun) {
        report.replay = { fromChainId: d.chainId, toChainId: chainId, dryRun: true };
        return report;
      }

      // 4. The group and every member, then the record: ids, ledger and hashes unchanged
      const { admins } = await verifyGroup(group);
      for (const k of keys) {
        const m = await sdk.contractGroups.forContract(v2[k].contractId);
        if (!m.contract.includes(group)) throw new Error(`${k} is not enrolled in ${group}`);
        const c = await sdk.contracts.fetch(v2[k].contractId);
        if (!c || Number(c.version) !== (v2[k].version ?? 1)) throw new Error(`${k}: the chain has version ${c?.version ?? 'none'}, the record ${v2[k].version ?? 1}`);
      }
      const at = stamp();
      const proved = {};
      for (const k of keys) {
        v2[k].restoredAt ??= at;
        proved[k] = await provedAt(v2[k].contractId);
      }
      v2.restores = [...(v2.restores ?? []), {
        at,
        fromChainId: d.chainId ?? fromChain,
        toChainId: chainId,
        replayed: keys,
        updatesReplayed,
        replayedNonces: steps.filter((s) => s.kind === 'create').map((s) => s.entry.identityNonce),
        ledgerLength: (v2.nonceLedger ?? []).length,
        notReplayed: skipped,
        provedAt: proved,
        gitCommit,
        sdk: injected.sdkId ?? installedSdk(),
      }];
      if (chainId) d.chainId = chainId;
      v2.contractGroup = { ...(v2.contractGroup ?? {}), admins, verifiedAt: at };
      record();
      say(`same-id restore done: ${keys.join(', ')} and group ${group} are on ${chainId ?? 'this chain'} at their recorded ids`);
      report.replay = { fromChainId: v2.restores.at(-1).fromChainId, toChainId: chainId, replayed: keys, updatesReplayed };
      report.contractGroupId = group;
      return report;
    }
    if (replayPlan) return replayLedger();

    // Move a record to its `<key>Superseded` list (the caller writes the record).
    const moveToSuperseded = (key, at) => {
      const old = v2[key];
      v2[`${key}Superseded`] = [...(v2[`${key}Superseded`] ?? []), { ...old, supersededAt: at }];
      delete v2[key];
      settle(v2.nonceLedger?.find((e) => e.kind === 'dataContractCreate' && e.key === key && e.contractId === old?.contractId), { supersededAt: at });
    };

    // --force-new for the set: supersede a forge-core registered from another schema (and so the
    // group it registered, and the contracts that name its id). After a chain change, or with
    // another deployer (whose ledger the record's is not), every recorded contract is superseded,
    // whatever its schema or state. They move at once, with the old ledger, before anything is
    // registered (a new chain's ids repeat the old one's), so a rerun after a crash finds only the
    // new set's records. (Both need --force-new without --only: refused above otherwise.)
    let coreSuperseded = false;
    if (chainChanged || deployerChanged) {
      const at = stamp();
      v2.nonceLedgerSuperseded = [...(v2.nonceLedgerSuperseded ?? []), { chainId: d.chainId, ...(deployerChanged ? { deployer: recordedDeployer } : {}), abandonedAt: at, entries: v2.nonceLedger ?? [] }];
      delete v2.nonceLedger; // (so the archived entries are not marked supersededAt)
      const moved = RECORD_KEYS.filter((key) => v2[key]);
      for (const key of moved) moveToSuperseded(key, at); // (a dry pass works on a copy)
      if (v2.contractGroup) moveToSuperseded('contractGroup', at);
      delete v2.contractGroupId;
      const why = chainChanged ? `chain ${d.chainId}` : `deployer ${recordedDeployer}`;
      say(`${moved.join(', ') || 'nothing recorded'} of ${why} ${dryRun ? 'would be' : 'is'} superseded; registering a new set${chainChanged ? ` on ${chainId}` : ''}`);
      if (chainChanged) d.chainId = chainId;
      coreSuperseded = true;
      record();
    } else if (forceNew && only === null && v2.forgeCore?.contractId) {
      const old = v2.forgeCore;
      if (!supersedes(old, schemaHash(load('forge-core')))) {
        if (old.status === 'registered') say(`forgeCore: ${old.contractId} was registered from the current schema; --force-new has nothing to supersede`);
      } else {
        coreSuperseded = true;
        const at = stamp();
        // A dependent's reservation from an interrupted run names the old forge-core: it is settled
        // against the chain first and leaves with it (landed: superseded; never landed: abandoned,
        // its nonce free again), so no unlanded reservation outlives the set it was made for
        for (const { key } of DEPENDENTS) {
          const open = v2[key]?.status === 'broadcasting' ? v2[key] : null;
          if (!open) continue;
          const landed = Boolean(await sdk.contracts.fetch(open.contractId));
          settle(entryFor('dataContractCreate', key, 'identityNonce', open.identityNonce), landed ? { status: 'registered' } : { status: 'abandoned', abandonedAt: at });
          if (landed) {
            Object.assign(open, { status: 'registered', confirmedAt: at });
            moveToSuperseded(key, at);
          } else {
            delete v2[key];
          }
          say(`${key}: the reservation ${open.contractId} of the superseded set ${landed ? 'landed; superseded' : 'never landed; abandoned'}`);
        }
        moveToSuperseded('forgeCore', at); // (a dry pass works on a copy)
        if (v2.contractGroup) moveToSuperseded('contractGroup', at);
        delete v2.contractGroupId;
        record();
        say(`forgeCore: ${old.contractId} ${dryRun ? 'would move' : 'moved'} to forgeCoreSuperseded; registering a new forge-core and contract group`);
      }
    }

    // A group an earlier run registered is checked before anything new enrols in it, not after
    const recordedGroup = v2.contractGroupId ?? v2.forgeCore?.contractGroupId;
    if (recordedGroup && !(forceNew && only === null)) await verifyGroup(recordedGroup, { optional: true });

    // forge-core registers the group, so the group id is derived from forge-core's own nonce,
    // whichever nonce that turns out to be (fresh, reused, or recorded by an earlier run).
    let coreId;
    if (only !== null) {
      // forge-core must already be registered and on chain; this mode never registers it
      coreId = await reconcile('forgeCore', load('forge-core'));
      if (!coreId) throw new Error(`--only ${only}: forge-core is not registered on this network; run without --only first`);
    } else {
      coreId = await registerContract({
        key: 'forgeCore',
        schemaName: 'forge-core',
        substitutions: {},
        registerGroup: true,
        groupIdFor: (nonce) => contractGroupId(ownerId, nonce),
      });
    }
    // The nonce forge-core was (or, in a dry run, would be) registered with
    const coreStep = report.steps.find((s) => s.key === 'forgeCore');
    const coreNonce = BigInt(coreStep?.dryRun ? coreStep.nonce : v2.forgeCore.identityNonce);
    const groupIdFinal = contractGroupId(ownerId, coreNonce);
    // A dry-run core step names a nonce nothing has recorded yet, so a leftover record (an
    // interrupted reservation) is not expected to agree with it
    if (!coreStep?.dryRun && v2.forgeCore?.contractGroupId && v2.forgeCore.contractGroupId !== groupIdFinal) {
      throw new Error(`recorded group ${v2.forgeCore.contractGroupId} does not derive from forge-core's nonce ${coreNonce}`);
    }

    const substitutions = { [PLACEHOLDER]: coreId };
    // Register the contracts that name forge-core's id, in order (all, or the one --only names).
    // Each registered id is substituted into the ones after it; one --only skips lends its
    // recorded id once it is confirmed on chain.
    const dependents = DEPENDENTS.filter((c) => only === null || c.only === only);
    // (only the ones registered before the first this run registers can be named by it)
    for (const c of DEPENDENTS) {
      if (dependents.includes(c)) break;
      if (!v2[c.key]?.contractId) continue;
      // Only a contract found on chain may be named (reconcile also settles an interrupted record)
      const found = await reconcile(c.key, load(c.schemaName, substitutions));
      if (!found) throw new Error(`--only ${only}: ${c.key} is recorded but not on chain; run --only ${c.only} first`);
      substitutions[placeholderFor(c.schemaName)] = found;
    }
    for (const { key, schemaName } of dependents) {
      if (forceNew && v2[key]?.contractId) {
        const old = v2[key];
        if (!supersedes(old, schemaHash(load(schemaName, substitutions)))) {
          if (old.status === 'registered') say(`${key}: ${old.contractId} was registered from the current schema; --force-new has nothing to supersede`);
        } else {
          // One in another group than forge-core's is a member of the group an earlier --force-new
          // superseded (a run that crashed before reaching it): the new one joins the new group
          const ofOldGroup = Boolean(old.contractGroupId) && old.contractGroupId !== groupIdFinal;
          const refused = dependentSupersedeError({ key, schemaName, contractId: old.contractId, coreSuperseded: coreSuperseded || ofOldGroup, sameGroup: Boolean(args['same-group']) });
          if (refused) throw new Error(refused);
          if (dryRun) {
            delete v2[key]; // (a dry pass works on a copy)
            say(`${key}: --force-new would supersede ${old.contractId} with a new contract`);
          } else {
            moveToSuperseded(key, stamp());
            record();
            say(`${key}: ${old.contractId} moved to ${key}Superseded; registering a new ${schemaName}`);
          }
        }
      }
      const id = await registerContract({
        key,
        schemaName,
        substitutions,
        registerGroup: false,
        groupIdFor: () => groupIdFinal,
      });
      substitutions[placeholderFor(schemaName)] = id;
    }
    if (only === 'collab' && v2.forgeCommunity?.contractId && schemaHash(load('forge-community', substitutions)) !== v2.forgeCommunity.schemaHash) {
      say(`forgeCommunity: WARNING ${v2.forgeCommunity.contractId} names another forge-collab than ${substitutions[placeholderFor('forge-collab')]}; --only community --force-new --same-group registers one that names it`);
    }

    if (!dryRun) {
      const { info, admins } = await verifyGroup(groupIdFinal);
      // Every contract recorded for this deployment, not only the ones this run registered
      for (const key of ['forgeCore', ...DEPENDENTS.map((c) => c.key)]) {
        if (!v2[key]?.contractId) {
          if (only !== null) continue; // --only on a deployment that predates the contract
          throw new Error(`${key} is not recorded after a full run`);
        }
        const m = await sdk.contractGroups.forContract(v2[key].contractId);
        if (!m.contract.includes(groupIdFinal)) throw new Error(`${key} is not enrolled in ${groupIdFinal}`);
      }
      stampTop();
      v2.contractGroupId = groupIdFinal;
      v2.contractGroup = { id: groupIdFinal, name: GROUP.name, owner: ownerId, admins, description: info.description ?? null, verifiedAt: stamp() };
      v2.protocolVersion = PROTOCOL_VERSION;
      v2.sdk = injected.sdkId ?? installedSdk();
      if (devnetName) v2.devnet = { name: devnetName, addresses: addresses ?? null };
      // The deployer (CNT-02, CNT-15): who signs, and what the escrowed identity file must be able to rebuild
      // (another deployer's block, after a --force-new with a new identity, is archived, never merged)
      const prior = v2.deployer?.identityId === ownerId ? v2.deployer : null;
      if (v2.deployer && !prior) v2.deployerSuperseded = [...(v2.deployerSuperseded ?? []), { ...v2.deployer, supersededAt: stamp() }];
      v2.deployer = {
        identityId: ownerId,
        assetLockTxid: prior?.assetLockTxid ?? rec.txid ?? null,
        createdAtHeight: createdHeight ?? prior?.createdAtHeight ?? null,
        note: 'custody: offline escrow (OD-2); never signs anything but Forge contract registrations and updates',
      };
      if (production && (v2.deployer.assetLockTxid === null || v2.deployer.createdAtHeight === null)) {
        say(`WARNING v2.deployer records no ${v2.deployer.assetLockTxid === null ? 'asset-lock txid (the identity file has none)' : 'creation height (--deployer-created-height)'}; the offline escrow needs both (CNT-02)`);
      }
      v2.restores ??= [];
      record();
      say(`contract group ${groupIdFinal} verified: owner ${ownerId}, no admins, every recorded contract enrolled`);
    }
    if (acknowledged.length > 0 && !dryRun && used.size === 0) say('WARNING --acknowledge-nonce explained no nonce: the ledger had nothing unexplained');
    report.contractGroupId = groupIdFinal;
    return report;
  }

  // Testnet and mainnet: a preflight pass sizes every transition a real pass would broadcast, so a
  // transition without room is refused before the first one is
  if (production && !dryRun) {
    const roomProblems = [];
    await run({ dryRun: true, d: structuredClone(dep), prefix: 'preflight: ', roomProblems });
    if (roomProblems.length > 0) throw new Error(`${network} registration refused, nothing was broadcast:\n  - ${roomProblems.join('\n  - ')}`);
  }
  const report = await run({ dryRun, d: dryRun ? structuredClone(dep) : dep });
  report.deployment = depFile;
  if (dryRun) {
    log('sha256 of the set (what the owner signs; --expect-sha256 checks it):');
    for (const line of formatSums(fileSums).trimEnd().split('\n')) log(`  ${line}`);
  }
  print(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { defaultLog(`ERROR: ${e?.message || e}`); process.exit(1); });
}

// Register the forge-v2 contracts (forge-core, forge-collab, forge-community) in one PV14
// contract group.
//
//   (cd forge-contracts/sdk-v2 && npm ci)           # @dashevo/evo-sdk@4.2.0-beta.7, pinned
//   node forge-contracts/scripts/deploy-v2.mjs --identity <deployer.identity.json> \
//        --network devnet --devnet-name moutai [--addresses https://ip:1443,...] [--dry-run]
//        [--only collab|community] [--force-new [--same-group]] [--update core]
//   node forge-contracts/scripts/deploy-v2.mjs --self-test    # offline: ids, schemas, sizes of the group fields
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
// target and the hash already recorded, and broadcasts nothing.
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
// contracts and the group; no moderation, not readonly (flip readonly in a later update once
// the schema is final).
//
// Before anything is broadcast, the script checks the network runs protocol 14, rebuilds every
// contract with full validation locally (the same rs-dpp as the network, compiled to wasm), and
// prints the transition sizes. --dry-run stops there.
//
// Protocol notes: the contract id is hash_double(owner || nonce) and the group id
// hash_double("contract_group" || owner || nonce) (rs-dpp contract_group::generate_contract_group_id).
// The JS below derives the group id itself because evo-sdk exposes no helper; the Rust validator
// (tools/contract-validate) prints a known-answer vector that --self-test checks.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
// The pinned protocol-14 SDK lives in sdk-v2/ (`npm ci` there). The package is ESM-only.
const EVO_SDK_ENTRY = join(ROOT, 'sdk-v2', 'node_modules', '@dashevo', 'evo-sdk', 'dist', 'evo-sdk.module.js');
export async function loadEvoSdk() {
  if (!existsSync(EVO_SDK_ENTRY)) throw new Error('run `npm ci` in forge-contracts/sdk-v2 first');
  const evo = await import(pathToFileURL(EVO_SDK_ENTRY).href);
  // The wasm module is initialized lazily; the offline classes (DataContract, PrivateKey, ...)
  // need it before any SDK connects, and this is the one public call that runs the init.
  await evo.EvoSDK.getLatestVersionNumber();
  return evo;
}
const PROTOCOL_VERSION = 14;
const MAX_STATE_TRANSITION_SIZE = 20480;
/** `forge-core` -> `FORGE_CORE_CONTRACT_ID`: the placeholder a later schema names a contract by. */
export const placeholderFor = (schemaName) => `${schemaName.toUpperCase().replace(/-/g, '_')}_CONTRACT_ID`;
const PLACEHOLDER = placeholderFor('forge-core');
const GROUP = { name: 'dash-forge', description: 'Dash Forge v2: forge-core, forge-collab and forge-community' };
// The contracts that name forge-core's id, registered after it in this order. `key` is the
// record's name under `v2` (its superseded list is `${key}Superseded`), `only` the --only value.
export const DEPENDENT_CONTRACTS = [
  { key: 'forgeCollab', schemaName: 'forge-collab', only: 'collab' },
  { key: 'forgeCommunity', schemaName: 'forge-community', only: 'community' },
];
// Protocol 14 limits on the group's registration fields (rs-platform-version system_limits).
const MAX_GROUP_NAME = 64;
const MAX_GROUP_DESCRIPTION = 256;
const PUT_SETTINGS = { connectTimeoutMs: 10000, timeoutMs: 90000, retries: 3 };
const CREDITS_PER_DASH = 1e11;

const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) throw new Error(`unexpected argument: ${t}`);
    const k = t.slice(2);
    a[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
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
const hashDouble = (b) => sha256(sha256(b));
const u64be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
export function contractId(ownerB58, nonce) {
  return b58encode(hashDouble(Buffer.concat([b58decode(ownerB58), u64be(nonce)])));
}
export function contractGroupId(ownerB58, nonce) {
  return b58encode(hashDouble(Buffer.concat([Buffer.from('contract_group'), b58decode(ownerB58), u64be(nonce)])));
}

// Offline checks, run before every deploy and alone with --self-test: the id derivation against
// rs-dpp's known answer, and every schema loading with the earlier contracts' ids substituted.
function selfTest() {
  // Printed by tools/contract-validate for owner 0x07 * 32, nonce 1
  const owner = b58encode(Buffer.alloc(32, 7));
  const want = { contract: '4xQ1gLbVttHSnHSNAexse7ByXJd7BQCRLgLYuPevrcTW', group: 'EjmhECjYE4T5yC24xyU852tpWTmwwmAphwLLnJrShYkH' };
  const got = { contract: contractId(owner, 1), group: contractGroupId(owner, 1) };
  if (got.contract !== want.contract || got.group !== want.group) {
    throw new Error(`id derivation self-test failed: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  }
  log('id derivation self-test: ok (matches rs-dpp)');
  if (GROUP.name.length > MAX_GROUP_NAME || GROUP.description.length > MAX_GROUP_DESCRIPTION) {
    throw new Error('contract group name or description over the protocol limit');
  }
  const core = loadSchema('forge-core');
  if (JSON.stringify(core).includes(PLACEHOLDER)) throw new Error('forge-core must not name its own id');
  const ids = { [PLACEHOLDER]: want.contract };
  for (const { schemaName } of DEPENDENT_CONTRACTS) {
    const raw = readFileSync(join(ROOT, 'contracts', `${schemaName}.json`), 'utf8');
    if (!raw.includes(PLACEHOLDER)) throw new Error(`${schemaName} names no ${PLACEHOLDER}: it would not refer to this forge-core`);
    // Only a contract registered before it may be named (loadSchema refuses an unresolved one)
    loadSchema(schemaName, ids, raw);
    ids[placeholderFor(schemaName)] = want.contract;
  }
  log(`schemas self-test: ok (forge-core + ${DEPENDENT_CONTRACTS.map((c) => c.schemaName).join(', ')})`);
}

// ---- deployment record ----
function depPath(network, devnetName) {
  return join(ROOT, 'deployments', `${network === 'devnet' ? `devnet-${devnetName}` : network}.json`);
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

export { b58decode, b58encode, selfTest };

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
  return createHash('sha256').update(JSON.stringify(json)).digest('hex');
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  selfTest();
  if (args['self-test']) return;

  const network = args.network || 'devnet';
  const devnetName = network === 'devnet' ? (args['devnet-name'] || 'moutai') : undefined;
  if (!['devnet', 'testnet', 'mainnet'].includes(network)) throw new Error(`unknown network ${network}`);
  if (!args.identity || args.identity === true) throw new Error('--identity <deployer.identity.json> required');
  const dryRun = Boolean(args['dry-run']);
  const only = args.only === undefined ? null : String(args.only);
  const onlyValues = DEPENDENT_CONTRACTS.map((c) => c.only);
  if (only !== null && !onlyValues.includes(only)) throw new Error(`--only accepts ${onlyValues.map((v) => `"${v}"`).join(' or ')}, got ${only}`);
  const update = args.update === undefined ? null : String(args.update);
  if (update !== null && update !== 'core') throw new Error(`--update accepts "core", got ${update}`);
  if (update !== null && (only !== null || args['force-new'])) throw new Error('--update core runs alone: no --only, no --force-new');
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
  // A devnet's DAPI addresses: --addresses, else the deployment file's `dapiAddresses` (as
  // deploy-key-exchange.mjs and snapshot-contracts.mjs read them), else SDK discovery
  const depFile = depPath(network, devnetName);
  const dep = readDep(depFile);
  const addresses = typeof args.addresses === 'string'
    ? args.addresses.split(',').map((s) => s.trim()).filter(Boolean)
    : (devnetName && (dep.dapiAddresses ?? dep.v2?.devnet?.addresses)) || undefined;

  const rec = JSON.parse(readFileSync(resolve(String(args.identity)), 'utf8'));
  const ownerId = rec.identityId;
  const critKey = pickKey(rec, 'AUTHENTICATION', 'CRITICAL');

  const evo = await loadEvoSdk();
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

  const identity = await sdk.identities.fetch(ownerId);
  if (!identity) {
    // A dry run only builds and sizes the transitions, which needs no identity on chain
    if (!dryRun) throw new Error(`deployer identity ${ownerId} not found on ${network}`);
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

  dep.v2 ??= {};
  const v2 = dep.v2;
  const record = () => writeDep(depFile, dep);

  const balance = async () => BigInt((await sdk.identities.balance(ownerId)) ?? 0n);
  // Identity nonces carry recent-document bits above bit 40; the contract id derives from the
  // low 40 bits (rs-dpp IDENTITY_NONCE_VALUE_FILTER), so mask whatever the query returns.
  const NONCE_MASK = 0xFFFFFFFFFFn;
  const chainNonce = async () => (identity ? BigInt((await sdk.identities.nonce(ownerId)) ?? 0n) & NONCE_MASK : 0n);
  let dryRunNextNonce = null;
  const report = { network: devnetName ? `devnet-${devnetName}` : network, ownerId, steps: [] };

  // A step whose recorded contract is on chain is finished; bring its record up to date
  // (a crash between broadcast and the final write leaves it `broadcasting`, without cost).
  async function reconcile(key, currentHash) {
    const existing = v2[key];
    if (!existing?.contractId) return null;
    const onChain = await sdk.contracts.fetch(existing.contractId);
    if (onChain) {
      if (existing.schemaHash && existing.schemaHash !== currentHash) {
        const dependent = DEPENDENT_CONTRACTS.find((c) => c.key === key);
        log(`${key}: WARNING ${existing.contractId} was registered from a different schema (${existing.schemaHash.slice(0, 12)}… != ${currentHash.slice(0, 12)}…); it is left as is${dependent ? ` (--only ${dependent.only} --force-new --same-group registers the current one)` : ''}`);
      }
      if (existing.status !== 'registered') {
        const cost = existing.balanceBefore != null ? BigInt(existing.balanceBefore) - (await balance()) : null;
        v2[key] = {
          ...existing,
          ownerId,
          status: 'registered',
          confirmedAt: new Date().toISOString(),
          ...(cost != null ? { costCredits: cost.toString(), costDash: Number(cost) / CREDITS_PER_DASH, costNote: 'balance delta since the recorded pre-broadcast balance' } : {}),
        };
        record();
        log(`${key}: found ${existing.contractId} on chain; record updated to registered`);
      } else {
        log(`${key}: already registered as ${existing.contractId}`);
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
    log(`${key}: a previous run reserved nonce ${existing.identityNonce} (${existing.contractId}) but it never landed`);
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
    for (let i = 0; after === before && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      after = await balance();
    }
    return after;
  }

  // Build, check and (unless --dry-run) broadcast one contract create. The nonce, contract id
  // and (for forge-core) the contract group id derived from THAT nonce are recorded together
  // BEFORE broadcasting, so a crash after broadcast resumes against the right ids.
  async function registerContract({ key, schemaName, substitutions, registerGroup, groupIdFor }) {
    const json = loadSchema(schemaName, substitutions);
    const hash = schemaHash(json);
    const done = await reconcile(key, hash);
    if (done) return done;

    // In a dry run nothing is broadcast, so the next contract's nonce is one past this one's
    const nonce = dryRunNextNonce ?? (await chainNonce()) + 1n;
    if (dryRun) dryRunNextNonce = nonce + 1n;
    const id = contractId(ownerId, nonce);
    const groupId = groupIdFor(nonce);

    // Full validation, the same parse a node's action transform runs (a cross-contract
    // reference is resolved only at registration, against state)
    const contract = DataContract.fromJSON(contractJson(json, id, 1), true, PROTOCOL_VERSION);
    if (contract.id.toString() !== id) throw new Error(`${key}: contract id mismatch ${contract.id} != ${id}`);

    const transition = new DataContractCreateTransition(contract, nonce, PROTOCOL_VERSION);
    if (registerGroup) transition.setContractGroup({ admins: [], name: GROUP.name, description: GROUP.description });
    transition.setContractGroupMemberships([{ contractGroupId: b58decode(groupId), member: 'contract' }]);
    const st = transition.toStateTransition();
    st.sign(privateKey, publicKey);
    const size = st.toBytes().length;
    log(`${key}: id ${id}, nonce ${nonce}, group ${groupId}, signed create transition ${size} B (limit ${MAX_STATE_TRANSITION_SIZE})`);
    if (size > MAX_STATE_TRANSITION_SIZE) throw new Error(`${key}: transition exceeds max_state_transition_size`);
    if (dryRun) {
      report.steps.push({ key, contractId: id, nonce: nonce.toString(), contractGroupId: groupId, sizeBytes: size, schemaHash: hash, dryRun: true });
      return id;
    }

    const before = await balance();
    v2[key] = {
      contractId: id,
      ownerId,
      identityNonce: nonce.toString(),
      contractGroupId: groupId,
      status: 'broadcasting',
      sizeBytes: size,
      schemaHash: hash,
      balanceBefore: before.toString(),
    };
    record();

    await sdk.stateTransitions.broadcastAndWait(st, PUT_SETTINGS);
    const after = await settledBalance(before);
    const fetched = await sdk.contracts.fetch(id);
    if (!fetched) throw new Error(`${key}: broadcast confirmed but ${id} cannot be fetched`);
    const costCredits = before - after;
    v2[key] = {
      ...v2[key],
      status: 'registered',
      deployedAt: new Date().toISOString(),
      costCredits: costCredits.toString(),
      costDash: Number(costCredits) / CREDITS_PER_DASH,
    };
    record();
    log(`${key}: registered; cost ${(Number(costCredits) / CREDITS_PER_DASH).toFixed(6)} DASH`);
    report.steps.push({ key, ...v2[key] });
    return id;
  }

  // --update core: an in-place DataContractUpdate of the recorded forge-core to the current
  // schema, as the next version. Returns the step to report; resumable (see the header).
  async function updateCore() {
    const coreRec = v2.forgeCore;
    if (!coreRec?.contractId || coreRec.status !== 'registered') throw new Error('--update core: no registered forge-core recorded for this network');
    const json = loadSchema('forge-core');
    const hash = schemaHash(json);
    const onChain = await sdk.contracts.fetch(coreRec.contractId);
    if (!onChain) throw new Error(`--update core: ${coreRec.contractId} is recorded but not on chain`);
    const chainVersion = Number(onChain.version);
    // Close an update out: the version and schema it took the contract to, and what it cost.
    const complete = (pending, cost, extra) => {
      coreRec.updates = [...(coreRec.updates ?? []), { ...pending, status: 'updated', costCredits: cost.toString(), costDash: Number(cost) / CREDITS_PER_DASH, ...extra }];
      coreRec.version = pending.version;
      coreRec.schemaHash = pending.schemaHash;
      delete coreRec.pendingUpdate;
      record();
    };
    if (coreRec.schemaHash === hash) {
      log(`forgeCore: ${coreRec.contractId} is already at the current schema (version ${chainVersion}); nothing to update`);
      return { key: 'forgeCore', ...coreRec, resumed: true };
    }
    const pending = coreRec.pendingUpdate;
    if (pending && pending.schemaHash === hash && chainVersion >= pending.version) {
      // An earlier run broadcast this update and it landed; finish the record.
      complete(pending, BigInt(pending.balanceBefore) - (await balance()), { confirmedAt: new Date().toISOString(), costNote: 'balance delta since the recorded pre-broadcast balance' });
      log(`forgeCore: found version ${chainVersion} on chain; record completed`);
      return { key: 'forgeCore', ...coreRec, resumed: true };
    }
    const version = chainVersion + 1;
    const contract = DataContract.fromJSON(contractJson(json, coreRec.contractId, version), true, PROTOCOL_VERSION);
    // A contract update is checked against the identity-CONTRACT nonce (drive-abci
    // data_contract_update/identity_contract_nonce), not the identity nonce registration uses: a
    // deployer with more than 23 transitions would be refused with the wrong one.
    const nonce = ((BigInt((await sdk.identities.contractNonce(ownerId, coreRec.contractId)) ?? 0n)) & NONCE_MASK) + 1n;
    const st = new DataContractUpdateTransition(contract, nonce, PROTOCOL_VERSION).toStateTransition();
    st.sign(privateKey, publicKey);
    const size = st.toBytes().length;
    log(`forgeCore: update ${coreRec.contractId} v${chainVersion} -> v${version}, nonce ${nonce}, signed transition ${size} B (limit ${MAX_STATE_TRANSITION_SIZE})`);
    if (size > MAX_STATE_TRANSITION_SIZE) throw new Error('forgeCore: update transition exceeds max_state_transition_size');
    if (dryRun) return { key: 'forgeCore', contractId: coreRec.contractId, update: { from: chainVersion, to: version }, sizeBytes: size, schemaHash: hash, dryRun: true };
    const before = await balance();
    coreRec.pendingUpdate = { version, identityNonce: nonce.toString(), sizeBytes: size, schemaHash: hash, previousSchemaHash: coreRec.schemaHash ?? null, balanceBefore: before.toString() };
    record();
    try {
      await sdk.stateTransitions.broadcastAndWait(st, PUT_SETTINGS);
    } catch (e) {
      // evo-sdk proves a contract update by the state it affected, and its strict wait refuses
      // that result ("affected state only"): the update landed; the version check below decides.
      if (!/affected state only|VerifiedDataContract snapshot/i.test(String(e?.message ?? e))) throw e;
    }
    const after = await settledBalance(before);
    const fetched = await sdk.contracts.fetch(coreRec.contractId);
    if (!fetched || Number(fetched.version) !== version) throw new Error(`forgeCore: update broadcast but the chain shows version ${fetched ? fetched.version : 'none'}`);
    complete(coreRec.pendingUpdate, before - after, { updatedAt: new Date().toISOString() });
    log(`forgeCore: updated to version ${version}; cost ${(Number(before - after) / CREDITS_PER_DASH).toFixed(6)} DASH`);
    return { key: 'forgeCore', ...coreRec };
  }
  if (update === 'core') {
    report.steps.push(await updateCore());
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Move a record to its `<key>Superseded` list (the caller writes the record).
  const moveToSuperseded = (key, at) => {
    v2[`${key}Superseded`] = [...(v2[`${key}Superseded`] ?? []), { ...v2[key], supersededAt: at }];
    delete v2[key];
  };
  // A dry run with --force-new sizes the contracts it would register and records nothing: a
  // record the real run would supersede is set aside, and put back at the end.
  const restoreAfterDryRun = {};

  // --force-new for the set: supersede a forge-core registered from another schema (and so the
  // group it registered, and the contracts that name its id).
  let coreSuperseded = false;
  if (forceNew && only === null && v2.forgeCore?.contractId) {
    const old = v2.forgeCore;
    if (!supersedes(old, schemaHash(loadSchema('forge-core')))) {
      if (old.status === 'registered') log(`forgeCore: ${old.contractId} was registered from the current schema; --force-new has nothing to supersede`);
    } else if (dryRun) {
      coreSuperseded = true;
      restoreAfterDryRun.forgeCore = old;
      delete v2.forgeCore;
      log(`forgeCore: --force-new would supersede ${old.contractId} (and its group, forge-collab and forge-community) with new contracts`);
    } else {
      coreSuperseded = true;
      const at = new Date().toISOString();
      moveToSuperseded('forgeCore', at);
      if (v2.contractGroup) moveToSuperseded('contractGroup', at);
      delete v2.contractGroupId;
      record();
      log(`forgeCore: ${old.contractId} moved to forgeCoreSuperseded; registering a new forge-core and contract group`);
    }
  }

  // forge-core registers the group, so the group id is derived from forge-core's own nonce,
  // whichever nonce that turns out to be (fresh, reused, or recorded by an earlier run).
  let coreId;
  if (only !== null) {
    // forge-core must already be registered and on chain; this mode never registers it
    coreId = await reconcile('forgeCore', schemaHash(loadSchema('forge-core')));
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
  // recorded id.
  const dependents = DEPENDENT_CONTRACTS.filter((c) => only === null || c.only === only);
  for (const { key, schemaName } of DEPENDENT_CONTRACTS) {
    if (!dependents.some((d) => d.key === key) && v2[key]?.contractId) substitutions[placeholderFor(schemaName)] = v2[key].contractId;
  }
  for (const { key, schemaName } of dependents) {
    if (forceNew && v2[key]?.contractId) {
      const old = v2[key];
      if (!supersedes(old, schemaHash(loadSchema(schemaName, substitutions)))) {
        if (old.status === 'registered') log(`${key}: ${old.contractId} was registered from the current schema; --force-new has nothing to supersede`);
      } else {
        const refused = dependentSupersedeError({ key, schemaName, contractId: old.contractId, coreSuperseded, sameGroup: Boolean(args['same-group']) });
        if (refused) throw new Error(refused);
        if (dryRun) {
          restoreAfterDryRun[key] = old;
          delete v2[key];
          log(`${key}: --force-new would supersede ${old.contractId} with a new contract`);
        } else {
          moveToSuperseded(key, new Date().toISOString());
          record();
          log(`${key}: ${old.contractId} moved to ${key}Superseded; registering a new ${schemaName}`);
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
  if (only === 'collab' && v2.forgeCommunity?.contractId && schemaHash(loadSchema('forge-community', substitutions)) !== v2.forgeCommunity.schemaHash) {
    log(`forgeCommunity: WARNING ${v2.forgeCommunity.contractId} names another forge-collab than ${substitutions[placeholderFor('forge-collab')]}; --only community --force-new --same-group registers one that names it`);
  }
  Object.assign(v2, restoreAfterDryRun);

  if (!dryRun) {
    const info = await sdk.contractGroups.info(groupIdFinal);
    if (!info || info.ownerId !== ownerId) throw new Error(`contract group ${groupIdFinal} not found or not owned by ${ownerId}`);
    // Every contract recorded for this deployment, not only the ones this run registered
    for (const key of ['forgeCore', ...DEPENDENT_CONTRACTS.map((c) => c.key)]) {
      if (!v2[key]?.contractId) {
        if (only !== null) continue; // --only on a deployment that predates the contract
        throw new Error(`${key} is not recorded after a full run`);
      }
      const m = await sdk.contractGroups.forContract(v2[key].contractId);
      if (!m.contract.includes(groupIdFinal)) throw new Error(`${key} is not enrolled in ${groupIdFinal}`);
    }
    v2.contractGroupId = groupIdFinal;
    v2.contractGroup = { id: groupIdFinal, name: GROUP.name, owner: ownerId, verifiedAt: new Date().toISOString() };
    v2.protocolVersion = PROTOCOL_VERSION;
    v2.sdk = '@dashevo/evo-sdk@4.2.0-beta.7';
    if (devnetName) v2.devnet = { name: devnetName, addresses: addresses ?? null };
    record();
    log(`contract group ${groupIdFinal} verified: owner ${ownerId}, every recorded contract enrolled`);
  }
  report.contractGroupId = groupIdFinal;
  report.deployment = depFile;
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { log(`ERROR: ${e?.message || e}`); process.exit(1); });
}

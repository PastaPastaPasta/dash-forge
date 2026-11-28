// Register one extra contract (forge-user, forge-org) and enrol it in the network's existing
// dash-forge contract group. Additive: no other Forge contract changes. The record goes to
// deployments/<network>.json as a top-level `<recordKey>` record; rerunning after success is a no-op.
// Mainnet needs the caller's approval flag (--i-have-owner-approval by default): registration is permanent and spends DASH.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { b58decode, b58encode, contractId, loadEvoSdk, takeLock, writeDep, PROTOCOL_VERSION } from '../deploy-v2.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUT_SETTINGS = { connectTimeoutMs: 10000, timeoutMs: 90000, retries: 3 };
const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[t.slice(2)] = true;
    else { a[t.slice(2)] = next; i++; }
  }
  return a;
}

/** The contract JSON a create registers from a committed schema file (`$comment` dropped). */
function groupContractJson(schema, id, ownerId) {
  return { $formatVersion: '1', id, ownerId, version: 1, config: schema.config, documentSchemas: schema.documentSchemas };
}

function loadGroupSchema(schemaFile) {
  return JSON.parse(readFileSync(join(ROOT, schemaFile), 'utf8'));
}

/**
 * `--emit <file>` writes the registered JSON under a placeholder owner (for
 * `tools/contract-validate`, which gives it its own id); otherwise registers it.
 */
export async function deployGroupContract(argv, { recordKey, schemaFile, label, mainnetApproval = 'i-have-owner-approval' }) {
  const args = parseArgs(argv);
  if ('emit' in args) {
    if (typeof args.emit !== 'string') throw new Error('--emit <file> needs a file name');
    const owner = b58encode(Buffer.alloc(32, 7));
    writeFileSync(resolve(args.emit), `${JSON.stringify(groupContractJson(loadGroupSchema(schemaFile), contractId(owner, 1n), owner), null, 2)}\n`);
    return;
  }
  const network = args.network || 'testnet';
  if (network === 'mainnet' && !args[mainnetApproval]) throw new Error(`mainnet registration needs the owner’s approval (--${mainnetApproval})`);
  if (!args.identity || args.identity === true) throw new Error('--identity <deployer.identity.json> required');
  const key = network === 'devnet' ? `devnet-${args['devnet-name'] || 'sakura'}` : network;
  const depFile = join(ROOT, 'deployments', `${key}.json`);
  const lock = args['dry-run'] ? null : takeLock(depFile);
  try {
    await register(args, { recordKey, schemaFile, label }, network, depFile);
  } finally {
    if (lock) rmSync(lock, { force: true });
  }
}

/** The contract's owner and document type names, from an evo-sdk contract. */
function shapeOf(c) {
  const owner = typeof c.ownerId === 'string' ? c.ownerId : c.ownerId.toBase58();
  const types = c.getDocumentTypes ? Object.keys(c.getDocumentTypes()) : Object.keys(c.toJSON().documentSchemas);
  return { owner, types: types.sort() };
}

async function register(args, { recordKey, schemaFile, label }, network, depFile) {
  const readDep = () => JSON.parse(readFileSync(depFile, 'utf8'));
  const putRecord = (r) => { const fresh = readDep(); fresh[recordKey] = r; writeDep(depFile, fresh); };
  const pause = () => new Promise((r) => setTimeout(r, 2000));
  const dep = readDep();
  const groupId = dep.v2?.contractGroupId ?? dep.v2?.forgeCore?.contractGroupId;
  if (!groupId) throw new Error(`${depFile} records no contract group`);

  const rec = JSON.parse(readFileSync(resolve(String(args.identity)), 'utf8'));
  const ownerId = rec.identityId;
  if (ownerId !== dep.v2.forgeCore.ownerId) throw new Error(`deployer ${ownerId} is not the set's owner ${dep.v2.forgeCore.ownerId}`);
  const crit = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === 'CRITICAL');
  if (!crit) throw new Error('the identity has no CRITICAL authentication key');

  const { EvoSDK, DataContract, DataContractCreateTransition, PrivateKey, IdentityPublicKey } = await loadEvoSdk();
  const sdk = new EvoSDK({ network, addresses: dep.dapiAddresses, trusted: true, settings: PUT_SETTINGS, version: PROTOCOL_VERSION });
  await sdk.connect();
  const chainNonce = async () => BigInt((await sdk.identities.nonce(ownerId)) ?? 0n) & 0xFFFFFFFFFFn;

  const fetchSettled = async (id) => {
    for (let i = 0; i < 10; i++) {
      const c = await sdk.contracts.fetch(id);
      if (c) return c;
      await pause();
    }
    return null;
  };
  const schema = loadGroupSchema(schemaFile);
  const prior = dep[recordKey];
  if (prior?.contractId && prior.contractGroupId === groupId) {
    const found = await fetchSettled(prior.contractId);
    if (found) {
      const got = shapeOf(found);
      const want = Object.keys(schema.documentSchemas).sort();
      if (got.owner !== ownerId || got.types.join() !== want.join()) {
        throw new Error(`${recordKey} records ${prior.contractId}, but the contract there (owner ${got.owner}, types ${got.types.join(', ')}) is not ${label} (owner ${ownerId}, types ${want.join(', ')}): reconcile the record by hand. Nothing was broadcast.`);
      }
      if (prior.status === 'broadcasting') putRecord({ ...prior, status: 'registered', confirmedAt: new Date().toISOString() });
      log(`already registered: ${prior.contractId}`);
      console.log(JSON.stringify(prior, null, 2));
      return;
    }
    if (prior.status === 'broadcasting') {
      if ((await chainNonce()) >= BigInt(prior.identityNonce)) {
        throw new Error(`the reservation ${prior.contractId} (nonce ${prior.identityNonce}) was broadcast and its nonce is used, but the contract cannot be fetched yet: check it before registering again`);
      }
    }
  }
  const group = await sdk.contractGroups.info(groupId);
  if (!group || group.ownerId !== ownerId) throw new Error(`group ${groupId} not found or not owned by ${ownerId}`);
  if (Array.isArray(group.adminIds) && group.adminIds.length > 0) throw new Error(`group ${groupId} has admins`);

  const nonce = (await chainNonce()) + 1n;
  const id = contractId(ownerId, nonce);
  const contract = DataContract.fromJSON(groupContractJson(schema, id, ownerId), true, PROTOCOL_VERSION);
  const transition = new DataContractCreateTransition(contract, nonce, PROTOCOL_VERSION);
  transition.setContractGroupMemberships([{ contractGroupId: b58decode(groupId), member: 'contract' }]);
  const st = transition.toStateTransition();
  st.sign(PrivateKey.fromWIF(crit.privateKeyWif), new IdentityPublicKey({
    keyId: crit.id, purpose: 'AUTHENTICATION', securityLevel: 'CRITICAL', keyType: crit.keyType, isReadOnly: false,
    data: Buffer.from(crit.publicKeyHex, 'hex'),
  }));
  const sizeBytes = st.toBytes().length;
  log(`${label}: id ${id}, nonce ${nonce}, group ${groupId}, ${sizeBytes} B`);
  if (args['dry-run']) return;

  const before = await sdk.identities.balance(ownerId);
  const reservation = {
    contractId: id,
    ownerId,
    identityNonce: nonce.toString(),
    contractGroupId: groupId,
    sizeBytes,
    status: 'broadcasting',
    reservedAt: new Date().toISOString(),
    sourceFile: `forge-contracts/${schemaFile}`,
  };
  const reserved = readDep();
  if (reserved[recordKey] && reserved[recordKey].contractGroupId !== groupId) {
    reserved[`${recordKey}Superseded`] = [...(reserved[`${recordKey}Superseded`] ?? []), reserved[recordKey]];
  }
  reserved[recordKey] = reservation;
  writeDep(depFile, reserved);
  await sdk.stateTransitions.broadcastAndWait(st, PUT_SETTINGS);
  if (!(await fetchSettled(id))) throw new Error(`broadcast confirmed but ${id} cannot be fetched yet: rerun to confirm the reservation`);
  let after = await sdk.identities.balance(ownerId);
  for (let i = 0; after === before && i < 10; i++) { await pause(); after = await sdk.identities.balance(ownerId); }
  const record = { ...reservation, status: 'registered', deployedAt: new Date().toISOString(), costCredits: (before - after).toString() };
  putRecord(record);
  log(`registered; recorded in ${depFile}`);
  console.log(JSON.stringify(record, null, 2));
}

export function runCli(opts) {
  deployGroupContract(process.argv.slice(2), opts).then(() => process.exit(0), (e) => { log(`ERROR: ${e?.message || e}`); process.exit(1); });
}

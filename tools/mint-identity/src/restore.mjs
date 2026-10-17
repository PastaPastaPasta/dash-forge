// Same-id restore of an escrowed identity (CNT-02, CNT-15): after a Platform reset that kept Core,
// re-create the identity from its ORIGINAL asset-lock transaction, which the new Platform chain
// never consumed. The identity id derives from the asset-lock outpoint alone (rs-dpp
// ChainAssetLockProof::create_identifier = hash_double(txid || vout)), so it comes back with the
// same id, and so do the contract ids it registers at the same nonces (deploy-v2.mjs --replay).
// Nothing is funded: the lock's credits pay for the identity again.
//
// Every check that needs no network runs first (the phrase rebuilds the file's keys and deposit
// address, the outpoint derives the file's identity id); then Core must still know the mined
// transaction (else Core was reset too, and a fresh registration is the only path), and Platform
// must not hold the asset lock already.
import { createHash } from 'node:crypto';
import { createRole } from './flow.mjs';
import { bytesToHex, privateKeyToWif } from './bytes.mjs';
import { assertValidMnemonic } from './mnemonic-arg.mjs';
import { ChainClient } from './chain.mjs';
import { InsightError } from './insight.mjs';
import { obtainAssetLock } from './lock.mjs';
import * as platform from './platform.mjs';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = `1${out}`; else break; }
  return out;
}
const sha256 = (b) => createHash('sha256').update(b).digest();

/**
 * The identity id an asset-lock outpoint creates: base58(sha256(sha256(txid bytes || vout LE))),
 * the txid in Core's internal byte order (its hex reversed), as rs-dpp's ChainAssetLockProof and
 * InstantAssetLockProof both derive it.
 */
export function identityIdFromOutpoint(txid, vout = 0) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(txid))) throw new Error(`not a transaction id: ${txid}`);
  const index = Buffer.alloc(4);
  index.writeUInt32LE(vout);
  return b58encode(sha256(sha256(Buffer.concat([Buffer.from(txid, 'hex').reverse(), index]))));
}

/** The advice every "impossible" refusal ends with. */
const FRESH = 'A same-id restore is impossible: mint a new deployer and register a new set (deploy-v2.mjs --force-new --abandon-live-set <network>).';

/**
 * The offline half: the escrowed file's phrase must rebuild its deposit address and every identity
 * key, and its asset-lock outpoint must derive its identity id (and `expectId`). Returns the
 * rebuilt role (keys, asset-lock key, txid, identity id). Messages never carry the phrase or a key.
 */
export function checkEscrow(record, network, { expectId, label = 'RESTORE' } = {}) {
  if (typeof record?.mnemonic !== 'string' || !record.mnemonic) throw new Error('the identity file holds no mnemonic: it is not an escrowed mint-identity file');
  if (!record.identityId) throw new Error('the identity file has no identityId: it is a pending mint, not a registered identity (finish it with mint.mjs --out <its dir>)');
  if (!/^[0-9a-fA-F]{64}$/.test(String(record.txid ?? ''))) throw new Error('the identity file has no asset-lock txid: the identity cannot be re-created from its asset lock');
  assertValidMnemonic(record.mnemonic, 'the identity file');
  const role = createRole(label, network, record.mnemonic);
  const wrong = (what) => new Error(`the identity file's mnemonic does not rebuild its ${what}: wrong or edited file`);
  if (record.depositAddress && role.depositAddress !== record.depositAddress) throw wrong('deposit address');
  if (record.assetLockKey?.publicKeyHex && bytesToHex(role.assetLockKeyPair.publicKey) !== record.assetLockKey.publicKeyHex.toLowerCase()) throw wrong('asset-lock key');
  const keys = record.identityKeys ?? [];
  if (keys.length !== role.identityKeys.length) throw wrong(`identity keys (${keys.length} in the file, ${role.identityKeys.length} rebuilt)`);
  for (const k of keys) {
    const r = role.identityKeys.find((x) => x.id === k.id);
    if (!r || r.publicKeyHex !== String(k.publicKeyHex).toLowerCase() || r.purpose !== k.purpose || r.securityLevel !== k.securityLevel) throw wrong(`identity key ${k.id}`);
  }
  const derived = identityIdFromOutpoint(record.txid, 0);
  if (derived !== record.identityId) {
    throw new Error(`asset lock ${record.txid}:0 creates identity ${derived}, not the file's ${record.identityId}: this file's identity was not created from its recorded asset lock`);
  }
  if (expectId && expectId !== derived) throw new Error(`asset lock ${record.txid}:0 creates identity ${derived}, not --expect-id ${expectId}`);
  role.txid = record.txid;
  role.identityId = derived;
  return role;
}

/** Whether the identity on chain has exactly the rebuilt keys (ids, purposes, levels, public keys, none disabled). */
function sameKeys(onChain, role) {
  return onChain.keys.length === role.identityKeys.length && role.identityKeys.every((k) => {
    const c = onChain.keys.find((x) => x.id === k.id);
    return c && c.purpose === k.purpose && c.securityLevel === k.securityLevel && c.dataHex === k.publicKeyHex && !c.disabled;
  });
}

/**
 * Re-create the identity of an escrowed file on `network`. Returns { status: 'restored' |
 * 'already-restored', identityId, balance, coreHeight, role } (`role` holds the rebuilt keys: never
 * print it). `deps` replaces the network calls in tests.
 */
export async function restoreIdentity({ record, network, expectId, log = () => {}, deps = {} }) {
  const role = checkEscrow(record, network, { expectId });
  const { txid, identityId } = role;
  const d = {
    getTransaction: (id) => new ChainClient(network, { log }).getTransaction(id),
    describeIdentity: (id) => platform.describeIdentity(network, id, log),
    obtainAssetLock: (opts) => obtainAssetLock(network, opts),
    identityIdFromLock: platform.identityIdFromLock,
    registerIdentity: platform.registerIdentity,
    ...deps,
  };
  log(`[restore] ${identityId}: asset lock ${txid}:0 (${network.name})`);

  // Core must still know the transaction, mined: a Core reset (or another network) loses it
  let tx;
  try {
    tx = await d.getTransaction(txid);
  } catch (err) {
    const notFound = (err instanceof InsightError && (err.status === 404 || err.status === 400)) || /not found/i.test(err?.message ?? '');
    if (!notFound) throw new Error(`cannot read asset-lock tx ${txid} from Core (${err?.message ?? err}); retry`);
    throw new Error(`Core ${network.name} does not know asset-lock tx ${txid}: Core was reset too (or this is another network), so the identity cannot be re-created from it. ${FRESH}`);
  }
  if (tx?.blockheight === undefined) {
    throw new Error(`asset-lock tx ${txid} is not mined on Core ${network.name}: an escrowed lock was mined long ago, so Core was reset (or this is another network). ${FRESH}`);
  }

  // Already there: the same keys means restored (by an earlier run); other keys means someone else
  // spent the escrowed asset lock on this chain
  const existing = await d.describeIdentity(identityId);
  if (existing) {
    if (!sameKeys(existing, role)) {
      throw new Error(`identity ${identityId} exists on this chain with other keys than the file's: its asset lock was consumed by another registration. ${FRESH}`);
    }
    log(`[restore] ${identityId} is already on this chain with the file's keys; nothing to do`);
    return { status: 'already-restored', identityId, balance: existing.balance, coreHeight: tx.blockheight, role };
  }

  // A chain-lock proof, always (an old InstantSend lock is refused); its id is checked again by the SDK
  const lock = await d.obtainAssetLock({ txid, log, proof: 'chain' });
  if (lock.type !== 'chain') throw new Error(`expected a chain-lock proof, got ${lock.type}`);
  const sdkId = d.identityIdFromLock(lock);
  if (sdkId !== identityId) throw new Error(`the SDK derives ${sdkId} from asset lock ${txid}:0, not ${identityId}; nothing was registered`);

  let result;
  try {
    result = await d.registerIdentity({ network, lock, assetLockPrivateKeyWif: privateKeyToWif(role.assetLockKeyPair.privateKey, network), identityKeys: role.identityKeys, log });
  } catch (err) {
    if (/already completely used|credits left out of/i.test(err?.message ?? '')) {
      throw new Error(`asset lock ${txid}:0 is already consumed on this chain (a top-up or another identity spent it), so ${identityId} cannot be re-created. ${FRESH}`);
    }
    throw err;
  }
  if (result.identityId !== identityId) throw new Error(`Platform created ${result.identityId}, not ${identityId}`);
  log(`[restore] ${identityId} re-created (balance ${result.balance} credits)`);
  return { status: 'restored', identityId, balance: result.balance, coreHeight: tx.blockheight, role };
}

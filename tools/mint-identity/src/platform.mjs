// Dash Platform operations via @dashevo/evo-sdk (4.2.x: protocol 14 on devnets,
// still speaks protocol 13 to testnet). Ported from mainnet-bridge
// src/platform/{identity,client}.ts, trimmed to the trusted-context path.
import * as evoSdk from '@dashevo/evo-sdk';
import { hash160 } from './hash.mjs';

const PUT_SETTINGS = { connectTimeoutMs: 10000, timeoutMs: 40000, retries: 3 };

// One connected SDK per network name, reused across calls.
const sdks = new Map();

/**
 * Connect (trusted: a prefetched quorum context verifies proofs) and reuse.
 * `network.sdk` holds the EvoSDK constructor options — `{ network: 'testnet',
 * trusted: true }` for testnet, `{ network: 'devnet', trusted: true,
 * devnetName, quorumUrl, addresses }` for a devnet. On a devnet the node's
 * chain id is checked so a stale address list can't point us at another network.
 */
export async function getSdk(network, log = () => {}) {
  if (!sdks.has(network.name)) {
    sdks.set(
      network.name,
      (async () => {
        const sdk = new evoSdk.EvoSDK({ ...network.sdk, settings: PUT_SETTINGS });
        log(`Connecting to Dash Platform (${network.name})...`);
        await sdk.connect();
        if (network.chainId) {
          const chainId = (await sdk.system.status()).toJSON()?.network?.chainId;
          if (chainId !== network.chainId) {
            throw new Error(`Platform reports chain id "${chainId}", expected "${network.chainId}"`);
          }
        }
        log(`Connected to Platform (${network.name}, protocol ${sdk.version()}).`);
        return sdk;
      })()
    );
  }
  try {
    return await sdks.get(network.name);
  } catch (err) {
    sdks.delete(network.name);
    throw err;
  }
}

export async function disconnectSdk() {
  const pending = [...sdks.values()];
  sdks.clear();
  for (const p of pending) {
    try {
      const sdk = await p;
      if (sdk?.disconnect) await sdk.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/** Platform's chain-locked Core height: the most a ChainAssetLockProof may claim. */
export async function getCoreChainLockedHeight(network, log = () => {}) {
  const sdk = await getSdk(network, log);
  const height = (await sdk.system.status()).toJSON()?.chain?.coreChainLockedHeight;
  return typeof height === 'number' ? height : undefined;
}

/**
 * Typed AssetLockProof from lock data:
 *   { type: 'instant', transactionBytes, instantLockBytes, outputIndex }
 *   { type: 'chain', txid, coreChainLockedHeight, outputIndex }
 */
export function buildAssetLockProof(lock) {
  const { AssetLockProof, OutPoint } = evoSdk;
  if (lock.type === 'chain') {
    return AssetLockProof.createChainAssetLockProof(lock.coreChainLockedHeight, new OutPoint(lock.txid, lock.outputIndex ?? 0));
  }
  return AssetLockProof.createInstantAssetLockProof(lock.instantLockBytes, lock.transactionBytes, lock.outputIndex ?? 0);
}

/** The Platform identity id a lock will produce (base58). */
export function identityIdFromLock(lock) {
  return buildAssetLockProof(lock).createIdentityId().toString();
}

/**
 * Register an identity from an asset-lock proof.
 * identityKeys: the 5-key set from generateDefaultIdentityKeysHD.
 * Returns { identityId, balance }.
 */
export async function registerIdentity({ network, lock, assetLockPrivateKeyWif, identityKeys, log = () => {} }) {
  const sdk = await getSdk(network, log);
  const { Identity, IdentityPublicKey, IdentitySigner, PrivateKey } = evoSdk;

  const proof = buildAssetLockProof(lock);
  const identityId = proof.createIdentityId().toString();
  log(`Derived identity id from ${lock.type} asset-lock proof: ${identityId}`);

  const identity = new Identity(identityId);
  const signer = new IdentitySigner();
  for (const key of identityKeys) {
    const publicKey = new IdentityPublicKey({
      keyId: key.id,
      purpose: key.purpose.toLowerCase(),
      securityLevel: key.securityLevel.toLowerCase(),
      keyType: key.keyType.toLowerCase(),
      isReadOnly: false,
      data: key.keyType === 'ECDSA_HASH160' ? hash160(key.publicKey) : key.publicKey,
    });
    identity.addPublicKey(publicKey);
    signer.addKeyFromWif(key.privateKeyWif);
  }

  const assetLockPrivateKey = PrivateKey.fromWIF(assetLockPrivateKeyWif);

  log(`Creating identity with ${identityKeys.length} keys...`);
  await sdk.identities.create({ identity, assetLockProof: proof, assetLockPrivateKey, signer, settings: PUT_SETTINGS });

  const balance = await getBalance(network, identityId, log);
  log(`Identity created: ${identityId} (balance ${balance} credits)`);
  return { identityId, balance };
}

/**
 * Top up an existing identity from an asset-lock proof.
 * Returns the new balance (bigint -> number).
 */
export async function topUpIdentity({ network, identityId, lock, assetLockPrivateKeyWif, log = () => {} }) {
  const sdk = await getSdk(network, log);
  const { PrivateKey } = evoSdk;

  const identity = await sdk.identities.fetch(identityId);
  if (!identity) throw new Error(`Identity not found: ${identityId}`);

  const proof = buildAssetLockProof(lock);
  const assetLockPrivateKey = PrivateKey.fromWIF(assetLockPrivateKeyWif);

  log(`Topping up identity ${identityId} (${lock.type} asset-lock proof)...`);
  const result = await sdk.identities.topUp({ identity, assetLockProof: proof, assetLockPrivateKey, settings: PUT_SETTINGS });
  const balance = await getBalance(network, identityId, log);
  log(`Top-up complete. New balance: ${balance} credits (topUp returned ${result})`);
  return balance;
}

/**
 * Transfer platform credits between two identities (IdentityCreditTransfer).
 * Signs with the sender's TRANSFER-purpose key. Consolidation helper.
 * `senderIdentityKeys` is the sender's full bridge-format key set.
 * Returns the sender's new balance.
 */
export async function transferCredits({ network, senderId, senderIdentityKeys, recipientId, amountCredits, log = () => {} }) {
  const sdk = await getSdk(network, log);
  const { IdentitySigner } = evoSdk;

  const identity = await sdk.identities.fetch(senderId);
  if (!identity) throw new Error(`Sender identity not found: ${senderId}`);

  const signer = new IdentitySigner();
  for (const key of senderIdentityKeys) {
    signer.addKeyFromWif(key.privateKeyWif);
  }

  log(`Transferring ${amountCredits} credits ${senderId} -> ${recipientId}...`);
  await sdk.identities.creditTransfer({
    identity,
    recipientId,
    amount: BigInt(amountCredits),
    signer,
    settings: PUT_SETTINGS,
  });
  const balance = await getBalance(network, senderId, log);
  log(`Transfer complete. Sender balance: ${balance} credits`);
  return balance;
}

/** Credit balance, or null when the identity does not exist (proved absence). */
export async function getBalanceOrNull(network, identityId, log = () => {}) {
  const sdk = await getSdk(network, log);
  const bal = await sdk.identities.balance(identityId);
  return bal === undefined || bal === null ? null : Number(bal);
}

export async function getBalance(network, identityId, log = () => {}) {
  return (await getBalanceOrNull(network, identityId, log)) ?? 0;
}

/**
 * Fetch an identity (proved) and summarize it: balance, revision, and its keys
 * as { id, purpose, securityLevel, keyType, dataHex, disabled }. Null if absent.
 */
export async function describeIdentity(network, identityId, log = () => {}) {
  const sdk = await getSdk(network, log);
  const identity = await sdk.identities.fetch(identityId);
  if (!identity) return null;
  return {
    identityId,
    balance: Number(identity.balance),
    revision: Number(identity.revision),
    keys: identity.publicKeys.map((k) => ({
      id: k.keyId,
      purpose: String(k.purpose).toUpperCase(),
      securityLevel: String(k.securityLevel).toUpperCase(),
      keyType: String(k.keyType).toUpperCase(),
      dataHex: String(k.data).toLowerCase(), // the 4.2 wasm getter returns hex
      disabled: k.disabledAt !== undefined,
    })),
  };
}

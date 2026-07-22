// Dash Platform operations via @dashevo/evo-sdk@4.0.0.
// Ported from mainnet-bridge src/platform/{identity,client}.ts, trimmed to the
// testnet-trusted path (mainnet-bridge's devnet/non-trusted branches dropped).
import * as evoSdk from '@dashevo/evo-sdk';
import { hash160 } from './hash.mjs';

const PUT_SETTINGS = { connectTimeoutMs: 10000, timeoutMs: 40000, retries: 3 };

let sdkPromise = null;

// Connect once (testnet trusted) and reuse. Trusted mode prefetches a quorum
// context so proofs verify and the normal wait path works (same as mainnet).
export async function getSdk(log = () => {}) {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const { EvoSDK } = evoSdk;
      const sdk = EvoSDK.testnetTrusted({ settings: PUT_SETTINGS });
      log('Connecting to Dash Platform (testnet)...');
      await sdk.connect();
      log('Connected to Platform.');
      return sdk;
    })();
  }
  return sdkPromise;
}

export async function disconnectSdk() {
  if (!sdkPromise) return;
  try {
    const sdk = await sdkPromise;
    if (sdk?.disconnect) await sdk.disconnect();
  } catch {
    /* ignore */
  }
  sdkPromise = null;
}

// Build the typed InstantAssetLockProof from raw islock + tx bytes.
function instantProof(transactionBytes, instantLockBytes, outputIndex = 0) {
  const { AssetLockProof } = evoSdk;
  return AssetLockProof.createInstantAssetLockProof(instantLockBytes, transactionBytes, outputIndex);
}

// Derive the Platform identity id a proof will produce (base58).
export function identityIdFromProof(transactionBytes, instantLockBytes, outputIndex = 0) {
  const proof = instantProof(transactionBytes, instantLockBytes, outputIndex);
  return proof.createIdentityId().toString();
}

/**
 * Register an identity from an instant asset-lock proof.
 * identityKeys: the 5-key set from generateDefaultIdentityKeysHD.
 * Returns { identityId, balance }.
 */
export async function registerIdentity({ transactionBytes, instantLockBytes, outputIndex = 0, assetLockPrivateKeyWif, identityKeys, log = () => {} }) {
  const sdk = await getSdk(log);
  const { Identity, IdentityPublicKey, IdentitySigner, PrivateKey } = evoSdk;

  const proof = instantProof(transactionBytes, instantLockBytes, outputIndex);
  const identityId = proof.createIdentityId().toString();
  log(`Derived identity id from proof: ${identityId}`);

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

  const balance = await getBalance(identityId, log);
  log(`Identity created: ${identityId} (balance ${balance} credits)`);
  return { identityId, balance };
}

/**
 * Top up an existing identity from an instant asset-lock proof.
 * Returns the new balance (bigint -> number).
 */
export async function topUpIdentity({ identityId, transactionBytes, instantLockBytes, outputIndex = 0, assetLockPrivateKeyWif, log = () => {} }) {
  const sdk = await getSdk(log);
  const { PrivateKey } = evoSdk;

  const identity = await sdk.identities.fetch(identityId);
  if (!identity) throw new Error(`Identity not found: ${identityId}`);

  const proof = instantProof(transactionBytes, instantLockBytes, outputIndex);
  const assetLockPrivateKey = PrivateKey.fromWIF(assetLockPrivateKeyWif);

  log(`Topping up identity ${identityId}...`);
  const result = await sdk.identities.topUp({ identity, assetLockProof: proof, assetLockPrivateKey, settings: PUT_SETTINGS });
  const balance = await getBalance(identityId, log);
  log(`Top-up complete. New balance: ${balance} credits (topUp returned ${result})`);
  return balance;
}

export async function getBalance(identityId, log = () => {}) {
  const sdk = await getSdk(log);
  const bal = await sdk.identities.balance(identityId);
  return bal === undefined || bal === null ? 0 : Number(bal);
}

// Bridge-format identity backup JSON.
// Reproduces mainnet-bridge/src/ui/components.ts createKeyBackup (create mode):
//   { network, created, mode, depositAddress, txid, mnemonic, identityId,
//     identityKeys[...], assetLockKey }
import { writeFileSync, chmodSync } from 'node:fs';
import { bytesToHex, privateKeyToWif } from './bytes.mjs';
import { getAssetLockDerivationPath } from './hd.mjs';

/**
 * Build the create-mode backup object (private-key-bearing).
 * role: { network, mnemonic, depositAddress, txid, identityId, identityKeys, assetLockKeyPair }
 */
export function buildIdentityBackup(role, networkConfig) {
  return {
    network: networkConfig.name,
    created: new Date().toISOString(),
    mode: 'create',
    depositAddress: role.depositAddress,
    txid: role.txid,
    mnemonic: role.mnemonic,
    identityId: role.identityId,
    identityKeys: role.identityKeys.map((k) => ({
      id: k.id,
      name: k.name,
      keyType: k.keyType,
      purpose: k.purpose,
      securityLevel: k.securityLevel,
      privateKeyWif: k.privateKeyWif,
      privateKeyHex: k.privateKeyHex,
      publicKeyHex: k.publicKeyHex,
      derivationPath: k.derivationPath,
    })),
    assetLockKey: role.assetLockKeyPair
      ? {
          wif: privateKeyToWif(role.assetLockKeyPair.privateKey, networkConfig),
          publicKeyHex: bytesToHex(role.assetLockKeyPair.publicKey),
          derivationPath: getAssetLockDerivationPath(networkConfig.name),
        }
      : null,
  };
}

// Write a backup JSON with 0600 perms (contains private keys — never world-readable).
export function writeIdentityFile(path, backupObject) {
  writeFileSync(path, JSON.stringify(backupObject, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

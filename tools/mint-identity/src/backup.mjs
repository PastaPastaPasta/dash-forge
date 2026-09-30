// Bridge-format identity backup JSON.
// Reproduces mainnet-bridge/src/ui/components.ts createKeyBackup (create mode):
//   { network, created, mode, depositAddress, txid, mnemonic, identityId,
//     identityKeys[...], assetLockKey }
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

/**
 * Write a file holding secrets (a mnemonic, a WIF) as a new 0600 inode: a unique temp sibling
 * created exclusively (`wx`, so nothing already there is opened or followed), synced, then
 * renamed over `path`. rename replaces a symlink at `path` rather than writing through it, and
 * the result is 0600 whatever the permissions of a file it replaces. The temp file is removed
 * on failure; the directory is synced after the rename, so the new name survives a crash too.
 */
export function writeSecretFile(path, data) {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the write already failed: report that error */
      }
    }
    rmSync(tmp, { force: true });
    throw err;
  }
  syncDir(dirname(path));
}

/** Best effort: not every platform can fsync a directory (Windows cannot open one). */
function syncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* the file itself is written and synced */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Write a backup JSON with 0600 perms (contains private keys — never world-readable).
export function writeIdentityFile(path, backupObject) {
  writeSecretFile(path, JSON.stringify(backupObject, null, 2) + '\n');
}

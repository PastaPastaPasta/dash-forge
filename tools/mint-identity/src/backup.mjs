// Bridge-format identity backup JSON.
// Reproduces mainnet-bridge/src/ui/components.ts createKeyBackup (create mode):
//   { network, created, mode, depositAddress, txid, mnemonic, identityId,
//     identityKeys[...], assetLockKey }
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * the result is 0600 whatever the permissions of a file it replaces. A temp file this call
 * created is removed on failure (one that was already there is left alone); the directory is
 * synced after the rename, so the new name survives a crash too. `nonce`: tests only.
 */
export function writeSecretFile(path, data, { nonce = randomBytes(8).toString('hex') } = {}) {
  const tmp = `${path}.${process.pid}.${nonce}.tmp`;
  let fd;
  let created = false;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    created = true;
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
    if (created) rmSync(tmp, { force: true });
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

/**
 * Create `dir` (and missing parents) 0700, and tighten it to 0700 when it already exists with
 * group/other access: it holds files with private keys. Returns `dir`.
 */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (st.mode & 0o077) chmodSync(dir, 0o700);
  return dir;
}

/**
 * Run `fn` holding an exclusive lock file `<path>.lock` (created `wx`, so two runs cannot both
 * hold it), removed afterwards even when `fn` throws. A second run fails straight away rather
 * than waiting. A run that crashed leaves the lock behind; the message says to remove it.
 */
export async function withExclusiveLock(path, what, fn) {
  const lockPath = `${path}.lock`;
  let fd;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if (err?.code === 'EEXIST') {
      throw new Error(`Another ${what} is in progress, or remove ${lockPath} if a previous run crashed`);
    }
    throw err;
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    fd = undefined;
    return await fn();
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

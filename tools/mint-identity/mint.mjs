#!/usr/bin/env node
// Dash Forge — headless testnet identity-minting CLI (spike S0.4).
//
//   node mint.mjs --out <dir> [--label OWNER] [--amount 0.5]
//   node mint.mjs pool --out <dir> [--amount 0.05]
//   node mint.mjs topup --identity <file> [--amount 0.1]
//   node mint.mjs balance --identity <file>
//
// See README.md for the full flag reference, rate-limit strategy, and security notes.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { TESTNET, dashToDuffs } from './src/config.mjs';
import { InsightClient } from './src/insight.mjs';
import { requestTestnetFunds } from './src/faucet.mjs';
import {
  createRole,
  assetLockAndRegister,
  assetLockAndTopUp,
  fanOutFunds,
  MIN_ASSET_LOCK_DUFFS,
} from './src/flow.mjs';
import { buildIdentityBackup, writeIdentityFile } from './src/backup.mjs';
import { generateKeyPair, getPublicKey, publicKeyToAddress } from './src/keys.mjs';
import { privateKeyToWif, wifToPrivateKey } from './src/bytes.mjs';
import * as platform from './src/platform.mjs';

const POOL_ROLES = ['OWNER', 'MAINTAINER', 'COLLAB', 'CONTRIB', 'FROZEN', 'CI-RUNNER', 'RELAY', 'DEPLOYER', 'TREASURY'];
const NETWORK = TESTNET;

function log(msg) {
  process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function ensureOutDir(out) {
  if (!out || out === true) throw new Error('--out <dir> is required');
  const dir = resolve(String(out));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fileForLabel(dir, label) {
  return join(dir, `${label}.identity.json`);
}

// --- mint one identity ---
async function cmdMint(args) {
  const dir = ensureOutDir(args.out);
  const label = String(args.label || 'OWNER');
  const amountDash = Number(args.amount || 0.5);
  const skipFaucet = !!args['skip-faucet'];
  const utxoFrom = args['utxo-from'] ? String(args['utxo-from']) : undefined;
  const outFile = fileForLabel(dir, label);

  // For --skip-faucet we want a stable deposit address across reruns: reuse a
  // provided mnemonic, or one already saved in the output file.
  let mnemonic = args.mnemonic && args.mnemonic !== true ? String(args.mnemonic) : undefined;
  if (!mnemonic && skipFaucet && existsSync(outFile)) {
    try {
      mnemonic = JSON.parse(readFileSync(outFile, 'utf8')).mnemonic;
    } catch { /* ignore */ }
  }

  const role = createRole(label, NETWORK, mnemonic);
  log(`[${label}] deposit address: ${role.depositAddress}`);

  const insight = new InsightClient(NETWORK);
  let minDuffs = Math.max(MIN_ASSET_LOCK_DUFFS + 1000, Math.floor(dashToDuffs(amountDash) * 0.9));

  if (skipFaucet) {
    if (utxoFrom && utxoFrom !== role.depositAddress) {
      throw new Error(
        `--utxo-from ${utxoFrom} does not match the derived deposit address ${role.depositAddress}. ` +
          `The asset lock can only spend funds controlled by this identity's key. ` +
          `Fund ${role.depositAddress} directly (pass the same --mnemonic to keep it stable), or omit --utxo-from.`
      );
    }
    // Persist a pending backup up front so the deposit key is recoverable while
    // the user funds the address out-of-band.
    writeIdentityFile(outFile, buildIdentityBackup(role, NETWORK));
    log(`[${label}] --skip-faucet: send >= ${amountDash} tDASH to ${role.depositAddress}, then this run will continue.`);
    log(`[${label}] pending backup written to ${outFile}`);
  } else {
    log(`[${label}] Requesting funds from faucet (${NETWORK.faucetBaseUrl})...`);
    const faucetRes = await requestTestnetFunds(NETWORK.faucetBaseUrl, role.depositAddress, { amount: amountDash, log });
    log(`[${label}] Faucet sent ${faucetRes.amount} tDASH (txid ${faucetRes.txid}).`);
    minDuffs = Math.max(MIN_ASSET_LOCK_DUFFS + 1000, Math.floor(dashToDuffs(faucetRes.amount) * 0.9));
  }

  log(`[${label}] Waiting for deposit UTXO (>= ${minDuffs} duffs)...`);
  const utxo = await insight.waitForUtxo(role.depositAddress, minDuffs, { timeoutMs: 300000, log });

  const { identityId, balance } = await assetLockAndRegister(role, utxo, NETWORK, log);

  writeIdentityFile(outFile, buildIdentityBackup(role, NETWORK));
  log(`[${label}] Wrote ${outFile}`);

  await platform.disconnectSdk();
  console.log(JSON.stringify({ label, identityId, balance, depositAddress: role.depositAddress, assetLockTxid: role.txid, file: outFile }, null, 2));
}

// --- mint the 9-role pool ---
async function cmdPool(args) {
  const dir = ensureOutDir(args.out);
  const perRoleDash = Number(args.amount || 0.05);
  const perRoleDuffs = dashToDuffs(perRoleDash);

  const roles = POOL_ROLES.map((label) => createRole(label, NETWORK));
  const treasury = roles.find((r) => r.label === 'TREASURY');
  const others = roles.filter((r) => r.label !== 'TREASURY');

  for (const r of roles) log(`[${r.label}] deposit address: ${r.depositAddress}`);

  const insight = new InsightClient(NETWORK);

  // 1. Fund TREASURY from the faucet with the max it gives (~1 tDASH).
  log('[TREASURY] Requesting funds from faucet...');
  const faucetRes = await requestTestnetFunds(NETWORK.faucetBaseUrl, treasury.depositAddress, { log });
  log(`[TREASURY] Faucet sent ${faucetRes.amount} tDASH (txid ${faucetRes.txid}).`);
  const treasuryFundDuffs = Math.floor(dashToDuffs(faucetRes.amount) * 0.9);
  const treasuryUtxo = await insight.waitForUtxo(treasury.depositAddress, treasuryFundDuffs, { timeoutMs: 300000, log });

  // 2. Fan out from TREASURY to the other 8 deposit addresses (one L1 tx -> no
  //    faucet rate-limit exposure). Change returns to TREASURY's deposit addr,
  //    which becomes TREASURY's own asset-lock funding UTXO.
  await fanOutFunds(
    {
      sourceUtxo: treasuryUtxo,
      sourceKeyPair: treasury.assetLockKeyPair,
      recipients: others.map((r) => r.depositAddress),
      perRoleDuffs,
      changeAddress: treasury.depositAddress,
    },
    NETWORK,
    log
  );

  // 3. Mint every role from its now-funded deposit UTXO.
  const results = [];
  const minDuffs = Math.max(MIN_ASSET_LOCK_DUFFS + 1000, Math.floor(perRoleDuffs * 0.9));
  for (const r of roles) {
    log(`=== Minting ${r.label} ===`);
    const wait = r.label === 'TREASURY' ? treasuryFundDuffs - perRoleDuffs * others.length : minDuffs;
    const utxo = await insight.waitForUtxo(r.depositAddress, Math.max(MIN_ASSET_LOCK_DUFFS + 1000, wait), { timeoutMs: 300000, log });
    const { identityId, balance } = await assetLockAndRegister(r, utxo, NETWORK, log);
    const outFile = fileForLabel(dir, r.label);
    writeIdentityFile(outFile, buildIdentityBackup(r, NETWORK));
    log(`[${r.label}] Wrote ${outFile} (identity ${identityId})`);
    results.push({ label: r.label, identityId, balance, file: outFile });
  }

  await platform.disconnectSdk();
  console.log(JSON.stringify({ pool: results }, null, 2));
}

// --- top up an existing identity ---
async function cmdTopup(args) {
  const idFile = args.identity && args.identity !== true ? String(args.identity) : undefined;
  if (!idFile) throw new Error('--identity <file> is required');
  const amountDash = Number(args.amount || 0.1);
  const waitSeconds = Number(args.wait || 300);
  const record = JSON.parse(readFileSync(resolve(idFile), 'utf8'));
  const identityId = record.identityId;
  if (!identityId) throw new Error(`No identityId in ${idFile}`);

  // One-time asset-lock key for the top-up (matches bridge top-up behavior). The key is
  // PERSISTED next to the identity file before any address is shown: funds sent after a
  // timeout or crash stay recoverable, and a rerun reuses the same deposit address.
  const pendingPath = `${resolve(idFile)}.topup-pending.json`;
  let assetLockKeyPair;
  if (existsSync(pendingPath)) {
    const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
    const privateKey = wifToPrivateKey(pending.wif).privateKey;
    assetLockKeyPair = { privateKey, publicKey: getPublicKey(privateKey) };
    log(`[topup ${identityId}] reusing pending deposit key from ${pendingPath}`);
  } else {
    assetLockKeyPair = generateKeyPair();
  }
  const depositAddress = publicKeyToAddress(assetLockKeyPair.publicKey, NETWORK);
  if (!existsSync(pendingPath)) {
    writeFileSync(
      pendingPath,
      JSON.stringify(
        {
          identityId,
          depositAddress,
          wif: privateKeyToWif(assetLockKeyPair.privateKey, NETWORK),
          created: new Date().toISOString(),
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
  }
  log(`[topup ${identityId}] one-time deposit address: ${depositAddress}`);

  const insight = new InsightClient(NETWORK);
  if (args['skip-faucet']) {
    log(`[topup] --skip-faucet: send >= ${amountDash} tDASH to ${depositAddress}, then this run will continue.`);
  } else {
    const faucetRes = await requestTestnetFunds(NETWORK.faucetBaseUrl, depositAddress, { amount: amountDash, log });
    log(`[topup] Faucet sent ${faucetRes.amount} tDASH (txid ${faucetRes.txid}).`);
  }
  const minDuffs = Math.max(MIN_ASSET_LOCK_DUFFS + 1000, Math.floor(dashToDuffs(amountDash) * 0.9));
  const utxo = await insight.waitForUtxo(depositAddress, minDuffs, { timeoutMs: waitSeconds * 1000, log });

  const { txid, balance } = await assetLockAndTopUp({ identityId, assetLockKeyPair }, utxo, NETWORK, log);
  unlinkSync(pendingPath);
  await platform.disconnectSdk();
  console.log(JSON.stringify({ identityId, topUpTxid: txid, balance }, null, 2));
}

// --- print identity credit balance ---
async function cmdBalance(args) {
  const idFile = args.identity && args.identity !== true ? String(args.identity) : undefined;
  if (!idFile) throw new Error('--identity <file> is required');
  const record = JSON.parse(readFileSync(resolve(idFile), 'utf8'));
  const identityId = record.identityId;
  if (!identityId) throw new Error(`No identityId in ${idFile}`);
  const balance = await platform.getBalance(identityId, log);
  await platform.disconnectSdk();
  console.log(JSON.stringify({ identityId, balance }, null, 2));
}

// --- transfer platform credits between identities (testnet consolidation) ---
async function cmdTransfer(args) {
  const fromFile = args.from && args.from !== true ? String(args.from) : undefined;
  const toFile = args.to && args.to !== true ? String(args.to) : undefined;
  if (!fromFile || !toFile) throw new Error('--from <file> and --to <file> are required');
  const sender = JSON.parse(readFileSync(resolve(fromFile), 'utf8'));
  const recipient = JSON.parse(readFileSync(resolve(toFile), 'utf8'));
  const amountDash = args.amount && args.amount !== true ? Number(args.amount) : 0.2;
  const amountCredits = Math.round(amountDash * 1e11); // 1 DASH = 1e11 credits
  const balance = await platform.transferCredits({
    senderId: sender.identityId,
    senderIdentityKeys: sender.identityKeys,
    recipientId: recipient.identityId,
    amountCredits,
    log,
  });
  await platform.disconnectSdk();
  console.log(JSON.stringify({ from: sender.identityId, to: recipient.identityId, amountCredits, senderBalance: balance }, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const sub = args._[0];

  try {
    if (sub === 'pool') await cmdPool(args);
    else if (sub === 'topup') await cmdTopup(args);
    else if (sub === 'balance') await cmdBalance(args);
    else if (sub === 'transfer') await cmdTransfer(args);
    else await cmdMint(args); // default: mint one
  } catch (err) {
    log(`ERROR: ${err.message}`);
    if (process.env.MINT_DEBUG) console.error(err);
    await platform.disconnectSdk().catch(() => {});
    process.exit(1);
  }
}

main();

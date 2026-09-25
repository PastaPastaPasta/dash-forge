#!/usr/bin/env node
// Dash Forge — headless identity-minting CLI for testnet and devnets (spike S0.4).
//
//   node mint.mjs [--network testnet|devnet --devnet-name moutai] --out <dir> [--label OWNER] [--amount 0.5]
//   node mint.mjs pool --out <dir> [--amount 0.05] [--role-amounts DEPLOYER=50]
//   node mint.mjs topup --identity <file> [--amount 0.1]
//   node mint.mjs balance --identity <file>
//   node mint.mjs verify --dir <dir>
//   node mint.mjs transfer --from <file> --to <file> [--amount 0.2]
//
// Funding: --funding faucet (testnet default) | fund-from-key (devnet default;
// --funding-key-file <path> or FORGE_DEVNET_FUNDING_WIF) | manual (alias --skip-faucet).
//
// See README.md for the full flag reference, rate-limit strategy, and security notes.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { resolveNetwork, networkFromName, dashToDuffs } from './src/config.mjs';
import { InsightClient } from './src/insight.mjs';
import { requestTestnetFunds } from './src/faucet.mjs';
import {
  createRole,
  assetLockAndRegister,
  assetLockAndTopUp,
  broadcastAssetLock,
  registerRoleFromLockTx,
  fanOutFunds,
  MIN_ASSET_LOCK_DUFFS,
} from './src/flow.mjs';
import { loadFundingKey, fundFromKey } from './src/funding.mjs';
import { waitForFundingTx } from './src/lock.mjs';
import { buildIdentityBackup, writeIdentityFile } from './src/backup.mjs';
import { generateKeyPair, getPublicKey, publicKeyToAddress } from './src/keys.mjs';
import { privateKeyToWif, wifToPrivateKey } from './src/bytes.mjs';
import * as platform from './src/platform.mjs';

const POOL_ROLES = ['OWNER', 'MAINTAINER', 'COLLAB', 'CONTRIB', 'FROZEN', 'CI-RUNNER', 'RELAY', 'DEPLOYER', 'TREASURY'];
const FUNDING_MODES = ['faucet', 'fund-from-key', 'manual'];
const DEPOSIT_WAIT_MS = 300000;

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

function str(v) {
  return v && v !== true ? String(v) : undefined;
}

function ensureOutDir(out) {
  if (!out || out === true) throw new Error('--out <dir> is required');
  const dir = resolve(String(out));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function fileForLabel(dir, label) {
  return join(dir, `${label}.identity.json`);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

/** --network/--devnet-name from the command line (testnet when absent). */
function networkFromArgs(args) {
  return resolveNetwork({ network: str(args.network) ?? 'testnet', devnetName: str(args['devnet-name']) });
}

/** The network an identity file was minted on; a --network flag must agree with it. */
function networkForRecord(args, record, file) {
  const network = networkFromName(record.network);
  if (str(args.network)) {
    const selected = networkFromArgs(args).name;
    if (selected !== network.name) throw new Error(`${file} is a ${network.name} identity, but --network selects ${selected}`);
  }
  return network;
}

/** Read `--<flag> <identity file>`: { file, record, network, identityId }. */
function loadIdentityArg(args, flag) {
  const file = str(args[flag]);
  if (!file) throw new Error(`--${flag} <file> is required`);
  const record = readJson(file);
  if (!record.identityId) throw new Error(`No identityId in ${file}`);
  return { file, record, network: networkForRecord(args, record, file), identityId: record.identityId };
}

/** --funding (or legacy --skip-faucet); faucet on testnet, fund-from-key on devnets by default. */
function fundingMode(args, network) {
  const mode = args['skip-faucet'] ? 'manual' : str(args.funding) ?? (network.faucetBaseUrl ? 'faucet' : 'fund-from-key');
  if (!FUNDING_MODES.includes(mode)) throw new Error(`--funding must be one of ${FUNDING_MODES.join(', ')}`);
  if (mode === 'faucet' && !network.faucetBaseUrl) {
    throw new Error(
      `${network.name} has no headless faucet (its web faucet ${network.webFaucetUrl ?? ''} needs a captcha). ` +
        'Use --funding fund-from-key --funding-key-file <path>, or --funding manual.'
    );
  }
  return mode;
}

/** Pay `recipients` ([{ address, duffs }]) from the funding key and wait until spendable. */
async function payFromFundingKey(args, network, recipients) {
  const key = loadFundingKey(network, { keyFile: str(args['funding-key-file']) });
  log(`fund-from-key: funding address ${key.address}`);
  const txid = await fundFromKey(key, recipients, network, log);
  await waitForFundingTx(network, txid, log);
}

/**
 * Fund one deposit `address` with `amountDash` in the given mode, unless it
 * already holds `minDuffs`. Returns the faucet's actual amount (DASH) when the
 * faucet paid, else undefined.
 */
async function fundDeposit(args, network, funding, insight, { address, amountDash, minDuffs, tag }) {
  const held = await insight.getBalance(address);
  if (held >= minDuffs) {
    log(`${tag} deposit address already holds ${(held / 1e8).toFixed(8)} DASH; not funding again.`);
    return undefined;
  }
  if (funding === 'manual') {
    log(`${tag} --funding manual: send >= ${amountDash} DASH to ${address}, then this run will continue.`);
    return undefined;
  }
  if (funding === 'fund-from-key') {
    await payFromFundingKey(args, network, [{ address, duffs: dashToDuffs(amountDash) }]);
    return undefined;
  }
  log(`${tag} Requesting funds from faucet (${network.faucetBaseUrl})...`);
  const res = await requestTestnetFunds(network.faucetBaseUrl, address, { amount: amountDash, log });
  log(`${tag} Faucet sent ${res.amount} tDASH (txid ${res.txid}).`);
  return res.amount;
}

/** Asset-lock the deposit, never re-requesting less than the network minimum. */
function minDepositDuffs(duffs) {
  return Math.max(MIN_ASSET_LOCK_DUFFS + 1000, Math.floor(duffs * 0.9));
}

/** Parse `DEPLOYER=50,TREASURY=10` into { DEPLOYER: 50, TREASURY: 10 } (DASH). */
function parseRoleAmounts(spec) {
  const out = {};
  if (!spec) return out;
  for (const part of String(spec).split(',')) {
    const [label, value] = part.split('=');
    if (!POOL_ROLES.includes(label) || !(Number(value) > 0)) throw new Error(`Bad --role-amounts entry "${part}"`);
    out[label] = Number(value);
  }
  return out;
}

/**
 * A role whose keys are already saved in `file` (a pending or finished mint),
 * or a fresh one. Resuming keeps the deposit address and any asset-lock txid.
 */
function loadOrCreateRole(file, label, network, mnemonic) {
  if (existsSync(file)) {
    const saved = readJson(file);
    if (saved.network !== network.name) throw new Error(`${file} is a ${saved.network} identity, not ${network.name}`);
    if (mnemonic && mnemonic !== saved.mnemonic) throw new Error(`${file} already holds a different mnemonic than --mnemonic`);
    const role = createRole(label, network, saved.mnemonic);
    if (role.depositAddress !== saved.depositAddress) throw new Error(`${file}: mnemonic does not match its depositAddress`);
    role.txid = saved.txid;
    role.identityId = saved.identityId;
    return role;
  }
  return createRole(label, network, mnemonic);
}

function saveRole(file, role, network) {
  writeIdentityFile(file, buildIdentityBackup(role, network));
}

// --- mint one identity ---
async function cmdMint(args) {
  const network = networkFromArgs(args);
  const dir = ensureOutDir(args.out);
  const label = String(args.label || 'OWNER');
  const amountDash = Number(args.amount || 0.5);
  const funding = fundingMode(args, network);
  const outFile = fileForLabel(dir, label);

  const role = loadOrCreateRole(outFile, label, network, str(args.mnemonic));
  if (role.identityId) throw new Error(`${outFile} already holds identity ${role.identityId}; use topup to add credits`);
  const utxoFrom = str(args['utxo-from']);
  if (utxoFrom && utxoFrom !== role.depositAddress) {
    throw new Error(
      `--utxo-from ${utxoFrom} does not match the derived deposit address ${role.depositAddress}. ` +
        `The asset lock can only spend funds controlled by this identity's key. ` +
        `Fund ${role.depositAddress} directly (rerun with the same --out to keep it stable), or omit --utxo-from.`
    );
  }
  log(`[${label}] ${network.name} deposit address: ${role.depositAddress}`);
  // Persist a pending backup up front so the deposit key is recoverable while funds move.
  saveRole(outFile, role, network);
  log(`[${label}] pending backup written to ${outFile}`);

  let result;
  if (role.txid) {
    log(`[${label}] resuming from asset-lock tx ${role.txid}`);
    result = await registerRoleFromLockTx(role, network, log);
  } else {
    const insight = new InsightClient(network);
    let minDuffs = minDepositDuffs(dashToDuffs(amountDash));
    const faucetDash = await fundDeposit(args, network, funding, insight, { address: role.depositAddress, amountDash, minDuffs, tag: `[${label}]` });
    if (faucetDash !== undefined) minDuffs = minDepositDuffs(dashToDuffs(faucetDash));
    log(`[${label}] Waiting for deposit UTXO (>= ${minDuffs} duffs)...`);
    const utxo = await insight.waitForUtxo(role.depositAddress, minDuffs, { timeoutMs: DEPOSIT_WAIT_MS, log });
    result = await assetLockAndRegister(role, utxo, network, log, () => saveRole(outFile, role, network));
  }

  saveRole(outFile, role, network);
  log(`[${label}] Wrote ${outFile}`);
  return { network: network.name, label, identityId: result.identityId, balance: result.balance, depositAddress: role.depositAddress, assetLockTxid: role.txid, file: outFile };
}

// --- mint the 9-role pool ---
async function cmdPool(args) {
  const network = networkFromArgs(args);
  const dir = ensureOutDir(args.out);
  const funding = fundingMode(args, network);
  const perRoleDash = Number(args.amount || (network.type === 'devnet' ? 5 : 0.05));
  const overrides = parseRoleAmounts(args['role-amounts']);
  if (funding === 'faucet' && Object.keys(overrides).length > 0) {
    throw new Error('--role-amounts needs --funding fund-from-key or manual (the faucet fan-out pays every role --amount)');
  }
  const duffsFor = (r) => dashToDuffs(overrides[r.label] ?? perRoleDash);

  const roles = POOL_ROLES.map((label) => loadOrCreateRole(fileForLabel(dir, label), label, network));
  const todo = roles.filter((r) => !r.identityId);
  for (const r of roles) {
    log(`[${r.label}] deposit address: ${r.depositAddress}${r.identityId ? ` (already minted: ${r.identityId})` : ''}`);
    if (!r.identityId) saveRole(fileForLabel(dir, r.label), r, network); // keys recoverable before funds move
  }

  // Roles that have neither broadcast an asset lock nor received their deposit.
  const insight = new InsightClient(network);
  const unfunded = [];
  for (const r of todo) {
    if (!r.txid && (await insight.getBalance(r.depositAddress)) < minDepositDuffs(duffsFor(r))) unfunded.push(r);
  }

  // Where each role's asset-lock input comes from: an exact outpoint when this
  // run funded it (never a stale, already-spent UTXO), else any large-enough UTXO.
  const outpoints = new Map();
  if (unfunded.length === 0) {
    log(todo.length === 0 ? 'Every role is already minted; nothing to fund.' : 'Every role still to mint is already funded.');
  } else if (funding === 'faucet') {
    if (unfunded.length !== roles.length) {
      throw new Error('--funding faucet funds a fresh pool only; finish a partial pool with --funding fund-from-key or manual');
    }
    await fundPoolFromFaucet(roles, network, insight, dashToDuffs(perRoleDash), outpoints);
  } else if (funding === 'fund-from-key') {
    await payFromFundingKey(args, network, unfunded.map((r) => ({ address: r.depositAddress, duffs: duffsFor(r) })));
  } else {
    for (const r of unfunded) log(`[${r.label}] --funding manual: send ${(duffsFor(r) / 1e8).toFixed(8)} DASH to ${r.depositAddress}`);
  }

  // Devnets broadcast every asset lock first and then register, so the whole
  // pool pays the chain-lock wait once. Testnet registers each role right after
  // its broadcast, while its InstantSend lock can still be fetched.
  const batch = network.lockProof === 'chain';
  const broadcast = async (r) => {
    const at = outpoints.get(r.label);
    const utxo = at
      ? await insight.waitForOutpoint(r.depositAddress, at.txid, at.vout, { timeoutMs: DEPOSIT_WAIT_MS, log })
      : await insight.waitForUtxo(r.depositAddress, minDepositDuffs(duffsFor(r)), { timeoutMs: DEPOSIT_WAIT_MS, log });
    const { txid, transactionBytes } = await broadcastAssetLock({ utxo, assetLockKeyPair: r.assetLockKeyPair, tag: `[${r.label}] ` }, network, log);
    r.txid = txid;
    saveRole(fileForLabel(dir, r.label), r, network);
    return transactionBytes;
  };
  const txBytes = new Map();
  if (batch) for (const r of todo.filter((x) => !x.txid)) txBytes.set(r.label, await broadcast(r));

  const results = [];
  for (const r of roles) {
    const file = fileForLabel(dir, r.label);
    if (!r.identityId) {
      if (!r.txid) txBytes.set(r.label, await broadcast(r));
      log(`=== Registering ${r.label} ===`);
      await registerRoleFromLockTx(r, network, log, txBytes.get(r.label));
      saveRole(file, r, network);
      log(`[${r.label}] Wrote ${file} (identity ${r.identityId})`);
    }
    results.push({ label: r.label, identityId: r.identityId, balance: await platform.getBalance(network, r.identityId, log), file });
  }
  return { network: network.name, pool: results };
}

/**
 * Testnet faucet strategy (3 requests/hour/IP): one faucet call funds TREASURY,
 * then one L1 fan-out tx pays the other 8 deposit addresses (outputs 0..7) with
 * the change (output 8) back to TREASURY's deposit address as its own asset-lock
 * UTXO. Records each role's funding outpoint in `outpoints`.
 */
async function fundPoolFromFaucet(roles, network, insight, perRoleDuffs, outpoints) {
  const treasury = roles.find((r) => r.label === 'TREASURY');
  const others = roles.filter((r) => r.label !== 'TREASURY');

  log('[TREASURY] Requesting funds from faucet...');
  const faucetRes = await requestTestnetFunds(network.faucetBaseUrl, treasury.depositAddress, { log });
  log(`[TREASURY] Faucet sent ${faucetRes.amount} tDASH (txid ${faucetRes.txid}).`);
  const treasuryFundDuffs = Math.floor(dashToDuffs(faucetRes.amount) * 0.9);
  const treasuryUtxo = await insight.waitForUtxo(treasury.depositAddress, treasuryFundDuffs, { timeoutMs: DEPOSIT_WAIT_MS, log });

  const txid = await fanOutFunds(
    {
      sourceUtxo: treasuryUtxo,
      sourceKeyPair: treasury.assetLockKeyPair,
      recipients: others.map((r) => r.depositAddress),
      perRoleDuffs,
      changeAddress: treasury.depositAddress,
    },
    network,
    log
  );
  others.forEach((r, vout) => outpoints.set(r.label, { txid, vout }));
  outpoints.set(treasury.label, { txid, vout: others.length });
}

// --- top up an existing identity ---
async function cmdTopup(args) {
  const { file: idFile, network, identityId } = loadIdentityArg(args, 'identity');
  const funding = fundingMode(args, network);
  const amountDash = Number(args.amount || 0.1);
  const waitSeconds = Number(args.wait || 300);

  // One-time asset-lock key for the top-up (matches bridge top-up behavior). The key is
  // PERSISTED next to the identity file before any address is shown: funds sent after a
  // timeout or crash stay recoverable, and a rerun reuses the same deposit address (and,
  // once broadcast, the same asset-lock tx).
  const pendingPath = `${resolve(idFile)}.topup-pending.json`;
  const savePending = (p) => writeFileSync(pendingPath, JSON.stringify(p, null, 2), { mode: 0o600 });
  let pending;
  let assetLockKeyPair;
  if (existsSync(pendingPath)) {
    pending = readJson(pendingPath);
    const privateKey = wifToPrivateKey(pending.wif).privateKey;
    assetLockKeyPair = { privateKey, publicKey: getPublicKey(privateKey) };
    log(`[topup ${identityId}] reusing pending deposit key from ${pendingPath}`);
  } else {
    assetLockKeyPair = generateKeyPair();
    pending = {
      identityId,
      network: network.name,
      depositAddress: publicKeyToAddress(assetLockKeyPair.publicKey, network),
      wif: privateKeyToWif(assetLockKeyPair.privateKey, network),
      created: new Date().toISOString(),
    };
    savePending(pending);
  }
  const depositAddress = publicKeyToAddress(assetLockKeyPair.publicKey, network);
  log(`[topup ${identityId}] one-time ${network.name} deposit address: ${depositAddress}`);

  let utxo = null; // null: finish the asset lock an earlier run already broadcast
  if (!pending.assetLockTxid) {
    const insight = new InsightClient(network);
    const minDuffs = minDepositDuffs(dashToDuffs(amountDash));
    await fundDeposit(args, network, funding, insight, { address: depositAddress, amountDash, minDuffs, tag: '[topup]' });
    utxo = await insight.waitForUtxo(depositAddress, minDuffs, { timeoutMs: waitSeconds * 1000, log });
  }
  const { txid, balance } = await assetLockAndTopUp(
    { identityId, assetLockKeyPair, resumeTxid: pending.assetLockTxid },
    utxo,
    network,
    log,
    (lockTxid) => savePending({ ...pending, assetLockTxid: lockTxid })
  );
  unlinkSync(pendingPath);
  return { network: network.name, identityId, topUpTxid: txid, balance };
}

// --- print identity credit balance ---
async function cmdBalance(args) {
  const { network, identityId } = loadIdentityArg(args, 'identity');
  return { network: network.name, identityId, balance: await platform.getBalance(network, identityId, log) };
}

// --- check every identity file in a directory against Platform ---
// Exists, has credits, and its on-chain keys are exactly the file's keys
// (same ids, purposes, security levels and public keys; ENCRYPTION included).
async function cmdVerify(args) {
  const dir = str(args.dir);
  if (!dir) throw new Error('--dir <dir> is required');
  const files = readdirSync(resolve(dir)).filter((f) => f.endsWith('.identity.json')).sort();
  if (files.length === 0) throw new Error(`No *.identity.json files in ${dir}`);

  const results = [];
  for (const f of files) {
    const path = join(resolve(dir), f);
    const record = readJson(path);
    const network = networkForRecord(args, record, path);
    const problems = [];
    const onChain = record.identityId ? await platform.describeIdentity(network, record.identityId, log) : null;
    if (!record.identityId) problems.push('no identityId (pending mint)');
    else if (!onChain) problems.push('identity not found on Platform');
    else {
      if (!(onChain.balance > 0)) problems.push('zero balance');
      for (const k of record.identityKeys) {
        const c = onChain.keys.find((x) => x.id === k.id);
        if (!c) problems.push(`key ${k.id} missing on chain`);
        else if (c.purpose !== k.purpose || c.securityLevel !== k.securityLevel || c.dataHex !== k.publicKeyHex || c.disabled) {
          problems.push(`key ${k.id} differs on chain`);
        }
      }
      if (!onChain.keys.some((k) => k.purpose === 'ENCRYPTION' && !k.disabled)) problems.push('no ENCRYPTION key');
    }
    results.push({
      file: path,
      network: network.name,
      identityId: record.identityId ?? null,
      balance: onChain?.balance ?? null,
      keys: onChain?.keys.map((k) => `${k.id}:${k.purpose}/${k.securityLevel}`) ?? [],
      ok: problems.length === 0,
      problems,
    });
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
  return { verified: results };
}

// --- transfer platform credits between identities (consolidation) ---
async function cmdTransfer(args) {
  const { record: sender, network } = loadIdentityArg(args, 'from');
  const { record: recipient, network: recipientNetwork } = loadIdentityArg(args, 'to');
  if (recipientNetwork.name !== network.name) throw new Error('--from and --to are on different networks');
  const amountCredits = Math.round(Number(args.amount || 0.2) * 1e11); // 1 DASH = 1e11 credits
  const balance = await platform.transferCredits({
    network,
    senderId: sender.identityId,
    senderIdentityKeys: sender.identityKeys,
    recipientId: recipient.identityId,
    amountCredits,
    log,
  });
  return { network: network.name, from: sender.identityId, to: recipient.identityId, amountCredits, senderBalance: balance };
}

const COMMANDS = { pool: cmdPool, topup: cmdTopup, balance: cmdBalance, verify: cmdVerify, transfer: cmdTransfer };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = COMMANDS[args._[0]] ?? cmdMint; // default: mint one

  try {
    const out = await command(args);
    await platform.disconnectSdk();
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    log(`ERROR: ${err.message}`);
    if (process.env.MINT_DEBUG) console.error(err);
    await platform.disconnectSdk().catch(() => {});
    process.exit(1);
  }
}

main();

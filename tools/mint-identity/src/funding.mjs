// `fund-from-key` funding: pay deposit addresses from UTXOs controlled by a WIF
// (e.g. a devnet's faucet wallet key) with one standard P2PKH transaction.
//
// The key is read at runtime from --funding-key-file or FORGE_DEVNET_FUNDING_WIF
// and never written or logged; only the address it controls is printed.
import { readFileSync } from 'node:fs';
import { wifToPrivateKey, bytesToHex } from './bytes.mjs';
import { getPublicKey, publicKeyToAddress } from './keys.mjs';
import { addressToScript, calculateTxId, createP2PKHTransaction, estimateP2PKHSize, signTransaction, serializeTransaction } from './tx.mjs';
import { sleep } from './insight.mjs';
import { ChainClient, isInsightUnavailable } from './chain.mjs';
import { defaultLedgerPath, withLedger } from './utxo-ledger.mjs';

export const FUNDING_WIF_ENV = 'FORGE_DEVNET_FUNDING_WIF';

// Coinbase outputs are spendable after 100 confirmations, and Insight's UTXO list
// does not say which outputs are coinbase, so only spend outputs past that depth.
const MIN_FUNDING_CONFIRMATIONS = 101;
const MAX_FUNDING_INPUTS = 50;
const BROADCAST_ATTEMPTS = 3;
const UTXO_FETCH_ATTEMPTS = 4;
const WIF_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{51,52}$/;

const outpointKey = (u) => `${u.txid}:${u.vout}`;

/**
 * Extract a WIF from the text of a key file: either a dash-network-configs
 * devnet YAML (its `faucet_privkey:` line) or a file holding just the WIF.
 */
export function parseFundingKeyText(text) {
  const yaml = text.match(/^faucet_privkey:\s*["']?([1-9A-HJ-NP-Za-km-z]+)["']?\s*$/m);
  if (yaml) return yaml[1];
  const trimmed = text.trim();
  if (WIF_PATTERN.test(trimmed)) return trimmed;
  throw new Error('Funding key file holds neither a `faucet_privkey:` line nor a bare WIF');
}

// Read the key file without ever echoing its path: a WIF pasted where the path
// belongs would otherwise land in the ENOENT message.
function readKeyFile(keyFile) {
  if (WIF_PATTERN.test(keyFile)) {
    throw new Error(`--funding-key-file takes a path, not the key itself; use ${FUNDING_WIF_ENV} to pass a WIF directly`);
  }
  try {
    return readFileSync(keyFile, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read the funding key file (${err.code ?? 'read error'})`);
  }
}

/**
 * Load the funding key from `keyFile` (a path; `/dev/fd/N` from bash process
 * substitution works) or the FORGE_DEVNET_FUNDING_WIF env var. Checks the WIF
 * belongs to `network`. Returns { privateKey, publicKey, address }.
 */
export function loadFundingKey(network, { keyFile, env = process.env } = {}) {
  let wif;
  if (keyFile) wif = parseFundingKeyText(readKeyFile(keyFile));
  else if (env[FUNDING_WIF_ENV]) wif = env[FUNDING_WIF_ENV].trim();
  else throw new Error(`fund-from-key needs --funding-key-file <path> or ${FUNDING_WIF_ENV}`);

  const { privateKey, compressed, prefix } = wifToPrivateKey(wif);
  if (prefix !== network.wifPrefix) {
    throw new Error(`Funding key WIF prefix ${prefix} does not match ${network.name} (${network.wifPrefix})`);
  }
  if (!compressed) throw new Error('Funding key must be a compressed-pubkey WIF');
  const publicKey = getPublicKey(privateKey);
  return { privateKey, publicKey, address: publicKeyToAddress(publicKey, network) };
}

/**
 * Pick inputs covering `targetDuffs` plus the fee for `outputCount` outputs
 * (+ change). Prefers one random UTXO that covers everything on its own (the
 * funding address may hold 100k+ small outputs; random spreads concurrent runs
 * across inputs), else accumulates the largest. Returns { inputs, fee }.
 */
export function selectFundingUtxos(utxos, targetDuffs, outputCount, { exclude = new Set(), minFee = 2000 } = {}) {
  const usable = utxos.filter((u) => u.confirmations >= MIN_FUNDING_CONFIRMATIONS && !exclude.has(outpointKey(u)));
  const feeFor = (n) => Math.max(minFee, estimateP2PKHSize(n, outputCount + 1));

  const single = usable.filter((u) => u.satoshis >= targetDuffs + feeFor(1));
  if (single.length > 0) return { inputs: [single[Math.floor(Math.random() * single.length)]], fee: feeFor(1) };

  const inputs = [];
  let total = 0;
  for (const u of [...usable].sort((a, b) => b.satoshis - a.satoshis)) {
    inputs.push(u);
    total += u.satoshis;
    if (total >= targetDuffs + feeFor(inputs.length)) return { inputs, fee: feeFor(inputs.length) };
    if (inputs.length >= MAX_FUNDING_INPUTS) break;
  }
  throw new Error(
    `Funding address cannot cover ${(targetDuffs / 1e8).toFixed(8)} DASH with ${MAX_FUNDING_INPUTS} mature inputs ` +
      `(${usable.length} usable UTXOs)`
  );
}

// A devnet faucet address holds 100k+ UTXOs (a ~45 MB Insight response), which
// Insight sometimes answers with a 503 under load; retry a few times. Returns
// null when Insight is unavailable, so the caller spends from the ledger.
async function fetchFundingUtxos(chain, address, log, attempts = UTXO_FETCH_ATTEMPTS) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chain.getUTXOs(address);
    } catch (err) {
      if (attempt >= attempts || (chain.dapi && isInsightUnavailable(err))) {
        if (chain.dapi && isInsightUnavailable(err)) {
          log(`fund-from-key: Insight cannot list UTXOs (${err.message}); spending from the local funding ledger`);
          return null;
        }
        throw err;
      }
      log(`fund-from-key: UTXO fetch failed (${err.message}); retrying in ${attempt * 10}s`);
      await sleep(attempt * 10000);
    }
  }
}

/** Seed an empty ledger from known funding txids (their outputs back to the funding address). */
async function bootstrapLedger(ledger, chain, txids, changeScript, log) {
  for (const txid of txids) {
    try {
      ledger.addOutputsOf(await chain.getRawTransactionBytes(txid), changeScript);
    } catch (err) {
      log(`fund-from-key: cannot seed the ledger from ${txid}: ${err.message}`);
    }
  }
  log(`fund-from-key: seeded the funding ledger with ${ledger.utxos.length} output(s) from ${txids.length} tx(s)`);
}

// Node rejections meaning an input is gone for good (someone else spent it).
const SPENT_INPUT = /missingorspent|missing inputs|txn-mempool-conflict|already spent|inputs-spent/i;

export const BOOTSTRAP_TXIDS_ENV = 'FORGE_FUNDING_BOOTSTRAP_TXIDS';

/**
 * Pay each { address, duffs } recipient from the funding key in one transaction,
 * change back to the funding address. Inputs come from Insight's UTXO list when
 * Insight is up, else from the local funding ledger (utxo-ledger.mjs); every
 * run holds the ledger lock, so parallel runs chain change outputs instead of
 * racing for them. A rejected broadcast retries with other inputs, unless the
 * node in fact accepted it (a lost response), which is checked first so we
 * never pay twice.
 * Returns { txid, paid: [{ address, txid, vout, satoshis, scriptPubKey }] }.
 */
export async function fundFromKey(fundingKey, recipients, network, log = () => {}, opts = {}) {
  const chain = opts.chain ?? new ChainClient(network, { log });
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath({ address: fundingKey.address });
  const bootstrapTxids =
    opts.bootstrapTxids ?? (process.env[BOOTSTRAP_TXIDS_ENV] ?? '').split(/[\s,]+/).filter((t) => /^[0-9a-f]{64}$/.test(t));
  const total = recipients.reduce((s, r) => s + r.duffs, 0);
  const outputs = recipients.map((r) => ({ script: addressToScript(r.address), value: BigInt(r.duffs) }));
  const changeScript = addressToScript(fundingKey.address);
  const changeHex = bytesToHex(changeScript);

  log(`fund-from-key: paying ${(total / 1e8).toFixed(8)} DASH to ${recipients.length} address(es) from ${fundingKey.address}`);
  return withLedger(
    ledgerPath,
    fundingKey.address,
    async (ledger) => {
      const listed = await fetchFundingUtxos(chain, fundingKey.address, log, opts.utxoFetchAttempts);
      if (listed === null && ledger.utxos.length === 0 && bootstrapTxids.length > 0) {
        await bootstrapLedger(ledger, chain, bootstrapTxids, changeHex, log);
      }
      const tried = new Set();
      let lastError;
      for (let attempt = 1; attempt <= BROADCAST_ATTEMPTS; attempt++) {
        // Ledger outputs are our own change (never coinbase): spendable at any depth.
        const utxos = listed ?? ledger.utxos.map((u) => ({ ...u, confirmations: Infinity }));
        if (listed === null && utxos.length === 0) {
          throw new Error(
            `Insight is unavailable and the funding ledger ${ledgerPath} is empty. Seed it with ` +
              `${BOOTSTRAP_TXIDS_ENV}=<txid of a recent funding tx from ${fundingKey.address}>`
          );
        }
        const { inputs, fee } = selectFundingUtxos(utxos, total, outputs.length, { exclude: tried, minFee: network.minFee * 2 });
        const tx = createP2PKHTransaction(inputs, outputs, changeScript, BigInt(fee));
        const signed = await signTransaction(tx, inputs, fundingKey.privateKey, fundingKey.publicKey);
        const bytes = serializeTransaction(signed);
        const txid = calculateTxId(signed);
        const settle = () => {
          ledger.markSpent(inputs);
          ledger.addOutputsOf(bytes, changeHex);
          const paid = recipients.map((r, vout) => ({ address: r.address, txid, vout, satoshis: r.duffs, scriptPubKey: bytesToHex(outputs[vout].script) }));
          for (const p of paid) ledger.recordPayment(p.address, { txid: p.txid, vout: p.vout, satoshis: p.satoshis, scriptPubKey: p.scriptPubKey });
          return { txid, paid };
        };
        try {
          await chain.broadcastTransaction(bytes);
          log(`fund-from-key: broadcast ${txid} (${inputs.length} input(s), fee ${fee} duffs)`);
          return settle();
        } catch (err) {
          if (await chain.isKnown(txid)) {
            log(`fund-from-key: ${txid} is known to the network despite the error (${err.message}); using it`);
            return settle();
          }
          lastError = err;
          for (const u of inputs) tried.add(outpointKey(u));
          if (SPENT_INPUT.test(err.message)) ledger.markSpent(inputs);
          log(`fund-from-key: broadcast attempt ${attempt} rejected (${err.message}); retrying with other inputs`);
        }
      }
      throw lastError;
    },
    { log }
  );
}

// `fund-from-key` funding: pay deposit addresses from UTXOs controlled by a WIF
// (e.g. a devnet's faucet wallet key) with one standard P2PKH transaction.
//
// The key is read at runtime from --funding-key-file or FORGE_DEVNET_FUNDING_WIF
// and never written or logged; only the address it controls is printed.
import { readFileSync } from 'node:fs';
import { wifToPrivateKey, bytesToHex } from './bytes.mjs';
import { getPublicKey, publicKeyToAddress } from './keys.mjs';
import { addressToScript, calculateTxId, createP2PKHTransaction, estimateP2PKHSize, signTransaction, serializeTransaction } from './tx.mjs';
import { InsightClient, sleep } from './insight.mjs';

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
// Insight sometimes answers with a 503 under load; retry a few times.
async function fetchFundingUtxos(insight, address, log) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await insight.getUTXOs(address);
    } catch (err) {
      if (attempt >= UTXO_FETCH_ATTEMPTS) throw err;
      log(`fund-from-key: UTXO fetch failed (${err.message}); retrying in ${attempt * 10}s`);
      await sleep(attempt * 10000);
    }
  }
}

/**
 * Pay each { address, duffs } recipient from the funding key in one transaction,
 * change back to the funding address. A rejected broadcast retries with other
 * UTXOs (another spender may have taken the chosen input), unless the node in
 * fact accepted it (a lost response), which is checked first so we never pay twice.
 * Returns the txid.
 */
export async function fundFromKey(fundingKey, recipients, network, log = () => {}) {
  const insight = new InsightClient(network);
  const total = recipients.reduce((s, r) => s + r.duffs, 0);
  const outputs = recipients.map((r) => ({ script: addressToScript(r.address), value: BigInt(r.duffs) }));
  const changeScript = addressToScript(fundingKey.address);

  log(`fund-from-key: paying ${(total / 1e8).toFixed(8)} DASH to ${recipients.length} address(es) from ${fundingKey.address}`);
  const utxos = await fetchFundingUtxos(insight, fundingKey.address, log);
  const tried = new Set();
  let lastError;
  for (let attempt = 1; attempt <= BROADCAST_ATTEMPTS; attempt++) {
    const { inputs, fee } = selectFundingUtxos(utxos, total, outputs.length, { exclude: tried, minFee: network.minFee * 2 });
    const tx = createP2PKHTransaction(inputs, outputs, changeScript, BigInt(fee));
    const signed = await signTransaction(tx, inputs, fundingKey.privateKey, fundingKey.publicKey);
    const txid = calculateTxId(signed);
    try {
      await insight.broadcastTransaction(bytesToHex(serializeTransaction(signed)));
      log(`fund-from-key: broadcast ${txid} (${inputs.length} input(s), fee ${fee} duffs)`);
      return txid;
    } catch (err) {
      if (await insight.getTransaction(txid).then(() => true, () => false)) {
        log(`fund-from-key: ${txid} is known to the network despite the error (${err.message}); using it`);
        return txid;
      }
      lastError = err;
      for (const u of inputs) tried.add(outpointKey(u));
      log(`fund-from-key: broadcast attempt ${attempt} rejected (${err.message}); retrying with other inputs`);
    }
  }
  throw lastError;
}

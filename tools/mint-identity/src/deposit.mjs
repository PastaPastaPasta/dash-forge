// Finding a deposit UTXO: Insight's address index when it is up, else the
// outpoint this tool itself paid (fund-from-key or the faucet reply), resolved
// through DAPI Core getTransaction. DAPI has no address index, so a deposit
// nobody told us about (--funding manual) still needs Insight.
import { addressToScript, parseTransactionOutputs } from './tx.mjs';
import { bytesToHex } from './bytes.mjs';
import { isInsightUnavailable } from './chain.mjs';
import { sleep } from './insight.mjs';

/**
 * The output of `known.txid` (at `known.vout`, or the largest paying `address`)
 * as a UTXO, via DAPI Core; null while no node knows the tx.
 */
export async function resolveKnownOutpoint(chain, address, known) {
  if (!chain.dapi || !known?.txid) return null;
  const tx = await chain.dapi.getTransaction(known.txid);
  if (!tx) return null;
  const script = bytesToHex(addressToScript(address));
  // The value comes from bytes that hash to the txid we asked for, never from the node's word.
  const parsed = parseTransactionOutputs(tx.transactionBytes);
  if (parsed.txid !== known.txid) throw new Error(`a DAPI node returned a transaction that is not ${known.txid}`);
  const outs = parsed.outputs.filter((o) => o.scriptPubKey === script && (known.vout === undefined || o.vout === known.vout));
  if (outs.length === 0) throw new Error(`${known.txid} pays nothing to ${address}`);
  const best = outs.reduce((a, b) => (b.satoshis > a.satoshis ? b : a));
  return { txid: known.txid, vout: best.vout, satoshis: best.satoshis, scriptPubKey: best.scriptPubKey, confirmations: tx.confirmations };
}

/**
 * `utxo` with its value and script read from its raw transaction (Insight's or DAPI's bytes,
 * which must hash to `utxo.txid`). The legacy sighash does not commit to input values, so a
 * source that under-reports a value would otherwise turn the difference into miner fees.
 */
export async function verifyUtxo(chain, utxo) {
  const parsed = parseTransactionOutputs(await chain.getRawTransactionBytes(utxo.txid));
  if (parsed.txid !== utxo.txid) throw new Error(`the transaction returned for ${utxo.txid} hashes to ${parsed.txid}`);
  const out = parsed.outputs[utxo.vout];
  if (!out) throw new Error(`${utxo.txid} has no output ${utxo.vout}`);
  if (out.scriptPubKey !== utxo.scriptPubKey) throw new Error(`${utxo.txid}:${utxo.vout} does not pay the expected script`);
  return { ...utxo, satoshis: out.satoshis };
}

/**
 * What `address` holds, in duffs: Insight's sum when Insight answers, else the
 * value of the `known` outpoint (0 when unknown). Never throws for an Insight outage.
 */
export async function depositBalance(chain, address, known) {
  try {
    return (await chain.getUTXOs(address)).reduce((s, u) => s + u.satoshis, 0);
  } catch (err) {
    if (!isInsightUnavailable(err)) throw err;
    return (await resolveKnownOutpoint(chain, address, known).catch(() => null))?.satoshis ?? 0;
  }
}

/**
 * Poll until `address` holds at least `minSatoshis`; returns one UTXO (the known
 * outpoint when given, else Insight's largest). Throws on timeout.
 */
export async function waitForDeposit(chain, address, minSatoshis, { known, timeoutMs = 180000, pollIntervalMs = 4000, log = () => {} } = {}) {
  const start = Date.now();
  let lastTotal = -1;
  let announced = false;
  while (Date.now() - start < timeoutMs) {
    try {
      let utxo = null;
      try {
        const utxos = await chain.getUTXOs(address);
        const total = utxos.reduce((s, u) => s + u.satoshis, 0);
        if (total !== lastTotal) {
          log(`  ${address}: ${(total / 1e8).toFixed(8)} tDASH detected`);
          lastTotal = total;
        }
        const pick = known ? utxos.find((u) => u.txid === known.txid && (known.vout === undefined || u.vout === known.vout)) : null;
        if (pick) utxo = pick;
        else if (!known && total >= minSatoshis && utxos.length > 0) utxo = utxos.reduce((m, u) => (u.satoshis > m.satoshis ? u : m), utxos[0]);
      } catch (err) {
        if (!isInsightUnavailable(err) || !known) throw err;
        if (!announced) log(`  Insight unavailable (${err.message}); watching ${known.txid} through DAPI Core`);
        announced = true;
        utxo = await resolveKnownOutpoint(chain, address, known);
      }
      if (utxo) utxo = await verifyUtxo(chain, { ...utxo, scriptPubKey: utxo.scriptPubKey ?? bytesToHex(addressToScript(address)) });
      if (utxo && utxo.satoshis >= minSatoshis) return utxo;
    } catch (err) {
      log(`  poll error (${address}): ${err.message}`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for >= ${minSatoshis} duffs at ${address}${known ? ` (from ${known.txid})` : ''}`);
}

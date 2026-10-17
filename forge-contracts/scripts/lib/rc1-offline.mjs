// rc1-offline.mjs — `rc1-live.mjs --offline`: the RC1 live case table run against an in-memory
// chain (offline-chain.mjs) instead of a network, for either contract set, so CI proves the table
// is self-consistent on the three-contract devnet set and on the four-contract mainnet set testnet
// registers (QA-03) without a network, funds or identities.
//
// The verdicts are split as `seed-offline.mjs` splits them:
//   * the rules that need chain state (references and `where`, unique indices, distinctFrom, the
//     total- and time-reading rules, canBeDeleted / deleteConstraints) are judged by the chain, in
//     JS, as the run goes: a case expecting one of those codes passes or fails here;
//   * everything else (the JSON schema, maxBytes, every other `propertyConstraints` rule, and
//     `immutable` on a replace) is rs-dpp's: each document the run writes is saved as an rc1 vector
//     (forge-contracts/vectors/rc1/README.md) -- accepted when the case expects it to land or to be
//     refused by chain state (a node judges the structure first), refused with its rule or schema
//     keyword otherwise -- and `contract-validate --vectors <out>` judges them.
// What neither can judge (an identity's keys: 40136) is reported as not judged offline.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { OfflineChain, vectorDoc } from './offline-chain.mjs';
import { b58encode } from './seed-io.mjs';

/** A synthetic identity (the offline chain checks no signature or key). */
function identity(name) {
  return { name, id: b58encode(createHash('sha256').update(`rc1 offline identity ${name}`).digest()), identityKey: {}, signer: {}, encKeyId: 2 };
}

/**
 * The offline session: the chain for `contractsDir` (the devnet set when omitted), its evo-sdk
 * stand-in with `create` and `replace` recording vectors, a scratch-like target and the four
 * identities. `expect(why, code, fn)` runs `fn` (one write) as a case rs-dpp must refuse for `why`:
 * the write is saved as a refuse vector and refused here with `code`, naming `why`.
 */
export function offlineSession({ contractsDir } = {}) {
  const chain = new OfflineChain({ contractsDir: contractsDir ? resolve(contractsDir) : undefined });
  const evo = chain.evo();
  const vectors = { create: [], replace: [] };
  let expecting = null;
  let current = { item: 'rc1', label: 'rc1' };
  const refused = (code, why) => Object.assign(new Error(`${code} ${why}: left to rs-dpp (contract-validate --vectors)`), { code });

  const realSdk = evo.EvoSDK;
  class EvoSDK extends realSdk {
    get documents() {
      const docs = super.documents;
      return {
        ...docs,
        create: async (args) => {
          const { type, owner } = args.document.meta;
          const vector = { item: current.item, name: current.label, type, owner, data: args.document.data };
          vectors.create.push(expecting ? { ...vector, expect: 'refused', why: expecting.why } : { ...vector, expect: 'ok' });
          if (expecting) throw refused(expecting.code, expecting.why);
          return docs.create(args);
        },
        replace: async (args) => {
          const id = args.document.id.toBase58();
          const stored = chain.docs.find((d) => d.id === id && !d.deleted);
          const vector = { item: current.item, name: current.label, type: args.document.meta.type, owner: args.document.meta.owner, data: args.document.data, stored: stored?.data ?? {} };
          vectors.replace.push(expecting ? { ...vector, expect: 'refused', why: expecting.why } : { ...vector, expect: 'ok' });
          if (expecting) throw refused(expecting.code, expecting.why);
          return docs.replace(args);
        },
      };
    }
  }

  const ids = chain.ids;
  const record = {
    network: 'devnet',
    devnetName: 'offline',
    v2: {
      forgeCore: { contractId: ids.core },
      forgeCollab: { contractId: ids.collab },
      forgeCommunity: { contractId: ids.community },
      ...(ids.meta ? { forgeMeta: { contractId: ids.meta } } : {}),
    },
  };
  const setName = contractsDir ?? 'the devnet set';
  return {
    chain,
    evo: { ...evo, EvoSDK },
    target: { network: 'devnet', label: `offline (${setName})`, scratch: true, recordFile: `<offline ${setName}>`, record, fourContract: Boolean(ids.meta) },
    identity,
    /** The case the next writes belong to (vector item and name). */
    at(item, label) {
      current = { item, label };
    },
    async expect(why, code, fn) {
      expecting = { why, code };
      try {
        return await fn();
      } finally {
        expecting = null;
      }
    },
    /** Write the vectors to `<out>/forge-<contract>.json` and `.replace.json`; resolves to the counts. */
    writeVectors(out) {
      const byContract = (list) => {
        const files = Object.fromEntries(Object.keys(chain.set.contracts).map((c) => [c, []]));
        for (const v of list) {
          files[chain.set.contractOf[v.type]].push({
            item: v.item,
            name: v.name,
            type: v.type,
            expect: v.expect,
            ...(v.why ? { why: v.why } : {}),
            owner: v.owner,
            ...(v.stored ? { stored: vectorDoc(v.type, v.stored, chain.set) } : {}),
            doc: vectorDoc(v.type, v.data, chain.set),
          });
        }
        return files;
      };
      mkdirSync(out, { recursive: true });
      const counts = {};
      for (const [kind, suffix] of [['create', ''], ['replace', '.replace']]) {
        for (const [c, list] of Object.entries(byContract(vectors[kind]))) {
          if (kind === 'replace' && list.length === 0) continue;
          writeFileSync(join(out, `forge-${c}${suffix}.json`), `${JSON.stringify(list, null, 1)}\n`);
          counts[`forge-${c}${suffix}`] = list.length;
        }
      }
      return counts;
    },
    vectors,
  };
}

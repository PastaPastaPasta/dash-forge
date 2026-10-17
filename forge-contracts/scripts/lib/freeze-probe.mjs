// The testnet freeze fee probes (docs/contracts/forge-v2.md §9.1): small throwaway contracts that
// differ only in the freeze item a fee gate decides, cut from `build.py --mainnet` itself so a
// probe measures exactly the index the registration would carry.
//
//   event pair+1:  EV-NONE   no byKind index
//                  EV-KIND   + byKind (repoId, kind)             (the candidate, as built)
//                  EV-KINDT  + byKind (repoId, kind, $createdAt)
//   config pair:   CFG-NONE  created (repoId, $createdAt), plain
//                  CFG-COUNT created rangeCountable              (the candidate, as built)
//
// Gate: the event index stays only when it adds at most +15 % to an event write; config.created
// is rangeCountable when a config write stays near its plain cost (the lead reads the number).
//
// Like the RC2 probes (rc2-probe.mjs), every reference and every rule that reads a total is
// dropped (they cost the same in each probe) and the probes of a pair hold the same type and the
// same defs, so a write's contract-load fee is the same on both. A bare event is cheaper than a
// real one (no ownerRefersTo, no targetId reference), so an added index is a larger share of it:
// the percentages are conservative.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bare, dropRefs } from './rc2-probe.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EVENT_PROBES = ['EV-NONE', 'EV-KIND', 'EV-KINDT'];
export const CONFIG_PROBES = ['CFG-NONE', 'CFG-COUNT'];
export const PROBES = [...EVENT_PROBES, ...CONFIG_PROBES];

/** forge-core and forge-community of `build.py --mainnet`, the layout the freeze items ride on. */
export function buildMainnet() {
  const out = mkdtempSync(join(tmpdir(), 'freeze-probe-'));
  try {
    execFileSync('python3', [join(ROOT, 'schema', 'build.py'), '--mainnet', '--out', out], { stdio: 'pipe' });
    const load = (name) => JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8'));
    return { core: load('forge-core'), community: load('forge-community') };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const KIND_INDEX = 'byKind';

/** The event type of one event probe: the built byKind index, widened by $createdAt, or removed. */
function eventSchema(probe, built) {
  const event = bare(built.community.documentSchemas.event);
  const at = event.indices.findIndex((i) => i.name === KIND_INDEX);
  if (at < 0) throw new Error(`the --mainnet build has no event.${KIND_INDEX} index (mainnet_event_by_kind)`);
  if (probe === 'EV-NONE') event.indices.splice(at, 1);
  if (probe === 'EV-KINDT') event.indices[at].properties.push({ $createdAt: 'asc' });
  return event;
}

/** The config type of one config probe: `created` as built (rangeCountable) or plain. */
function configSchema(probe, built) {
  const config = bare(built.core.documentSchemas.config);
  const created = config.indices.find((i) => i.name === 'created');
  if (!created?.rangeCountable) throw new Error('the --mainnet build has no rangeCountable config.created (mainnet_config_count)');
  if (probe === 'CFG-NONE') delete created.rangeCountable;
  return config;
}

/** One probe contract's schema (no id, owner or version). */
export function probeSchema(probe, built) {
  const isEvent = EVENT_PROBES.includes(probe);
  const type = isEvent ? 'event' : 'config';
  const schemaDefs = Object.fromEntries(Object.entries((isEvent ? built.community : built.core).schemaDefs).map(([k, v]) => [k, dropRefs(v)]));
  return { description: `freeze fee probe ${probe}`, schemaDefs, documentSchemas: { [type]: isEvent ? eventSchema(probe, built) : configSchema(probe, built) } };
}

/** Every probe's schema, built from build.py --mainnet. */
export function probeSchemas(built = buildMainnet()) {
  return Object.fromEntries(PROBES.map((p) => [p, probeSchema(p, clone(built))]));
}

/**
 * The documents the probes write, in the contract-validate vector notation (`{"$id": n}` an
 * identifier, `{"$b": [fill, len]}` a byte array), so `--emit` can have rs-dpp judge exactly what
 * the live run writes. A label is kind 4 (carries a value), a pin kind 19 (carries none).
 */
export const FREEZE_DOCS = {
  label: { type: 'event', doc: { repoId: { $id: 1 }, targetId: { $id: 3 }, targetNumber: 1, kind: 4, value: 'bug', r: 1 } },
  pin: { type: 'event', doc: { repoId: { $id: 1 }, targetId: { $id: 3 }, targetNumber: 1, kind: 19, r: 1 } },
  config: { type: 'config', doc: { repoId: { $id: 1 }, defaultBranch: 'main', vis: 'public' } },
};
/** Which FREEZE_DOCS each probe contract takes. */
export const DOCS_OF = { 'EV-NONE': ['label', 'pin'], 'EV-KIND': ['label', 'pin'], 'EV-KINDT': ['label', 'pin'], 'CFG-NONE': ['config'], 'CFG-COUNT': ['config'] };

/** A vector document as live properties: `fixed` values win, every other id or byte array is fresh. */
export function materialize(doc, fixed, random) {
  return Object.fromEntries(Object.entries(doc).map(([k, v]) => {
    if (k in fixed) return [k, fixed[k]];
    if (v && typeof v === 'object' && '$id' in v) return [k, random(32)];
    if (v && typeof v === 'object' && '$b' in v) return [k, random(v.$b[1])];
    return [k, v];
  }));
}

/** contract-validate input for one probe: the contract (placeholder id and owner) and its vectors. */
export function emitted(probe, schema) {
  const contract = { $formatVersion: '1', id: '1'.repeat(32), ownerId: '1'.repeat(32), version: 1, ...schema };
  const vectors = DOCS_OF[probe].map((name) => ({ item: 'freeze-probe', name: `${probe} ${name} ok`, type: FREEZE_DOCS[name].type, expect: 'ok', doc: FREEZE_DOCS[name].doc }));
  return { contract, vectors };
}

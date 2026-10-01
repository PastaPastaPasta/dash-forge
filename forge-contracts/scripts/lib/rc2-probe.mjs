// The RC2 fee-probe contracts (design/v5/PLAN.md §4.2 step 2, §7): small throwaway contracts
// that differ only in the RC2 item a gate decides, cut from the build.py variants themselves so a
// probe measures exactly the indexes the registration would carry.
//
//   ALL   patch stub + review (S2 toAuthor + S3 author)  + star (C1 fused: byWeek, outlivesDelete)
//   S2    patch stub + review (S2 only)
//   S3    patch stub + review (S3 only)
//   NONE  patch stub + review (neither)                  + star and starBeat (C1 off)
//
// Gates (owner decisions 2026-10-01): S2 and S3 each ship when a review on S2 (S3) costs at most
// 10 % more than on NONE; C1 ships when a fused star costs no more than star + starBeat (the
// 54.9 M credits measured on bonsia, WIPE-DECISIONS D-17).
//
// Every reference and every rule that reads a total is dropped (they cost the same in each
// probe), except review.patchId's reference: S2's `patchId.$ownerId` reads through it, and v5
// accepts that only for a `permanentDocument` reference by id into the same contract (v5
// book/src/contract-keywords/derived-index-properties.md:84), hence the patch stub. Both gates
// are conservative on these bare probes: a review without its references and lockGate is cheaper
// than a real one, so an added index is a larger share of it; and star + starBeat lose two
// reference lookups where the fused star loses one.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROBES = ['ALL', 'S2', 'S3', 'NONE'];
/** build.py `--off` per probe: what each probe's review and star types are cut from. */
const OFF = { ALL: '', S2: 'review_author', S3: 'review_to_author', NONE: 'review_to_author,review_author,fused_star' };

/** forge-collab and forge-community of one build.py variant (`off`: comma-separated flags, or ''). */
export function buildVariant(off) {
  const out = mkdtempSync(join(tmpdir(), 'rc2-probe-'));
  try {
    execFileSync('python3', [join(ROOT, 'schema', 'build.py'), ...(off ? ['--off', off] : []), '--out', out], { stdio: 'pipe' });
    const load = (name) => JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8'));
    return { collab: load('forge-collab'), community: load('forge-community') };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const clone = (x) => JSON.parse(JSON.stringify(x));
/** Drop every `refersTo` nested anywhere in a value (a def or a property). */
function dropRefs(value) {
  if (Array.isArray(value)) return value.map(dropRefs);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'refersTo').map(([k, v]) => [k, dropRefs(v)]));
}
/** A type with its references (all but `keep`) and the rules that read a total removed. */
function bare(schema, keep = null) {
  const s = clone(schema);
  delete s.ownerRefersTo;
  for (const [name, p] of Object.entries(s.properties)) if (name !== keep) s.properties[name] = dropRefs(p);
  for (const [k, v] of Object.entries(s.propertyConstraints ?? {})) if (/countOf|sumOf/.test(JSON.stringify(v))) delete s.propertyConstraints[k];
  return s;
}

/** The patch a probe review names: just what review.patchId's `where` reads, never deleted. */
function patchStub() {
  return {
    type: 'object',
    documentsMutable: false,
    canBeDeleted: false,
    properties: { repoId: { $ref: '#/$defs/id', position: 0 }, vis: { $ref: '#/$defs/vis', position: 1 } },
    required: ['repoId', 'vis'],
    additionalProperties: false,
  };
}

/** One probe contract's schema (no id, owner or version) from its build.py variant. */
export function probeSchema(probe, variant) {
  const defs = Object.fromEntries(Object.entries(variant.collab.schemaDefs).map(([k, v]) => [k, dropRefs(v)]));
  const review = bare(variant.collab.documentSchemas.review, 'patchId');
  const documentSchemas = { patch: patchStub(), review };
  if (probe === 'ALL' || probe === 'NONE') {
    documentSchemas.star = bare(variant.community.documentSchemas.star);
    if (variant.community.documentSchemas.starBeat) documentSchemas.starBeat = bare(variant.community.documentSchemas.starBeat);
  }
  return { description: `RC2 fee probe ${probe}`, schemaDefs: defs, documentSchemas };
}

/** Every probe's schema, built from the committed base schemas and build.py. */
export function probeSchemas(build = buildVariant) {
  return Object.fromEntries(PROBES.map((p) => [p, probeSchema(p, build(OFF[p]))]));
}

/** The index names of a type, to check a probe differs in the gated item alone. */
export const indexNames = (schema, type) => (schema.documentSchemas[type]?.indices ?? []).map((i) => i.name);

/**
 * The documents each probe writes, in the contract-validate vector notation (`{"$id": n}` an
 * identifier, `{"$b": [fill, len]}` a byte array), so `--emit` can have rs-dpp judge exactly
 * what the live run writes. A review is verdict 3 (a comment: no asMember either way).
 */
export const RC2_DOCS = {
  patch: { repoId: { $id: 1 }, vis: 'public' },
  review: { repoId: { $id: 1 }, patchId: { $id: 3 }, verdict: 3, commitOid: { $b: [1, 20] }, body: 'fee probe: a short review, the same bytes on every probe contract', vis: 'public' },
  star: { repoId: { $id: 1 } },
  starBeat: { repoId: { $id: 1 }, vis: 'public', repoOwner: { $id: 2 } },
};

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
  const vectors = Object.keys(schema.documentSchemas).map((type) => ({ item: 'rc2-probe', name: `${probe} ${type} ok`, type, expect: 'ok', doc: RC2_DOCS[type] }));
  return { contract, vectors };
}

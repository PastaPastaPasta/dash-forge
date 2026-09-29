#!/usr/bin/env python3
"""Offline mirror of the registration-only reference checks a node runs on a contract create
(drive-abci `data_contract_reference_validation/v0`, platform v4.2.0-beta.7), which a plain
contract parse (b7gate, DataContract::from_json) does not run:

  40121  the referenced document type exists (in this contract or an earlier one of the group)
  40122  a `permanentDocument` reference names a type whose documents can disappear
  40131  a `deletableDocument` reference names a type whose documents cannot
  40137  a `findBy` into another contract resolves to a unique index over exactly its keys,
         each filled from a source of the same value kind
  40126  every `where` pair: both sides exist, are plain single values (no object, no typed
         array), share one value kind (integers by their sized type), the referring side is not
         the reference property itself, and a referenced `$ownerId`/`$creatorId`/`$id` faces an
         identifier

  python3 forge-contracts/schema/wherecheck.py [contracts-dir]      (default: forge-contracts/contracts)
  python3 forge-contracts/schema/wherecheck.py --self-test

tools/contract-validate runs the same port in Rust against rs-dpp's parsed model; this one reads
the JSON directly, so it also runs where no Rust toolchain is at hand, and CI runs both.
"""
import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NAMES = ('forge-core', 'forge-collab', 'forge-community')
PLACEHOLDERS = {'FORGE_CORE_CONTRACT_ID': 'forge-core', 'FORGE_COLLAB_CONTRACT_ID': 'forge-collab'}
IDENTIFIER = 'application/x.dash.dpp.identifier'


def resolve(contract, schema):
    """A property schema with its `$ref` (into the contract's `$defs`) folded in."""
    while '$ref' in schema:
        name = schema['$ref'].split('/')[-1]
        schema = {**contract['schemaDefs'][name], **{k: v for k, v in schema.items() if k != '$ref'}}
    return schema


def int_kind(s):
    """rs-dpp's sized integer type (`find_integer_type_for_subschema_value`, sized_integer_types on)."""
    lo, hi = s.get('minimum'), s.get('maximum')

    def unsigned(mx):
        for name, lim in (('u8', 255), ('u16', 65535), ('u32', 4294967295)):
            if mx <= lim:
                return name
        return 'u64'

    def by_range(mn, mx):
        if mn >= 0:
            return unsigned(mx)
        for name, a, b in (('i8', -128, 127), ('i16', -32768, 32767), ('i32', -2**31, 2**31 - 1)):
            if mn >= a and mx <= b:
                return name
        return 'i64'

    if lo is not None and hi is not None:
        return by_range(lo, hi)
    if lo is not None:
        return 'u64' if lo >= 0 else 'i64'
    if hi is not None:
        return unsigned(hi)
    ints = [v for v in s.get('enum', []) if isinstance(v, int)]
    if len(ints) > 1:
        return by_range(min(ints), max(ints))
    if len(ints) == 1:
        return unsigned(ints[0])
    return 'i64'


def kind(contract, schema):
    s = resolve(contract, schema)
    t = s.get('type')
    if t == 'array' and s.get('byteArray'):
        return 'identifier' if s.get('contentMediaType') == IDENTIFIER else 'bytes'
    if t == 'array':
        return 'typedArray'
    if t == 'integer':
        return int_kind(s)
    return t  # string, boolean, number, object


def flattened(contract, doc_type):
    """`path -> schema` for every property, nested object members as `a.b` (flattened_properties)."""
    out = {}

    def walk(props, pre):
        for name, schema in props.items():
            s = resolve(contract, schema)
            out[pre + name] = s
            if s.get('type') == 'object':
                walk(s.get('properties', {}), pre + name + '.')

    walk(contract['documentSchemas'][doc_type]['properties'], '')
    return out


def can_disappear(contract, doc_type):
    d = contract['documentSchemas'][doc_type]
    default = contract.get('config', {}).get('canBeDeleted', True)
    return bool(d.get('canBeDeleted', default)) or 'moderatorAbilities' in d or 'ttl' in d


def leaves(decl):
    for key in ('anyOf', 'allOf'):
        if key in decl:
            for op in decl[key]:
                yield from leaves(op)
            return
    yield decl


def declarations(contract, doc_type):
    """(path, reference property or None for the owner's, declaration) of a type."""
    d = contract['documentSchemas'][doc_type]
    if 'ownerRefersTo' in d:
        yield '$ownerId', None, d['ownerRefersTo']
    for path, s in flattened(contract, doc_type).items():
        if 'refersTo' in s:
            yield path, path, s['refersTo']
        items = s.get('items')
        if isinstance(items, dict) and 'refersTo' in resolve(contract, items):
            yield path + '[]', path, resolve(contract, items)['refersTo']


def check(contracts):
    """Problems as `code path: reason` lines; `contracts` maps name -> parsed JSON, in registration order."""
    problems = []
    for name, c in contracts.items():
        for t in c['documentSchemas']:
            props = flattened(c, t)
            for path, ref_prop, decl in declarations(c, t):
                for leaf in leaves(decl):
                    if leaf.get('type') not in ('permanentDocument', 'deletableDocument'):
                        continue
                    at = f'{name}.{t}.{path}'
                    target_name = PLACEHOLDERS.get(leaf.get('contractId'), name) if 'contractId' in leaf else name
                    tc = contracts.get(target_name)
                    rt = leaf['documentType']
                    if tc is None or rt not in tc['documentSchemas']:
                        problems.append(f'40121 {at}: no document type {target_name}.{rt}')
                        continue
                    gone = can_disappear(tc, rt)
                    if leaf['type'] == 'permanentDocument' and gone:
                        problems.append(f'40122 {at}: permanentDocument names {rt}, whose documents can be deleted')
                    if leaf['type'] == 'deletableDocument' and not gone:
                        problems.append(f'40131 {at}: deletableDocument names {rt}, whose documents cannot be deleted')
                    target_props = flattened(tc, rt)

                    def source_kind(src):
                        if src == '.':  # the reference's own value: the writer, or the (element) value
                            if ref_prop is None:
                                return 'identifier'
                            s = props[ref_prop]
                            return kind(c, s['items']) if path.endswith('[]') else kind(c, s)
                        if src.startswith('$'):
                            return 'identifier'
                        return kind(c, props[src]) if src in props else None

                    if 'findBy' in leaf and target_name != name:
                        keys = leaf['findBy']
                        want = set(keys)
                        uniq = [i for i in tc['documentSchemas'][rt].get('indices', [])
                                if i.get('unique') and {next(iter(p)) for p in i['properties']} == want]
                        if not uniq:
                            problems.append(f'40137 {at}: no unique index of {target_name}.{rt} over exactly {sorted(want)}')
                        for k, src in keys.items():
                            dk = 'identifier' if k.startswith('$') else (kind(tc, target_props[k]) if k in target_props else None)
                            sk = source_kind(src)
                            if dk is None or sk is None or dk != sk:
                                problems.append(f'40137 {at}: findBy {k} ({dk}) from {src} ({sk})')
                    for referenced, referring in leaf.get('where', {}).items():
                        bad = lambda why: problems.append(f'40126 {at}: where {referenced} = {referring}: {why}')
                        if ref_prop is not None and referring == ref_prop:
                            bad('the referring property is the reference property itself')
                            continue
                        if referring.startswith('$'):
                            if referring != '$ownerId':
                                bad('the referring side must be a schema property or $ownerId')
                                continue
                            gk = 'identifier'
                        elif referring not in props:
                            bad('the declaring type does not define the referring property')
                            continue
                        else:
                            gk = kind(c, props[referring])
                        if referenced.startswith('$'):
                            if referenced not in ('$ownerId', '$creatorId', '$id'):
                                bad('only $ownerId, $creatorId and $id may be agreed with')
                            elif gk != 'identifier':
                                bad(f'{referenced} is an identifier, the referring side is {gk}')
                            continue
                        if referenced not in target_props:
                            bad(f'{rt} does not define the referenced property')
                            continue
                        dk = kind(tc, target_props[referenced])
                        if 'object' in (gk, dk):
                            bad('agreement properties must be plain values, not objects')
                        elif 'typedArray' in (gk, dk):
                            bad('agreement properties must be single values, not typed arrays')
                        elif gk != dk:
                            bad(f'value kinds differ: {referenced} is {dk}, {referring} is {gk}')
    return problems


def load(d):
    return {n: json.load(open(os.path.join(d, f'{n}.json'))) for n in NAMES}


def self_test(d):
    """Each mutation must produce the code it names: proof the mirror sees what a node refuses."""
    base = load(d)
    assert check(base) == [], check(base)

    def mutated(fn):
        cs = copy.deepcopy(base)
        fn(cs)
        return check(cs)

    def comm_checkrun_where(cs, k, v):
        cs['forge-community']['documentSchemas']['checkRun']['properties']['repoId']['refersTo']['where'] = {k: v}

    cases = [
        ('40126', 'missing referenced property', lambda cs: comm_checkrun_where(cs, 'nope', 'vis')),
        ('40126', 'missing referring property', lambda cs: comm_checkrun_where(cs, 'visibility', 'nope')),
        ('40126', 'kind mismatch (string vs bytes)', lambda cs: comm_checkrun_where(cs, 'visibility', 'headOid')),
        ('40126', 'referring side is the reference itself', lambda cs: comm_checkrun_where(cs, 'name', 'repoId')),
        ('40126', 'integer sizes differ (u32 vs u8)', lambda cs: cs['forge-collab']['documentSchemas']['transition']['ownerRefersTo']['anyOf'][2]['where'].update({"number": "targetKind"})),
        ('40131', 'deletable names a permanent type', lambda cs: cs['forge-collab']['documentSchemas']['transition']['ownerRefersTo']['anyOf'][2].update({"type": "deletableDocument"})),
        ('40122', 'permanent names a deletable type', lambda cs: cs['forge-community']['documentSchemas']['checkRun']['properties']['repoId']['refersTo'].update({"documentType": "maintainer"})),
        ('40121', 'unknown type', lambda cs: cs['forge-community']['documentSchemas']['checkRun']['properties']['repoId']['refersTo'].update({"documentType": "nope"})),
        ('40137', 'findBy with no unique index', lambda cs: cs['forge-community']['documentSchemas']['webhook']['ownerRefersTo']['findBy'].update({"repoId": "repoId", "memberId": ".", "vis": "vis"})),
    ]
    bad = 0
    for code, what, fn in cases:
        got = mutated(fn)
        ok = any(p.startswith(code) for p in got)
        bad += not ok
        print(f"{'PASS' if ok else 'MISS'} {code} {what}: {got[:1]}")
    return bad


def main():
    args = sys.argv[1:]
    d = next((a for a in args if not a.startswith('--')), os.path.join(os.path.dirname(HERE), 'contracts'))
    if '--self-test' in args:
        sys.exit(1 if self_test(d) else 0)
    problems = check(load(d))
    for p in problems:
        print(p)
    print(f'{d}: {len(problems)} registration reference problem(s)')
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()

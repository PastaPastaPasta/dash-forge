"""Independent seal-off marker reference (§18.5). No contract generation changes.

python3 tools/private-repos-vectors/seal_off_marker.py --write-vectors
python3 tools/private-repos-vectors/seal_off_marker.py --check
"""
import argparse
import json
import pathlib
import struct

import gen as G

OUT = pathlib.Path(__file__).resolve().parents[2] / 'forge-contracts/vectors'
OWNER = '22' * 32
OTHER = '33' * 32
VECTORS = []


def marker(epoch=1, mode='codeOnly', replaces=None, clock='1720000000123'):
    result = dict(mode=mode, conversionId='0123456789abcdeffedcba9876543210', boundaryEpoch=epoch, startedAtMs=clock)
    if replaces is not None:
        result['replacesEpoch'] = replaces
    return result


def encode(m):
    value = bytes([1, {'codeOnly': 1, 'everything': 2}[m['mode']]]) + bytes.fromhex(m['conversionId'])
    value += struct.pack('>IQ', m['boundaryEpoch'], int(m['startedAtMs']))
    if 'replacesEpoch' in m:
        value += struct.pack('>I', m['replacesEpoch'])
    return value


def parse(value, epoch):
    if len(value) not in (30, 34) or value[0] != 1 or value[1] not in (1, 2) or epoch < 1:
        return None
    if struct.unpack('>I', value[18:22])[0] != epoch:
        return None
    return dict(mode='codeOnly' if value[1] == 1 else 'everything', conversionId=value[2:18].hex(),
                boundaryEpoch=epoch, startedAtMs=str(struct.unpack('>Q', value[22:30])[0]),
                **(dict(replacesEpoch=struct.unpack('>I', value[30:34])[0]) if len(value) == 34 else {}))


def config(epoch, marked=False, **kw):
    result = dict(id=f'{epoch + 1:02x}' * 32, owner=OWNER, epoch=epoch, private=True, height=epoch * 10,
                  opening='opened')
    if marked:
        result['sealOff'] = encode(marker(epoch)).hex()
    result.update(kw)
    return result


def active(configs, owner):
    counted = [c for c in configs if c['owner'] == owner and c['private'] and c['epoch'] is not None and c['epoch'] >= 1]
    if any(c['opening'] == 'unreadable' for c in counted):
        return dict(kind='unknown')
    candidates = [(c, parse(bytes.fromhex(c['sealOff']), c['epoch'])) for c in counted
                  if c['opening'] == 'opened' and 'sealOff' in c]
    replaced = max((m['replacesEpoch'] for c, m in candidates if m is not None and 'replacesEpoch' in m and m['replacesEpoch'] < c['epoch']), default=None)
    remain = sorted([(c, m) for c, m in candidates if replaced is None or c['epoch'] > replaced], key=lambda cm: (cm[0]['epoch'], cm[0]['height'], bytes.fromhex(cm[0]['id'])))
    if not remain:
        return dict(kind='none')
    c, m = remain[0]
    return dict(kind='active', epoch=c['epoch'], height=c['height'], marker=m, highestEpoch=max(c['epoch'] for c, _ in remain), replacesThrough=replaced)


def decision(recorded, found, current, flipped, stated):
    if found['kind'] == 'unknown':
        return dict(kind='unknown')
    marked = found.get('epoch')
    through = found.get('replacesThrough')
    if recorded is not None and through is not None and recorded <= through:
        recorded = None
    boundary = min((e for e in (recorded, marked) if e is not None), default=None)
    if flipped:
        return dict(kind='public', cutoff=min((e for e in (boundary, stated) if e is not None), default=None))
    if boundary is None:
        return dict(kind='new')
    return dict(kind='adopt' if current == boundary else 'passed' if current is not None and current > boundary else 'lagging', epoch=boundary)


def vector(name, op, inp, expected):
    VECTORS.append(dict(name=name, description=name.replace('_', ' '), case='seal_off_marker', rules='v2', input=dict(op=op, **inp), expected=expected))


def build():
    for name, m in [('fresh', marker()), ('start_over', marker(3, 'everything', 1)), ('u64_timestamp', marker(clock=str(2**64-1)))]:
        value = encode(m)
        pt = G.tlv((6, b'main'), (8, G.u32(m['boundaryEpoch']-1)), (9, G.K0), (65, value))
        doc = dict(type='config', ownerId=OWNER, epoch=m['boundaryEpoch'])
        _, enc = G.seal_doc(doc, G.K1, pt)
        vector(name, 'encoding', dict(marker=m), dict(value=value.hex(), tlv=pt.hex(), enc=enc.hex()))
    vector('tag_skipped_in_issue', 'issue', {}, dict(title='Title'))
    cases = {
        'none': [config(1)],
        'one': [config(1, True)],
        'stale_unmarked_rotation_is_sticky': [config(1, True), config(2)],
        'settings_and_reanchor_are_sticky': [config(1, True), config(1, id='ff'*32), config(2)],
        'earliest_without_replace': [config(2, True), config(1, True)],
        'two_markers_replace_same_epoch': [config(1, True), config(3, sealOff=encode(marker(3, replaces=1)).hex()), config(4, sealOff=encode(marker(4, replaces=1)).hex())],
        'replace_chain': [config(1, True), config(2, sealOff=encode(marker(2, replaces=1)).hex()), config(3, sealOff=encode(marker(3, replaces=2)).hex())],
        'owner_start_over_new_boundary': [config(1, True), config(2), config(3, sealOff=encode(marker(3, replaces=1)).hex())],
        'non_owner_marker_ignored': [config(1, True, owner=OTHER)],
        'non_owner_replace_ignored': [config(1, True), config(2, owner=OTHER, sealOff=encode(marker(2, replaces=1)).hex())],
        'public_config_ignored': [config(1, True, private=False)],
        'race_loser_ignored': [config(1, True, opening='otherKey')],
        'winning_follow_up_counted': [config(1, True, opening='otherKey'), config(1, True, id='ff'*32, height=15)],
        'epoch_zero_ignored': [config(0, sealOff=encode(marker(1)).hex())],
        'unopenable_owner_fails_closed': [config(1, True), config(2, opening='unreadable')],
        'unopenable_non_owner_ignored': [config(1, True), config(2, owner=OTHER, opening='unreadable')],
        'unopenable_public_ignored': [config(1, True), config(2, private=False, opening='unreadable')],
        'tie_by_height': [config(1, sealOff=encode(marker(1, 'everything')).hex(), height=11), config(1, True)],
        'tie_by_raw_id': [config(1, sealOff=encode(marker(1, 'everything')).hex(), id='ff'*32), config(1, True, id='00'*32)],
        'replace_must_be_higher': [config(1, sealOff=encode(marker(1, replaces=2)).hex()), config(2, True)],
        'replace_clears_all_prior_boundaries': [config(1, True), config(2, True), config(3, sealOff=encode(marker(3, replaces=2)).hex())],
        'replace_keeps_higher_boundary': [config(1, True), config(2, True), config(3, sealOff=encode(marker(3, replaces=1)).hex())],
    }
    base = encode(marker())
    for name, value in [('length', b''), ('version', bytes([2])+base[1:]), ('mode', base[:1]+b'\x03'+base[2:]), ('epoch', encode(marker(2)))]:
        cases['unknown_'+name+'_keeps_boundary'] = [config(1, sealOff=value.hex()), config(2)]
    for name, configs in cases.items():
        vector(name, 'rule', dict(configs=configs, owner=OWNER), active(configs, OWNER))
    for name, recorded, mark, now, flipped, stated in [
        ('new', None, None, 2, False, None), ('another_device_adopts', None, 2, 2, False, None),
        ('another_device_lagging', None, 2, 1, False, None), ('another_device_passed', None, 2, 3, False, None),
        ('missing_key_epoch_lagging', None, 2, None, False, None), ('record_lower', 1, 2, 2, False, None),
        ('marker_lower', 3, 2, 3, False, None), ('fresh_public_cutoff', None, 2, 4, True, 4),
        ('public_record_lower', 1, 2, 4, True, 4), ('public_stated_lower', 4, 3, 4, True, 2),
    ]:
        active_marker = dict(kind='none') if mark is None else active([config(mark, True)], OWNER)
        expected = decision(recorded, active_marker, now, flipped, stated)
        vector(name, 'decision', dict(recorded=recorded, active=active_marker, current=now, flipped=flipped, stated=stated), expected)
    for name, recorded in [('stale_record_across_devices', 1), ('concurrent_owner_runs', None)]:
        found = active(cases['replace_clears_all_prior_boundaries'], OWNER)
        vector(name, 'decision', dict(recorded=recorded, active=found, current=3, flipped=False, stated=None), decision(recorded, found, 3, False, None))
    for name, recorded, configs, current in [
        ('record_above_active_after_same_replace', 4, cases['two_markers_replace_same_epoch'], 4),
        ('record_between_replaced_and_active', 2, [config(1, True), config(3, sealOff=encode(marker(3, replaces=1)).hex())], 3),
    ]:
        found = active(configs, OWNER)
        vector(name, 'decision', dict(recorded=recorded, active=found, current=current, flipped=False, stated=None), decision(recorded, found, current, False, None))
    vector('unknown_refuses', 'decision', dict(recorded=None, active=dict(kind='unknown'), current=2, flipped=False, stated=None), dict(kind='unknown'))
    for name, patterns, fits in [
        ('ascii_settings_fit', ['a'*100]*8, True),
        ('utf8_settings_refused', ['\U00010000'*100]*8, False),
        ('exact_1475_bytes_fit', ['a'*100]*7 + ['\U00010000'*93+'a'*7], True),
        ('exact_1476_bytes_refused', ['a'*100]*7 + ['\U00010000'*93+'é'+'a'*6], False),
    ]:
        m = marker(3, replaces=1)
        settings = dict(defaultBranch='b'*255, protectedPatterns=patterns)
        pt = G.tlv((6, settings['defaultBranch'].encode()), *[(7, p.encode()) for p in settings['protectedPatterns']],
                   (8, G.u32(2)), (9, G.K0), (12, G.K0), (65, encode(m)))
        vector(name, 'size', dict(settings=settings, marker=m), dict(tlvBytes=len(pt), fits=fits))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write-vectors', action='store_true')
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args()
    build()
    expected = {f"seal_off_marker__{v['name']}.json": json.dumps(v, indent=2, ensure_ascii=False)+'\n' for v in VECTORS}
    if args.write_vectors:
        for path in OUT.glob('seal_off_marker__*.json'):
            if path.name not in expected:
                path.unlink()
        for name, text in expected.items():
            (OUT/name).write_text(text)
    if args.check:
        actual = {p.name: p.read_text() for p in OUT.glob('seal_off_marker__*.json')}
        if actual != expected:
            raise SystemExit('seal-off marker vectors are stale')
    print(f'seal-off marker vectors: {len(expected)}'+(' checked' if args.check else ''))


if __name__ == '__main__':
    main()

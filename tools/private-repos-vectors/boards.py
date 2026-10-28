"""Independent reference for sealed boards and cards (docs/security/private-repos.md §4.6,
docs/design/boards.md §3.3). No contract generation changes.

python3 tools/private-repos-vectors/boards.py --write-vectors
python3 tools/private-repos-vectors/boards.py --check

Writes forge-contracts/vectors/sealed_board__*.json: `seal` (the TLV, its padding, the AD and the
enc under a fixed nonce, or the writer's refusal) and `open` (what a reader makes of a stored
document). forge-web `lib/private/board.conformance.test.ts` runs them byte for byte; forge-core
has no reader yet and its rules harness skips the case.
"""
import argparse
import json
import pathlib
import re
import struct

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import gen as G

OUT = pathlib.Path(__file__).resolve().parents[2] / 'forge-contracts/vectors'
CASE = 'sealed_board'
VECTORS = []

TAG = dict(name=32, spec=33, col=34, rank=35, fields=36, padding=64)
MAX_PT = dict(board=5120 - 29, card=2560 - 29)
OTHER_OWNER = bytes([0x23]) * 32
ITEM = bytes([0x44]) * 32
OTHER_ITEM = bytes([0x45]) * 32
SPEC = '{"v":1,"columns":[{"id":1,"name":"Todo"},{"id":2,"name":"In progress"},{"id":3,"name":"Done"}],"def":1,"done":3}'
RANK = re.compile(r'^[0-9A-Za-z]{0,62}[1-9A-Za-z]$')
NAME = re.compile(r'^[^\x00-\x1f\x7f]*[^\s\x00-\x1f\x7f][^\x00-\x1f\x7f]*$')


def vector(name, description, op, inp, expected):
    VECTORS.append(dict(name=name, description=description, case=CASE, rules='v2', input=dict(op=op, **inp), expected=expected))


def records(kind, f):
    """The records of `f`, ascending, without padding (§4.6)."""
    if kind == 'board':
        return G.tlv((TAG['name'], f['name'].encode()), (TAG['spec'], f['spec'].encode()))
    out = []
    if 'col' in f:
        out.append((TAG['col'], bytes([f['col']])))
    if 'rank' in f:
        out.append((TAG['rank'], f['rank'].encode()))
    if 'f' in f:
        out.append((TAG['fields'], f['f'].encode()))
    return G.tlv(*out)


def padded(kind, body):
    """`body` plus the tag-64 record that pads it to a multiple of 32 within the type's cap."""
    cap = MAX_PT[kind]
    if len(body) + 3 > cap:
        return body
    r = min((32 - (len(body) + 3) % 32) % 32, cap - 3 - len(body))
    return body + G.rec(TAG['padding'], bytes(r))


def writer_check(kind, f):
    """None when `f` may be sealed, else the writer's error ('malformed')."""
    if kind == 'board':
        name, spec = f['name'], f['spec']
        if not (1 <= len(name) <= 63 and len(name.encode()) <= 252 and NAME.match(name)):
            return 'malformed'
        if not 1 <= len(spec.encode()) <= 4096:
            return 'malformed'
        return None
    if 'col' in f and not 0 <= f['col'] <= 255:
        return 'malformed'
    if 'rank' in f and not RANK.match(f['rank']):
        return 'malformed'
    if 'f' in f and not 1 <= len(f['f'].encode()) <= 2048:
        return 'malformed'
    return None


def bind(doc):
    if doc['type'] == 'board':
        return struct.pack('>I', doc['key'])
    return struct.pack('>I', doc['board']) + bytes.fromhex(doc['item'])


def ad(owner, e, doc):
    return b'dash-forge/v2/doc\x00\x01' + G.repoId + owner + G.u32(e) + doc['type'].encode() + b'\x00' + bind(doc)


def seal(K, e, owner, doc, pt, nonce=G.NONCE):
    A = ad(owner, e, doc)
    return A, b'\x01' + nonce + AESGCM(G.k_doc(K, e)).encrypt(nonce, pt, A)


def board(key=7):
    return dict(type='board', key=key)


def card(board_key=7, item=ITEM):
    return dict(type='card', board=board_key, item=item.hex())


def seal_vectors():
    def v(name, desc, doc, f, K=G.K0, e=0):
        inp = dict(repoId=G.H(G.repoId), key=G.H(K), epoch=e, ownerId=G.H(G.ownerId), nonce=G.H(G.NONCE), doc=doc, fields=f)
        err = writer_check(doc['type'], f)
        if err is None and doc['type'] == 'board' and not 1 <= doc['key'] <= 0xffffffff:
            err = 'malformed'
        if err is not None:
            vector('seal_' + name, desc, 'seal', inp, dict(error=err))
            return
        pt = padded(doc['type'], records(doc['type'], f))
        A, enc = seal(K, e, G.ownerId, doc, pt)
        vector('seal_' + name, desc, 'seal', inp, dict(ad=G.H(A), tlv=G.H(pt), enc=G.H(enc)))

    v('board', 'a board under epoch 0: its name (TLV 32) and definition (33), padded to 32 bytes; the AD binds '
      'u32(key).', board(), dict(name='Roadmap', spec=SPEC))
    v('board_epoch1', 'the same board under epoch 1: another key, another epoch in the AD.', board(), dict(name='Roadmap', spec=SPEC), G.K1, 1)
    v('board_key_max', 'the largest key, 4294967295.', board(0xffffffff), dict(name='Ops', spec='{"v":1,"columns":[{"id":1,"name":"Todo"}]}'))
    v('board_unicode_name', 'a name of 11 characters and 13 bytes.', board(), dict(name='Sprint ✨ 12', spec=SPEC))
    v('board_name_63_chars', 'a name at its 63-character cap.', board(), dict(name='n' * 63, spec=SPEC))
    v('board_name_64_chars', 'a name over 63 characters is refused before sealing.', board(), dict(name='n' * 64, spec=SPEC))
    v('board_name_blank', 'a name of only white space is refused (the schema pattern needs a visible character).', board(), dict(name='   ', spec=SPEC))
    v('board_name_control', 'a name with a control character is refused.', board(), dict(name='a\tb', spec=SPEC))
    v('board_spec_4096_bytes', 'a definition at its 4096-byte cap (the TLV does not judge its JSON: the board rules do).', board(), dict(name='Big', spec='x' * 4096))
    v('board_spec_4097_bytes', 'a definition over 4096 bytes is refused.', board(), dict(name='Big', spec='x' * 4097))
    v('board_spec_empty', 'a board needs a definition.', board(), dict(name='Empty', spec=''))
    v('board_key_zero', 'key 0 is not a board key.', board(0), dict(name='Zero', spec=SPEC))
    v('card', 'a card: column (TLV 34, one byte), rank (35) and field values (36); the AD binds u32(board) and the '
      'item id.', card(), dict(col=2, rank='V', f='{"1":3,"2":5}'))
    v('card_empty', 'a card with nothing but its state (an archive or removal of an item never placed): only the '
      'padding record.', card(), {})
    v('card_col_zero', 'column 0 ("No status") is written: one byte 0x00.', card(), dict(col=0))
    v('card_rank_63', 'a rank at its 63-digit cap.', card(), dict(rank='z' * 63))
    v('card_rank_trailing_zero', 'an explicit rank never ends in 0.', card(), dict(rank='V0'))
    v('card_rank_64', 'a rank over 63 digits is refused.', card(), dict(rank='z' * 64))
    v('card_col_256', 'a column is 0-255.', card(), dict(col=256))
    v('card_fields_2048_bytes', 'field values at their 2048-byte cap.', card(), dict(f='{"5":"' + 't' * 2040 + '"}'))
    v('card_fields_2049_bytes', 'field values over 2048 bytes are refused.', card(), dict(f='{"5":"' + 't' * 2041 + '"}'))


CTX0 = G.CTX0
CTX01 = G.CTX01


def open_vectors():
    def v(name, desc, doc, context, expected, enc=None, f=None, pt=None, K=G.K0, owner=G.ownerId, **extra):
        d = dict(doc, ownerId=G.H(owner), epoch=extra.pop('epoch', 0), plaintext=extra.pop('plaintext', False))
        if enc is None:
            body = pt if pt is not None else padded(doc['type'], records(doc['type'], f))
            _, enc = seal(K, d['epoch'], G.ownerId, doc, body)
        if enc is not False:
            d['enc'] = G.H(enc)
        assert not extra, extra
        vector('open_' + name, desc, 'open', dict(repoId=G.H(G.repoId), context=context, doc=d), expected)

    B = dict(name='Roadmap', spec=SPEC)
    C = dict(col=2, rank='V', f='{"1":3}')
    _, board_enc = seal(G.K0, 0, G.ownerId, board(), padded('board', records('board', B)))
    _, card_enc = seal(G.K0, 0, G.ownerId, card(), padded('card', records('card', C)))
    v('board', 'a sealed board opens under K_0 to its name and definition.', board(), CTX0, G.readable(B), f=B)
    v('card', 'a sealed card opens to its column, rank and field values.', card(), CTX0, G.readable(C), f=C)
    v('card_empty', 'a card sealed with no fields opens to none.', card(), CTX0, G.readable({}), f={})
    v('board_epoch1', 'a board sealed under epoch 1 opens with K_1.', board(), CTX01, G.readable(B), f=B, K=G.K1, epoch=1)
    v('superseded_epoch_still_opens', 'a board under superseded epoch 0 by a member removed since still opens: both '
      'types are member-gated at consensus on every write, so the height part of the late rule (§8.2) does not apply.',
      board(), CTX01, G.readable(B), f=B)
    v('card_moved_to_other_item', 'the AD binds the item: a card\'s enc copied onto a card for another item fails the '
      'tag.', card(item=OTHER_ITEM), CTX0, G.unreadable('badTag'), enc=card_enc)
    v('card_moved_to_other_board', 'the AD binds the board key: the enc copied to another board fails the tag.',
      card(board_key=8), CTX0, G.unreadable('badTag'), enc=card_enc)
    v('board_moved_to_other_key', 'a board\'s enc copied under another key fails the tag.', board(8), CTX0,
      G.unreadable('badTag'), enc=board_enc)
    v('other_owner', 'the AD binds $ownerId: another member cannot re-post this enc as theirs.', board(), CTX0,
      G.unreadable('badTag'), enc=board_enc, owner=OTHER_OWNER)
    v('card_enc_as_board', 'the AD binds the type: a card\'s enc stored as a board (key 7, the card\'s board) fails '
      'the tag.', board(), CTX0, G.unreadable('badTag'), enc=card_enc)
    v('no_key', 'epoch 0 exists but the reader holds only K_1: Unreadable(NoKey).', board(),
      G.ctx({1: G.K1}, {0: ('c0', 10), 1: ('c1', 1000)}), G.unreadable('noKey'), enc=board_enc)
    v('no_epoch', 'an epoch without an anchor does not exist: Unreadable(NoEpoch).', board(),
      G.ctx({0: G.K0}, {1: ('c1', 1000)}), G.unreadable('noEpoch'), enc=board_enc)
    v('plaintext_beside_enc', 'a sealed board that also carries a plaintext name or spec is malformed (the contract\'s '
      'noPlain refuses it; a reader does too).', board(), CTX0, G.MALFORMED, enc=board_enc, plaintext=True)
    v('private_without_enc', 'a private repository\'s board without enc is malformed: its readers read only sealed '
      'boards.', board(), CTX0, G.MALFORMED, enc=False)
    v('version_3', 'a version other than 0x01 is a later client\'s (a public repository\'s members-only board): '
      'Unreadable(UnknownVersion), listed, never malformed.', board(), CTX0, G.unreadable('unknownVersion'),
      enc=b'\x03' + board_enc[1:])
    v('short_enc', 'an enc shorter than 29 bytes is malformed before any key is used.', board(), CTX0, G.MALFORMED,
      enc=board_enc[:28])
    burned1 = G.ctx({0: G.K0, 1: G.K1}, {0: ('c0', 10), 1: ('c1', 1000)}, burned=[1])
    v('under_burned_epoch_by_removed_member', 'the burned clause of §8.2 still applies: a card under burned epoch 1 by '
      'someone who is no longer a member is Unreadable(Late).', card(), burned1, G.unreadable('late'), f=C, K=G.K1, epoch=1)
    v('under_burned_epoch_by_member', 'the same card by a current member opens.', card(), dict(burned1, members=[G.H(G.ownerId)]),
      G.readable(C), f=C, K=G.K1, epoch=1)
    rec = G.rec
    v('tlv_out_of_order', 'records out of order (rank before column) are malformed.', card(), CTX0, G.MALFORMED,
      pt=rec(35, b'V') + rec(34, b'\x02'))
    v('tlv_repeated', 'a repeated record is malformed.', card(), CTX0, G.MALFORMED, pt=rec(34, b'\x02') + rec(34, b'\x03'))
    v('tlv_board_tag_in_card', 'a board\'s tag (33) in a card is malformed.', card(), CTX0, G.MALFORMED, pt=rec(33, b'{}'))
    v('tlv_content_tag_in_board', 'another kind\'s tag (2, a body) in a board is malformed.', board(), CTX0, G.MALFORMED,
      pt=rec(2, b'x') + rec(32, b'Roadmap') + rec(33, SPEC.encode()))
    v('tlv_extension_skipped', 'tags 64-255 are extensions: skipped.', card(), CTX0, G.readable(dict(col=1)),
      pt=rec(34, b'\x01') + rec(70, b'later'))
    v('tlv_col_two_bytes', 'a column is exactly one byte.', card(), CTX0, G.MALFORMED, pt=rec(34, b'\x00\x01'))
    v('tlv_rank_trailing_zero', 'a sealed rank ending in 0 is malformed, as the plaintext pattern refuses it.', card(),
      CTX0, G.MALFORMED, pt=rec(35, b'V0'))
    v('tlv_empty_rank_absent', 'a zero-length record of a field with minLength 1 counts as absent.', card(), CTX0,
      G.readable(dict(col=1)), pt=rec(34, b'\x01') + rec(35, b''))
    v('tlv_board_without_spec', 'a board needs its definition.', board(), CTX0, G.MALFORMED, pt=rec(32, b'Roadmap'))
    v('tlv_truncated', 'a record running past the end is malformed.', board(), CTX0, G.MALFORMED,
      pt=rec(32, b'Roadmap') + bytes([33, 0, 9]) + b'{}')


def build():
    seal_vectors()
    open_vectors()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write-vectors', action='store_true')
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args()
    build()
    expected = {f"{CASE}__{v['name']}.json": json.dumps(v, indent=2, ensure_ascii=False) + '\n' for v in VECTORS}
    assert len(expected) == len(VECTORS), 'duplicate vector names'
    if args.write_vectors:
        for path in OUT.glob(f'{CASE}__*.json'):
            if path.name not in expected:
                path.unlink()
        for name, text in expected.items():
            (OUT / name).write_text(text)
    if args.check:
        actual = {p.name: p.read_text() for p in OUT.glob(f'{CASE}__*.json')}
        if actual != expected:
            raise SystemExit('sealed board vectors are stale')
    print(f'sealed board vectors: {len(expected)}' + (' checked' if args.check else ''))


if __name__ == '__main__':
    main()

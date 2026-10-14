"""Independent Python reference for members-only branches and pull requests (mixed-visibility design
§4.3, §4.4, D4, D21, D22; docs/security/private-repos.md §19).

    python3 tools/private-repos-vectors/members_git.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/members_git.py --write-vectors  # (re)write the vector files below

Cases it writes (forge-contracts/vectors/<case>__<name>.json):

- `oid_blind`: the salted OID blind `SHA-256("dash-forge/v2/oid-blind" ‖ 0x00 ‖ salt ‖ oid)[0..len(oid)]`
  (`op: blind`), the reader's check of a plaintext OID against the real value and salt in `enc`
  (`op: check`), and S5's pull-request scenarios in blind space with rule C (`op: prFold`).
- `sealed_ref`: a members-only ref update (`refUpdate`/`protectedRefUpdate`, `refName` absent, keyed
  `refNameHash`, blinded `newOid`/`prevOid`, `enc` v0x03 with TLV 3, 22, 23, 27): `op: seal`, `op: open`
  (real values and blind alerts), and `op: union` (the member fold's input over public and opened
  members-only updates of one name, S5 V1, V1b, V1c).
- `sealed_patch`: a members-only pull request (`patch`: keyed or public name hashes, the copied blind
  `headOid`, TLV 24 and 27) and its head updates (`event` kind 16 with TLV 24 and 27): `op: seal`,
  `op: open`.
- `members_pack_plan`: the push's pack jobs by audience (D22).
- `publish_guard`: the publication guard over an abstract object graph (D21, S4's scenarios that do not
  need git), with the gitlink notes and the opt-in patch-id warning.
- `members_index`: the plaintext of a members-only object locator (kind 65): `"DFML" ‖ 0x01 ‖ packHash ‖
  objectLocator` with every row at packRef 0 (`op: encode`, `op: parse`).

The Rust harness (`forge-core`) runs every file. The TypeScript harness (`forge-web/lib/private`) runs
`oid_blind`, `sealed_ref`, `sealed_patch` and `members_index`; the pack plan and the guard are the git helper's, which the
browser never runs.
"""
import glob
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen  # noqa: E402
from gen import H, K0, K1, NONCE, ownerId, repoId, rec, ref_hash, sha256, tlv  # noqa: E402

VECTORS = []
CASES = ("oid_blind", "sealed_ref", "sealed_patch", "members_pack_plan", "publish_guard", "members_index")


def vector(case, name, description, inp, expected):
    VECTORS.append(dict(name=name, description=description, case=case, rules="v2", input=inp, expected=expected))


# --- the blind -----------------------------------------------------------------------------------

BLIND_DOMAIN = b"dash-forge/v2/oid-blind\x00"
NEW_OID, PREV_OID, HEAD_OID, OID_SALT = 22, 23, 24, 27


def blind(salt, oid):
    assert len(salt) == 32 and len(oid) in (20, 32)
    return sha256(BLIND_DOMAIN + salt + oid)[: len(oid)]


def is_null(oid):
    return oid is None or len(oid) == 0 or oid == bytes(len(oid))


def check(plain, real, salt):
    """How a reader judges one plaintext OID against the real value and salt sealed beside it."""
    if is_null(plain):
        return "null" if real is None else "malformed"
    if real is None or salt is None:
        return "malformed"
    if len(real) != len(plain):
        return "width"
    return "ok" if blind(salt, real) == plain else "mismatch"


def salt(label):
    return sha256(b"dash-forge vectors: salt " + label.encode())


def oid(label, width=20):
    return sha256(b"dash-forge vectors: commit " + label.encode())[:width]


# --- sealed ref updates ----------------------------------------------------------------------------


def ref_records(name, new, prev, s):
    records = [(3, name.encode())]
    if not is_null(new):
        records.append((NEW_OID, new))
    if prev is not None and not is_null(prev):
        records.append((PREV_OID, prev))
    if len(records) > 1:
        records.append((OID_SALT, s))
    return records


def seal_ref(name, new, prev, s, K=K0, e=0, force=False, kind="refUpdate", owner=ownerId, nonce=NONCE,
             records=None, plain_new=None, plain_prev=None):
    """(doc header, tlv, AD, enc) of a members-only ref update; `records`/`plain_*` override for negatives."""
    pn = plain_new if plain_new is not None else (new if is_null(new) else blind(s, new))
    if plain_prev is not None:
        pp = plain_prev
    else:
        pp = None if prev is None else (prev if is_null(prev) else blind(s, prev))
    doc = dict(type=kind, vis="public", ownerId=H(owner), epoch=e, refNameHash=H(ref_hash(K, e, name)),
               newOid=H(pn), force=force)
    if pp is not None:
        doc["prevOid"] = H(pp)
    recs = tlv(*(records if records is not None else ref_records(name, new, prev, s)))
    A, _, _, pt, enc = gen.seal_members(doc, K, recs, nonce=nonce)
    assert pt == recs  # ref updates are never padded
    return doc, recs, A, enc


def ctx_json(keys=None, anchors=None, members=()):
    return gen.ctx(keys or {0: K0}, anchors or {0: ("c0", 10)}, members)


def sealed_ref_vectors():
    A_, B_, C_, D_ = (oid(x) for x in "ABCD")
    s1, s2 = salt("r1"), salt("r2")
    seals = [
        ("create", "refs/heads/sec/fix", A_, None, s1, {}, "a new members-only branch: prevOid absent (a create is "
         "public, D4 nulls), newOid the blind of A under this document's salt, TLV 3, 22 and 27; never padded."),
        ("update", "refs/heads/sec/fix", B_, A_, s2, {}, "a fast-forward A to B: both OIDs blinded under this "
         "document's own salt (prevOid is not copied from the update that introduced A, so the public cannot "
         "chain a members branch's updates)."),
        ("force", "refs/heads/sec/fix", C_, B_, s1, dict(force=True), "a force push: force stays plaintext."),
        ("delete", "refs/heads/sec/fix", bytes(20), C_, s2, {}, "a delete: newOid stays all-zero in plaintext (a "
         "deleted members branch is public, D4), the real prevOid is TLV 23 with the salt."),
        ("protected", "refs/heads/sec/release", A_, None, s1, dict(kind="protectedRefUpdate"),
         "a protectedRefUpdate seals the same way."),
        ("sha256_width", "refs/heads/sec/fix", oid("A", 32), oid("Z", 32), s1, {}, "a SHA-256 repository: 32-byte "
         "blinds (the whole digest), the same width as the real OIDs."),
        ("epoch1", "refs/heads/sec/fix", B_, A_, s1, dict(K=K1, e=1), "under epoch 1: K_ref,1 keys the name hash; "
         "the blind does not depend on the epoch."),
    ]
    outs = {}
    for name, ref, new, prev, s, kw, desc in seals:
        K, e = kw.get("K", K0), kw.get("e", 0)
        kind, force = kw.get("kind", "refUpdate"), kw.get("force", False)
        doc, recs, A, enc = seal_ref(ref, new, prev, s, K=K, e=e, force=force, kind=kind)
        outs[name] = (doc, enc, ref, new, prev, K, e)
        inp = dict(op="seal", repoId=H(repoId), key=H(K), epoch=e, type=kind, ownerId=H(ownerId), refName=ref,
                   newOid=H(new), force=force, salt=H(s), nonce=H(NONCE))
        if prev is not None:
            inp["prevOid"] = H(prev)
        doc_out = {k: v for k, v in doc.items() if k not in ("type", "ownerId", "vis")}
        vector("sealed_ref", "seal_" + name, desc, inp, dict(doc=doc_out, tlv=H(recs), ad=H(A), enc=H(enc)))
    vector("sealed_ref", "seal_refused_mixed_widths", "a writer refuses a 20-byte newOid beside a 32-byte prevOid.",
           dict(op="seal", repoId=H(repoId), key=H(K0), epoch=0, type="refUpdate", ownerId=H(ownerId),
                refName="refs/heads/sec/fix", newOid=H(oid("B")), prevOid=H(oid("A", 32)), force=False,
                salt=H(s1), nonce=H(NONCE)), dict(error="malformed"))
    vector("sealed_ref", "seal_refused_null_create", "a create that is also a delete names nothing: refused.",
           dict(op="seal", repoId=H(repoId), key=H(K0), epoch=0, type="refUpdate", ownerId=H(ownerId),
                refName="refs/heads/sec/fix", newOid=H(bytes(20)), force=False, salt=H(s1), nonce=H(NONCE)),
           dict(error="malformed"))

    def opened(ref, new, prev, alerts=()):
        r = dict(name=ref, newOid=H(new))
        if prev is not None:
            r["prevOid"] = H(prev)
        return dict(status="readable", ref=r, alerts=list(alerts))

    def ov(name, desc, doc, enc, expected, context=None, height=50):
        d = dict(doc, enc=H(enc), createdAtBlockHeight=height)
        vector("sealed_ref", "open_" + name, desc, dict(op="open", repoId=H(repoId), context=context or ctx_json(),
                                                        doc=d), expected)

    for name in ("create", "update", "force", "delete", "protected", "sha256_width"):
        doc, enc, ref, new, prev, K, e = outs[name]
        ov(name, f"a member opens the {name} vector: the real values from TLV 22 and 23, each blind checked.",
           doc, enc, opened(ref, new, prev))
    doc, enc, ref, new, prev, K, e = outs["epoch1"]
    ov("epoch1", "epoch 1's update opens with K_1.", doc, enc, opened(ref, new, prev),
       context=ctx_json({0: K0, 1: K1}, {0: ("c0", 10), 1: ("c1", 20)}))
    doc, enc = outs["update"][:2]
    ov("outsider", "no key: an outsider (or a member the key was not shared with) cannot open it.", doc, enc,
       dict(status="unreadable", reason="noKey"), context=gen.ctx({}, {0: ("c0", 10)}))
    # a writer whose plaintext blind is not the blind of what it sealed: kept, with an alert
    bad = blind(salt("other"), B_)
    doc, _, _, enc = seal_ref("refs/heads/sec/fix", B_, A_, s2, plain_new=bad)
    ov("blind_mismatch", "newOid in plaintext is not the blind of TLV 22 under TLV 27: the update is kept on its real "
       "values and an alert raised (members fold the real values; the public sees the plaintext).",
       doc, enc, opened("refs/heads/sec/fix", B_, A_, [dict(field="newOid", kind="mismatch")]))
    wide = blind(s2, oid("B", 32))
    doc, _, _, enc = seal_ref("refs/heads/sec/fix", B_, A_, s2, plain_new=wide)
    ov("width_mismatch", "a 32-byte blind of a 20-byte commit (oidWidth admits each field alone): an alert.", doc,
       enc, opened("refs/heads/sec/fix", B_, A_, [dict(field="newOid", kind="width")]))
    doc, _, _, enc = seal_ref("refs/heads/sec/fix", B_, A_, s2, plain_prev=blind(salt("other"), A_))
    ov("prev_blind_mismatch", "the same for prevOid.", doc, enc,
       opened("refs/heads/sec/fix", B_, A_, [dict(field="prevOid", kind="mismatch")]))
    negatives = [
        ("missing_salt", [(3, b"refs/heads/sec/fix"), (NEW_OID, B_), (PREV_OID, A_)],
         "TLV 22 and 23 without the salt (27): nothing can be checked, so malformed."),
        ("missing_real_new", [(3, b"refs/heads/sec/fix"), (PREV_OID, A_), (OID_SALT, s2)],
         "a non-null plaintext newOid without its real value (22): malformed."),
        ("missing_real_prev", [(3, b"refs/heads/sec/fix"), (NEW_OID, B_), (OID_SALT, s2)],
         "a plaintext prevOid without its real value (23): malformed."),
        ("salt_twice", [(3, b"refs/heads/sec/fix"), (NEW_OID, B_), (PREV_OID, A_), (OID_SALT, s2), (OID_SALT, s2)],
         "a repeated tag is malformed (§4.3)."),
        ("salt_short", [(3, b"refs/heads/sec/fix"), (NEW_OID, B_), (PREV_OID, A_), (OID_SALT, s2[:31])],
         "a salt of 31 bytes: malformed (exactly 32)."),
        ("real_width_21", [(3, b"refs/heads/sec/fix"), (NEW_OID, B_ + b"\x00"), (PREV_OID, A_), (OID_SALT, s2)],
         "a real OID of 21 bytes: malformed (exactly 20 or 32)."),
        ("head_tag_in_ref", [(3, b"refs/heads/sec/fix"), (NEW_OID, B_), (PREV_OID, A_), (HEAD_OID, B_),
                             (OID_SALT, s2)], "tag 24 is not a ref update's: malformed."),
    ]
    for name, records, desc in negatives:
        doc, _, _, enc = seal_ref("refs/heads/sec/fix", B_, A_, s2, records=records)
        ov(name, desc, doc, enc, gen.MALFORMED)
    # a delete whose real value is sealed for the zero newOid
    doc, _, _, enc = seal_ref("refs/heads/sec/fix", bytes(20), C_, s2,
                              records=[(3, b"refs/heads/sec/fix"), (NEW_OID, C_), (PREV_OID, C_), (OID_SALT, s2)])
    ov("real_on_null", "a real value (22) for an all-zero plaintext newOid: a delete carries none, so malformed.", doc,
       enc, gen.MALFORMED)
    doc, _, _, enc = seal_ref("refs/heads/sec/fix", bytes(20), None, s2,
                              records=[(3, b"refs/heads/sec/fix"), (OID_SALT, s2)])
    ov("salt_alone", "a salt with nothing blinded: malformed.", doc, enc, gen.MALFORMED)
    doc, _, _, enc = seal_ref("refs/heads/sec/fix", bytes(20), None, s2, records=[(3, b"refs/heads/sec/fix")])
    ov("null_create", "an update naming no commit (a null newOid and no prevOid): no writer seals one, so malformed.",
       doc, enc, gen.MALFORMED)
    # the name hash check still runs: another name inside enc
    doc, _, _, enc = seal_ref("refs/heads/sec/fix", B_, A_, s2,
                              records=ref_records("refs/heads/other", B_, A_, s2))
    ov("name_hash_mismatch", "refNameHash is the keyed hash of another name than TLV 3's: malformed (§4.5).", doc, enc,
       gen.MALFORMED)
    # a private repository's v0x01 ref update keeps tags 22-24 and 27 reserved
    pdoc = dict(type="refUpdate", ownerId=H(ownerId), epoch=0, refNameHash=gen.MAIN_E0, newOid="aa" * 20,
                force=False)
    pt = tlv((3, b"refs/heads/main"), (NEW_OID, b"\xaa" * 20), (OID_SALT, s1))
    _, penc = gen.seal_doc(pdoc, K0, pt)
    doc, _, _, enc = seal_ref("refs/heads/sec/fix", B_, A_, s2)
    vector("sealed_ref", "open_v03_private_blind_tags_reserved", "a private repository's document never carries blinds, "
           "v0x03 included (DESIGN D38): tags 22-24 and 27 are reserved there, so the same bytes stamped private are "
           "malformed (the AD does not bind vis).",
           dict(op="open", repoId=H(repoId), context=ctx_json(),
                doc=dict({k: v for k, v in doc.items() if k != "vis"}, enc=H(enc), createdAtBlockHeight=50)),
           gen.MALFORMED)
    vector("sealed_ref", "open_v01_blind_tags_reserved", "a private repository's ref update (v0x01) is not blinded: "
           "tags 22-24 and 27 stay reserved there, malformed.",
           dict(op="open", repoId=H(repoId), context=ctx_json(), doc=dict(pdoc, enc=H(penc), createdAtBlockHeight=50)),
           gen.MALFORMED)

    # --- union: the member fold's input over public and members-only updates of one name (S5 V1-V1c)
    def row(rid, at, doc=None, enc=None, public=None, protected=False):
        r = dict(id=H(gen.cid(rid)), createdAt=at, createdAtBlockHeight=at // 10, protected=protected)
        if public is not None:
            name, new, prev = public
            r.update(ownerId=H(ownerId), refName=name, refNameHash=H(sha256(name.encode())), newOid=H(new),
                     force=False)
            if prev is not None:
                r["prevOid"] = H(prev)
        else:
            r.update({k: v for k, v in doc.items() if k not in ("type",)})
            r["enc"] = H(enc)
        return r

    def upd(rid, new, prev, force=False, protected=False):
        out = dict(id=H(gen.cid(rid)), newOid=H(new), force=force, protected=protected)
        if prev is not None:
            out["prevOid"] = H(prev)
        return out

    name = "refs/heads/sec/fix"
    D2 = oid("D'")
    v1 = [("u1", A_, None, False), ("u2", B_, A_, False), ("u3", C_, B_, False), ("u4", D2, C_, True)]
    rows, expect = [], []
    for i, (rid, new, prev, force) in enumerate(v1):
        doc, _, _, enc = seal_ref(name, new, prev, salt(rid), force=force)
        rows.append(row(rid, 1000 + i, doc, enc))
        expect.append(upd(rid, new, prev, force))
    vector("sealed_ref", "union_v1_chain", "S5 V1: create A, A to B, B to C, force C to D', all members-only: members "
           "fold the real values (the public reader folds nothing: no plaintext update of the name).",
           dict(op="union", repoId=H(repoId), context=ctx_json(), rows=rows),
           dict(refs={name: expect}, publicRefs={}, alerts=[], unreadable=0))
    rows, expect = [], []
    for i, (rid, new, prev, force) in enumerate(v1):
        K, e = (K0, 0) if i < 2 else (K1, 1)
        doc, _, _, enc = seal_ref(name, new, prev, salt(rid), K=K, e=e, force=force)
        rows.append(row(rid, 1000 + i, doc, enc))
        expect.append(upd(rid, new, prev, force))
    vector("sealed_ref", "union_v1b_rotation", "S5 V1b: the same branch with a rotation between B and C: the name "
           "hashes differ per epoch, the real values chain across it.",
           dict(op="union", repoId=H(repoId), context=ctx_json({0: K0, 1: K1}, {0: ("c0", 10), 1: ("c1", 20)}),
                rows=rows), dict(refs={name: expect}, publicRefs={}, alerts=[], unreadable=0))
    P1, P2, X_, Y_ = oid("P1"), oid("P2"), oid("X"), oid("Y")
    rows = [row("p1", 900, public=(name, P1, None)), row("p2", 901, public=(name, P2, P1)),
            row("p3", 902, public=(name, bytes(20), P2))]
    doc, _, _, enc = seal_ref(name, X_, None, salt("x"))
    rows.append(row("x", 950, doc, enc))
    doc, _, _, enc = seal_ref(name, Y_, X_, salt("y"))
    rows.append(row("y", 960, doc, enc))
    pub = [upd("p1", P1, None), upd("p2", P2, P1), upd("p3", bytes(20), P2)]
    vector("sealed_ref", "union_v1c_public_then_members", "S5 V1c: a public branch P1, P2, deleted (\"stop publishing\"), "
           "then members-only X and Y under the same name: members fold the union (Y), the public reads it deleted.",
           dict(op="union", repoId=H(repoId), context=ctx_json(), rows=rows),
           dict(refs={name: pub + [upd("x", X_, None), upd("y", Y_, X_)]}, publicRefs={name: pub}, alerts=[],
                unreadable=0))
    rows = [row("p1", 900, public=(name, P1, None))]
    doc, _, _, enc = seal_ref(name, X_, None, salt("x"))
    rows.append(row("x", 950, doc, enc))
    vector("sealed_ref", "union_public_name_wins", "a members-only update naming a branch that is live in public (any "
           "member could seal one naming main): public names win (D29), so members fold the public branch, leave the "
           "members-only update out and raise an alert, and both audiences read the same public branch.",
           dict(op="union", repoId=H(repoId), context=ctx_json(), rows=rows),
           dict(refs={name: [upd("p1", P1, None)]}, publicRefs={name: [upd("p1", P1, None)]},
                alerts=[dict(id=H(gen.cid("x")), kind="publicName")], unreadable=0))
    rows = [row("m", 1000, *seal_ref(name, B_, A_, s2, plain_new=blind(salt("z"), B_))[::3])]
    vector("sealed_ref", "union_mismatch_kept", "a blind that does not match its real value: kept in the fold on the "
           "real values, with an alert naming the document.",
           dict(op="union", repoId=H(repoId), context=ctx_json(), rows=rows),
           dict(refs={name: [upd("m", B_, A_)]}, publicRefs={},
                alerts=[dict(id=H(gen.cid("m")), field="newOid", kind="mismatch")], unreadable=0))
    other = "refs/heads/sec/other"
    rows = [row("n1", 1000, *seal_ref(other, A_, None, s1)[::3]),
            row("n2", 1001, *seal_ref(other, B_, A_, s2, kind="protectedRefUpdate")[::3], protected=True),
            row("n3", 1002, *seal_ref(name, C_, None, s1)[::3]),
            row("hidden", 1003, *seal_ref(name, D_, C_, s2, K=K1, e=1)[::3])]
    named = row("named", 1004, *seal_ref(name, D_, C_, s1)[::3])
    named["refName"] = name  # a sealed update that also names its branch in plaintext: no honest writer's
    rows.append(named)
    vector("sealed_ref", "union_two_names_and_unreadable", "two names; a protected update keeps its flag; an update "
           "under an epoch the reader does not hold and a sealed update carrying a plaintext refName are left out "
           "(counted, not folded).",
           dict(op="union", repoId=H(repoId), context=ctx_json(), rows=rows),
           dict(refs={other: [upd("n1", A_, None), upd("n2", B_, A_, protected=True)], name: [upd("n3", C_, None)]},
                publicRefs={}, alerts=[], unreadable=2))


# --- sealed pull requests ---------------------------------------------------------------------------

MPATCH_PROPS = {"number": 12, "title": "Fix the token leak", "body": "Members-only until the release.",
                "baseRefName": "refs/heads/main", "sourceRefName": "refs/heads/sec/fix", "draft": False,
                "sourceRepoId": "11" * 32, "asMember": True, "vis": "public"}


def patch_records(props, head_real=None, s=None):
    recs = [(1, props["title"].encode())]
    if props.get("body"):
        recs.append((2, props["body"].encode()))
    recs += [(4, props["baseRefName"].encode()), (5, props["sourceRefName"].encode())]
    if head_real is not None:
        recs.append((HEAD_OID, head_real))
    if s is not None:
        recs.append((OID_SALT, s))
    return recs


def seal_patch(props, base_public, source_public, head_real, head_plain, s, K=K0, e=0, records=None):
    base_hash = sha256(props["baseRefName"].encode()) if base_public else ref_hash(K, e, props["baseRefName"])
    source_hash = sha256(props["sourceRefName"].encode()) if source_public else ref_hash(K, e, props["sourceRefName"])
    doc = dict(type="patch", vis="public", ownerId=H(ownerId), epoch=e, number=props["number"],
               baseRefNameHash=H(base_hash), sourceRefNameHash=H(source_hash))
    recs = tlv(*(records if records is not None else patch_records(props, head_real, s)))
    A, _, _, pt, enc = gen.seal_members(doc, K, recs)
    out = {k: v for k, v in props.items() if k not in ("title", "body", "baseRefName", "sourceRefName")}
    out.update(baseRefNameHash=H(base_hash), sourceRefNameHash=H(source_hash), headOid=H(head_plain), epoch=e,
               enc=H(enc))
    return doc, pt, A, enc, out


def seal_head_update(target, oid_plain, head_real, s, K=K0, e=0, records=None):
    doc = dict(type="event", vis="public", ownerId=H(ownerId), epoch=e, targetId=target)
    recs = records if records is not None else [(HEAD_OID, head_real), (OID_SALT, s)]
    A, _, _, pt, enc = gen.seal_members(doc, K, tlv(*recs))
    return doc, pt, A, enc


def sealed_patch_vectors():
    H1, H2 = oid("H1"), oid("H2")
    s = salt("push-H1")
    seals = [
        ("members_source_public_base", True, False, H1, s, "a members-only PR from a members-only branch into public "
         "main: baseRefNameHash is the public sha256 of main (the public can verify the merge on it), "
         "sourceRefNameHash the keyed hash, headOid the blind copied from the branch's ref update (rule C) with the "
         "real head (24) and that update's salt (27) inside enc."),
        ("members_base", False, False, H1, s, "a members-only PR into a members-only base: both names keyed."),
        ("public_source", True, True, None, None, "a members-only PR from a public branch: its head is the plain "
         "commit, so no 24 and 27 (reviews and check runs on it are plain too)."),
    ]
    for name, base_public, source_public, real, sl, desc in seals:
        plain = blind(sl, real) if real is not None else H2
        doc, pt, A, enc, out = seal_patch(MPATCH_PROPS, base_public, source_public, real, plain, sl)
        inp = dict(op="seal", repoId=H(repoId), key=H(K0), epoch=0, type="patch", ownerId=H(ownerId),
                   props=dict(MPATCH_PROPS, headOid=H(plain)), basePublic=base_public, sourcePublic=source_public,
                   nonce=H(NONCE))
        if real is not None:
            inp["head"] = dict(real=H(real), salt=H(sl))
        vector("sealed_patch", "seal_" + name, desc, inp, dict(props=out))
    target = H(gen.cid("pr12"))
    s2 = salt("push-H2")
    doc, pt, A, enc = seal_head_update(target, blind(s2, H2), H2, s2)
    hu_props = dict(targetId=target, kind=16, oid=H(blind(s2, H2)), asMember=True)
    vector("sealed_patch", "seal_head_update", "a head update (event kind 16) of a members-only PR: oid is the blind "
           "copied from the ref update that moved the branch, TLV 24 and 27 carry the real head and that update's "
           "salt, with no value (15); sealed under the current epoch, not padded.",
           dict(op="seal", repoId=H(repoId), key=H(K0), epoch=0, type="event", ownerId=H(ownerId), props=hu_props,
                head=dict(real=H(H2), salt=H(s2)), basePublic=True, sourcePublic=True, nonce=H(NONCE)),
           dict(props=dict(hu_props, epoch=0, enc=H(enc))))
    vector("sealed_patch", "seal_refused_blind_mismatch", "the writer refuses a headOid that is not the blind of the "
           "real head under the salt it seals (it never writes what readers alert on).",
           dict(op="seal", repoId=H(repoId), key=H(K0), epoch=0, type="patch", ownerId=H(ownerId),
                props=dict(MPATCH_PROPS, headOid=H(blind(salt("other"), H1))), basePublic=True, sourcePublic=False,
                head=dict(real=H(H1), salt=H(s)), nonce=H(NONCE)), dict(error="malformed"))
    vector("sealed_patch", "seal_refused_real_head_in_plaintext", "the writer refuses a members source whose real "
           "head would be the plaintext headOid.",
           dict(op="seal", repoId=H(repoId), key=H(K0), epoch=0, type="patch", ownerId=H(ownerId),
                props=dict(MPATCH_PROPS, headOid=H(H1)), basePublic=True, sourcePublic=False,
                head=dict(real=H(H1), salt=H(s)), nonce=H(NONCE)), dict(error="malformed"))

    def ov(name, desc, doc, enc, expected, height=50):
        d = dict(doc, enc=H(enc), createdAtBlockHeight=height)
        vector("sealed_patch", "open_" + name, desc, dict(op="open", repoId=H(repoId), context=ctx_json(), doc=d,
                                                          plainHead=plain_of[name]), expected)

    fields = {k: MPATCH_PROPS[k] for k in ("title", "body", "baseRefName", "sourceRefName")}
    plain_of = {}
    b1 = blind(s, H1)
    doc, _, _, enc, _ = seal_patch(MPATCH_PROPS, True, False, H1, b1, s)
    plain_of["members_source"] = H(b1)
    ov("members_source", "a member opens the PR: the text, and the real head of the blind headOid.", doc, enc,
       dict(status="readable", fields=fields, head=dict(real=H(H1), salt=H(s)), alerts=[]))
    doc, _, _, enc, _ = seal_patch(MPATCH_PROPS, True, True, None, H2, None)
    plain_of["public_source"] = H(H2)
    ov("public_source", "a PR from a public branch has no sealed head: headOid is plain.", doc, enc,
       dict(status="readable", fields=fields, alerts=[]))
    doc, _, _, enc, _ = seal_patch(MPATCH_PROPS, True, False, H1, b1, s)
    plain_of["head_mismatch"] = H(blind(salt("other"), H1))
    ov("head_mismatch", "the plaintext headOid is not the blind of TLV 24 under TLV 27: the PR is kept (it folds on "
       "the blind as written, as the public does) and an alert raised; its real head is not trusted.", doc, enc,
       dict(status="readable", fields=fields, alerts=[dict(field="headOid", kind="mismatch")]))
    doc, _, _, enc, _ = seal_patch(MPATCH_PROPS, True, False, None, b1, None,
                                   records=patch_records(MPATCH_PROPS, None, s))
    plain_of["salt_without_head"] = H(b1)
    ov("salt_without_head", "a salt without a real head: malformed.", doc, enc, gen.MALFORMED)
    doc, _, _, enc, _ = seal_patch(MPATCH_PROPS, True, False, H1, b1, None,
                                   records=patch_records(MPATCH_PROPS, H1, None))
    plain_of["head_without_salt"] = H(b1)
    ov("head_without_salt", "a real head without its salt: malformed.", doc, enc, gen.MALFORMED)
    doc, _, _, enc, _ = seal_patch(MPATCH_PROPS, True, False, H1, b1, s,
                                   records=patch_records(MPATCH_PROPS, H1, s) + [(NEW_OID, H1)])
    plain_of["ref_tag_in_patch"] = H(b1)
    ov("ref_tag_in_patch", "tag 22 is a ref update's, not a PR's: malformed.", doc, enc, gen.MALFORMED)
    # head updates
    b2 = blind(s2, H2)
    for name, recs, plain, expected, desc in [
        ("head_update", None, b2, dict(status="readable", fields={}, head=dict(real=H(H2), salt=H(s2)), alerts=[]),
         "a member opens a head update: the real head of its blind oid."),
        ("head_update_mismatch", None, blind(s2, oid("H3")),
         dict(status="readable", fields={}, alerts=[dict(field="headOid", kind="mismatch")]),
         "S5 V2b: a head update whose blind is not that of its TLV 24: kept (everyone folds the blind), alerted."),
        ("head_update_with_value", [(15, b"x"), (HEAD_OID, H2), (OID_SALT, s2)], b2,
         dict(status="readable", fields={"eventValue": "x"}, head=dict(real=H(H2), salt=H(s2)), alerts=[]),
         "a value beside the head is read too (the fold ignores a head update's value)."),
        ("head_update_empty", [], b2, gen.MALFORMED, "an event with neither a value (15) nor a head (24): malformed."),
    ]:
        doc, _, _, enc = seal_head_update(target, plain, H2, s2, records=recs)
        plain_of[name] = H(plain)
        ov(name, desc, doc, enc, expected)


# --- S5's pull-request scenarios in blind space ----------------------------------------------------


def pr_fold(patch, head_updates, reviews, author="author"):
    """Head = the newest head update (by createdAt, id), else the PR's own; approvers count on that head
    exactly as written (blind space); the real head comes from verified blinds only."""
    known, alerts = {}, []

    def learn(plain, real, s, at):
        if real is None:
            return
        st = check(bytes.fromhex(plain), bytes.fromhex(real), bytes.fromhex(s) if s else None)
        if st == "ok":
            known[plain] = real
        else:
            alerts.append(dict(at=at, kind=st))

    learn(patch["headOid"], patch.get("real"), patch.get("salt"), "patch")
    head = patch["headOid"]
    for hu in sorted(head_updates, key=lambda h: (h["createdAt"], h["id"])):
        learn(hu["oid"], hu.get("real"), hu.get("salt"), hu["id"])
        head = hu["oid"]
    standing = {}
    for r in sorted(reviews, key=lambda r: (r["createdAt"], r["id"])):
        if r["reviewer"] == author or r["verdict"] not in (1, 2) or r["commitOid"] != head:
            continue
        standing[r["reviewer"]] = r["verdict"]
    out = dict(head=head, approvers=sorted(k for k, v in standing.items() if v == 1), alerts=alerts)
    if head in known:
        out["realHead"] = known[head]
    return out


def oid_blind_vectors():
    s = salt("a")
    for name, o, desc in [("sha1", oid("A"), "a SHA-1 commit: the first 20 bytes of the salted SHA-256."),
                          ("sha256", oid("A", 32), "a SHA-256 commit: the whole digest."),
                          ("sha1_other_salt", oid("A"), "the same commit under another salt: unlinkable.")]:
        sl = salt("b") if name.endswith("other_salt") else s
        vector("oid_blind", "blind_" + name, desc, dict(op="blind", salt=H(sl), oid=H(o)), dict(blind=H(blind(sl, o))))
    A_ = oid("A")
    for name, plain, real, sl, desc in [
        ("ok", blind(s, A_), A_, s, "the blind of the real value under the salt."),
        ("mismatch", blind(salt("b"), A_), A_, s, "another salt's blind: mismatch (alert, keep)."),
        ("width", blind(s, oid("A", 32)), A_, s, "a 32-byte blind of a 20-byte commit: width (alert, keep)."),
        ("null_zero", bytes(20), None, None, "an all-zero OID (a delete) is never blinded: null."),
        ("null_with_real", bytes(20), A_, s, "a real value for an all-zero OID: malformed."),
        ("missing_real", blind(s, A_), None, s, "a blind without its real value: malformed."),
        ("missing_salt", blind(s, A_), A_, None, "a blind without its salt: malformed."),
    ]:
        inp = dict(op="check", plain=H(plain))
        if real is not None:
            inp["real"] = H(real)
        if sl is not None:
            inp["salt"] = H(sl)
        vector("oid_blind", "check_" + name, desc, inp, dict(status=check(plain, real, sl)))

    H1, H2, H3 = oid("H1"), oid("H2"), oid("H3")
    s1, s2, s3 = salt("push-H1"), salt("push-H2"), salt("push-H3")
    b1, b2, b3 = blind(s1, H1), blind(s2, H2), blind(s3, H3)
    patch = dict(headOid=H(b1), real=H(H1), salt=H(s1))
    hu = lambda i, at, plain, real, sl: dict(id=i, createdAt=at, oid=H(plain), real=H(real), salt=H(sl))
    rv = lambda i, who, verdict, commit, at: dict(id=i, reviewer=who, verdict=verdict, commitOid=H(commit),
                                                  createdAt=at)
    scenarios = [
        ("v2", "S5 V2: bob approves H1, the head moves to H2, carol approves H2: everyone counts carol on the blind; "
         "members also learn the real head H2.",
         patch, [hu("hu1", 20, b2, H2, s2)], [rv("r1", "bob", 1, b1, 10), rv("r2", "carol", 1, b2, 30)]),
        ("v2b", "S5 V2b: the head update's blind is not that of its TLV 24: members fold the blind as the public "
         "does (carol counts for both), raise an alert, and have no trusted real head.",
         patch, [hu("hu1", 20, b2, H3, s2)], [rv("r1", "bob", 1, b1, 10), rv("r2", "carol", 1, b2, 30)]),
        ("v4_rule_c", "S5 V4 rule C: after a rotation the branch moves to H3; the head update copies the push's "
         "blind and carol's review copies the folded head: counted for both readers.",
         patch, [hu("hu1", 20, b2, H2, s2), hu("hu2", 40, b3, H3, s3)],
         [rv("r1", "bob", 1, b2, 30), rv("r2", "carol", 1, b3, 50)]),
        ("v4_recomputed_blind", "a writer that re-blinds H3 under a fresh salt instead of copying it writes a "
         "commitOid nobody folds: the review does not count, for members or the public alike.",
         patch, [hu("hu1", 40, b3, H3, s3)], [rv("r2", "carol", 1, blind(salt("fresh"), H3), 50)]),
        ("request_changes_then_approve", "a reviewer's newest verdict on the blinded head stands.",
         patch, [], [rv("r1", "bob", 2, b1, 10), rv("r2", "bob", 1, b1, 20), rv("r3", "author", 1, b1, 25)]),
    ]
    for name, desc, p, hus, rvs in scenarios:
        vector("oid_blind", "pr_" + name, desc, dict(op="prFold", author="author", patch=p, headUpdates=hus,
                                                     reviews=rvs), pr_fold(p, hus, rvs))


# --- the pack plan (D22) ---------------------------------------------------------------------------


def pack_plan(public_tips, members_tips, batch):
    P = set(public_tips)
    pub_want = sorted({u["new"] for u in batch if u["audience"] == "public" and u.get("new")} - P)
    out = dict(public=dict(want=pub_want, have=sorted(P)) if pub_want else None, members=[])
    for u in sorted((u for u in batch if u["audience"] == "members" and u.get("new")), key=lambda u: u["dst"]):
        have = set(P) | set(pub_want)
        prev = members_tips.get(u["dst"])
        if prev:
            have.add(prev)
        if u["new"] in have:
            continue
        out["members"].append(dict(ref=u["dst"], want=[u["new"]], have=sorted(have)))
    return out


def pack_plan_vectors():
    o = lambda x: H(oid(x))
    P = [o("main"), o("v1")]
    cases = [
        ("public_only", "a public push: one public pack against P only.", P, {},
         [dict(dst="refs/heads/main", new=o("main2"), audience="public")]),
        ("members_only_new_branch", "a new members-only branch: its own pack against P (no other members branch's "
         "objects as bases, D22).", P, {"refs/heads/sec/other": o("other")},
         [dict(dst="refs/heads/sec/fix", new=o("fix1"), audience="members")]),
        ("members_update", "a members-only branch moves: its previous tip joins the bases.", P,
         {"refs/heads/sec/fix": o("fix1")}, [dict(dst="refs/heads/sec/fix", new=o("fix2"), audience="members")]),
        ("mixed_batch", "public first (against P only, never a members tip), then one pack per members branch "
         "against P, the batch's new public tips and that branch's previous tip.", P,
         {"refs/heads/sec/a": o("a1"), "refs/heads/sec/b": o("b1")},
         [dict(dst="refs/heads/sec/b", new=o("b2"), audience="members"),
          dict(dst="refs/heads/main", new=o("main2"), audience="public"),
          dict(dst="refs/heads/sec/a", new=o("a2"), audience="members"),
          dict(dst="refs/tags/v2", new=o("main2"), audience="public")]),
        ("deletes_and_known", "deletes pack nothing; a members branch set to a public commit needs no pack.", P,
         {"refs/heads/sec/a": o("a1")},
         [dict(dst="refs/heads/old", new=None, audience="public"),
          dict(dst="refs/heads/sec/a", new=o("main"), audience="members"),
          dict(dst="refs/heads/sec/gone", new=None, audience="members")]),
    ]
    for name, desc, p, mt, batch in cases:
        vector("members_pack_plan", name, desc, dict(publicTips=p, membersTips=mt, batch=batch),
               pack_plan(p, mt, batch))


# --- the publication guard (D21), over an abstract object graph --------------------------------------


class Graph:
    def __init__(self, objects, notes):
        self.o, self.notes = objects, notes

    def reach(self, tips, objects=False):
        seen, stack = set(), list(tips)
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            ob = self.o[x]
            t = ob["type"]
            if t == "commit":
                seen.add(x)
                stack.extend(ob.get("parents", []))
                if objects and ob.get("tree"):
                    stack.append(ob["tree"])
            elif objects:
                seen.add(x)
                if t == "tag":
                    stack.append(ob["target"])
                elif t == "tree":
                    stack.extend(ob.get("entries", []))
            elif t == "tag":
                stack.append(ob["target"])
        return seen

    def commits(self, include, exclude):
        return self.reach(include) - self.reach(exclude)

    def objects(self, include, exclude):
        return self.reach(include, True) - self.reach(exclude, True)

    def gitlinks(self, include, exclude):
        """The gitlinks (submodule entries, never walked into) the commits of `include ^exclude` introduce: an
        entry of the commit's tree that differs from at least one parent's at its path (every entry of a root
        commit), as `git log --raw -m` lists them."""
        out = set()
        for c in self.commits(include, exclude):
            ob = self.o[c]
            mine = self.o[ob["tree"]].get("gitlinks", {}) if ob.get("tree") else {}
            parents = [self.o[q].get("tree") for q in ob.get("parents", [])]
            theirs = [self.o[t].get("gitlinks", {}) if t else {} for t in parents]
            for path, target in mine.items():
                if not theirs or any(t.get(path) != target for t in theirs):
                    out.add((c, path, target))
        return out

    def patch_ids(self, commits):
        """`git patch-id --stable` of each commit that has one (a merge, or a commit changing nothing, has none)."""
        return {c: self.o[c]["patchId"] for c in commits if self.o[c].get("patchId")}

    def peel(self, x):
        tags = []
        while self.o[x]["type"] == "tag":
            tags.append(x)
            x = self.o[x]["target"]
        return tags, x, self.o[x]["type"]


NARROW_FIRST = "members"


def guard(inp):
    g = Graph(inp["objects"], inp.get("notes", {}))
    P = inp["publicTips"]
    ledger = inp["ledger"]
    dec = inp.get("decryptable")
    # a ledger this reader cannot read ("unknown") may hold what no key here opens, for this
    # repository or another dash remote of the clone: fail closed
    if ledger == "unknown" or (inp["membersKey"] and dec is None and ledger is None):
        return dict(verdict="unavailable", findings=[], notes=[], published=[])
    if ledger == "unknown":
        ledger = None
    notes = []
    if dec is None and ledger is not None and not ledger:
        notes.append("noKeyEmptyLedger")
    S = {}  # oid -> narrowest audience
    for e in ledger or []:
        a = e.get("audience", "members")
        S[e["oid"]] = a if S.get(e["oid"], "members") == "members" else S[e["oid"]]
    for x in dec or []:
        S.setdefault(x, "members")
    # what is already members-only (recorded or decryptable), before this batch adds its own tips
    established = [x for x, a in S.items() if a == "members"]
    for u in inp["batch"]:
        if u["audience"] == "members" and u.get("new"):
            S.setdefault(u["new"], "members")
    narrow = [x for x, a in S.items() if a != "members"]
    all_s = list(S)
    sealed_objects = g.objects(all_s, P) if all_s else set()
    sealed_commits = g.commits(all_s, P) if all_s else set()
    findings, published, gitlinks, remade = [], [], [], []
    by_patch = {}
    if inp.get("patchIds") and sealed_commits:
        for c, pid in sorted(g.patch_ids(sealed_commits).items()):
            by_patch.setdefault(pid, c)
    for u in inp["batch"]:
        T = u.get("new")
        if not T:
            continue
        found = []
        if u["audience"] == "members":
            if narrow:
                only_narrow = g.commits(narrow, P) - (g.commits(established, P) if established else set())
                leak = g.commits([T], P) & only_narrow
                if leak:
                    found.append(dict(dst=u["dst"], kind="commits", oids=sorted(leak)))
        else:
            tags, peeled, kind = g.peel(T)
            for t in tags:
                if t in sealed_objects:
                    found.append(dict(dst=u["dst"], kind="tag", oids=[t]))
            if kind == "commit":
                leak = g.commits([peeled], P) - g.commits([peeled], P + all_s)
                if leak:
                    found.append(dict(dst=u["dst"], kind="commits", oids=sorted(leak)))
                # a gitlink naming a members-only commit is allowed (it publishes an id, no content): noted
                gitlinks += [dict(dst=u["dst"], commit=c, path=p, target=t)
                             for c, p, t in sorted(g.gitlinks([peeled], P)) if t in sealed_commits]
                # opt-in: public commits carrying a members-only commit's changes under a new id
                if by_patch:
                    fresh = g.commits([peeled], P + all_s)
                    remade += [dict(dst=u["dst"], commit=c, like=by_patch[pid])
                               for c, pid in sorted(g.patch_ids(fresh).items()) if pid in by_patch]
            elif peeled in sealed_objects:
                found.append(dict(dst=u["dst"], kind="object", oids=[peeled]))
            if u["dst"].startswith("refs/notes/") and kind == "commit":
                named = sorted(x for x in g.notes.get(peeled, []) if x in sealed_objects or x in sealed_commits)
                if named:
                    found.append(dict(dst=u["dst"], kind="note", oids=named))
            if u["dst"].startswith("refs/replace/"):
                x = u["dst"][len("refs/replace/"):]
                if x in sealed_objects or x in sealed_commits:
                    found.append(dict(dst=u["dst"], kind="replace", oids=[x]))
        if found and inp.get("publishPrivate") == T:
            published.extend(found)
        else:
            findings.extend(found)
    out = dict(verdict="refuse" if findings else "pass", findings=findings, notes=notes, published=published)
    if gitlinks:
        out["gitlinks"] = gitlinks
    if remade:
        out["remade"] = remade
    return out


def guard_vectors():
    """A small public history with members-only branches shaped like S4's fixture."""
    o = lambda x: H(oid(x))
    objs = {}

    def commit(name, parents, tree=None, patch=None):
        objs[o(name)] = dict(type="commit", parents=[o(p) for p in parents], tree=o(tree) if tree else None)
        if patch:
            objs[o(name)]["patchId"] = H(sha256(patch.encode()))
        if tree and o(tree) not in objs:
            objs[o(tree)] = dict(type="tree", entries=[])

    def tree(name, entries, gitlinks=None):
        objs[o(name)] = dict(type="tree", entries=[o(e) for e in entries])
        if gitlinks:
            objs[o(name)]["gitlinks"] = {p: o(t) for p, t in gitlinks.items()}

    def blob(name):
        objs[o(name)] = dict(type="blob")

    blob("pub.txt")
    blob("secret.txt")
    tree("t-pub", ["pub.txt"])
    tree("t-sec", ["pub.txt", "secret.txt"])
    for i in range(1, 5):
        commit(f"main{i}", [f"main{i - 1}"] if i > 1 else [], "t-pub")
    commit("m1", ["main3"], "t-sec")
    commit("m2", ["m1"], "t-sec")
    commit("m3", ["m2"], "t-sec")
    commit("mpub", ["main2"], "t-pub")  # a members tip that is also public (P reaches it)
    commit("old1", ["m1"], "t-sec")  # force-pushed away: in the fold history only
    commit("merge-m", ["main4", "m3"], "t-sec")
    commit("squash", ["main4"], "t-sec2")
    blob("secret2.txt")
    tree("t-sec2", ["pub.txt", "secret2.txt"])
    commit("ff5", ["main4"], "t-pub")
    commit("on-mpub", ["mpub"], "t-pub")
    commit("narrow1", ["main3"], "t-pub")  # a narrower branch's commit (3F audience)
    commit("merge-narrow", ["m3", "narrow1"], "t-pub")
    commit("narrow2", ["m3"], "t-pub")  # a narrower branch built on the members-only m3
    objs[o("tag-m3")] = dict(type="tag", target=o("m3"))
    objs[o("tag-main4")] = dict(type="tag", target=o("main4"))
    objs[o("sealed-tag")] = dict(type="tag", target=o("main4"))  # a members-only annotated tag on a public commit
    # gitlinks (submodule entries): to a members-only commit, to a public one, and one kept unchanged
    tree("t-link-sec", ["pub.txt"], {"sub-fix": "m2"})
    tree("t-link-pub", ["pub.txt"], {"sub-lib": "main2"})
    tree("t-link-both", ["pub.txt"], {"sub-fix": "m2", "sub-lib": "main2"})
    commit("link-sec", ["main4"], "t-link-sec")
    commit("link-pub", ["main4"], "t-link-pub")
    commit("link-kept", ["link-sec"], "t-link-both")
    # a members-only fix (m1 adds secret.txt) re-made on main by a cherry-pick (the same change, so the same
    # patch id over real git), then an unrelated public change; commits whose tree equals their parent's have
    # no patch id
    objs[o("m1")]["patchId"] = H(sha256(b"adds secret.txt"))
    commit("picked", ["main4"], "t-sec", patch="adds secret.txt")
    blob("docs.txt")
    tree("t-docs", ["pub.txt", "secret.txt", "docs.txt"])
    commit("picked-other", ["picked"], "t-docs", patch="adds docs.txt")
    commit("notes-pub", [], "t-pub")
    commit("notes-sec", [], "t-pub")
    notes = {o("notes-pub"): [o("main3")], o("notes-sec"): [o("m2")]}
    P = [o("main4"), o("mpub")]
    m3, old1 = o("m3"), o("old1")
    base = dict(objects=objs, notes=notes, publicTips=P, membersKey=True)
    sealed_m = sorted([o("m1"), o("m2"), o("m3")])
    cases = [
        ("ff_public", "a fast-forward of public commits passes.", dict(ledger=[], decryptable=[m3],
         batch=[dict(dst="refs/heads/main", new=o("ff5"), audience="public")])),
        ("squash_passes", "a squash of a members-only branch has public parents only: it passes (its new tree is "
         "a publication the user chose).", dict(ledger=[], decryptable=[m3],
         batch=[dict(dst="refs/heads/main", new=o("squash"), audience="public")])),
        ("merge_refused", "a merge of the members-only branch into main names its three commits.",
         dict(ledger=[], decryptable=[m3], batch=[dict(dst="refs/heads/main", new=o("merge-m"), audience="public")])),
        ("ff_to_members_tip", "main fast-forwarded to the members-only tip.", dict(ledger=[], decryptable=[m3],
         batch=[dict(dst="refs/heads/main", new=m3, audience="public")])),
        ("already_public_tip", "a members tip already reachable from a public tip passes.",
         dict(ledger=[], decryptable=[o("mpub")], batch=[dict(dst="refs/heads/x", new=o("on-mpub"),
                                                                audience="public")])),
        ("stale_s_from_fold_history", "S holds every newOid the pusher decrypts, not only the current tips: a branch "
         "force-pushed away (old1) is still refused.", dict(ledger=[], decryptable=[m3, old1],
         batch=[dict(dst="refs/heads/x", new=old1, audience="public")])),
        ("ledger_without_key", "no key, a ledger: S is the ledger, still refused.",
         dict(ledger=[dict(oid=m3)], decryptable=None, batch=[dict(dst="refs/heads/main", new=o("merge-m"),
                                                                    audience="public")])),
        ("unavailable", "members-only content on, no key and no ledger: the guard cannot run (E806).",
         dict(ledger=None, decryptable=None, batch=[dict(dst="refs/heads/main", new=o("ff5"), audience="public")])),
        ("ledger_unknown", "a ledger of another version fails closed even with the key at hand (E806).",
         dict(ledger="unknown", decryptable=[m3],
              batch=[dict(dst="refs/heads/main", new=o("ff5"), audience="public")])),
        ("ledger_unknown_no_members_key", "an unreadable ledger fails closed even in a repository without members-only "
         "content: the ledger is the clone's, shared by every dash remote it pushes to.",
         dict(ledger="unknown", decryptable=None, membersKey=False,
              batch=[dict(dst="refs/heads/main", new=o("ff5"), audience="public")])),
        ("ledger_sealed_tag_no_key", "no key: a members-only tag object recorded in the ledger (the helper records every "
         "members-only ref's newOid, tag objects included) is refused though it peels to a public commit.",
         dict(ledger=[dict(oid=m3), dict(oid=o("sealed-tag"))], decryptable=None,
              batch=[dict(dst="refs/tags/sec", new=o("sealed-tag"), audience="public")])),
        ("ledger_duplicates_keep_narrowest", "an id recorded twice keeps its narrowest audience.",
         dict(ledger=[dict(oid=o("narrow1"), audience="branch:" + "ab" * 8), dict(oid=o("narrow1"))],
              decryptable=[m3], batch=[dict(dst="refs/heads/sec/fix", new=o("merge-narrow"), audience="members")])),
        ("narrow_shared_ancestor_passes", "a members-only commit a narrower branch builds on stays members-only: pushing "
         "it to a members-only branch is no narrowing.", dict(
             ledger=[dict(oid=o("narrow2"), audience="branch:" + "ab" * 8), dict(oid=m3)], decryptable=[m3],
             batch=[dict(dst="refs/heads/sec/other", new=m3, audience="members")])),
        ("empty_ledger_no_key", "an empty ledger and no key: the push passes with a note.",
         dict(ledger=[], decryptable=None, batch=[dict(dst="refs/heads/main", new=o("ff5"), audience="public")])),
        ("no_members_key", "a repository without members-only content and no ledger: nothing to check.",
         dict(ledger=None, decryptable=None, membersKey=False,
              batch=[dict(dst="refs/heads/main", new=o("ff5"), audience="public")])),
        ("lightweight_tag_on_members", "a lightweight tag on a members-only commit.",
         dict(ledger=[], decryptable=[m3], batch=[dict(dst="refs/tags/v9", new=m3, audience="public")])),
        ("annotated_tag_on_members", "an annotated tag on a members-only commit.",
         dict(ledger=[], decryptable=[m3, o("tag-m3")], batch=[dict(dst="refs/tags/v9", new=o("tag-m3"),
                                                                       audience="public")])),
        ("annotated_tag_on_public", "an annotated tag on a public commit passes.",
         dict(ledger=[], decryptable=[m3], batch=[dict(dst="refs/tags/v4", new=o("tag-main4"), audience="public")])),
        ("sealed_tag_object", "a members-only tag object re-pushed as public, though it peels to a public commit.",
         dict(ledger=[], decryptable=[m3, o("sealed-tag")], batch=[dict(dst="refs/tags/sec", new=o("sealed-tag"),
                                                                           audience="public")])),
        ("note_on_members", "a notes commit annotating a members-only commit.",
         dict(ledger=[], decryptable=[m3], batch=[dict(dst="refs/notes/commits", new=o("notes-sec"),
                                                         audience="public")])),
        ("note_on_public", "notes on public commits pass.",
         dict(ledger=[], decryptable=[m3], batch=[dict(dst="refs/notes/commits", new=o("notes-pub"),
                                                         audience="public")])),
        ("replace_named_sealed", "refs/replace/<X> where X is a members-only commit.",
         dict(ledger=[], decryptable=[m3], batch=[dict(dst="refs/replace/" + o("m2"), new=o("main4"),
                                                         audience="public")])),
        ("tree_target", "a tree as a ref target, reachable only from members-only commits.",
         dict(ledger=[], decryptable=[m3], batch=[dict(dst="refs/heads/tree", new=o("t-sec"), audience="public")])),
        ("blob_target_public", "a blob reachable from public history passes.",
         dict(ledger=[], decryptable=[m3], batch=[dict(dst="refs/heads/blob", new=o("pub.txt"), audience="public")])),
        ("delete_passes", "a delete publishes nothing.",
         dict(ledger=[], decryptable=[m3], batch=[dict(dst="refs/heads/main", new=None, audience="public")])),
        ("batch_new_members_tip_and_tag", "a batch adding a members-only branch and a public tag on its tip: the new "
         "members tip joins S first, so the tag is refused.",
         dict(ledger=[], decryptable=[], batch=[dict(dst="refs/heads/sec/new", new=m3, audience="members"),
                                                dict(dst="refs/tags/v9", new=m3, audience="public")])),
        ("publish_private_override", "-o publish-private=<oid> bound to the tip lets that ref through and lists what "
         "it publishes.", dict(ledger=[], decryptable=[m3], publishPrivate=o("merge-m"),
                               batch=[dict(dst="refs/heads/main", new=o("merge-m"), audience="public")])),
        ("override_other_tip", "an override for another commit does not apply.",
         dict(ledger=[], decryptable=[m3], publishPrivate=o("m2"),
              batch=[dict(dst="refs/heads/main", new=o("merge-m"), audience="public")])),
        ("narrow_into_members", "D21 rev 4: a members-only ref may not take a commit recorded with a narrower "
         "audience.", dict(ledger=[dict(oid=o("narrow1"), audience="branch:" + "ab" * 8)], decryptable=[m3],
                           batch=[dict(dst="refs/heads/sec/fix", new=o("merge-narrow"), audience="members")])),
        ("gitlink_to_members_noted", "a public commit whose tree has a gitlink (a submodule entry) naming a "
         "members-only commit passes: it publishes the commit's id, not its content (an oracle only), and the "
         "helper notes it.", dict(ledger=[], decryptable=[m3],
                                  batch=[dict(dst="refs/heads/main", new=o("link-sec"), audience="public")])),
        ("gitlink_to_public_passes", "a gitlink naming a public commit is not noted.",
         dict(ledger=[], decryptable=[m3], batch=[dict(dst="refs/heads/main", new=o("link-pub"), audience="public")])),
        ("gitlink_noted_once", "a gitlink is noted where a commit introduces it, not again in a later commit that "
         "keeps it unchanged.", dict(ledger=[], decryptable=[m3],
                                    batch=[dict(dst="refs/heads/main", new=o("link-kept"), audience="public")])),
        ("gitlink_ledger_without_key", "no key: the ledger's members-only commits are noted alike.",
         dict(ledger=[dict(oid=m3)], decryptable=None,
              batch=[dict(dst="refs/heads/main", new=o("link-sec"), audience="public")])),
        ("patch_id_off_by_default", "a members-only commit re-made on main with a new id (a cherry-pick): the "
         "guard does not see it, and without the opt-in nothing is said.", dict(ledger=[], decryptable=[m3],
         batch=[dict(dst="refs/heads/main", new=o("picked-other"), audience="public")])),
        ("patch_id_warns", "with the opt-in (git config dash.patchIdCheck true) the re-made commit is named beside the "
         "members-only commit with the same changes; the push still passes (a warning).", dict(
             ledger=[], decryptable=[m3], patchIds=True,
             batch=[dict(dst="refs/heads/main", new=o("picked-other"), audience="public")])),
        ("patch_id_no_match", "the opt-in with no re-made commit says nothing.", dict(
            ledger=[], decryptable=[m3], patchIds=True,
            batch=[dict(dst="refs/heads/main", new=o("ff5"), audience="public")])),
        ("members_into_members", "members-only commits into another members-only branch pass.",
         dict(ledger=[dict(oid=m3)], decryptable=[m3], batch=[dict(dst="refs/heads/sec/other", new=m3,
                                                                     audience="members")])),
    ]
    for name, desc, extra in cases:
        inp = dict(base, **extra)
        vector("publish_guard", name, desc, inp, guard(inp))
    assert guard(dict(base, **cases[2][2]))["findings"][0]["oids"] == sealed_m
    noted = {name: guard(dict(base, **extra)).get("gitlinks", []) for name, _, extra in cases}
    assert [g["path"] for g in noted["gitlink_to_members_noted"]] == ["sub-fix"]
    assert noted["gitlink_to_public_passes"] == [] and noted["gitlink_ledger_without_key"]
    assert [(g["commit"], g["path"]) for g in noted["gitlink_noted_once"]] == [(o("link-sec"), "sub-fix")]
    warned = {name: guard(dict(base, **extra)).get("remade", []) for name, _, extra in cases}
    assert warned["patch_id_warns"] == [dict(dst="refs/heads/main", commit=o("picked"), like=o("m1"))]
    assert warned["patch_id_off_by_default"] == [] and warned["patch_id_no_match"] == []


# --- the members-only object locator (kind 65) --------------------------------------------------------------

MI_MAGIC, MI_VERSION = b"DFML", 0x01


def locator(rows):
    """An objectLocator: fanout (256 cumulative u32 counts) ‖ rows sorted by (oid, packRef); a row is oid(20) ‖
    packRef(u16) ‖ offset(5) ‖ length(u32) ‖ span(u32) ‖ depth(u8)."""
    rows = sorted(rows)
    raw = [o + pr.to_bytes(2, "big") + off.to_bytes(5, "big") + ln.to_bytes(4, "big") + sp.to_bytes(4, "big")
           + bytes([d]) for o, pr, off, ln, sp, d in rows]
    fan, n = [], 0
    for b in range(256):
        n += sum(1 for r in raw if r[0] == b)
        fan.append(n.to_bytes(4, "big"))
    return b"".join(fan) + b"".join(raw)


def members_index(pack_hash, loc):
    return MI_MAGIC + bytes([MI_VERSION]) + pack_hash + loc


def parse_members_index(b):
    if len(b) < 37 or b[:4] != MI_MAGIC:
        return dict(error="malformed")
    if b[4] != MI_VERSION:
        return dict(skip=True)
    loc = b[37:]
    if len(loc) < 1024:
        return dict(error="malformed")
    count = int.from_bytes(loc[1020:1024], "big")
    if len(loc) != 1024 + 36 * count:
        return dict(error="malformed")
    rows = [loc[1024 + 36 * i:1024 + 36 * (i + 1)] for i in range(count)]
    if any(r[20:22] != b"\0\0" for r in rows):
        return dict(error="malformed")
    return dict(packHash=H(b[5:37]), objectCount=count)


def members_index_vectors():
    pack_hash = sha256(b"a members-only pack")
    rows = [(oid("blob"), 0, 12, 40, 40, 0), (oid("commit"), 0, 52, 160, 160, 0), (oid("tree"), 0, 212, 70, 282, 1)]
    loc = locator(rows)
    good = members_index(pack_hash, loc)
    vector("members_index", "encode", "The plaintext of a members-only pack's index: DFML, version 1, the kind-64 "
           "pack's packHash, then its objectLocator with every row at packRef 0 (sealed afterwards as DFPK 0x01 under "
           "the members key).", dict(op="encode", packHash=H(pack_hash), locator=H(loc)), dict(bytes=H(good)))
    vector("members_index", "encode_refused_other_pack_ref", "A row at another packRef: an index of one pack has "
           "none.", dict(op="encode", packHash=H(pack_hash), locator=H(locator(rows[:2] + [(oid("tree"), 1, 0, 9, 9,
                                                                                            0)]))),
           dict(error="malformed"))

    def pv(name, desc, b):
        vector("members_index", "parse_" + name, desc, dict(op="parse", bytes=H(b)), parse_members_index(b))

    pv("ok", "It names the pack it indexes and every row of it.", good)
    pv("empty_pack", "A pack of no objects has an index of no rows.", members_index(pack_hash, locator([])))
    pv("later_version", "A later layout is skipped (the browser indexes the pack itself), never fatal.",
       good[:4] + bytes([0x02]) + good[5:])
    pv("other_magic", "Not a members-only index.", b"DFMX" + good[4:])
    pv("short_header", "Shorter than its header.", good[:36])
    pv("bad_locator", "A locator whose fanout does not describe its rows.", good[:-1])
    pv("other_pack_ref", "A row at packRef 1.", members_index(pack_hash, locator(rows[:2] + [(oid("tree"), 1, 0, 9, 9,
                                                                                            0)])))
    assert parse_members_index(good) == dict(packHash=H(pack_hash), objectCount=3)


def write_vectors(out_dir):
    members_index_vectors()
    oid_blind_vectors()
    sealed_ref_vectors()
    sealed_patch_vectors()
    pack_plan_vectors()
    guard_vectors()
    for case in CASES:
        for old in glob.glob(os.path.join(out_dir, case + "__*.json")):
            os.remove(old)
    names = set()
    for v in VECTORS:
        fname = f"{v['case']}__{v['name']}.json"
        assert fname not in names, fname
        names.add(fname)
        with open(os.path.join(out_dir, fname), "w") as f:
            f.write(json.dumps(v, indent=2, ensure_ascii=False) + "\n")
    counts = {}
    for v in VECTORS:
        counts[v["case"]] = counts.get(v["case"], 0) + 1
    print(json.dumps(dict(total=len(VECTORS), **counts), indent=1))


def self_check():
    s = salt("a")
    assert blind(s, bytes(20)) != bytes(20)
    assert check(blind(s, oid("A")), oid("A"), s) == "ok"
    assert hashlib.sha256(BLIND_DOMAIN + s + oid("A")).digest()[:20] == blind(s, oid("A"))


if __name__ == "__main__":
    self_check()
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, "..", "..", "forge-contracts", "vectors")
    if "--write-vectors" in sys.argv:
        write_vectors(out_dir)
    else:
        members_index_vectors()
        oid_blind_vectors()
        sealed_ref_vectors()
        sealed_patch_vectors()
        pack_plan_vectors()
        guard_vectors()
        print(json.dumps({c: sum(v["case"] == c for v in VECTORS) for c in CASES}, indent=1))

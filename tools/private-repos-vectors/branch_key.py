"""Independent Python reference for narrower branches (mixed-visibility DESIGN §4.3 "Narrower branches (phase 3F)",
D34, D39; docs/security/private-repos.md §20).

    python3 tools/private-repos-vectors/branch_key.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/branch_key.py --write-vectors  # (re)write the vector files below

A narrower branch (Maintainers, Writers and maintainers, a group plus people, or people) has its own branch key in
generations g = 0, 1, …:

    K_br,g      = 32 random bytes
    PRK_br,g    = HKDF-Extract(salt = repoId, IKM = K_br,g)
    KCV_br,g    = HKDF-Expand(PRK_br,g, "dash-forge/v2/br-kcv" ‖ 0x00, 14)
    refNameHash = HMAC-SHA256(HKDF-Expand(PRK_br,g, "dash-forge/v2/br-ref" ‖ 0x00, 32), name)
    enc v0x06   = 0x06 ‖ KCV_br,g[0..4] ‖ nonce(12) ‖ COMMIT_obj(32) ‖ AES-256-GCM(K_doc,obj, nonce, TLV, AD') ‖ tag(16)
                  v0x03's framing with PRK_br,g for PRK_e and u32(g) for u32(e) in the K_obj info and the AD's
                  epoch field (the document's `epoch` is g); AD' = AD(enc[0] = 0x06) ‖ COMMIT_obj         (65 B)
    DFPK 0x03   = "DFPK" ‖ 0x03 ‖ L ‖ 00 00 ‖ KCV_br,g[0..4] ‖ u64(plaintextLen) ‖ fileId(16)              (36 B)
    K_pack      = HKDF-Expand(PRK_br,g, "dash-forge/v2/pack" ‖ 0x00 ‖ 0x03 ‖ fileId, 32)

Cases it writes (forge-contracts/vectors/branch_key__<name>.json), each with an `op`:

- `kdf`: KCV, the name hash.
- `seal`: a narrower branch's ref update (`refUpdate`/`protectedRefUpdate`, `refName` absent, the branch key's name
  hash, blinded OIDs as a members-only update's, TLV 3, 22, 23, 27, `epoch` = g).
- `open`: a reader holding branch keys (from `branchKey` letters) opens one; framing, key selection by KCV and
  generation, commitment, GCM, TLV, name hash, the branch's own name, and the late rule across generations.
- `packSeal` / `packOpen` / `sniff`: DFPK 0x03 artifacts.
- `fold`: the `branchKey` letters a reader opened, folded into its branch keyring (chains of generations).

Both harnesses run every file: forge-core `private::branch_key` and forge-web `lib/private/branch-key`.
"""
import glob
import hashlib
import hmac
import json
import os
import struct
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen  # noqa: E402
import env  # noqa: E402
import members_git  # noqa: E402
from gen import H, NONCE, FILE_ID, GRACE_BLOCKS, expand, ownerId, repoId, sha256, tlv, u32, u64  # noqa: E402
from members_git import blind, oid, ref_records, salt  # noqa: E402

V6 = 0x06
DFPK3 = 0x03
MIN_V6 = 1 + 4 + 12 + 32 + 16
CASE = "branch_key"
VECTORS = []
GROUPS = ("maintainers", "writers", "members")
MAX_RECIPIENTS = 64

KB0 = bytes(range(100, 132))  # generation 0
KB1 = bytes(range(140, 172))  # generation 1
KB2 = bytes(range(180, 212))  # generation 2
KX = bytes([0x5a]) * 32  # another branch's key
BRANCH = "refs/heads/sec/embargo"
P_A, P_B, P_C = (gen.b58(bytes([x]) * 32) for x in (0xa1, 0xb2, 0xc3))
assert P_A < P_B


def vector(name, description, inp, expected):
    VECTORS.append(dict(name=name, description=description, case=CASE, rules="v2", input=inp, expected=expected))


# --- keys ------------------------------------------------------------------------------------------


def prk(K):
    return hmac.new(repoId, K, hashlib.sha256).digest()


def kcv(K):
    return expand(prk(K), b"dash-forge/v2/br-kcv\x00", 14)


def ref_key(K):
    return expand(prk(K), b"dash-forge/v2/br-ref\x00")


def ref_hash(K, name):
    return hmac.new(ref_key(K), name.encode(), hashlib.sha256).digest()


def k_pack(K, file_id):
    return expand(prk(K), b"dash-forge/v2/pack\x00" + bytes([DFPK3]) + file_id)


def k_obj(K, g, nonce, A):
    return expand(prk(K), b"dash-forge/v2/obj\x00" + u32(g) + nonce + sha256(A))


# --- ref updates (enc v0x06) ------------------------------------------------------------------------


def seal_ref(name, new, prev, s, K=KB0, g=0, force=False, kind="refUpdate", nonce=NONCE, records=None,
             plain_new=None, hash_name=None, owner=ownerId):
    pn = plain_new if plain_new is not None else (new if members_git.is_null(new) else blind(s, new))
    pp = None if prev is None else (prev if members_git.is_null(prev) else blind(s, prev))
    doc = dict(type=kind, vis="public", ownerId=H(owner), epoch=g,
               refNameHash=H(ref_hash(K, hash_name or name)), newOid=H(pn), force=force)
    if pp is not None:
        doc["prevOid"] = H(pp)
    recs = tlv(*(records if records is not None else ref_records(name, new, prev, s)))
    A = gen.ad(doc, None, V6)
    ko = k_obj(K, g, nonce, A)
    kd, C = gen.obj_keys(ko)
    enc = bytes([V6]) + kcv(K)[:4] + nonce + C + AESGCM(kd).encrypt(nonce, recs, A + C)
    return doc, recs, A, enc


def open_ref(doc, enc, ring, height, groups):
    """The reference reader: `ring` = folded branches with their keys (see `ring_of`: the counted chain and the
    read-only keys), `groups` = who each group is now (hex ids), which resolves a branch's audience now."""
    if len(enc) < MIN_V6 or enc[0] != V6:
        return gen.MALFORMED
    g = doc["epoch"]
    cands = [(b, K, ro) for b in ring for (gg, K, ro) in b["keys"] if gg == g and kcv(K)[:4] == enc[1:5]]
    if not cands:
        return dict(status="unreadable", reason="noKey")
    nonce, C, ct = enc[5:17], enc[17:49], enc[49:]
    A = gen.ad(doc, None, V6)
    hit = None
    for b, K, ro in cands:
        kd, C2 = gen.obj_keys(k_obj(K, g, nonce, A))
        if C2 == C:
            hit = (b, K, ro, kd)
            break
    if hit is None:
        return dict(status="unreadable", reason="commitMismatch")
    b, K, ro, kd = hit
    try:
        pt = AESGCM(kd).decrypt(nonce, ct, A + C)
    except Exception:
        return dict(status="unreadable", reason="badTag")
    recs = parse_ref_tlv(pt)
    if recs is None:
        return gen.MALFORMED
    name = recs[3].decode()
    if bytes.fromhex(doc["refNameHash"]) != ref_hash(K, name) or name != b["name"]:
        return gen.MALFORMED
    real = real_values(doc, recs)
    if real is None:
        return gen.MALFORMED
    # the late rule across generations: written under g after generation g+1 was issued (plus the grace period)
    # by someone outside the branch's current audience. A read-only key (from a letter that does not count: its
    # sender is not in the audience now, or it forks the chain) is superseded by the first counted generation at
    # or after its own.
    issued = {int(k): v for k, v in b["issuedAt"].items()}
    later = [h for i, h in issued.items() if (i >= g if ro else i == g + 1)]
    nxt = min(later) if later else None
    audience = audience_now(b["group"], b["people"], groups)
    if nxt is not None and height > nxt + GRACE_BLOCKS and gen.b58(bytes.fromhex(doc["ownerId"])) not in audience:
        return dict(status="unreadable", reason="late")
    return dict(status="readable", ref=real[0], alerts=real[1], branch=name, gen=g)


def parse_ref_tlv(pt):
    """TLV of a ref update: tags 3 (once), 22, 23, 27, each at most once, nothing else."""
    out, i = {}, 0
    while i < len(pt):
        if i + 3 > len(pt):
            return None
        t, n = pt[i], struct.unpack(">H", pt[i + 1:i + 3])[0]
        v = pt[i + 3:i + 3 + n]
        if len(v) != n or t in out or t not in (3, 22, 23, 27):
            return None
        out[t] = v
        i += 3 + n
    if 3 not in out or not out[3]:
        return None
    for t in (22, 23):
        if t in out and len(out[t]) not in (20, 32):
            return None
    if 27 in out and len(out[27]) != 32:
        return None
    if (27 in out) != (22 in out or 23 in out):
        return None
    try:
        out[3].decode()
    except UnicodeDecodeError:
        return None
    return out


def real_values(doc, recs):
    s = recs.get(27)
    alerts = []

    def judge(field, plain, real):
        c = members_git.check(plain, real, s)
        if c == "malformed":
            return None
        if c not in ("ok", "null"):
            alerts.append(dict(field=field, kind=c))
        return real if real is not None else plain

    new = judge("newOid", bytes.fromhex(doc["newOid"]), recs.get(22))
    if new is None:
        return None
    prev = None
    if "prevOid" in doc:
        prev = judge("prevOid", bytes.fromhex(doc["prevOid"]), recs.get(23))
        if prev is None:
            return None
    elif 23 in recs:
        return None
    if 22 in recs and 23 in recs and len(recs[22]) != len(recs[23]):
        return None
    if members_git.is_null(new) and (prev is None or members_git.is_null(prev)):
        return None
    r = dict(name=recs[3].decode(), newOid=H(new))
    if prev is not None:
        r["prevOid"] = H(prev)
    return r, alerts


# --- packs (DFPK 0x03) ------------------------------------------------------------------------------


def pack_header(K, plen, file_id, L=14):
    return b"DFPK" + bytes([DFPK3, L]) + b"\x00\x00" + kcv(K)[:4] + u64(plen) + file_id


def seal_pack(K, plain, file_id=FILE_ID, L=14):
    S = 1 << L
    nseg = max(1, -(-len(plain) // S))
    h = pack_header(K, len(plain), file_id, L)
    kf = k_pack(K, file_id)
    out = bytearray(h)
    for i in range(nseg):
        n = u64(i) + b"\x00\x00\x00" + bytes([1 if i == nseg - 1 else 0])
        out += AESGCM(kf).encrypt(n, plain[i * S:(i + 1) * S], h)
    return bytes(out)


def open_pack(sealed, size, keys):
    if len(sealed) != size:
        return dict(error="sizeMismatch")
    if len(sealed) < 36 or sealed[:4] != b"DFPK" or sealed[4] != DFPK3 or sealed[6:8] != b"\x00\x00" \
            or not 10 <= sealed[5] <= 20:
        return dict(error="sealedPackCorrupt")
    plen = struct.unpack(">Q", sealed[12:20])[0]
    file_id = sealed[20:36]
    S = 1 << sealed[5]
    nseg = max(1, -(-plen // S))
    if 36 + plen + 16 * nseg != len(sealed):
        return dict(error="sealedPackCorrupt")
    cands = [K for K in keys if kcv(K)[:4] == sealed[8:12]]
    if not cands:
        return dict(error="noKey")
    for K in cands:
        kf, out, at, ok = k_pack(K, file_id), b"", 36, True
        for i in range(nseg):
            ln = min(S, plen - i * S) + 16
            try:
                out += AESGCM(kf).decrypt(u64(i) + b"\x00\x00\x00" + bytes([1 if i == nseg - 1 else 0]),
                                          sealed[at:at + ln], sealed[:36])
            except Exception:
                ok = False
                break
            at += ln
        if ok:
            return dict(plain=H(out))
    return dict(error="sealedPackCorrupt")


def sniff(head):
    if head[:min(4, len(head))] != b"DFPK"[:min(4, len(head))]:
        return dict(kind="plain")
    if len(head) < 5:
        return dict(kind="short")
    if head[4] == DFPK3:
        return dict(kind="branch", kcv=H(head[8:12])) if len(head) >= 12 else dict(kind="short")
    if head[4] == 1:
        return dict(kind="sealed", epoch=struct.unpack(">I", head[8:12])[0]) if len(head) >= 12 else dict(kind="short")
    return dict(kind="otherVersion", version=head[4])


# --- the branchKey letter and the reader's branch keyring --------------------------------------------


OWNER58 = gen.b58(ownerId)


def body(name=BRANCH, keys=(KB0,), group="maintainers", people=(), v=1, t="branchKey", to=None):
    """A `branchKey` body. `to` lists every recipient the writer sealed it to (the writer among them), ascending: what
    the next re-lettering compares with the audience as it is then."""
    return {"type": t, "v": v, "name": name, "gen": len(keys) - 1, "keys": [H(k) for k in keys], "group": group,
            "people": list(people), "to": sorted(to if to is not None else [OWNER58])}


def valid_body(b):
    """The checks of one `branchKey` body: `None` (not a branchKey v1 body: skipped) or the reason it is ignored,
    or the parsed tuple."""
    if not isinstance(b, dict) or b.get("type") != "branchKey" or b.get("v") != 1:
        return "skip", None
    keys = b.get("keys")
    name = b.get("name")
    ok = isinstance(name, str) and name.startswith("refs/heads/") and len(name) > len("refs/heads/") \
        and isinstance(keys, list) and 1 <= len(keys) <= 256 \
        and all(isinstance(k, str) and len(k) == 64 and all(c in "0123456789abcdef" for c in k) for k in keys) \
        and len(set(keys)) == len(keys) \
        and b.get("gen") == len(keys) - 1 and not isinstance(b.get("gen"), bool) \
        and (b.get("group") is None or b.get("group") in GROUPS) \
        and isinstance(b.get("people"), list) \
        and all(env.b58decode(p) is not None for p in b["people"]) \
        and b["people"] == sorted(set(b["people"])) and len(b["people"]) < MAX_RECIPIENTS \
        and (b.get("group") is not None or b["people"]) \
        and isinstance(b.get("to"), list) and 1 <= len(b["to"]) <= MAX_RECIPIENTS \
        and all(env.b58decode(p) is not None for p in b["to"]) and b["to"] == sorted(set(b["to"])) \
        and set(b) == {"type", "v", "name", "gen", "keys", "group", "people", "to"}
    if not ok:
        return "malformed", None
    return None, b


def audience_now(group, people, groups):
    """Who an audience is now: its group's people (`groups`: group -> base58 ids, the owner in each) and its
    people."""
    return set(groups.get(group, [])) | set(people) if group else set(people)


def fold(letters, groups):
    """Fold the letters a reader opened into branches. Letters are taken in (height, id) order; per name the first
    valid letter starts the chain, and a later one counts only when its keys agree with the chain on every
    generation both hold (it may extend it: a new generation, whose letter carries every earlier key). Each
    generation's `issuedAt` is the height of the first letter carrying it. The audience is the newest counted
    letter's at the highest generation; the holders of the current generation are the union of the `to` lists of the
    letters carrying it.

    A letter counts only when its sender is in the audience as it resolves now (`groups`): the first letter's own
    audience, a later one's the chain's so far. So a holder who leaves cannot keep the branch on a generation they
    made, and someone outside an audience cannot start a branch for it. The keys of letters that do not count are kept
    read-only (`readOnly`, by generation): they open what was written under them, under the late rule."""
    branches, ignored, uncounted = {}, [], []
    for L in sorted(letters, key=lambda x: (x["height"], x["id"])):
        why, b = valid_body(L["body"])
        if why == "skip":
            continue
        if why is not None:
            ignored.append(dict(id=L["id"], reason=why))
            continue
        cur = branches.get(b["name"])
        if cur is None:
            if L["sender"] not in audience_now(b["group"], b["people"], groups):
                ignored.append(dict(id=L["id"], reason="sender"))
                uncounted.append(b)
                continue
            branches[b["name"]] = dict(name=b["name"], keys=list(b["keys"]), group=b["group"],
                                       people=list(b["people"]), issuedAt={str(g): L["height"]
                                                                           for g in range(len(b["keys"]))},
                                       letters=[L["id"]], holders=list(b["to"]))
            continue
        common = min(len(cur["keys"]), len(b["keys"]))
        if cur["keys"][:common] != b["keys"][:common]:
            ignored.append(dict(id=L["id"], reason="otherChain"))
            uncounted.append(b)
            continue
        if L["sender"] not in audience_now(cur["group"], cur["people"], groups):
            ignored.append(dict(id=L["id"], reason="sender"))
            uncounted.append(b)
            continue
        for g in range(len(cur["keys"]), len(b["keys"])):
            cur["issuedAt"][str(g)] = L["height"]
        if len(b["keys"]) > len(cur["keys"]):
            cur["holders"] = list(b["to"])
        elif len(b["keys"]) == len(cur["keys"]):
            cur["holders"] = sorted(set(cur["holders"]) | set(b["to"]))
        if len(b["keys"]) >= len(cur["keys"]):
            cur["keys"] = list(b["keys"])
            cur["group"], cur["people"] = b["group"], list(b["people"])
        cur["letters"].append(L["id"])
    for b in branches.values():
        ro = []
        for u in uncounted:
            if u["name"] != b["name"]:
                continue
            for g, k in enumerate(u["keys"]):
                if (g >= len(b["keys"]) or b["keys"][g] != k) and (g, k) not in ro:
                    ro.append((g, k))
        b["readOnlyKeys"] = sorted(ro)
    out = [dict(b, kcvs=[H(kcv(bytes.fromhex(k))[:4]) for k in b["keys"]], gen=len(b["keys"]) - 1,
                readOnly=[dict(gen=g, kcv=H(kcv(bytes.fromhex(k))[:4])) for g, k in b["readOnlyKeys"]])
           for _, b in sorted(branches.items())]
    for b in out:
        del b["keys"]
        del b["readOnlyKeys"]
    return dict(branches=out, ignored=ignored)


def ring_of(letters, groups):
    """The keyring a reader holding `letters` uses, for the open vectors: per branch every (generation, key,
    read-only) and the fold's facts."""
    f = fold(letters, groups)
    by_kcv = {}
    for L in letters:
        for k in L["body"].get("keys", []):
            if isinstance(k, str) and len(k) == 64:
                by_kcv[(L["body"].get("name"), H(kcv(bytes.fromhex(k))[:4]))] = bytes.fromhex(k)
    out = []
    for b in f["branches"]:
        keys = [(g, by_kcv[(b["name"], c)], False) for g, c in enumerate(b["kcvs"])]
        keys += [(r["gen"], by_kcv[(b["name"], r["kcv"])], True) for r in b["readOnly"]]
        out.append(dict(b, keys=keys))
    return out


# --- vectors ----------------------------------------------------------------------------------------


def kdf_vectors():
    for label, K in (("gen0", KB0), ("gen1", KB1)):
        vector("kdf_" + label, "KCV_br,g and the branch key's name hash (no generation in their HKDF info: a "
               "generation is a fresh random key).", dict(op="kdf", repoId=H(repoId), key=H(K), names=[BRANCH,
                                                                                                  "refs/heads/main"]),
               dict(kcv=H(kcv(K)), prk=H(prk(K)), refKey=H(ref_key(K)),
                    refNameHashes=[H(ref_hash(K, BRANCH)), H(ref_hash(K, "refs/heads/main"))]))
    # domain separation from the members key: the same 32 bytes as an epoch key derive other values
    assert ref_key(KB0) != gen.k_ref(KB0, 0) and kcv(KB0) != gen.kcv(KB0, 0)


LET0 = dict(id="aa" * 32, height=100, sender=OWNER58, body=body())
LET1 = dict(id="bb" * 32, height=300, sender=OWNER58, body=body(keys=(KB0, KB1)))
GROUPS = {"maintainers": [OWNER58], "writers": [OWNER58], "members": [OWNER58]}


def ctx_of(letters, groups=None):
    return dict(letters=letters, groups=groups or GROUPS)


def seal_open_vectors():
    A_, B_, C_ = (oid(x) for x in "ABC")
    s1, s2 = salt("b1"), salt("b2")
    seals = [
        ("create", BRANCH, A_, None, s1, {}, "a new Maintainers branch: generation 0, prevOid absent, newOid the "
         "blind of A, TLV 3, 22 and 27; `epoch` is the generation."),
        ("update", BRANCH, B_, A_, s2, {}, "a fast-forward under generation 0."),
        ("delete", BRANCH, bytes(20), B_, s1, {}, "a delete: newOid stays all-zero in plaintext."),
        ("protected", BRANCH, A_, None, s1, dict(kind="protectedRefUpdate"), "a protectedRefUpdate seals the same "
         "way."),
        ("gen1", BRANCH, C_, B_, s2, dict(K=KB1, g=1, force=True), "generation 1 after the audience shrank: its "
         "own name hash and KCV; a force push."),
        ("sha256_width", BRANCH, oid("A", 32), None, s1, {}, "a SHA-256 repository: 32-byte blinds."),
    ]
    outs = {}
    for name, ref, new, prev, s, kw, desc in seals:
        K, g = kw.get("K", KB0), kw.get("g", 0)
        kind, force = kw.get("kind", "refUpdate"), kw.get("force", False)
        doc, recs, A, enc = seal_ref(ref, new, prev, s, K=K, g=g, force=force, kind=kind)
        assert len(enc) == MIN_V6 + len(recs)
        outs[name] = (doc, enc, ref, new, prev)
        inp = dict(op="seal", repoId=H(repoId), key=H(K), gen=g, type=kind, ownerId=H(ownerId), refName=ref,
                   newOid=H(new), force=force, salt=H(s), nonce=H(NONCE))
        if prev is not None:
            inp["prevOid"] = H(prev)
        doc_out = {k: v for k, v in doc.items() if k not in ("type", "ownerId", "vis")}
        vector("seal_" + name, desc, inp, dict(doc=doc_out, tlv=H(recs), ad=H(A), enc=H(enc)))
    vector("seal_refused_null_create", "a create that is also a delete names nothing: refused.",
           dict(op="seal", repoId=H(repoId), key=H(KB0), gen=0, type="refUpdate", ownerId=H(ownerId), refName=BRANCH,
                newOid=H(bytes(20)), force=False, salt=H(s1), nonce=H(NONCE)), dict(error="malformed"))
    vector("seal_refused_tag", "a narrower branch is a branch: a tag ref is refused.",
           dict(op="seal", repoId=H(repoId), key=H(KB0), gen=0, type="refUpdate", ownerId=H(ownerId),
                refName="refs/tags/v1", newOid=H(A_), force=False, salt=H(s1), nonce=H(NONCE)),
           dict(error="malformed"))

    letters = [LET0, LET1]

    def ov(name, desc, doc, enc, letters=letters, height=150, groups=None, expected=None):
        groups = groups or GROUPS
        got = open_ref(doc, enc, ring_of(letters, groups), height, groups)
        if expected is not None:
            assert got == expected, (name, got, expected)
        d = dict(doc, enc=H(enc), createdAtBlockHeight=height)
        vector("open_" + name, desc, dict(op="open", repoId=H(repoId), context=ctx_of(letters, groups), doc=d), got)

    for name in ("create", "update", "delete", "protected", "sha256_width"):
        doc, enc, ref, new, prev = outs[name]
        ov(name, f"a holder of the branch key opens the {name} vector: real values, each blind checked.", doc, enc)
    doc, enc = outs["gen1"][:2]
    ov("gen1", "generation 1 opens with K_br,1 (its letter carries K_br,0 and K_br,1).", doc, enc, height=320)
    doc, enc = outs["update"][:2]
    ov("not_in_audience", "a member without the branch key (no letter): a branch they don't have access to.", doc,
       enc, letters=[], expected=dict(status="unreadable", reason="noKey"))
    ov("removed_reader_gen1", "a reader removed at generation 1 holds generation 0 only: generation 1's updates do "
       "not open.", outs["gen1"][0], outs["gen1"][1], letters=[LET0], height=320,
       expected=dict(status="unreadable", reason="noKey"))
    ov("old_gen_still_opens", "a holder of generation 1 still opens generation 0's history.", doc, enc,
       letters=[LET1])
    other = dict(id="cc" * 32, height=90, sender=OWNER58, body=body(name="refs/heads/sec/other", keys=(KX,)))
    ov("other_branch_key", "another branch's key: its KCV does not match, so nothing is tried.", doc, enc,
       letters=[other], expected=dict(status="unreadable", reason="noKey"))
    # a late write under generation 0 after generation 1 was issued, by someone outside the audience
    late_owner = bytes([0x66]) * 32
    ldoc, _, _, lenc = seal_ref(BRANCH, B_, A_, s2, owner=late_owner)
    ov("late_removed_writer", "written under generation 0 after generation 1 was issued plus the grace period, by "
       "someone no longer in the branch's audience (a removed recipient keeps the old key): late, never folded.",
       ldoc, lenc, height=300 + GRACE_BLOCKS + 1, expected=dict(status="unreadable", reason="late"))
    ov("late_within_grace", "the same write within the grace period still opens (a push racing the new "
       "generation).", ldoc, lenc, height=300 + GRACE_BLOCKS)
    late58 = gen.b58(late_owner)
    ov("late_audience_member", "a current member of the audience writing under the old generation late is not "
       "late (their client had not caught up).", ldoc, lenc, height=300 + GRACE_BLOCKS + 1,
       groups=dict(GROUPS, maintainers=[OWNER58, late58]))
    # a holder (W) who made generation 1 before being removed: their letter no longer counts, the owner's
    # generation 1 does, and W's key is read-only (it still opens what audience members wrote under it in time)
    w58 = gen.b58(late_owner)
    w_letter = dict(id="dd" * 32, height=200, sender=w58, body=body(keys=(KB0, KX), to=[OWNER58, w58]))
    o_letter = dict(id="ee" * 32, height=300, sender=OWNER58, body=body(keys=(KB0, KB1)))
    kx_doc, _, _, kx_enc = seal_ref(BRANCH, C_, B_, s2, K=KX, g=1, owner=late_owner)
    ov("read_only_by_leaver_late", "a removed holder made generation 1 (a key only they chose) before they were "
       "removed; after the owner's generation 1 was issued and the grace period, their own update under it is late: "
       "a leaver can't keep moving the branch with a key they made.", kx_doc, kx_enc,
       letters=[LET0, w_letter, o_letter], height=300 + GRACE_BLOCKS + 1,
       expected=dict(status="unreadable", reason="late"))
    ov("read_only_in_time", "the same update written before the owner's generation 1 still opens (read-only key).",
       kx_doc, kx_enc, letters=[LET0, w_letter, o_letter], height=250)
    kx_doc2, _, _, kx_enc2 = seal_ref(BRANCH, C_, B_, s2, K=KX, g=1)
    ov("read_only_by_audience_member", "an audience member's update under the leaver's generation opens at any "
       "time: legit work pushed under it is never lost.", kx_doc2, kx_enc2, letters=[LET0, w_letter, o_letter],
       height=900)
    # tampering and malformed
    bad = bytearray(enc)
    bad[20] ^= 1
    ov("commit_mismatch", "a flipped COMMIT_obj: CommitMismatch before GCM.", doc, bytes(bad),
       expected=dict(status="unreadable", reason="commitMismatch"))
    bad = bytearray(enc)
    bad[-1] ^= 1
    ov("bad_tag", "a flipped tag: BadTag.", doc, bytes(bad), expected=dict(status="unreadable", reason="badTag"))
    wrong_gen = dict(doc, epoch=1)
    ov("wrong_generation_field", "the document's epoch names generation 1 while the KCV is generation 0's: no key of "
       "that generation matches.", wrong_gen, enc, expected=dict(status="unreadable", reason="noKey"))
    ov("short", "shorter than the 65-byte framing: malformed.", doc, enc[:MIN_V6 - 1], expected=gen.MALFORMED)
    # the name inside enc is another branch's, with a matching name hash: a branch key opens only its branch
    s3 = salt("b3")
    odoc, _, _, oenc = seal_ref("refs/heads/sec/other", B_, A_, s3)
    ov("other_name_inside", "the key opens, the name hash matches the name inside, but that name is not the branch "
       "this key was given for: malformed (a branch key opens only its own branch).", odoc, oenc,
       expected=gen.MALFORMED)
    hdoc, _, _, henc = seal_ref(BRANCH, B_, A_, s3, hash_name="refs/heads/sec/other")
    ov("name_hash_mismatch", "refNameHash is the branch key's hash of another name than TLV 3's: malformed.", hdoc,
       henc, expected=gen.MALFORMED)
    tdoc, _, _, tenc = seal_ref(BRANCH, B_, A_, s3, records=[(3, BRANCH.encode()), (22, B_), (23, A_), (24, B_),
                                                              (27, s3)])
    ov("head_tag_in_ref", "tag 24 is not a ref update's: malformed.", tdoc, tenc, expected=gen.MALFORMED)
    bdoc, _, _, benc = seal_ref(BRANCH, B_, A_, s3, plain_new=blind(salt("zz"), B_))
    ov("blind_mismatch", "a plaintext newOid that is not the blind of TLV 22: kept on its real values, with an "
       "alert.", bdoc, benc)


def pack_vectors():
    small = gen.mod251(100)
    multi = gen.mod251(2500)
    s_small = seal_pack(KB0, small, L=10)
    s_multi = seal_pack(KB1, multi, L=10)
    vector("pack_seal_small", "a one-segment DFPK 0x03 artifact under generation 0 (L = 10).",
           dict(op="packSeal", repoId=H(repoId), key=H(KB0), plain=H(small), fileId=H(FILE_ID), segLog2=10),
           dict(header=H(s_small[:36]), sealed=H(s_small), sha256=H(sha256(s_small))))
    vector("pack_seal_multi", "three segments under generation 1: the final flag on the last nonce only.",
           dict(op="packSeal", repoId=H(repoId), key=H(KB1), plain=H(multi), fileId=H(FILE_ID), segLog2=10),
           dict(header=H(s_multi[:36]), sha256=H(sha256(s_multi))))
    keys = [H(KB0), H(KB1)]

    def po(name, desc, sealed, keys=keys, size=None):
        size = len(sealed) if size is None else size
        got = open_pack(sealed, size, [bytes.fromhex(k) for k in keys])
        vector("pack_open_" + name, desc, dict(op="packOpen", repoId=H(repoId), keys=keys, sealed=H(sealed),
                                               sizeBytes=size), got)

    po("small", "opened with the generation the KCV names.", s_small)
    po("multi", "every segment's tag checked.", s_multi)
    po("no_key", "a reader without the branch key: skipped (no key), never read as corrupt.", s_small, keys=[H(KX)])
    bad = bytearray(s_multi)
    bad[600] ^= 1
    po("tampered", "a flipped byte in a segment: corrupt.", bytes(bad))
    po("size_mismatch", "the manifest's sizeBytes is checked first.", s_small, size=len(s_small) + 1)
    trunc = s_multi[:-16]
    po("truncated", "a dropped final segment's tag: the length check refuses it.", trunc)
    for name, head, desc in (
        ("branch", s_small[:12], "DFPK 0x03: a branch-key artifact, its KCV prefix."),
        ("members", gen.header(3, 10, FILE_ID)[:12], "DFPK 0x01: the members key, its epoch."),
        ("letter", b"DFPK\x02\x0e\x00\x00\x01\x00\x00\x00", "DFPK 0x02: another layout (a letter)."),
        ("plain", b"PACK\x00\x00\x00\x02", "a git pack."),
        ("short", b"DFPK", "four bytes: too short to tell."),
    ):
        vector("sniff_" + name, desc, dict(op="sniff", head=H(head)), sniff(head))


def fold_vectors():
    def fv(name, desc, letters, groups=None):
        groups = groups or GROUPS
        vector("fold_" + name, desc, dict(op="fold", repoId=H(repoId), letters=letters, groups=groups),
               fold(letters, groups))

    fv("one", "one letter: a Maintainers branch at generation 0.", [LET0])
    fv("grow_then_shrink", "generation 0, then a joiner's letter of generation 0 (the audience grew: no new "
       "generation; the holders gain the joiner), then generation 1 (it shrank: its `to` alone holds it), which carries "
       "K_br,0 too.",
       [dict(LET0, body=body(to=[OWNER58, P_A, P_B])),
        dict(id="ab" * 32, height=200, sender=OWNER58, body=body(group="writers", to=[OWNER58, P_C])),
        dict(LET1, body=body(keys=(KB0, KB1), to=[OWNER58, P_A]))])
    fv("joiner_gets_history", "a joiner after generation 1 receives one letter with both keys: it reads the whole "
       "history; generation 0's issuedAt is that letter's height for them.", [LET1])
    fv("other_chain_ignored", "a later letter for the same name whose generation 0 is another key: ignored (the "
       "first chain stands; a writer outside the audience cannot redirect the branch).",
       [LET0, dict(id="cd" * 32, height=400, sender=OWNER58, body=body(keys=(KX, KB1)))])
    fv("not_branch_key", "another letter type (a branch share, a read letter) and a later version are skipped.",
       [LET0, dict(id="de" * 32, height=110, sender=OWNER58, body=dict(type="branch", v=1)),
        dict(id="ef" * 32, height=120, sender=OWNER58, body=dict(body(), v=2))])
    bad = [
        ("gen_mismatch", dict(body(), gen=3)),
        ("tag_ref", body(name="refs/tags/v1")),
        ("unknown_group", dict(body(), group="triage")),
        ("repeated_key", body(keys=(KB0, KB0))),
        ("no_audience", body(group=None, people=())),
        ("people_unsorted", body(people=(P_B, P_A))),
        ("people_hex", body(people=("aa" * 32,))),
        ("extra_field", dict(body(), note="x")),
        ("to_empty", body(to=())),
        ("to_unsorted", dict(body(), to=[P_B, P_A])),
    ]
    fv("malformed_ignored", "letters whose body breaks a rule are ignored with a reason, never fatal: " +
       ", ".join(n for n, _ in bad) + ".",
       [dict(id=f"{i + 1:02x}" * 32, height=100 + i, sender=OWNER58, body=b) for i, (n, b) in enumerate(bad)])
    fv("people_and_group", "a group plus people (Writers and maintainers + one person).",
       [dict(id="aa" * 32, height=100, sender=OWNER58, body=body(group="writers", people=(P_C,)))])
    fv("two_branches", "letters of two branches fold separately.",
       [LET0, dict(id="cc" * 32, height=90, sender=OWNER58, body=body(name="refs/heads/sec/other", keys=(KX,),
                                                                          group=None,
                                                                          people=tuple(sorted((P_A, OWNER58)))))])
    fv("sender_outside_audience", "a writer outside Maintainers starts a Maintainers branch of a name before the "
       "maintainers do: its sender is not in its own audience, so it is ignored (no front-running a name).",
       [dict(id="ca" * 32, height=90, sender=P_C, body=body(to=[OWNER58, P_C]))])
    fv("leaver_extension_dropped", "a holder made generation 1 (a key only they chose) and was then removed: their "
       "letter no longer counts, the owner's generation 1 does, and the leaver's key is kept read-only.",
       [LET0, dict(id="cb" * 32, height=200, sender=P_A, body=body(keys=(KB0, KX), to=[OWNER58, P_A])),
        dict(id="cc" * 32, height=300, sender=OWNER58, body=body(keys=(KB0, KB1)))])
    fv("leaver_fill_dropped", "a holder who added three generations before leaving cannot fill the branch: after "
       "they leave, the owner's next generation counts.",
       [LET0, dict(id="cb" * 32, height=200, sender=P_A, body=body(keys=(KB0, KX, KB2, bytes([0x31]) * 32),
                                                                     to=[OWNER58, P_A])),
        dict(id="cc" * 32, height=300, sender=OWNER58, body=body(keys=(KB0, KB1)))])
    fv("member_fork_first_wins", "two audience members each start generation 1: the first counts, the other is a "
       "fork, kept read-only.",
       [LET0, dict(id="cb" * 32, height=200, sender=P_A, body=body(keys=(KB0, KX), to=[OWNER58, P_A])),
        dict(id="cc" * 32, height=300, sender=OWNER58, body=body(keys=(KB0, KB1)))],
       groups=dict(GROUPS, maintainers=sorted([OWNER58, P_A])))


def write_vectors(out_dir):
    kdf_vectors()
    seal_open_vectors()
    pack_vectors()
    fold_vectors()
    for old in glob.glob(os.path.join(out_dir, CASE + "__*.json")):
        os.remove(old)
    names = set()
    for v in VECTORS:
        fname = f"{v['case']}__{v['name']}.json"
        assert fname not in names, fname
        names.add(fname)
        with open(os.path.join(out_dir, fname), "w") as f:
            f.write(json.dumps(v, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(dict(total=len(VECTORS)), indent=1))


def self_check():
    doc, recs, A, enc = seal_ref(BRANCH, oid("A"), None, salt("x"))
    assert enc[0] == V6 and len(enc) == MIN_V6 + len(recs)
    r = open_ref(doc, enc, ring_of([LET0], GROUPS), 150, GROUPS)
    assert r["status"] == "readable", r
    s = seal_pack(KB0, b"hello")
    assert open_pack(s, len(s), [KB0]) == dict(plain=H(b"hello"))


if __name__ == "__main__":
    self_check()
    if "--write-vectors" in sys.argv:
        here = os.path.dirname(os.path.abspath(__file__))
        write_vectors(os.path.join(here, "..", "..", "forge-contracts", "vectors"))
    else:
        kdf_vectors()
        seal_open_vectors()
        pack_vectors()
        fold_vectors()
        print(len(VECTORS), "vectors")

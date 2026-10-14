"""Independent Python reference for a bot's members-only posts (enc v0x05; mixed-visibility design §4.9 "Envelope
v0x05", docs/security/private-repos.md §23) and the `postKey` key letter.

    python3 tools/private-repos-vectors/bot_post.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/bot_post.py --write-vectors  # (re)write forge-contracts/vectors/bot_post__*.json

    W_{e,b}  = HKDF-Expand(PRK_e, "dash-forge/v2/bot-post" || 0x00 || u32(e) || botId(32), 32)
    PRK_b    = HKDF-Extract(salt = repoId, IKM = W_{e,b})
    K_obj    = HKDF-Expand(PRK_b, "dash-forge/v2/obj" || 0x00 || u32(e) || nonce || SHA-256(AD), 32)
    enc      = 0x05 || nonce(12) || COMMIT_obj(32) || AES-256-GCM(K_doc,obj, nonce, TLV, AD || COMMIT_obj) || tag(16)

PRK_obj, K_doc,obj, COMMIT_obj, the TLV and its padding are v0x03's (gen.py); the AD is v0x03's with version 0x05.
A reader opens a v0x05 document only when its $ownerId holds a Bot row of the repository now (`bots` in the
context), deriving W from the epoch key and that $ownerId; the AD binds the owner, so one bot's key opens and mints
nothing of another's.

Every vector has case `bot_post` and an `input.op`: `postKey` (W of a bot and epoch), `seal` (a bot's post under its
W), `open` (the reading layer: framing, epoch, key, Bot row, commitment, GCM, TLV, late rule), `openWithPostKey` (the
bot reading with W alone), `objKey` (K_obj a bundle or read letter shares, and opening the post with it alone),
`letter` (a postKey letter's padded plaintext) and `letterDecode` (what a reader takes). The Rust harness
(`forge_core::private::bot_post`) and the TypeScript harness (`forge-web/lib/private/bot-post`) run every file and
must reproduce it exactly.
"""
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen  # noqa: E402  (the crypto helpers; importing runs no generator)
from gen import (  # noqa: E402
    AESGCM, CTX0, GRACE_BLOCKS, H, K0, K1, MALFORMED, MAX_ENC, MIN_V3, NONCE, ad, cid, ctx, expand, info, members_tlv,
    obj_keys, prk, readable, rec, repoId, seal_members, sha256, subkey, tlv, unreadable,
)
import key_letters  # noqa: E402

CASE = "bot_post"
V3, V5 = 0x03, 0x05
BOT = bytes([0xb0]) * 32
BOT2 = bytes([0xb1]) * 32
HUMAN = bytes([0x22]) * 32
VECTORS = []


def vector(name, description, inp, expected):
    VECTORS.append(dict(name=name, description=description, case=CASE, rules="v2", input=inp, expected=expected))


def post_key(K, e, bot):
    """W_{e,b} under the epoch key K."""
    return subkey(K, b"bot-post", e, bot)


def k_obj_bot(W, e, nonce, A):
    """K_obj = HKDF-Expand(PRK_b, "dash-forge/v2/obj" || 0x00 || u32(e) || nonce || SHA-256(AD), 32)."""
    return expand(prk(W), info(b"obj", e, nonce + sha256(A)))


def seal_bot(doc, W, records, nonce=NONCE, pt=None):
    """(AD, K_obj, COMMIT_obj, TLV, enc) of a bot's post under its post key W."""
    A = ad(doc, None, V5)
    pt = members_tlv(doc["type"], records) if pt is None else pt
    ko = k_obj_bot(W, doc["epoch"], nonce, A)
    kd, C = obj_keys(ko)
    return A, ko, C, pt, bytes([V5]) + nonce + C + AESGCM(kd).encrypt(nonce, pt, A + C)


def open_bot(doc, W, enc):
    A = ad(doc, None, V5)
    nonce, C, ct = enc[1:13], enc[13:45], enc[45:]
    kd, C2 = obj_keys(k_obj_bot(W, doc["epoch"], nonce, A))
    if C2 != C:
        return "commitMismatch"
    try:
        return AESGCM(kd).decrypt(nonce, ct, A + C)
    except Exception:
        return "badTag"


def bot_ctx(base, bots=(BOT,)):
    return dict(base, bots=[H(b) for b in bots])


def doc(kind="comment", owner=BOT, epoch=0, vis="public"):
    d = dict(type=kind, vis=vis, ownerId=H(owner), epoch=epoch)
    if vis is None:
        del d["vis"]
    if kind == "comment":
        d["targetId"] = "33" * 32
    elif kind == "issue":
        d["number"] = 7
    elif kind == "review":
        d["patchId"] = "44" * 32
    elif kind == "event":
        d["targetId"] = "33" * 32
    elif kind == "patch":
        d["number"] = 8
    return d


BODY = "CI: 3 of 412 tests failed on fix-auth (members-only log)."
BODY_TLV = tlv((2, BODY.encode()))
W0 = post_key(K0, 0, BOT)


def post_key_vectors():
    for name, K, e, bot, desc in [
        ("w_epoch0", K0, 0, BOT, "W_{0,b}: HKDF-Expand(PRK_0, \"dash-forge/v2/bot-post\" || 0x00 || u32(0) || botId)."),
        ("w_other_bot", K0, 0, BOT2, "another bot's post key under the same epoch differs: each bot gets its own."),
        ("w_epoch1", K1, 1, BOT, "the same bot under epoch 1 (a rotation): a fresh post key."),
    ]:
        vector(f"post_key__{name}", desc, dict(op="postKey", repoId=H(repoId), key=H(K), epoch=e, bot=H(bot)),
               dict(w=H(post_key(K, e, bot))))
    assert post_key(K0, 0, BOT) != post_key(K0, 0, BOT2) != post_key(K1, 1, BOT)


def seal_vectors():
    def s(name, desc, d, fields, records, W=W0):
        A, ko, C, pt, e = seal_bot(d, W, records)
        assert open_bot(d, W, e) == pt
        vector(f"seal__{name}", desc, dict(op="seal", repoId=H(repoId), w=H(W), bot=d["ownerId"], doc=d,
                                           fields=fields, nonce=H(NONCE)),
               dict(ad=H(A), kObj=H(ko), commit=H(C), tlv=H(pt), enc=H(e)))
        return e

    s("comment", "a bot's members-only comment: K_obj from PRK_b (W's extract), the nonce and SHA-256(AD v0x05); "
      "the TLV padded to 64 bytes as v0x03.", doc(), {"body": BODY}, BODY_TLV)
    s("issue", "a bot's members-only issue: title and body, padded.", doc("issue"),
      {"title": "Nightly failed", "body": BODY}, tlv((1, b"Nightly failed"), (2, BODY.encode())))
    s("review", "a bot's members-only review body; its verdict stays plaintext (a bot's counts for nothing).",
      doc("review"), {"body": "Suggested fix in src/auth.rs"}, tlv((2, b"Suggested fix in src/auth.rs")))
    s("private_repo", "a bot's post in a private-only repository (vis absent: private): the same envelope; the AD "
      "does not bind vis.", doc(vis=None), {"body": BODY}, BODY_TLV)
    room = MAX_ENC["comment"] - MIN_V3 - 3
    long = "x" * room
    e = s("at_room", "a comment body at the v0x05 room (5,120 - 61 - 3 bytes): no room for the padding record, so the "
          "enc is exactly 5,120 bytes.", doc(), {"body": long}, tlv((2, long.encode())))
    assert len(e) == 5120
    for name, d, fields, err, desc in [
        ("other_bot_refused", doc(owner=BOT2), {"body": BODY}, "malformed",
         "a post key seals only its own bot's documents: another $ownerId is refused before sealing."),
        ("other_epoch_refused", doc(epoch=1), {"body": BODY}, "malformed",
         "W_{0,b} seals only epoch 0: a document under epoch 1 is refused."),
        ("patch_refused", doc("patch"), {"title": "t"}, "malformed",
         "a bot posts issues, comments and reviews members-only, never a pull request (its branch names are keyed by "
         "the epoch, which a bot never holds)."),
        ("event_refused", doc("event"), {"eventValue": "bug"}, "malformed", "nor an event."),
        ("over_room", doc(), {"body": "b" * (room + 1)}, "tooLarge", "one byte over the room does not fit."),
        ("tag_not_for_kind", doc(), {"body": "x", "title": "t"}, "malformed", "title is not a comment field."),
    ]:
        vector(f"seal__{name}", desc, dict(op="seal", repoId=H(repoId), w=H(W0), bot=H(BOT), doc=d, fields=fields,
                                           nonce=H(NONCE)), dict(error=err))


def open_vectors():
    def o(name, desc, d, context, expected, enc, height=50):
        dd = dict(d, enc=H(enc))
        if height is not None:
            dd.setdefault("createdAtBlockHeight", height)
        vector(f"open__{name}", desc, dict(op="open", repoId=H(repoId), context=context, doc=dd), expected)

    D = doc()
    _, ko, C, pt, enc = seal_bot(D, W0, BODY_TLV)
    o("member", "a member holding K_0 derives W_{0,b} from the post's $ownerId, a Bot row of this repository, and "
      "opens it.", D, bot_ctx(CTX0), readable({"body": BODY}), enc)
    o("outsider_placeholder", "an outsider holds no key: Unreadable(NoKey), shown as a members-only placeholder.", D,
      bot_ctx(ctx({}, {0: ("c0", 10)})), unreadable("noKey"), enc)
    o("no_lane", "no epoch 0 anchored: Unreadable(NoEpoch).", D, bot_ctx(ctx({}, {})), unreadable("noEpoch"), enc)
    o("removed_bot", "the author's Bot row is gone (the owner removed the bot): its members-only posts end, "
      "Unreadable(NotABot), even for a member holding the key.", D, bot_ctx(CTX0, bots=()), unreadable("notABot"),
      enc)
    human = doc(owner=HUMAN)
    Wh = post_key(K0, 0, HUMAN)
    _, _, _, _, human_enc = seal_bot(human, Wh, BODY_TLV)
    o("human_author_refused", "a v0x05 post by an identity with no Bot row (here a person holding the members key, "
      "who derived their own 'post key'): never opened, Unreadable(NotABot); members write v0x03.", human,
      bot_ctx(CTX0, bots=(BOT,)), unreadable("notABot"), human_enc)
    # bot B2 copies bot B's post (enc) onto its own document: members derive W_{0,B2} from its $ownerId and the AD
    # binds B2, so the commitment fails
    copied = doc(owner=BOT2)
    o("copied_to_other_bot", "another bot's document carrying this bot's enc: members derive the other bot's W "
      "and AD, so COMMIT_obj mismatches.", copied, bot_ctx(CTX0, bots=(BOT, BOT2)), unreadable("commitMismatch"), enc)
    # bot B2 seals a post claiming $ownerId B with its own key: commitment fails for members
    W2 = post_key(K0, 0, BOT2)
    _, _, _, _, forged = seal_bot(D, W2, tlv((2, b"FORGED")))
    o("forged_with_other_key", "a post under bot B's $ownerId sealed with bot B2's post key (B2 cannot sign as B, but "
      "the envelope alone must not open): CommitMismatch.", D, bot_ctx(CTX0, bots=(BOT, BOT2)),
      unreadable("commitMismatch"), forged)
    flipped = bytearray(enc)
    flipped[13] ^= 0x01
    o("commit_mismatch", "COMMIT_obj with one bit flipped: compared before GCM runs, CommitMismatch.", D,
      bot_ctx(CTX0), unreadable("commitMismatch"), bytes(flipped))
    tampered = bytearray(enc)
    tampered[-1] ^= 0x01
    o("body_tampered", "the commitment matches but the GCM tag does not: BadTag.", D, bot_ctx(CTX0),
      unreadable("badTag"), bytes(tampered))
    _, _, _, _, v3 = seal_members(dict(D), K0, BODY_TLV)
    o("v03_relabelled_as_v05", "a members' v0x03 enc with enc[0] rewritten to 0x05 on the bot's document: the bot "
      "key derives another K_obj, CommitMismatch.", D, bot_ctx(CTX0), unreadable("commitMismatch"),
      bytes([V5]) + v3[1:])
    o("v05_relabelled_as_v03", "the bot's enc with enc[0] rewritten to 0x03: read as a members' envelope under the "
      "epoch key, CommitMismatch.", D, bot_ctx(CTX0), unreadable("commitMismatch"), bytes([V3]) + enc[1:])
    o("too_short", "a v0x05 enc under 61 bytes is malformed before any key is used.", D, bot_ctx(CTX0), MALFORMED,
      enc[:60])
    ev = doc("event")
    o("event_malformed", "a v0x05 enc on an event: bots post issues, comments and reviews only, malformed.", ev,
      bot_ctx(CTX0), MALFORMED, enc)
    priv = doc(vis=None)
    _, _, _, _, priv_enc = seal_bot(priv, W0, BODY_TLV)
    o("private_repo", "a bot's post in a private-only repository opens for a member.", priv, bot_ctx(CTX0),
      readable({"body": BODY}), priv_enc)
    I = doc("issue")
    _, _, _, _, issue_enc = seal_bot(I, W0, tlv((1, b"Nightly failed"), (2, BODY.encode())))
    o("issue", "a bot's members-only issue opens to its title and body (the padding skipped).", I, bot_ctx(CTX0),
      readable({"title": "Nightly failed", "body": BODY}), issue_enc)
    ctx01 = bot_ctx(ctx({0: K0, 1: K1}, {0: ("c0", 10), 1: ("c1", 1000)}))
    o("late_after_rotation", "a bot never holds the members key, so it is not among the key's members: a post under "
      "epoch 0 written after the epoch-1 anchor + 240 blocks (the rotation gave it a fresh post key) is late.", D,
      ctx01, unreadable("late"), enc, height=1000 + GRACE_BLOCKS + 1)
    o("in_grace_after_rotation", "within the grace period the old post key still posts.", D, ctx01,
      readable({"body": BODY}), enc, height=1000 + GRACE_BLOCKS)
    o("unknown_v06", "v0x06 (a narrower branch's envelope) is the first version this client does not know: "
      "UnknownVersion, never malformed.", D, bot_ctx(CTX0), unreadable("unknownVersion"), bytes([0x06]) + enc[1:])


def open_with_post_key_vectors():
    D = doc()
    _, _, _, _, enc = seal_bot(D, W0, BODY_TLV)
    for name, desc, d, W, bot, e, epoch, exp in [
        ("own_post", "the bot reopens its own post with W alone (to edit it).", D, W0, BOT, enc, 0,
         readable({"body": BODY})),
        ("other_bots_post", "a post key opens nothing of another bot: NoKey.", D, post_key(K0, 0, BOT2), BOT2, enc, 0,
         unreadable("noKey")),
        ("other_epoch", "W_{1,b} does not open the bot's epoch-0 post: NoKey.", D, post_key(K1, 1, BOT), BOT, enc, 1,
         unreadable("noKey")),
        ("tampered", "a flipped tag: BadTag.", D, W0, BOT, enc[:-1] + bytes([enc[-1] ^ 1]), 0, unreadable("badTag")),
    ]:
        vector(f"open_with_post_key__{name}", desc,
               dict(op="openWithPostKey", repoId=H(repoId), w=H(W), epoch=epoch, bot=H(bot), doc=dict(d, enc=H(e))),
               exp)


def obj_key_vectors():
    D = doc()
    _, ko, _, _, enc = seal_bot(D, W0, BODY_TLV)
    vector("obj_key__bundle", "K_obj of a bot's post as a member derives it (what a maintainer's bundle or a read "
           "letter shares); anyone holding it opens that one post, and nothing else.",
           dict(op="objKey", repoId=H(repoId), key=H(K0), doc=dict(D, enc=H(enc))),
           dict(kObj=H(ko), opened=readable({"body": BODY})))
    moved = dict(D, targetId="34" * 32)
    vector("obj_key__moved_refused", "the post's enc on another thread: the key does not commit, no K_obj.",
           dict(op="objKey", repoId=H(repoId), key=H(K0), doc=dict(moved, enc=H(enc))),
           dict(kObj=None, opened=None))


def letter_vectors():
    def fmt(name, desc, epoch, W):
        letter = dict(type="postKey", v=1, fields=dict(epoch=epoch, key=H(W)))
        pt = key_letters.encode(letter)
        assert len(pt) % 512 == 0
        vector(f"letter__{name}", desc, dict(op="letter", epoch=epoch, key=H(W)), dict(plaintext=H(pt)))
        return pt

    pt = fmt("epoch0", "a postKey letter for epoch 0: {\"epoch\":0,\"key\":\"<hex W>\",\"type\":\"postKey\",\"v\":1}, "
             "padded with spaces to 512 bytes.", 0, W0)
    fmt("epoch_max", "the largest epoch a letter carries is u32's.", 4294967295, W0)

    def dec(name, desc, plain, exp):
        vector(f"letter_decode__{name}", desc, dict(op="letterDecode", plaintext=H(plain)), exp)

    dec("ok", "a reader takes the letter: its epoch and key.", pt, dict(epoch=0, key=H(W0)))

    def raw(obj):
        return key_letters.encode(dict(type=obj.pop("type"), v=obj.pop("v"), fields=obj))

    dec("extra_field_refused", "an unknown field: not a v1 postKey letter.",
        raw(dict(type="postKey", v=1, epoch=0, key=H(W0), bot=H(BOT))), None)
    dec("missing_key_refused", "no key: refused.", raw(dict(type="postKey", v=1, epoch=0)), None)
    dec("epoch_past_u32_refused", "an epoch past u32: refused.",
        raw(dict(type="postKey", v=1, epoch=4294967296, key=H(W0))), None)
    dec("uppercase_key_refused", "a key in uppercase hex: refused (lowercase only, as every key in letters).",
        raw(dict(type="postKey", v=1, epoch=0, key=H(W0).upper())), None)
    dec("short_key_refused", "a 31-byte key: refused.", raw(dict(type="postKey", v=1, epoch=0, key=H(W0[:31]))), None)
    dec("v2_refused", "version 2 (a later client's): skipped.", raw(dict(type="postKey", v=2, epoch=0, key=H(W0))),
        None)
    dec("other_type_refused", "a branch letter's type is not a postKey letter.",
        raw(dict(type="branchKey", v=1, epoch=0, key=H(W0))), None)


def build():
    VECTORS.clear()
    post_key_vectors()
    seal_vectors()
    open_vectors()
    open_with_post_key_vectors()
    obj_key_vectors()
    letter_vectors()


def write_vectors(out_dir):
    build()
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


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "..", "..", "forge-contracts", "vectors")
    if "--write-vectors" in sys.argv:
        write_vectors(out)
    else:
        build()
        print(json.dumps(dict(total=len(VECTORS)), indent=1))

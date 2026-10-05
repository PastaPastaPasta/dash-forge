"""Independent Python reference for docs/security/private-repos.md §11.

    python3 tools/private-repos-vectors/gen.py                 # print the §11 summary values
    python3 tools/private-repos-vectors/gen.py --write-vectors  # (re)write forge-contracts/vectors/private_*.json

Needs `cryptography` (HKDF, HMAC, AES-GCM, AES-CBC); secp256k1 is done by hand below. The
summary values are asserted against the hex printed in §11, so the vector files can only be
written from a generator that still agrees with the normative document. Both the Rust
(`forge-core::private`) and the TypeScript (`forge-web/lib/private`) harnesses run every file
this writes, and must reproduce it byte for byte.
"""
import base64
import glob
import hashlib
import hmac
import json
import os
import re
import struct
import sys

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDFExpand

H = lambda b: b.hex()


def sha256(b):
    return hashlib.sha256(b).digest()


def u32(n):
    return struct.pack(">I", n)


def u64(n):
    return struct.pack(">Q", n)


# ---------------------------------------------------------------------------------------------
# §2 key hierarchy
# ---------------------------------------------------------------------------------------------

repoId = bytes([0x11]) * 32
ownerId = bytes([0x22]) * 32
K0 = bytes(range(0, 32))
K1 = bytes(range(32, 64))
Kx = bytes([0x77]) * 32
NONCE = bytes.fromhex("000102030405060708090a0b")
FILE_ID = bytes.fromhex("f0e1d2c3b4a5968778695a4b3c2d1e0f")
GRACE_BLOCKS = 240


def prk(K, repo=repoId):
    return hmac.new(repo, K, hashlib.sha256).digest()


def expand(PRK, info, L=32):
    return HKDFExpand(algorithm=hashes.SHA256(), length=L, info=info).derive(PRK)


def info(label, epoch, extra=b""):
    return b"dash-forge/v2/" + label + b"\x00" + u32(epoch) + extra


def subkey(K, label, epoch, extra=b"", repo=repoId):
    return expand(prk(K, repo), info(label, epoch, extra))


def k_doc(K, e):
    return subkey(K, b"doc", e)


def k_ref(K, e):
    return subkey(K, b"ref", e)


def kcv(K, e):
    return subkey(K, b"kcv", e)[:14]


def commit(K, e):
    return subkey(K, b"commit", e)


def k_hedge(K, e):
    return subkey(K, b"hedge", e)


def k_pack(K, e, file_id):
    return subkey(K, b"pack", e, b"\x01" + file_id)


def ref_hash(K, e, name):
    return hmac.new(k_ref(K, e), name.encode(), hashlib.sha256).digest()


# ---------------------------------------------------------------------------------------------
# §4 documents
# ---------------------------------------------------------------------------------------------


# Document $ids are 32 bytes and are compared as raw bytes (§5.3), never as strings. Vectors
# carry them as hex; the `idEncoding: "base58"` vectors carry every identity and id in base58,
# the form the apps use, to hold both harnesses' boundary converters in parity.
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(b):
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\x00"))) + out


EXPLICIT_IDS = {"c1-a": bytes([0x0a]) * 32, "c1-b": bytes([0x0b]) * 32}


def cid(label):
    """The 32-byte $id a vector names `label`."""
    return EXPLICIT_IDS.get(label) or sha256(b"dash-forge vectors: id " + label.encode())


def rec(tag, value):
    return bytes([tag]) + struct.pack(">H", len(value)) + value


def tlv(*records):
    return b"".join(rec(t, v) for t, v in records)


def oidf(o):
    return bytes([len(o)]) + o


def bind(doc, K):
    t = doc["type"]
    if t in ("issue", "patch"):
        return u32(doc["number"])
    if t in ("comment", "event"):
        return bytes.fromhex(doc["targetId"])
    if t == "review":
        return bytes.fromhex(doc["patchId"])
    if t in ("refUpdate", "protectedRefUpdate"):
        return (
            bytes.fromhex(doc["refNameHash"])
            + oidf(bytes.fromhex(doc["newOid"]))
            + oidf(bytes.fromhex(doc.get("prevOid", "")))
            + (b"\x01" if doc.get("force", False) else b"\x00")
        )
    if t == "config":
        return commit(K, doc["epoch"])
    raise ValueError(t)


def ad(doc, K, version):
    return (
        b"dash-forge/v2/doc\x00"
        + bytes([version])
        + repoId
        + bytes.fromhex(doc["ownerId"])
        + u32(doc["epoch"])
        + doc["type"].encode()
        + b"\x00"
        + bind(doc, K)
    )


def seal_doc(doc, K, pt, nonce=NONCE):
    """enc for `doc` under the epoch key K (the one of doc["epoch"])."""
    e = doc["epoch"]
    if doc["type"] == "config":
        A = ad(doc, K, 2)
        return A, b"\x02" + commit(K, e) + nonce + AESGCM(k_doc(K, e)).encrypt(nonce, pt, A)
    A = ad(doc, K, 1)
    return A, b"\x01" + nonce + AESGCM(k_doc(K, e)).encrypt(nonce, pt, A)


# ---------------------------------------------------------------------------------------------
# §3 sealed artifacts
# ---------------------------------------------------------------------------------------------


def header(epoch, plen, file_id, L=14, magic=b"DFPK", version=1, reserved=0):
    return magic + bytes([version, L]) + struct.pack(">H", reserved) + u32(epoch) + u64(plen) + file_id


def seal_pack(K, epoch, plain, file_id=FILE_ID, L=14, final_flags=None, hdr=None, key_epoch=None):
    S = 1 << L
    nseg = max(1, -(-len(plain) // S))
    h = hdr if hdr is not None else header(epoch, len(plain), file_id, L)
    kf = k_pack(K, epoch if key_epoch is None else key_epoch, file_id)
    out, tags = bytearray(h), []
    for i in range(nseg):
        final = (1 if i == nseg - 1 else 0) if final_flags is None else final_flags[i]
        n = u64(i) + b"\x00\x00\x00" + bytes([final])
        c = AESGCM(kf).encrypt(n, plain[i * S:(i + 1) * S], h)
        out += c
        tags.append(H(c[-16:]))
    return bytes(out), tags, nseg


def mod251(n):
    return bytes(i % 251 for i in range(n))


# ---------------------------------------------------------------------------------------------
# §5.1 wraps (secp256k1 by hand)
# ---------------------------------------------------------------------------------------------

P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)


def inv(a):
    return pow(a, P - 2, P)


def ec_add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % P == 0:
        return None
    lam = (3 * p[0] * p[0]) * inv(2 * p[1]) % P if p == q else (q[1] - p[1]) * inv(q[0] - p[0]) % P
    x = (lam * lam - p[0] - q[0]) % P
    return (x, (lam * (p[0] - x) - p[1]) % P)


def ec_mul(k, p):
    r = None
    while k:
        if k & 1:
            r = ec_add(r, p)
        p = ec_add(p, p)
        k >>= 1
    return r


def comp(pt):
    return bytes([2 + (pt[1] & 1)]) + pt[0].to_bytes(32, "big")


def priv(label):
    return int.from_bytes(sha256(label), "big") % N


def cbc(key, iv, data):
    pad = 16 - len(data) % 16
    enc = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend()).encryptor()
    return iv + enc.update(data + bytes([pad]) * pad) + enc.finalize()


d_s, d_r, d_t = priv(b"dash-forge vectors: sender"), priv(b"dash-forge vectors: recipient"), priv(b"dash-forge vectors: third")
Ps, Pr, Pt = ec_mul(d_s, G), ec_mul(d_r, G), ec_mul(d_t, G)
shared = sha256(comp(ec_mul(d_s, Pr)))
assert shared == sha256(comp(ec_mul(d_r, Ps)))
IV = bytes.fromhex("0f0e0d0c0b0a09080706050403020100")


def wrap_pt(K, e, version=1):
    return bytes([version]) + kcv(K, e) + K


# ---------------------------------------------------------------------------------------------
# The §11 summary values, asserted against the document
# ---------------------------------------------------------------------------------------------


def summary():
    out = {}
    out["prk_e0"] = H(prk(K0))
    out.update(
        K_doc_e0=H(k_doc(K0, 0)), K_ref_e0=H(k_ref(K0, 0)), kcv_e0=H(kcv(K0, 0)), commit_e0=H(commit(K0, 0)),
        K_doc_e1=H(k_doc(K1, 1)), K_ref_e1=H(k_ref(K1, 1)), kcv_e1=H(kcv(K1, 1)), commit_e1=H(commit(K1, 1)),
        K_pack_e0=H(k_pack(K0, 0, FILE_ID)),
    )
    out["refNameHash_main_e0"] = H(ref_hash(K0, 0, "refs/heads/main"))
    out["refNameHash_main_e1"] = H(ref_hash(K1, 1, "refs/heads/main"))
    out["refNameHash_dev_e0"] = H(ref_hash(K0, 0, "refs/heads/dev"))
    out["public_sha256_main"] = H(sha256(b"refs/heads/main"))
    A, e = seal_doc(ISSUE, K0, ISSUE_TLV)
    out["issue"] = dict(ad=H(A), pt=H(ISSUE_TLV), enc=H(e), enc_len=len(e))
    A, e = seal_doc(REF_UPDATE, K0, REF_TLV)
    out["refUpdate"] = dict(ad=H(A), pt=H(REF_TLV), enc=H(e))
    A, e = seal_doc(REF_UPDATE_DEV, K0, REF_TLV)
    out["refUpdate_hash_mismatch"] = dict(refNameHash=REF_UPDATE_DEV["refNameHash"], enc=H(e))
    A, e = seal_doc(COMMENT, K0, b"")
    out["comment_empty"] = dict(ad=H(A), enc=H(e), enc_len=len(e))
    A, e = seal_doc(COMMENT, K0, COMMENT_TLV)
    out["comment_inline"] = dict(pt=H(COMMENT_TLV), enc=H(e))
    A, e = seal_doc(CONFIG0, K0, CONFIG0_TLV)
    out["config_anchor_e0"] = dict(ad=H(A), pt=H(CONFIG0_TLV), enc=H(e), enc_len=len(e))
    A, e = seal_doc(CONFIG1, K1, CONFIG1_TLV)
    out["config_anchor_e1"] = dict(ad=H(A), pt=H(CONFIG1_TLV), enc=H(e))
    A, e = seal_doc(CONFIG1, Kx, CONFIG1_TLV)
    out["config_anchor_e1_other_key"] = dict(commit=H(commit(Kx, 1)), enc=H(e))
    plain = mod251(40000)
    sealed, tags, nseg = seal_pack(K0, 0, plain)
    out["pack"] = dict(header=H(sealed[:36]), K_file=H(k_pack(K0, 0, FILE_ID)), nseg=nseg, sealed_len=len(sealed),
                       packHash=H(sha256(sealed)), plain_sha256=H(sha256(plain)), tags=tags)
    out["empty_pack_sealed"] = H(seal_pack(K0, 0, b"")[0])
    out["wrap"] = dict(sender_priv=d_s.to_bytes(32, "big").hex(), sender_pub=H(comp(Ps)),
                       recipient_priv=d_r.to_bytes(32, "big").hex(), recipient_pub=H(comp(Pr)), shared=H(shared),
                       plaintext=H(wrap_pt(K0, 0)), wrapped=H(cbc(shared, IV, wrap_pt(K0, 0))))
    tn = tag_name(K0, 0, "v1.0.0")
    A, e = seal_release_raw(K0, 0, ownerId, tn, release_tlv(REL_V1))
    out["release"] = dict(K_tag_e0=H(k_tag(K0, 0)), tagName_e0=tn, tagName_e1=tag_name(K1, 1, "v1.0.0"),
                          tagName_branch_e0=tag_name(K0, 0, "refs/heads/main"), pt=H(release_tlv(REL_V1)), enc=H(e),
                          manifest_packHash=MANIFEST_HASH)
    _, ko, C, pt, e = seal_members(MDOC, K0, tlv((2, MBODY.encode())))
    out["members_comment"] = dict(kObj=H(ko), commit=H(C), tlv=H(pt), enc=H(e), enc_len=len(e))
    k_obj, nonce, ivs = named_inputs(1)
    body = "A letter to 1 people (the sender included): the embargo ends on Friday."
    letter_shared, C, _, _, _, e = seal_named(named_doc(), NAMED_SENDER, 4, [NAMED_SENDER], tlv((2, body.encode())),
                                              k_obj, nonce, ivs)
    out["letter_n1"] = dict(sender_priv=NAMED_SENDER["priv"].to_bytes(32, "big").hex(), sender_pub=H(NAMED_SENDER["pub"]),
                            shared=H(letter_shared[0]), commit=H(C), enc_len=len(e))
    return out


ISSUE = dict(type="issue", ownerId=H(ownerId), epoch=0, number=7)
ISSUE_FIELDS = {"title": "Rotate the signing key", "body": "See the runbook."}
ISSUE_TLV = tlv((1, b"Rotate the signing key"), (2, b"See the runbook."))
MAIN_E0 = H(ref_hash(K0, 0, "refs/heads/main"))
REF_UPDATE = dict(type="refUpdate", ownerId=H(ownerId), epoch=0, refNameHash=MAIN_E0, newOid="aa" * 20, force=False)
REF_UPDATE_DEV = dict(REF_UPDATE, refNameHash=H(ref_hash(K0, 0, "refs/heads/dev")))
REF_TLV = tlv((3, b"refs/heads/main"))
COMMENT = dict(type="comment", ownerId=H(ownerId), epoch=0, targetId="33" * 32)
COMMENT_TLV = tlv((2, b"nit: rename"), (10, b"src/lib.rs"))
EVENT = dict(type="event", ownerId=H(ownerId), epoch=0, targetId="33" * 32)
EVENT_TLV = tlv((15, b"bug"))
CONFIG0 = dict(type="config", ownerId=H(ownerId), epoch=0)
CONFIG0_TLV = tlv((6, b"refs/heads/main"))
CONFIG1 = dict(type="config", ownerId=H(ownerId), epoch=1)
CONFIG1_TLV = tlv((6, b"refs/heads/main"), (7, b"refs/heads/main"), (8, u32(0)), (9, K0))
CONFIG1_BURNED_TLV = tlv((6, b"refs/heads/main"), (7, b"refs/heads/main"), (8, u32(0)), (11, b"\x01"))
CONFIG2 = dict(type="config", ownerId=H(ownerId), epoch=2)

# The hex §11 prints, checked here so the files below never drift from the document
DOC = {
    "prk_e0": "74b9ee840de5d5a97a0a075fb825e319f4f1fd18e73809ef1dd0cd89fe5921b5",
    "K_doc_e0": "0f21a88819aca66526d4965dcd7854ba141266e080d843b25b79e49cda40ee39",
    "K_ref_e0": "6141d2b714c98c85bd535dee436535c7c9c27e91bed3a9cb5d6e7517dffa629e",
    "kcv_e0": "7cab1ab77a4b34d31fa6ef954054",
    "commit_e0": "2ae6cfc9c4d7f570f56f946332e8d950b2f39d4d3c8c60b7a33d8275ebf3e584",
    "K_doc_e1": "88011c08c79c9c87dba7ba9a464ce66c8c057a4b42e7d29d54e1a98087aa94c2",
    "K_ref_e1": "e4afad398b71356f3f6955487651500e127071fb4774ea234b85036f4cbed895",
    "kcv_e1": "52533798d0b561eddfe088451253",
    "commit_e1": "307277ccb5bcfa7871f82e43c6e58515464a5065460b829def44e1cc32521c33",
    "K_pack_e0": "7c3836d19c8c22116136d9a49d6cc92914771e1010c697673a7baba1c521932b",
    "refNameHash_main_e0": "e729d18b929db396450159dfc6256e24302b94c9c3c9eb40643f5ae0be3fe579",
    "refNameHash_main_e1": "7310537f7a9b04d1eaab334d91ee963c89be088d7309ed5dcf84951ed7bb215a",
    "refNameHash_dev_e0": "eef70d7506d9e18be1005f88cd0889a9fa321fb0bce4dc1209442c41cc0c47e2",
    "public_sha256_main": "f921bd05e68b03740c450e565e0e6173e546193170b2dd404ddb6f153e9b5bf3",
    ("issue", "ad"): "646173682d666f7267652f76322f646f6300" "01" + "11" * 32 + "22" * 32 + "00000000" "6973737565" "00" "00000007",
    ("issue", "pt"): "010016526f7461746520746865207369676e696e67206b6579020010536565207468652072756e626f6f6b2e",
    ("issue", "enc"): "01000102030405060708090a0b1f7039a0ac468d0d3a5c60dba50b8e67de7316a802d264e22094824ccaf8a0d1650855aba0344d75612e31c48cdfc7b2d5d8c2c6a98c23a1320093aa",
    ("refUpdate", "pt"): "03000f726566732f68656164732f6d61696e",
    ("refUpdate", "enc"): "01000102030405060708090a0b1d702080a6549f56371975d7b304906fd0738aace1e93172a442bd35c7f049054557",
    ("refUpdate_hash_mismatch", "enc"): "01000102030405060708090a0b1d702080a6549f56371975d7b304906fd07300c3612fcbb987e4b0ae16ad06494ccd",
    ("comment_empty", "enc"): "01000102030405060708090a0bbd9c1374076ddd93b6478109a3cc02c4",
    ("comment_inline", "pt"): "02000b6e69743a2072656e616d650a000a7372632f6c69622e7273",
    ("comment_inline", "enc"): "01000102030405060708090a0b1c70249caa46d6592d197ad2ad4ef70eb36e0da54a9e66e577e4f16f2a8e55d2c8ed09dc06cd085c7a26e3",
    ("config_anchor_e0", "pt"): "06000f726566732f68656164732f6d61696e",
    ("config_anchor_e0", "enc"): "022ae6cfc9c4d7f570f56f946332e8d950b2f39d4d3c8c60b7a33d8275ebf3e584000102030405060708090a0b18702080a6549f56371975d7b304906fd0739b4b2701a46ecedc74a79a665a7b3473",
    ("config_anchor_e1", "pt"): "06000f726566732f68656164732f6d61696e07000f726566732f68656164732f6d61696e08000400000000090020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    ("config_anchor_e1", "enc"): "02307277ccb5bcfa7871f82e43c6e58515464a5065460b829def44e1cc32521c33000102030405060708090a0bd0b9cc2c71a2a510ad23e4af9dc285bf3b180fe8ade1be1e55826633284d4657b8bb74aad1ab382bbcebb6776071579f82f9905c711e7dd4af5478299d221175e8af28f11d2cce5f87a7b0fa5bd88567ca44d954ae135b0551f16c90b8d2",
    ("config_anchor_e1_other_key", "commit"): "89f8dd4eb6cb38196f7958b1b644b4f761f82979c8d965aa291f3a2820ca7775",
    ("config_anchor_e1_other_key", "enc"): "0289f8dd4eb6cb38196f7958b1b644b4f761f82979c8d965aa291f3a2820ca7775000102030405060708090a0b62d8b509a110c74363a7f13c991f9540e7cadfbfca8f15f458b0df9cae818010a978835f90e2633689bc080a101a5d3f0700d9645e9f0c36f60301625817759d9812eb95a6506f4a0145b672c01f5101421fbe9cac9e11adb6104751312f",
    ("pack", "header"): "4446504b010e0000000000000000000000009c40f0e1d2c3b4a5968778695a4b3c2d1e0f",
    ("pack", "sealed_len"): 40084,
    ("pack", "tags"): ["bd93a5ffb088dee81cd4e5c8d6750d33", "fb62d98c6a0e1d864129988e24495f65", "69789e159bdc8234933d844b7a8ed32c"],
    ("pack", "packHash"): "7e7e4e4ed63d4c51a46f0ecd9b3a2a50b2f5fed46e89c58b8ac6450bf7582315",
    ("pack", "plain_sha256"): "8f272ca6d96caedf3d860ff34ed21868f04ce18a2f41686f513c3c989146ca79",
    "empty_pack_sealed": "4446504b010e0000000000000000000000000000f0e1d2c3b4a5968778695a4b3c2d1e0f70ae66b8c3bceb742661fa2f54aa8f1b",
    ("wrap", "sender_priv"): "840fa5c84d8f6ecf5c27fd778356ba94480b9b35f264e7690933dcf1676f9ac0",
    ("wrap", "sender_pub"): "03f3d414f81ac96cea14d3ec25685430f04c47c8b0559fff0ffe77113d8ada7948",
    ("wrap", "recipient_priv"): "f16baad1b1863c015869f5a6a2db471537d06a31d3bd78d961300f13f6b14239",
    ("wrap", "recipient_pub"): "035bf470bf1fbffac4b0b01c0ae8480b0b56d6695482bb116286c62e99af15e337",
    ("wrap", "shared"): "e6cf085ee93d30ba8b5f81451d11709e9856c12acef291ce4e084b18a4c4856b",
    ("wrap", "plaintext"): "017cab1ab77a4b34d31fa6ef954054000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    ("wrap", "wrapped"): "0f0e0d0c0b0a09080706050403020100828afa35dca4dbd8eb40591d52f363f10671f7b77f5f619a25ee6d03fb88043c7fa0037e5c0d83ea667f9ba7289a82cc",
    # §16 sealed releases
    ("release", "K_tag_e0"): "c0fde38636cc9f84810a94cd882035292ca5891c5884563869b17b5231bf91ee",
    ("release", "tagName_e0"): "A0TK3ZkbqTL94-CbAhgvnnKHPpCVVjvXTNKOyh6BhlM",
    ("release", "tagName_e1"): "RIgIOsyi-3hmGZTqr75wHSm48J_2WLR3WawK5CVj4Qg",
    ("release", "tagName_branch_e0"): "365b9_MPzBqkrDwjvQNRk03R0LJ96TexlyGFYJkoUbY",
    ("release", "pt"): "020015466972737420737461626c652072656c656173652e10000676312e302e3011000d56657273696f6e20312e302e30120014aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa130001004000110000000000000000000000000000000000",
    ("release", "enc"): "01000102030405060708090a0b1c703ab4aa409f0d7f0f60d2a247982ecb7813a304816aa94996842aa8b3f5df2171308684245164672e34ca3044f13df6aed239822c11b72160aaf5710b729c53b3aa03727feefeb272ab1c48a938ea8a155bc02d513d87c976c4447d35583d1ece6f0259a4661d29a4f7bba9d2ab92",
    ("release", "manifest_packHash"): "4a3f5093cd8d639b3f998ec93e3ebb5628c53b819f12895a4a54c62f6e8746fa",
    # §4.1 members-only (v0x03) and specific-people (v0x04) envelopes
    ("members_comment", "kObj"): "4faf51f6930dfb44ded0de72f22d0bd0233a50c420b375ece2ce3edc56fb6958",
    ("members_comment", "commit"): "f9a7fa2b8dc201ec7c98681cdcfcfdd62d0c8514308e08b3254c75e528853e9f",
    ("members_comment", "tlv"): "0200256d656d626572732d6f6e6c793a207468652066697820697320696e207365632f6376652d3140001500"
                                "0000000000000000000000000000000000000000",
    ("members_comment", "enc"): "03000102030405060708090a0bf9a7fa2b8dc201ec7c98681cdcfcfdd62d0c8514308e08b3254c75e528853e9f"
                                "68c2c84f9892eab0fdb7a611874cf68f179a64d1f255e203d2fcd039a43f1e5e4427ffea6920a529663580783"
                                "4ce89db33640789703539675c630fe4e0e9e440fa0941eba61eeb6f2957e4f93ebbccfe",
    ("members_comment", "enc_len"): 125,
    ("letter_n1", "shared"): "c7524c877dacb46526e61feb3284a734dce449c07bfb0aae69308c5062f8c7f5",
    ("letter_n1", "commit"): "2dc65817226a703692c4718be4d43ac458a7ef18f38f925fe833b0c134e6ccd1",
    ("letter_n1", "enc_len"): 258,
}


def check_against_document(out):
    for k, want in DOC.items():
        got = out[k[0]][k[1]] if isinstance(k, tuple) else out[k]
        assert got == want, f"§11 mismatch at {k}: {got} != {want}"


# ---------------------------------------------------------------------------------------------
# Vector files
# ---------------------------------------------------------------------------------------------

VECTORS = []


def vector(case, name, description, inp, expected):
    VECTORS.append(dict(name=name, description=description, case=case, rules="v2", input=inp, expected=expected))


def kdf_vectors():
    for name, K, e, fid in [("epoch0", K0, 0, FILE_ID), ("epoch1", K1, 1, None), ("split_view_key_epoch1", Kx, 1, None)]:
        exp = dict(prk=H(prk(K)), doc=H(k_doc(K, e)), ref=H(k_ref(K, e)), kcv=H(kcv(K, e)), commit=H(commit(K, e)),
                   hedge=H(k_hedge(K, e)))
        inp = dict(repoId=H(repoId), key=H(K), epoch=e)
        if fid:
            inp["fileId"] = H(fid)
            exp["pack"] = H(k_pack(K, e, fid))
        vector("private_kdf", name, f"HKDF-SHA256 subkeys of the epoch key for epoch {e} (§2.2).", inp, exp)


def ref_hash_vectors():
    for name, K, e, ref in [("main_epoch0", K0, 0, "refs/heads/main"), ("main_epoch1", K1, 1, "refs/heads/main"),
                            ("dev_epoch0", K0, 0, "refs/heads/dev")]:
        vector("private_ref_hash", name,
               "refNameHash = HMAC-SHA256(K_ref,e, refName), per epoch, never the public sha256 (§4.5).",
               dict(repoId=H(repoId), key=H(K), epoch=e, refName=ref),
               dict(hash=H(ref_hash(K, e, ref)), publicSha256=H(sha256(ref.encode()))))


def fields_json(f):
    return {k: v for k, v in f.items()}


PATCH = dict(type="patch", ownerId=H(ownerId), epoch=0, number=3,
             baseRefNameHash=H(ref_hash(K0, 0, "refs/heads/main")),
             sourceRefNameHash=H(ref_hash(K0, 0, "refs/heads/feature")))
PATCH_FIELDS = {"title": "Add the feature", "body": "Closes #7.", "baseRefName": "refs/heads/main",
                "sourceRefName": "refs/heads/feature"}
PATCH_TLV = tlv((1, b"Add the feature"), (2, b"Closes #7."), (4, b"refs/heads/main"), (5, b"refs/heads/feature"))
REVIEW = dict(type="review", ownerId=H(ownerId), epoch=0, patchId="44" * 32)
PROTECTED = dict(REF_UPDATE, type="protectedRefUpdate", prevOid="bb" * 20, force=True)


def doc_seal_vectors():
    cases = [
        ("issue", ISSUE, K0, ISSUE_FIELDS, ISSUE_TLV, None, "issue #7: AD binds u32(number); title and body in TLV (§4.1, §4.3, §4.4)."),
        ("ref_update", REF_UPDATE, K0, {"refName": "refs/heads/main"}, REF_TLV, None,
         "refUpdate: AD binds refNameHash, oidf(newOid), oidf(empty prevOid), force."),
        ("protected_ref_update_force", PROTECTED, K0, {"refName": "refs/heads/main"}, REF_TLV, None,
         "protectedRefUpdate with a prevOid and force = true in the bind."),
        ("comment_inline", COMMENT, K0, {"body": "nit: rename", "path": "src/lib.rs"}, COMMENT_TLV, None,
         "inline review comment: path is TLV tag 10 (§4.3)."),
        ("patch", PATCH, K0, PATCH_FIELDS, PATCH_TLV, None, "patch with base and source ref names (tags 4, 5)."),
        ("review_empty", REVIEW, K0, {}, b"", None, "a review may have an empty plaintext."),
        ("event_label", EVENT, K0, {"eventValue": "bug"}, EVENT_TLV, None,
         "a label event: its value is TLV tag 15; the AD binds targetId like a comment's (§4.3, §4.4)."),
        ("config_anchor_epoch0", CONFIG0, K0, {"defaultBranch": "refs/heads/main"}, CONFIG0_TLV, True,
         "config anchor for epoch 0: enc v0x02 carries COMMIT_0, which the AD binds (§4.2)."),
        ("config_anchor_epoch1", CONFIG1, K1,
         {"defaultBranch": "refs/heads/main", "protectedPatterns": ["refs/heads/main"], "prevEpoch": 0, "prevEpochKey": H(K0)},
         CONFIG1_TLV, True, "config anchor for epoch 1 with prevEpoch 0 and prevEpochKey K_0 (tags 8, 9)."),
        ("config_burned_anchor_epoch1", CONFIG1, K1,
         {"defaultBranch": "refs/heads/main", "protectedPatterns": ["refs/heads/main"], "prevEpoch": 0, "burned": True},
         CONFIG1_BURNED_TLV, True,
         "a burned epoch-1 anchor: tag 8 prevEpoch and tag 11 = 0x01, and no prevEpochKey: the burned key may sit "
         "with someone who never held K_0 (§5.3)."),
        ("config_anchor_epoch2_with_skip", CONFIG2, K2,
         {"defaultBranch": "refs/heads/main", "prevEpoch": 1, "prevEpochKey": H(K1), "skipEpochKey": H(K0)},
         tlv((6, b"refs/heads/main"), (8, u32(1)), (9, K1), (12, K0)), True,
         "the anchor above burned epoch 1 carries prevEpochKey = K_1 and skipEpochKey = K_0 (tag 12), the key of "
         "the nearest epoch below the burned run."),
        ("config_split_view", CONFIG1, Kx,
         {"defaultBranch": "refs/heads/main", "protectedPatterns": ["refs/heads/main"], "prevEpoch": 0, "prevEpochKey": H(K0)},
         CONFIG1_TLV, True, "the epoch-1 anchor plaintext under another key K_x carries COMMIT_x (§11 split view)."),
    ]
    for name, doc, K, fields, pt, anchor, desc in cases:
        A, e = seal_doc(doc, K, pt)
        inp = dict(repoId=H(repoId), key=H(K), doc=doc, fields=fields_json(fields), nonce=H(NONCE))
        if anchor is not None:
            inp["anchor"] = anchor
        vector("private_doc_seal", name, desc, inp, dict(ad=H(A), tlv=H(pt), enc=H(e)))
    refusals = [
        ("comment_without_body", COMMENT, K0, {}, None, "a comment needs a body: the writer refuses to seal it."),
        ("title_257_chars", ISSUE, K0, {"title": "a" * 257}, None, "title over 256 characters is refused."),
        ("ref_name_hash_mismatch", REF_UPDATE_DEV, K0, {"refName": "refs/heads/main"}, None,
         "a writer never seals a refName that does not hash to the document's refNameHash (H3)."),
        ("patch_base_hash_mismatch", dict(PATCH, baseRefNameHash=H(ref_hash(K0, 0, "refs/heads/dev"))), K0, PATCH_FIELDS, None,
         "nor a baseRefName that does not hash to baseRefNameHash."),
        ("prev_epoch_in_epoch0_anchor", CONFIG0, K0, {"prevEpoch": 0, "prevEpochKey": H(K0)}, True,
         "tags 8/9 are not allowed in an epoch-0 config."),
        ("burned_in_epoch0", CONFIG0, K0, {"defaultBranch": "refs/heads/main", "burned": True}, True,
         "tag 11 is not allowed in an epoch-0 config: epoch 0 is never burned."),
        ("burned_with_prev_key", CONFIG1, K1,
         {"defaultBranch": "refs/heads/main", "prevEpoch": 0, "prevEpochKey": H(K0), "burned": True}, True,
         "a burned config never carries prevEpochKey: a writer refuses to seal it."),
        ("burned_with_skip_key", CONFIG1, K1,
         {"defaultBranch": "refs/heads/main", "prevEpoch": 0, "burned": True, "skipEpochKey": H(K0)}, True,
         "nor skipEpochKey."),
        ("anchor_epoch1_without_prev", CONFIG1, K1, {"defaultBranch": "refs/heads/main"}, True,
         "an anchor for e >= 1 must carry prevEpoch and prevEpochKey."),
        ("non_anchor_epoch1_without_prev", CONFIG1, K1, {"defaultBranch": "refs/heads/dev"}, False,
         "every config of an epoch e >= 1 carries prevEpoch and prevEpochKey, anchor or not: any of them may "
         "become the anchor when an earlier one's author stops being a maintainer."),
        ("tag_not_for_kind", ISSUE, K0, {"title": "t", "refName": "refs/heads/main"}, None,
         "refName is not an issue field."),
        ("patch_base_hash_without_name", PATCH, K0, {"title": "Add the feature", "sourceRefName": "refs/heads/feature"},
         None, "a writer never seals a patch whose baseRefNameHash names no baseRefName (H3)."),
        ("event_without_value", EVENT, K0, {}, None, "an event is sealed only for its value: none, nothing to seal."),
        ("event_value_121_chars", EVENT, K0, {"eventValue": "v" * 121}, None,
         "an event value over 120 characters is refused (the schema's cap)."),
        ("event_title", EVENT, K0, {"eventValue": "bug", "title": "t"}, None, "title is not an event field."),
        ("body_over_enc_cap", ISSUE, K0, {"title": "t", "body": "b" * 5085}, None,
         "title + body over 5085 bytes does not fit a 5120-byte enc (§4.3 combined size)."),
    ]
    for name, doc, K, fields, anchor, desc in refusals:
        inp = dict(repoId=H(repoId), key=H(K), doc=doc, fields=fields, nonce=H(NONCE))
        if anchor is not None:
            inp["anchor"] = anchor
        vector("private_doc_seal", name, desc, inp, dict(error="tooLarge" if name == "body_over_enc_cap" else "malformed"))


def ctx(keys, anchors, members=(), burned=None):
    out = dict(keys={str(e): H(K) for e, K in keys.items()},
               anchors={str(e): dict(id=H(cid(i)), height=h) for e, (i, h) in anchors.items()},
               members=list(members))
    if burned is not None:
        out["burned"] = list(burned)
    return out


CTX0 = ctx({0: K0}, {0: ("c0", 10)})
CTX01 = ctx({0: K0, 1: K1}, {0: ("c0", 10), 1: ("c1", 1000)})


def readable(fields):
    return dict(status="readable", fields=fields)


def unreadable(reason):
    return dict(status="unreadable", reason=reason)


MALFORMED = dict(status="malformed")


def doc_open_vectors():
    def v(name, desc, doc, K, pt, context, expected, enc=None, height=50):
        if enc is None:
            _, enc = seal_doc(doc, K, pt)
        d = dict(doc, enc=H(enc))
        if "id" in d:
            d["id"] = H(cid(d["id"]))
        if height is not None:
            d.setdefault("createdAtBlockHeight", height)
        vector("private_doc_open", name, desc, dict(repoId=H(repoId), context=context, doc=d), expected)

    v("issue", "the §11 issue opens under K_0.", ISSUE, K0, ISSUE_TLV, CTX0, readable(ISSUE_FIELDS))
    _, issue_enc = seal_doc(ISSUE, K0, ISSUE_TLV)
    v("issue_other_number", "the AD binds the issue number: opened as #8 the tag fails.", dict(ISSUE, number=8), K0, None,
      CTX0, unreadable("badTag"), enc=issue_enc)
    v("issue_other_owner", "the AD binds $ownerId: another owner's copy never decrypts.", dict(ISSUE, ownerId="23" * 32),
      K0, None, CTX0, unreadable("badTag"), enc=issue_enc)
    v("issue_other_epoch", "the AD and subkeys bind the epoch: the enc under epoch 1 fails.", dict(ISSUE, epoch=1), K0, None,
      CTX01, unreadable("badTag"), enc=issue_enc)
    v("issue_reframed_as_v2", "enc[0] rewritten to 0x02 (32 bytes inserted) is malformed for a non-config kind.", ISSUE, K0,
      None, CTX0, MALFORMED, enc=b"\x02" + bytes(32) + issue_enc[1:])
    v("enc_too_short", "an enc under 29 bytes is malformed before any key is used.", ISSUE, K0, None, CTX0, MALFORMED,
      enc=issue_enc[:28])
    v("issue_no_epoch", "an epoch without an anchor does not exist: Unreadable(NoEpoch).", ISSUE, K0, None,
      ctx({0: K0}, {1: ("c1", 1000)}), unreadable("noEpoch"), enc=issue_enc)
    v("issue_no_key", "the epoch exists but the reader holds no key for it: Unreadable(NoKey).", dict(ISSUE, epoch=1), K0,
      None, ctx({0: K0}, {0: ("c0", 10), 1: ("c1", 1000)}), unreadable("noKey"), enc=issue_enc)
    late = dict(ISSUE, createdAtBlockHeight=1000 + GRACE_BLOCKS + 1)
    v("issue_late", "under epoch 0 after the epoch-1 anchor height + 240 by a non-member: Unreadable(Late) (§8.2).", late,
      K0, ISSUE_TLV, CTX01, unreadable("late"))
    v("issue_within_grace", "at exactly the anchor height + 240 the content is still shown.",
      dict(ISSUE, createdAtBlockHeight=1000 + GRACE_BLOCKS), K0, ISSUE_TLV, CTX01, readable(ISSUE_FIELDS))
    v("issue_late_from_current_member", "late content by a current member is shown.", late, K0, ISSUE_TLV,
      ctx({0: K0, 1: K1}, {0: ("c0", 10), 1: ("c1", 1000)}, [H(ownerId)]), readable(ISSUE_FIELDS))
    v("issue_without_block_height", "a document without $createdAtBlockHeight is malformed: the late rule cannot be "
      "judged (the schema requires it).", ISSUE, K0, ISSUE_TLV, CTX0, MALFORMED, height=None)
    v("tampered_without_block_height", "the height is judged at step 7: a tampered document without one is still "
      "Unreadable(BadTag), not Malformed.", dict(ISSUE, number=8), K0, None, CTX0, unreadable("badTag"), enc=issue_enc,
      height=None)
    v("title_with_leading_bom", "UTF-8 values are taken byte for byte: a leading U+FEFF is part of the title, never "
      "stripped.", ISSUE, K0, tlv((1, "\ufeffRotate".encode())), CTX0, readable({"title": "\ufeffRotate"}))
    v("ref_update", "the §11 refUpdate opens and its refName hashes to refNameHash.", REF_UPDATE, K0, REF_TLV, CTX0,
      readable({"refName": "refs/heads/main"}))
    v("protected_ref_update_force", "a protectedRefUpdate with prevOid and force.", PROTECTED, K0, REF_TLV, CTX0,
      readable({"refName": "refs/heads/main"}))
    v("ref_update_hash_mismatch", "tag valid, but refs/heads/main does not hash to the refNameHash of refs/heads/dev (H3).",
      REF_UPDATE_DEV, K0, REF_TLV, CTX0, MALFORMED)
    v("comment_empty", "decrypts, then Malformed: a comment needs a body.", COMMENT, K0, b"", CTX0, MALFORMED)
    v("comment_inline", "the inline comment yields body and path.", COMMENT, K0, COMMENT_TLV, CTX0,
      readable({"body": "nit: rename", "path": "src/lib.rs"}))
    v("comment_path_over_1000_bytes", "a path of 300 four-byte characters (1200 bytes) is malformed.", COMMENT, K0,
      tlv((2, b"x"), (10, "\U0001F600".encode() * 300)), CTX0, MALFORMED)
    v("comment_empty_body_record", "a required field must be non-empty: a zero-length body record does not make a comment.",
      COMMENT, K0, tlv((2, b"")), CTX0, MALFORMED)
    v("comment_path_empty", "path has no minLength, so an empty path is kept.", COMMENT, K0, tlv((2, b"x"), (10, b"")),
      CTX0, readable({"body": "x", "path": ""}))
    v("patch", "a patch whose base and source names match their hashes.", PATCH, K0, PATCH_TLV, CTX0, readable(PATCH_FIELDS))
    v("patch_base_hash_mismatch", "baseRefName does not hash to baseRefNameHash (H3).",
      dict(PATCH, baseRefNameHash=H(ref_hash(K0, 0, "refs/heads/dev"))), K0, PATCH_TLV, CTX0, MALFORMED)
    v("patch_source_hash_mismatch", "sourceRefName does not hash to sourceRefNameHash (H3).",
      dict(PATCH, sourceRefNameHash=H(ref_hash(K0, 0, "refs/heads/dev"))), K0, PATCH_TLV, CTX0, MALFORMED)
    no_hash = {k: v_ for k, v_ in PATCH.items() if k != "sourceRefNameHash"}
    v("patch_without_source_hash", "a hash field that is absent is not checked.", no_hash, K0, PATCH_TLV, CTX0,
      readable(PATCH_FIELDS))
    v("patch_base_hash_without_name", "a present baseRefNameHash with no baseRefName in enc is malformed (H3): the "
      "patch would be indexed under a branch it does not name.", PATCH, K0,
      tlv((1, b"Add the feature"), (5, b"refs/heads/feature")), CTX0, MALFORMED)
    v("patch_source_hash_without_name", "a present sourceRefNameHash with no sourceRefName in enc is malformed (H3).",
      PATCH, K0, tlv((1, b"Add the feature"), (4, b"refs/heads/main")), CTX0, MALFORMED)
    v("review_empty", "a review's plaintext may be empty.", REVIEW, K0, b"", CTX0, readable({}))
    c0 = dict(CONFIG0, id="c0")
    c1 = dict(CONFIG1, id="c1")
    v("config_anchor_epoch0", "the epoch-0 anchor opens under K_0.", c0, K0, CONFIG0_TLV, CTX0,
      readable({"defaultBranch": "refs/heads/main"}))
    v("config_anchor_epoch1", "the epoch-1 anchor yields prevEpoch 0 and prevEpochKey K_0.", c1, K1, CONFIG1_TLV, CTX01,
      readable({"defaultBranch": "refs/heads/main", "protectedPatterns": ["refs/heads/main"], "prevEpoch": 0,
                "prevEpochKey": H(K0)}))
    v("config_split_view", "the K_x anchor opened by a K_1 holder: CommitMismatch, without running GCM (H1).", c1, Kx,
      CONFIG1_TLV, CTX01, unreadable("commitMismatch"))
    _, cfg_enc = seal_doc(CONFIG0, K0, CONFIG0_TLV)
    v("config_version_1", "a config whose enc[0] is 0x01 is malformed.", c0, K0, None, CTX0, MALFORMED,
      enc=b"\x01" + cfg_enc[1:])
    v("config_short_v2", "a config enc under 61 bytes is malformed.", c0, K0, None, CTX0, MALFORMED, enc=cfg_enc[:60])
    v("config_non_anchor_with_prev", "a later config of epoch 1 that is not the anchor carries tags 8/9 like its anchor.",
      dict(CONFIG1, id="c1-later"), K1, CONFIG1_TLV, CTX01,
      readable({"defaultBranch": "refs/heads/main", "protectedPatterns": ["refs/heads/main"], "prevEpoch": 0,
                "prevEpochKey": H(K0)}))
    v("config_non_anchor", "a later config of epoch 1 without tags 8/9 is malformed: every config of an epoch "
      "e >= 1 must be able to serve as its anchor.",
      dict(CONFIG1, id="c1-later"), K1, tlv((6, b"refs/heads/dev")), CTX01, MALFORMED)
    v("config_empty_non_anchor", "an empty plaintext is valid for a non-anchor config.", dict(CONFIG0, id="c0-later"), K0,
      b"", CTX0, readable({}))
    v("config_patterns_repeat", "tag 7 repeats, order kept; a zero-length pattern counts as absent.",
      dict(CONFIG0, id="c0-later"), K0, tlv((7, b"refs/heads/main"), (7, b""), (7, b"refs/tags/**")), CTX0,
      readable({"protectedPatterns": ["refs/heads/main", "refs/tags/**"]}))
    # TLV strictness (§4.3): each sealed with a valid tag, so only the parse can refuse it
    T, B = rec(1, b"Rotate the signing key"), rec(2, b"See the runbook.")
    strict = [
        ("tlv_title_twice", "tag 1 twice is malformed.", T + T + B, MALFORMED),
        ("tlv_out_of_order", "tags out of order (2 then 1) are malformed.", B + T, MALFORMED),
        ("tlv_reserved_tag", "reserved tag 16 is malformed.", T + B + rec(16, b"x"), MALFORMED),
        ("tlv_event_value_in_issue", "tag 15 (an event value) in an issue is malformed.", T + B + rec(15, b"x"),
         MALFORMED),
        ("tlv_imported_in_issue", "tags 13 and 14 (imported.author, imported.url) open in an issue.",
         T + B + rec(13, b"octocat") + rec(14, b"https://github.com/acme/secret/issues/12"),
         readable(dict(ISSUE_FIELDS, importedAuthor="octocat", importedUrl="https://github.com/acme/secret/issues/12"))),
        ("tlv_burned_in_issue", "tag 11 (burned) is a config field: in an issue it is malformed.",
         T + B + rec(11, b"\x01"), MALFORMED),
        ("tlv_tag_zero", "tag 0 is not a field of any kind.", rec(0, b"x") + T + B, MALFORMED),
        ("tlv_extension_skipped", "extension tag 200 is skipped.", T + B + rec(200, b"future"), readable(ISSUE_FIELDS)),
        ("tlv_extension_twice", "an extension tag repeated is malformed like any repeated tag.",
         T + B + rec(200, b"a") + rec(200, b"b"), MALFORMED),
        ("tlv_trailing_bytes", "two trailing bytes after the last record are malformed.", T + B + b"\x00\x00", MALFORMED),
        ("tlv_length_past_end", "a record whose length runs past the end is malformed.", T + b"\x02\x00\x40abc", MALFORMED),
        ("tlv_ref_name_in_issue", "tag 3 in an issue is malformed.", T + rec(3, b"refs/heads/main"), MALFORMED),
        ("tlv_title_257_chars", "a title of 257 characters is malformed.", rec(1, b"a" * 257), MALFORMED),
        ("tlv_title_256_chars", "a title of 256 characters is fine.", rec(1, b"a" * 256), readable({"title": "a" * 256})),
        ("tlv_title_1024_bytes", "256 four-byte characters are 1024 bytes: at both caps, fine.",
         rec(1, "\U0001F600".encode() * 256), readable({"title": "\U0001F600" * 256})),
        ("tlv_invalid_utf8", "a UTF-8 field that is not valid UTF-8 is malformed.", rec(1, b"\xff\xfe"), MALFORMED),
        ("tlv_empty_title", "a zero-length title counts as absent, so the required title is missing.", rec(1, b"") + B,
         MALFORMED),
        ("tlv_empty_body", "a zero-length body is allowed (no minLength).", T + rec(2, b""),
         readable({"title": "Rotate the signing key", "body": ""})),
    ]
    for name, desc, pt, exp in strict:
        v(name, desc, ISSUE, K0, pt, CTX0, exp)
    v("tlv_prev_epoch_in_epoch0", "tags 8/9 in the epoch-0 anchor are malformed.", c0, K0, tlv((8, u32(0)), (9, K0)), CTX0,
      MALFORMED)
    v("tlv_prev_epoch_length_3", "tag 8 with length 3 is malformed.", c1, K1, tlv((8, b"\x00\x00\x00"), (9, K0)), CTX01,
      MALFORMED)
    v("tlv_anchor_without_prev_key", "an epoch-1 anchor without prevEpochKey is malformed.", c1, K1, tlv((8, u32(0))), CTX01,
      MALFORMED)
    v("tlv_burned_in_epoch0", "tag 11 (burned) in an epoch-0 config is malformed: epoch 0 is never burned.", c0, K0,
      tlv((6, b"refs/heads/main"), (11, b"\x01")), CTX0, MALFORMED)
    v("tlv_burned_bad_value", "tag 11 whose value is not the single byte 0x01 is malformed.", c1, K1,
      CONFIG1_TLV + rec(11, b"\x02"), CTX01, MALFORMED)
    v("tlv_burned_two_bytes", "tag 11 of length 2 is malformed.", c1, K1, CONFIG1_TLV + rec(11, b"\x01\x01"), CTX01,
      MALFORMED)
    v("config_burned_anchor", "an epoch-1 anchor with tags 8 and 11 opens with burned = true and no prevEpochKey.",
      c1, K1, CONFIG1_BURNED_TLV, CTX01,
      readable({"defaultBranch": "refs/heads/main", "protectedPatterns": ["refs/heads/main"], "prevEpoch": 0,
                "burned": True}))
    v("tlv_burned_with_prev_key", "a burned config carrying tag 9 (prevEpochKey) is malformed.", c1, K1,
      CONFIG1_TLV + rec(11, b"\x01"), CTX01, MALFORMED)
    v("tlv_burned_with_skip_key", "a burned config carrying tag 12 (skipEpochKey) is malformed.", c1, K1,
      CONFIG1_BURNED_TLV + rec(12, K0), CTX01, MALFORMED)
    v("tlv_skip_key_in_epoch0", "tag 12 in an epoch-0 config is malformed.", c0, K0,
      tlv((6, b"refs/heads/main"), (12, K0)), CTX0, MALFORMED)
    v("tlv_skip_key_length_31", "tag 12 of 31 bytes is malformed.", c1, K1, CONFIG1_TLV + rec(12, K0[:31]), CTX01,
      MALFORMED)
    v("tlv_skip_key_in_issue", "tag 12 is a config field: in an issue it is malformed.", ISSUE, K0,
      ISSUE_TLV + rec(12, K0), CTX0, MALFORMED)
    v("config_with_skip_key", "an epoch-1 config with tags 8, 9 and 12 opens with its skipEpochKey.", c1, K1,
      CONFIG1_TLV + rec(12, K0), CTX01,
      readable({"defaultBranch": "refs/heads/main", "protectedPatterns": ["refs/heads/main"], "prevEpoch": 0,
                "prevEpochKey": H(K0), "skipEpochKey": H(K0)}))
    v("content_under_burned_epoch_late",
      "an issue sealed under burned epoch 1 by a non-member is Unreadable(Late) at any height: nothing is written "
      "under a burned epoch.", dict(ISSUE, epoch=1), K1, ISSUE_TLV,
      ctx({0: K0, 1: K1}, {0: ("c0", 10), 1: ("c1", 1000)}, burned=[1]), unreadable("late"), height=1001)
    v("content_under_burned_epoch_from_member_shown",
      "the same issue by a current member is shown (an honest client that raced the burn).", dict(ISSUE, epoch=1), K1,
      ISSUE_TLV, ctx({0: K0, 1: K1}, {0: ("c0", 10), 1: ("c1", 1000)}, members=[H(ownerId)], burned=[1]),
      readable(ISSUE_FIELDS), height=1001)
    v("issue_edited_after_rotation_late",
      "an issue created under epoch 0 before the epoch-1 anchor (height 1000) and edited at 1000 + 241 by a removed "
      "member is Unreadable(LateEdit): an edit is judged by $updatedAtBlockHeight (§8.2 edits are judged too), and "
      "the reason says the document existed in time but was rewritten late (a replace keeps only the new text).",
      dict(ISSUE, updatedAtBlockHeight=1000 + GRACE_BLOCKS + 1), K0, ISSUE_TLV, CTX01, unreadable("lateEdit"), height=500)
    v("issue_created_late_and_edited_is_late",
      "an issue both created and edited after the grace period by a removed member is plain Unreadable(Late).",
      dict(ISSUE, updatedAtBlockHeight=5000), K0, ISSUE_TLV, CTX01, unreadable("late"), height=1000 + GRACE_BLOCKS + 1)
    v("issue_edited_within_grace_shown", "the same edit at 1000 + 240 is shown.",
      dict(ISSUE, updatedAtBlockHeight=1000 + GRACE_BLOCKS), K0, ISSUE_TLV, CTX01, readable(ISSUE_FIELDS), height=500)
    v("issue_edited_by_member_shown", "an edit after the grace period by a current member is shown.",
      dict(ISSUE, updatedAtBlockHeight=5000), K0, ISSUE_TLV,
      ctx({0: K0, 1: K1}, {0: ("c0", 10), 1: ("c1", 1000)}, members=[H(ownerId)]), readable(ISSUE_FIELDS), height=500)
    v("event_label", "a sealed label event opens to its value.", EVENT, K0, EVENT_TLV, CTX0,
      readable({"eventValue": "bug"}))
    _, event_enc = seal_doc(EVENT, K0, EVENT_TLV)
    v("event_other_target", "the AD binds targetId: an event's enc moved onto another issue fails the tag.",
      dict(EVENT, targetId="34" * 32), K0, None, CTX0, unreadable("badTag"), enc=event_enc)
    v("event_empty", "an event whose TLV has no value is malformed (the value is required).", EVENT, K0, b"", CTX0,
      MALFORMED)
    v("event_title", "tag 1 in an event is malformed.", EVENT, K0, tlv((1, b"t"), (15, b"bug")), CTX0, MALFORMED)
    v("event_value_480_bytes", "120 four-byte characters are 480 bytes: at both caps, fine.", EVENT, K0,
      rec(15, "\U0001F600".encode() * 120), CTX0, readable({"eventValue": "\U0001F600" * 120}))
    v("event_not_judged_late",
      "an event is member-gated at consensus (a removed member cannot write one), so the late rule does not "
      "apply: under epoch 0 past the epoch-1 anchor plus grace, by a non-member, it still opens (§8.1 step 7).",
      EVENT, K0, EVENT_TLV, CTX01, readable({"eventValue": "bug"}), height=1000 + GRACE_BLOCKS + 1)
    v("event_without_height",
      "the event schema carries no $createdAtBlockHeight: a sealed event without one opens (content types "
      "without it are malformed).", EVENT, K0, EVENT_TLV, CTX0, readable({"eventValue": "bug"}), height=None)
    v("tlv_nine_patterns", "more than 8 protectedPattern records are malformed.", dict(CONFIG0, id="c0-later"), K0,
      b"".join(rec(7, b"refs/heads/p") for _ in range(9)), CTX0, MALFORMED)


def pack_vectors():
    plain = mod251(40000)
    sealed, tags, nseg = seal_pack(K0, 0, plain)
    big = dict(repoId=H(repoId), key=H(K0), epoch=0, fileId=H(FILE_ID), plaintextMod251=40000)
    vector("private_pack_seal", "three_segments",
           "40,000 bytes at L = 14: 3 segments, packHash is the sealed bytes' sha256, never the plaintext's (§3).", big,
           dict(header=H(sealed[:36]), segments=nseg, sealedLen=len(sealed), tags=tags, packHash=H(sha256(sealed)),
                plaintextSha256=H(sha256(plain))))
    empty, etags, _ = seal_pack(K0, 0, b"")
    vector("private_pack_seal", "empty", "a zero-length plaintext is one 16-byte segment (52 bytes sealed).",
           dict(repoId=H(repoId), key=H(K0), epoch=0, fileId=H(FILE_ID), plaintextHex=""),
           dict(header=H(empty[:36]), segments=1, sealedLen=len(empty), tags=etags, packHash=H(sha256(empty)),
                plaintextSha256=H(sha256(b"")), sealed=H(empty)))

    # open: small artifacts at L = 10 (readers accept 10..20), so the files stay small
    small = mod251(2500)
    s10, _, _ = seal_pack(K0, 0, small, L=10)
    keys0 = {"0": H(K0)}

    def o(name, desc, sealed_bytes, size, expected, keys=keys0):
        vector("private_pack_open", name, desc, dict(repoId=H(repoId), keys=keys, sealed=H(sealed_bytes), sizeBytes=size),
               expected)

    ok = dict(plaintextSha256=H(sha256(small)), plaintextLen=len(small))
    o("three_segments_l10", "2,500 bytes at L = 10 open segment by segment.", s10, len(s10), ok)
    exact = mod251(2048)
    s_exact, _, _ = seal_pack(K0, 0, exact, L=10)
    o("exact_multiple_of_segment", "a plaintext that fills its last segment exactly has no empty extra segment.", s_exact,
      len(s_exact), dict(plaintextSha256=H(sha256(exact)), plaintextLen=2048))
    o("empty", "the empty artifact opens to zero bytes.", empty, len(empty), dict(plaintextSha256=H(sha256(b"")), plaintextLen=0))
    o("size_bytes_off_by_one", "the manifest's sizeBytes one byte off: the copy failed verification, nothing allocated.",
      s10, len(s10) + 1, dict(error="sizeMismatch"))
    no_final, _, _ = seal_pack(K0, 0, small, L=10, final_flags=[0, 0, 0])
    o("last_segment_not_final", "the last segment sealed with final = 0 fails its tag.", no_final, len(no_final),
      dict(error="sealedPackCorrupt"))
    early_final, _, _ = seal_pack(K0, 0, small, L=10, final_flags=[0, 1, 1])
    o("middle_segment_final", "a non-last segment sealed with final = 1 fails its tag (truncation defence).", early_final,
      len(early_final), dict(error="sealedPackCorrupt"))
    trunc = s10[:-(452 + 16)]
    o("truncated_by_one_segment", "truncated by one segment: caught by the length check before decryption.", trunc,
      len(trunc), dict(error="sealedPackCorrupt"))
    o("trailing_byte", "a trailing byte after the last segment is corrupt.", s10 + b"\x00", len(s10) + 1,
      dict(error="sealedPackCorrupt"))
    o("reserved_nonzero", "reserved = 0x0001 is refused.", s10[:6] + b"\x00\x01" + s10[8:], len(s10),
      dict(error="sealedPackCorrupt"))
    o("bad_magic", "a wrong magic is refused.", b"DFPX" + s10[4:], len(s10), dict(error="sealedPackCorrupt"))
    o("version_2", "an unknown header version is refused.", s10[:4] + b"\x02" + s10[5:], len(s10),
      dict(error="sealedPackCorrupt"))
    o("seg_log2_9", "L = 9 is refused.", s10[:5] + b"\x09" + s10[6:], len(s10), dict(error="sealedPackCorrupt"))
    o("seg_log2_21", "L = 21 is refused.", s10[:5] + bytes([21]) + s10[6:], len(s10), dict(error="sealedPackCorrupt"))
    o("header_epoch_changed", "the header's epoch changed to 1: the key and the AD change, every tag fails.",
      s10[:8] + u32(1) + s10[12:], len(s10), dict(error="sealedPackCorrupt"), keys={"0": H(K0), "1": H(K1)})
    o("no_key_for_epoch", "a header epoch the reader holds no key for: Unreadable(NoKey).", s10[:8] + u32(5) + s10[12:],
      len(s10), dict(error="noKey"))
    flipped = bytearray(s10)
    flipped[36 + 1040 + 5] ^= 1
    o("ciphertext_bit_flip", "one flipped ciphertext bit in segment 1 fails its tag.", bytes(flipped), len(s10),
      dict(error="sealedPackCorrupt"))
    swapped = s10[:36] + s10[36 + 1040:36 + 2080] + s10[36:36 + 1040] + s10[36 + 2080:]
    o("segments_swapped", "segments 0 and 1 swapped: the counter nonce catches reordering.", swapped, len(s10),
      dict(error="sealedPackCorrupt"))
    wrong_len = header(0, 2499, FILE_ID, L=10)
    o("plaintext_len_mismatch", "a header whose plaintextLen disagrees with the sealed length is corrupt.",
      wrong_len + s10[36:], len(s10), dict(error="sealedPackCorrupt"))

    def r(name, desc, a, b, seal=big, plain_=plain, sealed_=sealed, L=14):
        S = 1 << L
        s0, s1 = a >> L, (b - 1) >> L
        start, end = 36 + s0 * (S + 16), min(36 + (s1 + 1) * (S + 16), len(sealed_))
        vector("private_pack_range", name, desc, dict(seal=seal, range=[a, b]),
               dict(segments=[s0, s1], sealedRange=[start, end], output=H(plain_[a:b])))

    r("within_one_segment", "[20000, 20100) reads segment 1 only: sealed range [16436, 32836) (§3.5).", 20000, 20100)
    r("across_segments", "[16000, 17000) spans segments 0 and 1.", 16000, 17000)
    r("last_segment_to_end", "a range ending at plaintextLen ends at the sealed length.", 39990, 40000)
    r("first_byte", "[0, 1) reads segment 0.", 0, 1)
    vector("private_pack_range", "past_end", "a range past plaintextLen is refused.", dict(seal=big, range=[39990, 40001]),
           dict(error="outOfRange"))
    vector("private_pack_range", "empty_range", "an empty range is refused.", dict(seal=big, range=[5, 5]),
           dict(error="outOfRange"))


def wrap_vectors():
    base = dict(repoId=H(repoId), senderPriv=d_s.to_bytes(32, "big").hex(), senderPub=H(comp(Ps)),
                recipientPriv=d_r.to_bytes(32, "big").hex(), recipientPub=H(comp(Pr)))
    vector("private_wrap_seal", "epoch0",
           "shared key SHA-256(parity || x), the 47-byte plaintext 0x01 || KCV_0 || K_0, AES-256-CBC under the IV (§5.1).",
           dict(base, key=H(K0), epoch=0, iv=H(IV)),
           dict(shared=H(shared), plaintext=H(wrap_pt(K0, 0)), wrapped=H(cbc(shared, IV, wrap_pt(K0, 0)))))

    def o(name, desc, wrapped, priv_, pub, epoch, anchor_commit, expected):
        vector("private_wrap_open", name, desc,
               dict(repoId=H(repoId), epoch=epoch, wrapped=H(wrapped), readerPriv=priv_, counterpartyPub=pub,
                    anchorCommit=H(anchor_commit)), expected)

    w0 = cbc(shared, IV, wrap_pt(K0, 0))
    rp, sp = d_r.to_bytes(32, "big").hex(), d_s.to_bytes(32, "big").hex()
    o("recipient", "the recipient unwraps K_0; KCV matches; COMMIT_0 matches the epoch-0 anchor.", w0, rp, H(comp(Ps)), 0,
      commit(K0, 0), dict(key=H(K0)))
    o("sender_reads_back", "the sender reads its own wrap with its key and the recipient's public key.", w0, sp,
      H(comp(Pr)), 0, commit(K0, 0), dict(key=H(K0)))
    o("third_key", "a third key: padding error or KCV mismatch, WrapUnreadable.", w0, d_t.to_bytes(32, "big").hex(),
      H(comp(Ps)), 0, commit(K0, 0), dict(error="wrapUnreadable"))
    bad = bytearray(wrap_pt(K0, 0))
    bad[1] ^= 1
    o("kcv_flipped", "a KCV byte flipped in the plaintext: WrapUnreadable.", cbc(shared, IV, bytes(bad)), rp, H(comp(Ps)), 0,
      commit(K0, 0), dict(error="wrapUnreadable"))
    o("version_2", "a wrap plaintext whose version byte is not 0x01: WrapUnreadable.", cbc(shared, IV, wrap_pt(K0, 0, 2)),
      rp, H(comp(Ps)), 0, commit(K0, 0), dict(error="wrapUnreadable"))
    o("wrong_epoch", "K_0 wrapped for epoch 0, read as epoch 1: the KCV is per epoch, WrapUnreadable.", w0, rp, H(comp(Ps)),
      1, commit(K1, 1), dict(error="wrapUnreadable"))
    o("split_view_key", "a wrap of K_x (commit 89f8dd…7775) against the K_1 anchor: KeyMismatch.",
      cbc(shared, IV, wrap_pt(Kx, 1)), rp, H(comp(Ps)), 1, commit(K1, 1), dict(error="keyMismatch"))


# --- §5 epoch scenarios --------------------------------------------------------------------------

ALICE, BOB, CAROL, DAVE, ERIN, FRANK, MALLORY = ("a1" * 32, "b0" * 32, "c0" * 32, "d0" * 32, "e0" * 32, "f0" * 32,
                                                 "99" * 32)
K2, K3, Ky, Kz, Kd = (bytes([0x40 + i for i in range(32)]), bytes([0x60 + i for i in range(32)]), bytes([0x55]) * 32,
                      bytes([0x66]) * 32, bytes([0x88]) * 32)


def member(identity, role, at=1):
    return dict(identity=identity, role=role, createdAt=at)


def config(label, owner, epoch, K, height, prev=None, created_at=None, fields=b"", burned=False, skip=None):
    pt = fields
    if prev is not None:
        pt = pt + tlv((8, u32(prev[0])))
        if not burned:
            pt = pt + tlv((9, prev[1]))
    if burned:
        pt = pt + tlv((11, b"\x01"))
    if skip is not None:
        pt = pt + tlv((12, skip))
    _, enc = seal_doc(dict(type="config", ownerId=owner, epoch=epoch), K, pt)
    return dict(id=H(cid(label)), owner=owner, epoch=epoch, createdAtBlockHeight=height,
                createdAt=height * 1000 if created_at is None else created_at, enc=H(enc))


def wrap(wid, owner, member_id, epoch, K=None, enabled=True, key_id=4):
    w = dict(id=H(cid(wid)), owner=owner, memberId=member_id, epoch=epoch, recipientKeyId=key_id, keyEnabled=enabled)
    if K is not None:
        w["key"] = H(K)
    return w


def tie_ids():
    """Two ids whose raw-byte order and base58 string order disagree (base58 strings of 32-byte
    ids are 43 or 44 characters long)."""
    i = 0
    while True:
        a, b = sha256(b"tie a %d" % i), sha256(b"tie b %d" % i)
        lo, hi = min(a, b), max(a, b)
        if b58(lo) > b58(hi):
            return lo, hi
        i += 1


ID_FIELDS = ("identity", "owner", "memberId", "reader", "author", "id")


def to_base58(x, key=None):
    """Every 32-byte identity / id in `x` (hex) as base58, as the apps carry them."""
    if isinstance(x, dict):
        # the values of `anchors` (keyed by epoch) are ids too
        return {k: to_base58(v, "anchors" if key == "anchors" else k) for k, v in x.items()}
    if isinstance(x, list):
        return [to_base58(v, key) for v in x]
    if isinstance(x, str) and len(x) == 64 and key in ID_FIELDS + ("anchors", "members", "nonMembers", "missingWraps"):
        return b58(bytes.fromhex(x))
    return x


def epoch_vectors():
    team = [member(ALICE, "maintainer"), member(BOB, "writer")]
    c0 = config("c0", ALICE, 0, K0, 10)
    c1 = config("c1", ALICE, 1, K1, 1000, prev=(0, K0))

    def ev(name, desc, memberships, configs, wraps, expected, reader=BOB, content=None, manifests=None,
           base58=False):
        inp = dict(repoId=H(repoId), reader=reader, memberships=memberships, configs=configs, wraps=wraps)
        if content is not None:
            inp["contentQueries"] = content
        if manifests is not None:
            inp["manifestQueries"] = manifests
        full = dict(currentEpoch=None, anchors={}, readable=[], writeEpoch=None, unanchored=[], alerts=[],
                    repair=None)
        full.update(expected)
        full["anchors"] = {e: H(cid(label)) for e, label in full["anchors"].items()}
        if base58:
            inp, full = to_base58(inp), to_base58(full)
            inp["idEncoding"] = "base58"
        vector("private_epoch", name, desc, inp, full)

    def repair(rotate=False, non_members=(), missing=()):
        return dict(rotate=rotate, nonMembers=sorted(non_members), missingWraps=sorted(missing))

    ok_repair = repair()
    ev("accept_wrap_from_current_maintainer", "a current maintainer's wrap whose key commits to the anchor is accepted.",
       team, [c0], [wrap("w0a", ALICE, ALICE, 0), wrap("w0b", ALICE, BOB, 0, K0)],
       dict(currentEpoch=0, anchors={"0": "c0"}, readable=[0], writeEpoch=0, repair=ok_repair))
    ev("reject_wrap_from_non_maintainer", "a wrap written by a writer is ignored.",
       team + [member(CAROL, "writer")], [c0], [wrap("w0a", ALICE, ALICE, 0), wrap("w0b", ALICE, BOB, 0),
                                                 wrap("w0c", CAROL, BOB, 0, K0)],
       dict(currentEpoch=0, anchors={"0": "c0"}, repair=repair(missing=[CAROL])))
    ev("revoked_maintainer_wrap_not_current",
       "a wrap by an identity with no current maintainer document is ignored, though the gate admitted it (C1).",
       team, [c0], [wrap("w0a", ALICE, ALICE, 0), wrap("w0d", DAVE, BOB, 0, K0)],
       dict(currentEpoch=0, anchors={"0": "c0"}, repair=repair(missing=[BOB])))
    ev("removed_maintainer_preposted_anchor_ignored",
       "a config for epoch 1 by a since-removed maintainer, earlier by block height, is not the anchor; the current "
       "maintainer's later config is (C1).",
       team, [c0, config("c1-dave", DAVE, 1, Kd, 500, prev=(0, K0)), c1],
       [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1), wrap("w1d", DAVE, BOB, 1, Kd)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1, repair=ok_repair))
    ev("anchor_first_by_block_height_then_id_among_current_maintainers",
       "at equal block heights the smaller $id is the anchor; a writer's config never is; the loser's wrap is a "
       "KeyMismatch naming the loser.",
       team + [member(ERIN, "maintainer"), member(CAROL, "writer")],
       [c0, config("c1-writer", CAROL, 1, Kz, 900, prev=(0, K0)), config("c1-a", ERIN, 1, K1, 1000, prev=(0, K0)),
        config("c1-b", ALICE, 1, Ky, 1000, prev=(0, K0))],
       [wrap("w1e", ERIN, BOB, 1, K1), wrap("w1a", ALICE, BOB, 1, Ky), wrap("w1ea", ERIN, ALICE, 1),
        wrap("w1ee", ERIN, ERIN, 1), wrap("w1ec", ERIN, CAROL, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1-a"}, readable=[0, 1], writeEpoch=1,
            alerts=[dict(kind="keyMismatch", epoch=1, author=ALICE)], repair=ok_repair))
    lo, hi = tie_ids()
    assert lo < hi and b58(lo) > b58(hi)
    EXPLICIT_IDS["tie-lo"], EXPLICIT_IDS["tie-hi"] = lo, hi
    tie = dict(
        memberships=team + [member(ERIN, "maintainer")],
        configs=[c0, config("tie-hi", ALICE, 1, Ky, 1000, prev=(0, K0)), config("tie-lo", ERIN, 1, K1, 1000, prev=(0, K0))],
        wraps=[wrap("w1e", ERIN, BOB, 1, K1), wrap("w1a", ALICE, BOB, 1, Ky), wrap("w1ea", ERIN, ALICE, 1),
               wrap("w1ee", ERIN, ERIN, 1)],
        expected=dict(currentEpoch=1, anchors={"0": "c0", "1": "tie-lo"}, readable=[0, 1], writeEpoch=1,
                      alerts=[dict(kind="keyMismatch", epoch=1, author=ALICE)], repair=ok_repair),
    )
    ev("anchor_tie_by_raw_id_bytes_not_base58",
       "at equal block heights the anchor is the smaller $id as raw bytes; here the base58 strings sort the other way "
       "(a 43- against a 44-character id), so a string compare would pick the wrong anchor (M2).", **tie)
    ev("base58_identities", "the same tie with every identity and id in base58, the apps' form: both harnesses convert "
       "at the boundary and resolve identically.", **tie, base58=True)
    ev("anchor_created_at_ms_not_used_for_order",
       "the client-set $createdAt is not an order: the lower block height wins though its $createdAt is later.",
       team + [member(ERIN, "maintainer")],
       [c0, config("c1-x", ERIN, 1, Ky, 1100, prev=(0, K0), created_at=5),
        config("c1-y", ALICE, 1, K1, 1000, prev=(0, K0), created_at=9_999_999)],
       [wrap("w1a", ALICE, BOB, 1, K1), wrap("w1e", ERIN, BOB, 1, Ky), wrap("w1aa", ALICE, ALICE, 1),
        wrap("w1ae", ALICE, ERIN, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1-y"}, readable=[0, 1], writeEpoch=1,
            alerts=[dict(kind="keyMismatch", epoch=1, author=ERIN)], repair=ok_repair))
    ev("anchor_does_not_open_alert_no_skip",
       "the anchor commits to K_x; the reader's K_1 wrap is a KeyMismatch and the later K_1 config is not used (H1).",
       team + [member(ERIN, "maintainer")],
       [c0, config("c1-x", ERIN, 1, Kx, 1000, prev=(0, K0)), config("c1-later", ALICE, 1, K1, 1001, prev=(0, K0))],
       [wrap("w0b", ALICE, BOB, 0, K0), wrap("w1b", ALICE, BOB, 1, K1), wrap("w1a", ALICE, ALICE, 1),
        wrap("w1e", ALICE, ERIN, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1-x"}, readable=[0], writeEpoch=None,
            alerts=[dict(kind="keyMismatch", epoch=1, author=ALICE)], repair=ok_repair))
    ev("unanchored_epoch_not_writable_and_unreadable",
       "epoch 2 has wraps but no anchor (a crash between steps 2 and 3): it does not exist.",
       team, [c0, c1], [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1), wrap("w2b", ALICE, BOB, 2, K2)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1, unanchored=[2],
            repair=ok_repair))
    ev("current_epoch_is_highest_anchored",
       "epochs 0, 1 and 2 exist: the current epoch is 2, though the reader holds only epoch 1 (and 0 through the "
       "chain), so it has no write epoch.",
       team, [c0, c1, config("c2", ALICE, 2, K2, 2000, prev=(1, K1))],
       [wrap("w1b", ALICE, BOB, 1, K1), wrap("w2a", ALICE, ALICE, 2)],
       dict(currentEpoch=2, anchors={"0": "c0", "1": "c1", "2": "c2"}, readable=[0, 1], writeEpoch=None,
            repair=repair(missing=[BOB])))
    ev("epoch_gap_ignored",
       "configs for epochs 0, 1 and 3: epochs exist only contiguously from 0, so epoch 3 is not an epoch (an "
       "EpochGap alert names its author), its wraps are ignored and the current epoch is 1.",
       team, [c0, c1, config("c3", ALICE, 3, K3, 3000, prev=(2, K2))],
       [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1), wrap("w3a", ALICE, ALICE, 3),
        wrap("w3b", ALICE, BOB, 3, K3)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1, unanchored=[3],
            alerts=[dict(kind="epochGap", epoch=3, author=ALICE)], repair=ok_repair))
    ev("huge_epoch_from_removed_maintainer_ignored",
       "a since-removed maintainer's config and wrap at epoch 4294967295 are no candidates at all (C1): no alert, "
       "and the next rotation is still epoch 2.",
       team, [c0, c1, config("c-max", DAVE, 0xFFFFFFFF, Kd, 5000, prev=(0xFFFFFFFE, K0))],
       [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1), wrap("wmax", DAVE, BOB, 0xFFFFFFFF, Kd)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1, unanchored=[0xFFFFFFFF],
            repair=ok_repair))
    ev("huge_epoch_from_current_maintainer_is_a_gap",
       "a current maintainer's config at epoch 4294967295 is above a gap: an EpochGap alert, never the current "
       "epoch, so it cannot exhaust the epoch numbers.",
       team + [member(ERIN, "maintainer")],
       [c0, c1, config("c-max", ERIN, 0xFFFFFFFF, Kd, 5000, prev=(0xFFFFFFFE, K0))],
       [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1), wrap("w1e", ALICE, ERIN, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1, unanchored=[0xFFFFFFFF],
            alerts=[dict(kind="epochGap", epoch=0xFFFFFFFF, author=ERIN)], repair=ok_repair))
    ev("preposted_future_config_ignored",
       "a current maintainer's config for epoch 2 at block 500, before epoch 1 was anchored (block 1000), is never "
       "epoch 2's anchor, though it is first by block height: the later config is, and the reader's wrap of its key is "
       "accepted.",
       team, [c0, c1, config("c2-pre", ALICE, 2, Kd, 500, prev=(1, K1)), config("c2", ALICE, 2, K2, 2000, prev=(1, K1))],
       [wrap("w2a", ALICE, ALICE, 2), wrap("w2b", ALICE, BOB, 2, K2)],
       dict(currentEpoch=2, anchors={"0": "c0", "1": "c1", "2": "c2"}, readable=[0, 1, 2], writeEpoch=2,
            repair=ok_repair))
    ev("preposted_config_ignored_after_regrant",
       "dave pre-posted configs for epochs 1 and 2 (blocks 5 and 500) while an earlier maintainer, lost the role, and "
       "was granted it again: neither comes after the anchor below it, so alice's configs stay the anchors; an epoch "
       "whose only config is pre-posted does not exist (EpochGap).",
       team + [member(DAVE, "maintainer")],
       [c0, c1, config("c1-dave", DAVE, 1, Kd, 5, prev=(0, K0)), config("c2-dave", DAVE, 2, Kd, 500, prev=(1, K1)),
        config("c3-dave", DAVE, 3, Kd, 600, prev=(2, Kd))],
       [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1), wrap("w1d", ALICE, DAVE, 1),
        wrap("w2d", DAVE, BOB, 2, Kd)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1, unanchored=[2, 3],
            alerts=[dict(kind="epochGap", epoch=2, author=DAVE), dict(kind="epochGap", epoch=3, author=DAVE)],
            repair=ok_repair))
    EXPLICIT_IDS["c0-hi"], EXPLICIT_IDS["c1-lo"] = b"\x90" * 32, b"\x10" * 32
    ev("anchor_tie_at_same_height_after_prev_by_id",
       "epoch 1's only config shares epoch 0's anchor block height: it counts only if its $id is greater (raw bytes); "
       "here it is smaller, so epoch 1 does not exist.",
       team, [config("c0-hi", ALICE, 0, K0, 10), config("c1-lo", ALICE, 1, K1, 10, prev=(0, K0))],
       [wrap("w0a", ALICE, ALICE, 0), wrap("w0b", ALICE, BOB, 0, K0), wrap("w1b", ALICE, BOB, 1, K1)],
       dict(currentEpoch=0, anchors={"0": "c0-hi"}, readable=[0], writeEpoch=0, unanchored=[1],
            alerts=[dict(kind="epochGap", epoch=1, author=ALICE)], repair=ok_repair))
    ev("reanchor_of_middle_epoch_keeps_epochs_above",
       "dave anchored epoch 1 and was removed; alice re-anchored it (block 3500) after epoch 2's anchor (block 2000). "
       "Epoch 2 still counts: it comes after epoch 1's key was first stated (dave's config, block 1000, the same "
       "commitment), which no removal moves.",
       team, [c0, config("c1-dave", DAVE, 1, K1, 1000, prev=(0, K0)), config("c2", ALICE, 2, K2, 2000, prev=(1, K1)),
              config("c1-re", ALICE, 1, K1, 3500, prev=(0, K0))],
       [wrap("w2a", ALICE, ALICE, 2), wrap("w2b", ALICE, BOB, 2, K2)],
       dict(currentEpoch=2, anchors={"0": "c0", "1": "c1-re", "2": "c2"}, readable=[0, 1, 2], writeEpoch=2,
            repair=ok_repair))
    ev("preposted_after_other_key_ignored",
       "a since-removed maintainer's config for epoch 1 (block 500, another key) states nothing about epoch 1's key: "
       "erin's config for epoch 2 at block 700, before alice's epoch-1 anchor (block 1000) stated K_1, never counts, "
       "and the later epoch-2 config is the anchor.",
       team + [member(ERIN, "maintainer")],
       [c0, config("c1-dave", DAVE, 1, Kd, 500, prev=(0, K0)), c1, config("c2-pre", ERIN, 2, Ky, 700, prev=(1, K1)),
        config("c2", ALICE, 2, K2, 2000, prev=(1, K1))],
       [wrap("w2a", ALICE, ALICE, 2), wrap("w2b", ALICE, BOB, 2, K2), wrap("w2e", ALICE, ERIN, 2)],
       dict(currentEpoch=2, anchors={"0": "c0", "1": "c1", "2": "c2"}, readable=[0, 1, 2], writeEpoch=2,
            repair=ok_repair))
    ev("chain_walk_reaches_epoch_0_from_one_wrap", "one wrap for epoch 2 reads epochs 2, 1 and 0 through the chain.",
       team, [c0, c1, config("c2", ALICE, 2, K2, 2000, prev=(1, K1))],
       [wrap("w2a", ALICE, ALICE, 2), wrap("w2b", ALICE, BOB, 2, K2)],
       dict(currentEpoch=2, anchors={"0": "c0", "1": "c1", "2": "c2"}, readable=[0, 1, 2], writeEpoch=2, repair=ok_repair))
    ev("chain_with_skipped_epoch_number",
       "epoch 2's anchor names prevEpoch 0 and there is no epoch 1: epoch 2 is above a gap, so it is not an epoch "
       "(EpochGap), and the reader's wrap for it is ignored.",
       team, [c0, config("c2", ALICE, 2, K2, 2000, prev=(0, K0))],
       [wrap("w0a", ALICE, ALICE, 0), wrap("w0b", ALICE, BOB, 0, K0), wrap("w2a", ALICE, ALICE, 2),
        wrap("w2b", ALICE, BOB, 2, K2)],
       dict(currentEpoch=0, anchors={"0": "c0"}, readable=[0], writeEpoch=0, unanchored=[2],
            alerts=[dict(kind="epochGap", epoch=2, author=ALICE)], repair=ok_repair))
    ev("chain_prev_epoch_must_be_e_minus_1",
       "epochs 0, 1 and 2 exist, but epoch 2's anchor names prevEpoch 0 (skipping 1): each anchor chains to exactly "
       "the epoch below it, so the chain is broken at 2 and only epoch 2 is readable.",
       team, [c0, c1, config("c2", ALICE, 2, K2, 2000, prev=(0, K0))],
       [wrap("w2a", ALICE, ALICE, 2), wrap("w2b", ALICE, BOB, 2, K2)],
       dict(currentEpoch=2, anchors={"0": "c0", "1": "c1", "2": "c2"}, readable=[2], writeEpoch=2,
            alerts=[dict(kind="chainBroken", epoch=2, author=ALICE)], repair=ok_repair))
    ev("chain_prev_epoch_must_be_smaller", "an anchor naming prevEpoch >= its own epoch breaks the chain (L2).",
       team, [c0, config("c1", ALICE, 1, K1, 1000, prev=(1, K1))],
       [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[1], writeEpoch=1,
            alerts=[dict(kind="chainBroken", epoch=1, author=ALICE)], repair=ok_repair))
    ev("chain_key_must_open_first_anchor_of_prev",
       "prevEpochKey commits to a later epoch-0 config, not epoch 0's anchor: ChainBroken (L2).",
       team, [c0, config("c0-later", ALICE, 0, Kz, 20), config("c1", ALICE, 1, K1, 1000, prev=(0, Kz))],
       [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[1], writeEpoch=1,
            alerts=[dict(kind="chainBroken", epoch=1, author=ALICE)], repair=ok_repair))
    ev("chain_prev_epoch_without_anchor",
       "prevEpoch names epoch 0, which has no anchor: without epoch 0 no epoch exists, so epoch 1 is a gap "
       "(EpochGap) and nothing is readable.",
       team, [config("c1", ALICE, 1, K1, 1000, prev=(0, K0))],
       [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1)],
       dict(unanchored=[1], alerts=[dict(kind="epochGap", epoch=1, author=ALICE)]))
    c1_burned = config("c1-burned", ALICE, 1, K1, 1000, prev=(0, K0), burned=True)
    ev("burned_anchor_has_no_prev_key",
       "a reader whose only wrap is for burned epoch 1 (the leaked key) reads epoch 1 alone: the burned anchor "
       "carries no prevEpochKey, so K_0 never reaches someone who only ever held the burned key.",
       team, [c0, c1_burned], [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1-burned"}, readable=[1], writeEpoch=None,
            repair=repair(rotate=True)))
    ev("burned_epoch_not_writable",
       "epoch 1's anchor is burned: it exists and is readable (a chain link), but nothing is written under it, "
       "content under it is late unless its author is a current member, a manifest under it is suspect, and the "
       "repair check rotates though no non-member is wrapped.",
       team, [c0, c1_burned],
       [wrap("w0b", ALICE, BOB, 0, K0), wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1-burned"}, readable=[0, 1], writeEpoch=None,
            repair=repair(rotate=True), content=["late", "shown"],
            manifests=[dict(suspect=True, readable=False), dict(suspect=True, readable=True)]),
       content=[dict(epoch=1, createdAtBlockHeight=1001, owner=MALLORY),
                dict(epoch=1, createdAtBlockHeight=1001, owner=BOB)],
       manifests=[dict(headerEpoch=1, createdAtBlockHeight=1001, owner=MALLORY),
                  dict(headerEpoch=1, createdAtBlockHeight=1001, owner=BOB)])
    ev("burned_epoch_chain_walks",
       "a wrap for epoch 2 walks the chain through burned epoch 1 (prevEpochKey = K_1) and on to 0 with its "
       "skipEpochKey = K_0: a burned epoch is still a link.",
       team, [c0, c1_burned, config("c2", ALICE, 2, K2, 2000, prev=(1, K1), skip=K0)],
       [wrap("w2a", ALICE, ALICE, 2), wrap("w2b", ALICE, BOB, 2, K2)],
       dict(currentEpoch=2, anchors={"0": "c0", "1": "c1-burned", "2": "c2"}, readable=[0, 1, 2], writeEpoch=2,
            repair=ok_repair, content=["late", "shown"]),
       content=[dict(epoch=1, createdAtBlockHeight=999_999, owner=MALLORY),
                dict(epoch=0, createdAtBlockHeight=1000, owner=MALLORY)])
    c2_burned = config("c2-burned", ALICE, 2, K2, 2000, prev=(1, K1), burned=True)
    ev("skip_key_walks_past_burned",
       "epoch 2 is burned; epoch 3's anchor carries prevEpochKey = K_2 and skipEpochKey = K_1, the nearest epoch "
       "below that is not burned: one wrap for 3 reads 3, 2, then 1 and 0.",
       team, [c0, c1, c2_burned, config("c3", ALICE, 3, K3, 3000, prev=(2, K2), skip=K1)],
       [wrap("w3a", ALICE, ALICE, 3), wrap("w3b", ALICE, BOB, 3, K3)],
       dict(currentEpoch=3, anchors={"0": "c0", "1": "c1", "2": "c2-burned", "3": "c3"}, readable=[0, 1, 2, 3],
            writeEpoch=3, repair=ok_repair))
    ev("consecutive_burned_skip",
       "epochs 1 and 2 are both burned: epoch 3's skipEpochKey is K_0, the nearest epoch below the run that is not "
       "burned; the walk reaches 2 (its prevEpochKey) and 0, and burned epoch 1 stays unreadable (nothing is sealed "
       "under it).",
       team, [c0, c1_burned, config("c2-burned", ALICE, 2, K2, 2000, prev=(1, K1), burned=True),
              config("c3", ALICE, 3, K3, 3000, prev=(2, K2), skip=K0)],
       [wrap("w3a", ALICE, ALICE, 3), wrap("w3b", ALICE, BOB, 3, K3)],
       dict(currentEpoch=3, anchors={"0": "c0", "1": "c1-burned", "2": "c2-burned", "3": "c3"}, readable=[0, 2, 3],
            writeEpoch=3, repair=ok_repair))
    ev("missing_skip_key_chain_broken",
       "epoch 2's anchor sits above burned epoch 1 but carries no skipEpochKey: the chain is broken at 2, and the "
       "walk reaches burned epoch 1 only.",
       team, [c0, c1_burned, config("c2", ALICE, 2, K2, 2000, prev=(1, K1))],
       [wrap("w2a", ALICE, ALICE, 2), wrap("w2b", ALICE, BOB, 2, K2)],
       dict(currentEpoch=2, anchors={"0": "c0", "1": "c1-burned", "2": "c2"}, readable=[1, 2], writeEpoch=2,
            alerts=[dict(kind="chainBroken", epoch=2, author=ALICE)], repair=ok_repair))
    ev("burned_current_requires_rotation",
       "a maintainer reading a burned current epoch is asked to rotate (RotationRequired with no members): any "
       "maintainer finishes an interrupted burn.",
       team, [c0, c1_burned],
       [wrap("w0a", ALICE, ALICE, 0, K0), wrap("w1a", ALICE, ALICE, 1, K1), wrap("w1b", ALICE, BOB, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1-burned"}, readable=[0, 1], writeEpoch=None,
            alerts=[dict(kind="rotationRequired", epoch=1, members=[])], repair=repair(rotate=True)), reader=ALICE)
    ev("burned_flag_only_on_the_anchor_counts",
       "a later config of epoch 1 carries the burned flag, but the anchor does not: epoch 1 is not burned.",
       team, [c0, c1, config("c1-later", ALICE, 1, K1, 1100, prev=(0, K0), burned=True)],
       [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1, repair=ok_repair))
    ev("rotation_required_when_wrapped_non_member",
       "the current epoch is wrapped to an identity that is not a member: the repair check rotates (H2), and "
       "nothing is written under it meanwhile (no write epoch).",
       team, [c0, c1], [wrap("w1a", ALICE, ALICE, 1, K1), wrap("w1b", ALICE, BOB, 1), wrap("w1m", ALICE, MALLORY, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=None,
            alerts=[dict(kind="rotationRequired", epoch=1, members=[MALLORY])],
            repair=repair(rotate=True, non_members=[MALLORY])), reader=ALICE)
    ev("rotation_alert_only_for_maintainers",
       "the repair check finds a wrapped non-member, but only a maintainer's client is asked to rotate.",
       team, [c0, c1], [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1), wrap("w1m", ALICE, MALLORY, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=None,
            repair=repair(rotate=True, non_members=[MALLORY])))
    ev("missing_wrap_repaired_without_rotation", "a member with no wrap for the current epoch is wrapped, no rotation.",
       team + [member(FRANK, "writer")], [c0, c1], [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, repair=repair(missing=[FRANK])), reader=ALICE)
    # RC2 member roles: a reader is a writer document (role 3), so it is a key recipient like any member
    ev("missing_reader_wrap_repaired", "a reader (a writer document with role 3) is a member for the key: its missing "
       "wrap for the current epoch is written, no rotation.",
       team + [member(FRANK, "reader")], [c0, c1], [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, repair=repair(missing=[FRANK])), reader=ALICE)
    ev("wrap_to_reader_no_rotation", "a wrap to a reader is a wrap to a member: no rotation, and the reader opens "
       "every epoch.",
       team + [member(FRANK, "reader")], [c0, c1],
       [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1), wrap("w1f", ALICE, FRANK, 1, K1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1, repair=ok_repair),
       reader=FRANK)
    ev("wrap_to_disabled_key_requires_repair", "a member whose only wrap is to a since-disabled key needs a new wrap.",
       team, [c0, c1], [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1, enabled=False)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1,
            repair=repair(missing=[BOB])))
    ev("wrap_unreadable_is_skipped", "a wrap the reader cannot open (no key given) is skipped without an alert.",
       team, [c0], [wrap("w0a", ALICE, ALICE, 0), wrap("w0b", ALICE, BOB, 0)],
       dict(currentEpoch=0, anchors={"0": "c0"}, repair=ok_repair))
    ev("outsider_reads_nothing", "an identity with no wrap reads nothing.", team, [c0, c1],
       [wrap("w1a", ALICE, ALICE, 1), wrap("w1b", ALICE, BOB, 1, K1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, repair=ok_repair), reader=MALLORY)
    ev("no_anchor_no_epoch", "a repo with no current-maintainer config has no epoch at all.", team,
       [config("c0-dave", DAVE, 0, K0, 10)], [wrap("w0b", DAVE, BOB, 0, K0)],
       dict(unanchored=[0]))
    ev("two_wraps_same_key", "two maintainers wrapping the same key for one member agree: no alert.",
       team + [member(ERIN, "maintainer")], [c0],
       [wrap("w0a", ALICE, BOB, 0, K0), wrap("w0e", ERIN, BOB, 0, K0), wrap("w0aa", ALICE, ALICE, 0),
        wrap("w0ae", ALICE, ERIN, 0)],
       dict(currentEpoch=0, anchors={"0": "c0"}, readable=[0], writeEpoch=0, repair=ok_repair))
    late_team = team
    ev("late_content_hidden_after_next_anchor_plus_grace",
       "a document under epoch 0 at the epoch-1 anchor height + 241 by a removed member is Unreadable(Late) (M2).",
       late_team, [c0, c1], [wrap("w1b", ALICE, BOB, 1, K1), wrap("w1a", ALICE, ALICE, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1, repair=ok_repair,
            content=["late"]),
       content=[dict(epoch=0, createdAtBlockHeight=1000 + GRACE_BLOCKS + 1, owner=MALLORY)])
    ev("late_content_within_grace_shown", "at the anchor height + 240 the document is shown.",
       late_team, [c0, c1], [wrap("w1b", ALICE, BOB, 1, K1), wrap("w1a", ALICE, ALICE, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1, repair=ok_repair,
            content=["shown", "shown"]),
       content=[dict(epoch=0, createdAtBlockHeight=1000 + GRACE_BLOCKS, owner=MALLORY),
                dict(epoch=1, createdAtBlockHeight=999_999, owner=MALLORY)])
    ev("late_content_from_current_member_shown", "late content by a current member is shown.",
       late_team, [c0, c1], [wrap("w1b", ALICE, BOB, 1, K1), wrap("w1a", ALICE, ALICE, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1, repair=ok_repair,
            content=["shown"]),
       content=[dict(epoch=0, createdAtBlockHeight=5000, owner=BOB)])
    ev("manifest_under_old_epoch_flagged_suspect",
       "a manifest whose sealed header epoch is older than the epoch current at its block height is suspect, and read "
       "only if its uploader is a current member (§8.2).",
       late_team, [c0, c1], [wrap("w1b", ALICE, BOB, 1, K1), wrap("w1a", ALICE, ALICE, 1)],
       dict(currentEpoch=1, anchors={"0": "c0", "1": "c1"}, readable=[0, 1], writeEpoch=1, repair=ok_repair,
            manifests=[dict(suspect=True, readable=False), dict(suspect=True, readable=True),
                       dict(suspect=False, readable=True), dict(suspect=False, readable=True),
                       dict(suspect=True, readable=False)]),
       manifests=[dict(headerEpoch=0, createdAtBlockHeight=1100, owner=MALLORY),
                  dict(headerEpoch=0, createdAtBlockHeight=1100, owner=BOB),
                  dict(headerEpoch=1, createdAtBlockHeight=1100, owner=MALLORY),
                  dict(headerEpoch=0, createdAtBlockHeight=500, owner=MALLORY),
                  dict(headerEpoch=0, createdAtBlockHeight=1000 + GRACE_BLOCKS + 1, owner=MALLORY)])



# --- §4 sealed collaboration documents (the CLI's and the web's writers, same bytes) -------------

SEALED = {"issue": ("title", "body"), "patch": ("title", "body", "baseRefName", "sourceRefName"),
          "comment": ("body", "path"), "review": ("body",), "event": ("value",)}
TLV_TAG = {"title": 1, "body": 2, "baseRefName": 4, "sourceRefName": 5, "path": 10, "importedAuthor": 13,
           "importedUrl": 14, "value": 15}
BIND_OF = {"issue": "number", "patch": "number", "comment": "targetId", "review": "patchId", "event": "targetId"}
# the plaintext text cap per type: enc 5120 - v0x01 framing 29 - 3 bytes per TLV record
TEXT_CAP = {"issue": 5120 - 29 - 6, "patch": 5120 - 29 - 12, "comment": 5120 - 29 - 6, "review": 5120 - 29 - 3}


def seal_collab(doc_type, props, K=K0, epoch=0, owner=ownerId, nonce=NONCE):
    """The sealed properties of a `doc_type` document whose public properties are `props`."""
    out = {k: v for k, v in props.items() if k not in SEALED[doc_type]}
    fields = [(TLV_TAG[f], props[f].encode()) for f in SEALED[doc_type] if f in props]
    if "imported" in props:
        imp = dict(props["imported"])
        for f, tag in (("author", "importedAuthor"), ("url", "importedUrl")):
            if f in imp:
                fields.append((TLV_TAG[tag], imp.pop(f).encode()))
        out["imported"] = imp
    pt = tlv(*sorted(fields))
    if len(pt) > 5120 - 29:
        return None
    doc = dict(type=doc_type, ownerId=H(owner), epoch=epoch)
    doc[BIND_OF[doc_type]] = props[BIND_OF[doc_type]]
    if doc_type == "patch":
        out["baseRefNameHash"] = H(ref_hash(K, epoch, props["baseRefName"]))
        out.pop("sourceRefNameHash", None)
        if "sourceRefName" in props:
            out["sourceRefNameHash"] = H(ref_hash(K, epoch, props["sourceRefName"]))
    _, enc = seal_doc(doc, K, pt, nonce)
    out["epoch"] = epoch
    out["enc"] = H(enc)
    return out


def collab_seal_vectors():
    def v(name, desc, doc_type, props):
        sealed = seal_collab(doc_type, props)
        inp = dict(repoId=H(repoId), key=H(K0), epoch=0, ownerId=H(ownerId), docType=doc_type, nonce=H(NONCE),
                   props=props)
        vector("private_collab_seal", name, desc, inp, dict(error="tooLarge") if sealed is None else dict(props=sealed))

    patch_hashes = dict(baseRefNameHash=H(sha256(b"refs/heads/main")), sourceRefNameHash=H(sha256(b"refs/heads/feature")))
    v("issue_7", "issue #7: title and body move into enc (TLV 1, 2); number stays plaintext and is bound in the AD.",
      "issue", dict(number=7, title="Rotate the signing key", body="See the runbook."))
    v("issue_renumbered_8", "the same issue claimed as #8 (a renumbered retry): the AD binds the number, so enc differs.",
      "issue", dict(number=8, title="Rotate the signing key", body="See the runbook."))
    v("issue_empty_body", "an issue without a body: only the title record is sealed.", "issue",
      dict(number=9, title="Title only"))
    v("patch_with_source",
      "a PR from a fork: title, body and both branch names are sealed; the hashes become HMAC(K_ref,0, name); "
      "sourceRepoId, headOid, patchManifestHash and draft stay plaintext.", "patch",
      dict(number=3, title="Add the feature", body="Closes #7.", baseRefName="refs/heads/main",
           sourceRefName="refs/heads/feature", sourceRepoId="55" * 32, headOid="aa" * 20,
           patchManifestHash="66" * 32, draft=True, **patch_hashes))
    v("patch_no_source", "a PR with no source branch: no sourceRefNameHash at all.", "patch",
      dict(number=4, title="Fix", baseRefName="refs/heads/main", baseRefNameHash=patch_hashes["baseRefNameHash"],
           sourceRepoId=H(repoId), headOid="bb" * 20))
    v("comment_inline_reply",
      "an inline reply inside a review: body and path are sealed; targetId (bound), replyTo, reviewId, commitOid, "
      "line, startLine and side stay plaintext.", "comment",
      dict(targetId="33" * 32, body="nit: rename", path="src/lib.rs", replyTo="77" * 32, reviewId="88" * 32,
           commitOid="cc" * 20, line=12, startLine=10, side=1))
    v("comment_plain", "a plain comment: only the body is sealed.", "comment", dict(targetId="33" * 32, body="LGTM"))
    v("review_with_body", "a review: the body is sealed; patchId (bound), verdict, commitOid and commentCount stay "
      "plaintext.", "review", dict(patchId="44" * 32, verdict=1, commitOid="dd" * 20, body="Ship it.", commentCount=2))
    v("review_empty", "a review without a body seals an empty TLV (a 29-byte enc).", "review",
      dict(patchId="44" * 32, verdict=3, commitOid="dd" * 20))
    v("issue_imported",
      "an imported issue: imported.author and imported.url are sealed (TLV 13, 14; they name the source org, repo "
      "and people); imported.createdAt stays plaintext, alone in its object.", "issue",
      dict(number=12, title="Imported", body="from GitHub",
           imported=dict(author="octocat", createdAt=1700000000, url="https://github.com/acme/secret/issues/12")))
    v("comment_imported_author_only", "an imported comment whose source gave only an author.", "comment",
      dict(targetId="33" * 32, body="+1", imported=dict(author="hubot", createdAt=1700000001)))
    v("event_label_add",
      "a label event: the label name (value) is sealed (TLV 15); targetId (bound), targetNumber and kind stay "
      "plaintext, so the kind (label added) is visible and the name is not.", "event",
      dict(targetId="33" * 32, targetNumber=7, kind=4, value="security"))
    v("event_milestone_set", "a milestone event: the milestone name is sealed.", "event",
      dict(targetId="33" * 32, targetNumber=7, kind=17, value="v1.0 launch"))
    v("event_review_dismiss",
      "a review dismissal: the reason is sealed; refId (the dismissed review) stays plaintext.", "event",
      dict(targetId="44" * 32, targetNumber=3, kind=15, value="the approval predates the force-push",
           refId="99" * 32))
    v("event_retarget", "a retarget: the new base branch name is sealed.", "event",
      dict(targetId="44" * 32, targetNumber=3, kind=8, value="refs/heads/release"))
    for t, base in (("issue", dict(number=10, title="t")), ("comment", dict(targetId="33" * 32, body="b")),
                    ("review", dict(patchId="44" * 32, verdict=2, commitOid="dd" * 20)),
                    ("patch", dict(number=11, title="t", baseRefName="refs/heads/main", sourceRefName="refs/heads/f",
                                   sourceRepoId=H(repoId), headOid="ee" * 20, **patch_hashes))):
        used = sum(len(base[f]) for f in SEALED[t] if f in base)
        fill = "body"
        for extra, tag in ((0, "at_cap"), (1, "over_cap")):
            props = dict(base)
            props[fill] = props.get(fill, "") + "x" * (TEXT_CAP[t] - used + extra)
            v(f"{t}_{tag}", f"{t} text at {TEXT_CAP[t] + extra} bytes: "
              + ("fits." if extra == 0 else "one byte over the per-type cap: tooLarge, nothing sealed."), t, props)


def hedge_vectors():
    rnd = bytes(range(0x80, 0xA0))
    kh = k_hedge(K0, 0)
    small = mod251(1000)
    fid = hmac.new(kh, b"\x01" + rnd + sha256(small), hashlib.sha256).digest()[:16]
    vector("private_hedge", "file_id",
           "fileId = HMAC-SHA256(K_hedge,e, 0x01 || rnd(32) || SHA-256(plaintext))[0..16] (§3.6).",
           dict(repoId=H(repoId), key=H(K0), epoch=0, rnd=H(rnd), plaintextMod251=1000), dict(fileId=H(fid)))
    A = ad(ISSUE, K0, 1)
    nonce = hmac.new(kh, b"\x02" + rnd + A + sha256(ISSUE_TLV), hashlib.sha256).digest()[:12]
    vector("private_hedge", "doc_nonce",
           "doc nonce = HMAC-SHA256(K_hedge,e, 0x02 || rnd(32) || AD || SHA-256(plaintext))[0..12], for the §11 issue.",
           dict(repoId=H(repoId), key=H(K0), epoch=0, rnd=H(rnd), doc=ISSUE, fields=ISSUE_FIELDS), dict(nonce=H(nonce)))


# --- §16 sealed releases -------------------------------------------------------------------------

RELEASE_FLAGS = {"prerelease": 0x01, "draft": 0x02, "yanked": 0x04, "unpublished": 0x08, "notesContinue": 0x10}
MAX_RELEASE_PT = 1536 - 29          # forge-core $defs.enc.maxItems minus the v0x01 framing
PAD_TAG = 64                        # the first extension tag: readers skip it (§4.3)
PAD_BUCKET = 32
MAX_SAFE_INT = (1 << 53) - 1
MAX_MANIFEST_BYTES = 1 << 20        # a reader refuses a kind-4 manifest whose sizeBytes is larger
MANIFEST_FILE_ID = bytes.fromhex("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf")
B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


def _tag_pattern():
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "..", "..", "forge-contracts", "contracts", "forge-core.json")) as f:
        return json.load(f)["documentSchemas"]["release"]["properties"]["tagName"]["pattern"]


TAG_PATTERN = re.compile(_tag_pattern())


def legal_tag(tag):
    """The contract's release.tagName: 1-63 bytes of the ref grammar."""
    return 1 <= len(tag.encode()) <= 63 and TAG_PATTERN.fullmatch(tag) is not None


def k_tag(K, e):
    return subkey(K, b"tag", e)


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def tag_hash(K, e, tag):
    return hmac.new(k_tag(K, e), tag.encode(), hashlib.sha256).digest()


def tag_name(K, e, tag):
    """The plaintext `tagName` of a sealed release: base64url(HMAC-SHA256(K_tag,e, tag)), 43 chars."""
    return b64url(tag_hash(K, e, tag))


def release_records(f):
    """The records of a release's fields (§16.2), ascending; the flags record is always there."""
    recs = []
    if "notes" in f:
        recs.append((2, f["notes"].encode()))
    if "importedAuthor" in f:
        recs.append((13, f["importedAuthor"].encode()))
    if "importedUrl" in f:
        recs.append((14, f["importedUrl"].encode()))
    recs.append((16, f["tag"].encode()))
    if "name" in f:
        recs.append((17, f["name"].encode()))
    if "targetOid" in f:
        recs.append((18, bytes.fromhex(f["targetOid"])))
    recs.append((19, bytes([sum(bit for k, bit in RELEASE_FLAGS.items() if f.get(k))])))
    if "importedCreatedAt" in f:
        recs.append((20, u64(f["importedCreatedAt"])))
    if "assetManifest" in f:
        recs.append((21, bytes.fromhex(f["assetManifest"])))
    return tlv(*recs)


def pad_record(n):
    """The tag-64 padding record that brings a TLV of n bytes to a multiple of 32 (§16.2), or b""."""
    if n + 3 > MAX_RELEASE_PT:
        return b""
    r = min((-(n + 3)) % PAD_BUCKET, MAX_RELEASE_PT - 3 - n)
    return rec(PAD_TAG, bytes(r))


def release_tlv(f):
    body = release_records(f)
    return body + pad_record(len(body))


def release_ad(owner, e, tagname):
    return b"dash-forge/v2/doc\x00" + b"\x01" + repoId + owner + u32(e) + b"release\x00" + tagname.encode()


def seal_release_raw(K, e, owner, tagname, pt, nonce=NONCE):
    A = release_ad(owner, e, tagname)
    return A, b"\x01" + nonce + AESGCM(k_doc(K, e)).encrypt(nonce, pt, A)


def release_writer_check(f):
    """The writer's refusals (§16.2): None when the fields may be sealed, else the error code."""
    def text(v, lo, chars, nbytes):
        return lo <= len(v.encode()) and len(v) <= chars and len(v.encode()) <= nbytes
    if "tag" not in f or not legal_tag(f["tag"]):
        return "malformed"
    if "name" in f and not text(f["name"], 1, 120, 480):
        return "malformed"
    if "notes" in f and not text(f["notes"], 1, 5120, 5120):
        return "malformed"
    if "targetOid" in f and len(bytes.fromhex(f["targetOid"])) not in (20, 32):
        return "malformed"
    # the release schema's imported caps (tighter than TLV 13's reader cap)
    if "importedAuthor" in f and not text(f["importedAuthor"], 1, 64, 256):
        return "malformed"
    if "importedUrl" in f and not text(f["importedUrl"], 1, 300, 300):
        return "malformed"
    if "importedCreatedAt" in f and not 0 <= f["importedCreatedAt"] <= MAX_SAFE_INT:
        return "malformed"
    if ("importedAuthor" in f or "importedCreatedAt" in f) and "importedUrl" not in f:
        return "malformed"
    if "assetManifest" in f and len(bytes.fromhex(f["assetManifest"])) != 32:
        return "malformed"
    if f.get("notesContinue") and "assetManifest" not in f:
        return "malformed"
    if len(release_records(f)) > MAX_RELEASE_PT:
        return "tooLarge"
    return None


def canonical_json(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


# The asset file of the §11 pack vector (40,000 bytes, i mod 251) sealed as it is stored, and the
# kind-4 manifest that lists it, sealed with its own fileId.
ASSET_PLAIN = mod251(40000)
ASSET_SEALED = seal_pack(K0, 0, ASSET_PLAIN)[0]
RELEASE_NOTES_FULL = ("Highlights\n\n- Sealed releases for private repositories.\n- Asset lists move into a sealed "
                      "kind-4 manifest.\n\nThe whole changelog is longer than a release document holds.")
RELEASE_MANIFEST = {
    "v": 1,
    "tag": "v23.1.8",
    "total": 2,
    "source": "https://github.com/acme/secret/releases/tag/v23.1.8",
    "notes": RELEASE_NOTES_FULL,
    "assets": [
        {"name": "secret-23.1.8-x86_64-linux-gnu.tar.gz", "sha256": H(sha256(ASSET_PLAIN)), "sizeBytes": len(ASSET_PLAIN),
         "uris": ["https://bucket.example/o/" + H(sha256(ASSET_SEALED))],
         "sealedSha256": H(sha256(ASSET_SEALED)), "sealedSizeBytes": len(ASSET_SEALED)},
        {"name": "SHA256SUMS.asc", "sha256": "", "sizeBytes": 2048,
         "uris": ["https://github.com/acme/secret/releases/download/v23.1.8/SHA256SUMS.asc"]},
    ],
}
MANIFEST_SEALED = seal_pack(K0, 0, canonical_json(RELEASE_MANIFEST), file_id=MANIFEST_FILE_ID)[0]
MANIFEST_HASH = H(sha256(MANIFEST_SEALED))

REL_V1 = {"tag": "v1.0.0", "name": "Version 1.0.0", "notes": "First stable release.", "targetOid": "aa" * 20}
REL_IMPORTED = {"tag": "v23.1.8", "name": "Secret 23.1.8", "notes": "Highlights (the full notes are in the manifest)",
                "targetOid": "bb" * 32, "notesContinue": True, "importedAuthor": "UdjinM6",
                "importedUrl": "https://github.com/acme/secret/releases/tag/v23.1.8",
                "importedCreatedAt": 1754179200000, "assetManifest": MANIFEST_HASH}
AT_CAP_FILL = MAX_RELEASE_PT - (3 + len("v9.9.9")) - 4 - 3


def release_seal_vectors():
    def v(name, desc, f, K=K0, e=0):
        inp = dict(repoId=H(repoId), key=H(K), epoch=e, ownerId=H(ownerId), nonce=H(NONCE), fields=f)
        err = release_writer_check(f)
        if err:
            vector("private_release_seal", name, desc, inp, dict(error=err))
            return
        tn = tag_name(K, e, f["tag"])
        pt = release_tlv(f)
        A, enc = seal_release_raw(K, e, ownerId, tn, pt)
        vector("private_release_seal", name, desc, inp,
               dict(tagHash=H(tag_hash(K, e, f["tag"])), tagName=tn, ad=H(A), tlv=H(pt), enc=H(enc),
                    props=dict(tagName=tn, vis="private", delta=0, epoch=e, enc=H(enc))))

    v("v1_0_0", "a release under epoch 0: tag, name, notes and target commit are sealed (TLV 16, 17, 2, 18), with "
      "the flags record (19) and the tag-64 padding to a multiple of 32 bytes; the plaintext tagName is "
      "base64url(HMAC-SHA256(K_tag,0, tag)), and the AD binds it (§16.1-§16.3).", REL_V1)
    v("v1_0_0_epoch1", "the same release under epoch 1: K_tag is per epoch, so the tagName differs (§16.1).", REL_V1, K1, 1)
    v("tag_only", "the smallest release: the tag and a zero flags byte, padded to 32 bytes.", {"tag": "v0.1"})
    v("prerelease_draft", "a draft pre-release: flags 0x01 | 0x02 in one byte (TLV 19).",
      {"tag": "v2.0.0-rc.1", "name": "RC 1", "prerelease": True, "draft": True})
    v("yanked", "a later revision that yanks v1.0.0 (flag 0x04), carrying every field forward: the same length as "
      "the v1_0_0 revision it supersedes.", dict(REL_V1, yanked=True))
    v("unpublished", "a revision that unpublishes v1.0.0 (flag 0x08), carrying every field forward, as a yank does: "
      "what delta -1 does for a public tag.", dict(REL_V1, unpublished=True))
    v("imported_with_manifest",
      "an imported release whose assets and full notes are in a sealed kind-4 manifest: TLV 13, 14, 20 carry the "
      "provenance, TLV 21 the manifest's packHash, flag 0x10 says the notes continue there; the target is a 32-byte "
      "(SHA-256) commit id.", REL_IMPORTED)
    v("tag_named_like_a_branch",
      "a tag named refs/heads/main hashes under K_tag, never K_ref: its tagName is not the refNameHash of the "
      "branch (e729d18b... under K_ref,0), so a release never matches a ref update.", {"tag": "refs/heads/main"})
    v("at_enc_cap", f"tag, flags and notes at exactly {MAX_RELEASE_PT} bytes of TLV (no room for padding): a "
      "1536-byte enc, the forge-core cap.", {"tag": "v9.9.9", "notes": "n" * AT_CAP_FILL})
    v("over_enc_cap", "one byte more does not fit forge-core's 1536-byte enc: tooLarge, nothing sealed (§16.2).",
      {"tag": "v9.9.9", "notes": "n" * (AT_CAP_FILL + 1)})
    v("illegal_tag", "a tag the public grammar refuses (v1..2) is refused sealed too.", {"tag": "v1..2"})
    v("tag_64_bytes", "a tag over 63 bytes is refused.", {"tag": "v" * 64})
    v("empty_tag", "a release needs its tag.", {"tag": ""})
    v("name_121_chars", "a name over 120 characters is refused (the schema's cap).", {"tag": "v1", "name": "n" * 121})
    v("notes_continue_without_manifest", "flag 0x10 needs TLV 21: notes cannot continue in a manifest that is not named.",
      {"tag": "v1", "notes": "preview", "notesContinue": True})
    v("target_oid_21_bytes", "a target commit id is 20 or 32 bytes.", {"tag": "v1", "targetOid": "aa" * 21})
    v("imported_author_65_chars", "a writer applies the release schema's imported.author cap (64 characters).",
      {"tag": "v1", "importedAuthor": "a" * 65, "importedUrl": "https://x.example/r"})
    v("imported_author_without_url", "provenance needs its URL, as the public imported object requires url.",
      {"tag": "v1", "importedAuthor": "octocat"})

    # the kind-4 manifest artifact: canonical JSON, sealed as §3 with its own fileId
    vector("private_release_seal", "manifest_kind4",
           "a sealed release's asset manifest: canonical JSON (keys sorted, no whitespace) with the plaintext tag, the "
           "full notes and each asset's plaintext sha256/size plus sealedSha256/sealedSizeBytes, sealed as a §3 "
           "artifact; packHash is what TLV 21 names (§16.5).",
           dict(repoId=H(repoId), key=H(K0), epoch=0, fileId=H(MANIFEST_FILE_ID), manifest=RELEASE_MANIFEST),
           dict(canonical=canonical_json(RELEASE_MANIFEST).decode(), header=H(MANIFEST_SEALED[:36]),
                sealedLen=len(MANIFEST_SEALED), packHash=MANIFEST_HASH, sealed=H(MANIFEST_SEALED)))


def release_open_vectors():
    def v(name, desc, doc, context, expected, enc=None, f=None, K=K0):
        d = dict(doc)
        if enc is None:
            _, enc = seal_release_raw(K, d["epoch"], bytes.fromhex(d["ownerId"]), d["tagName"], release_tlv(f))
        if enc is not False:
            d["enc"] = H(enc)
        vector("private_release_open", name, desc, dict(repoId=H(repoId), context=context, doc=d), expected)

    def doc_of(f, K=K0, e=0, owner=ownerId, **extra):
        return dict(ownerId=H(owner), epoch=e, tagName=tag_name(K, e, f["tag"]), vis="private", delta=0, **extra)

    _, v1_enc = seal_release_raw(K0, 0, ownerId, tag_name(K0, 0, "v1.0.0"), release_tlv(REL_V1))
    v("v1_0_0", "the v1.0.0 release opens under K_0; the recomputed tagName matches the document's.",
      doc_of(REL_V1), CTX0, readable(REL_V1), f=REL_V1)
    v("v1_0_0_epoch1", "a revision sealed under epoch 1 opens with K_1.", doc_of(REL_V1, K1, 1), CTX01,
      readable(REL_V1), f=REL_V1, K=K1)
    v("imported_with_manifest", "every field of the imported release comes back.", doc_of(REL_IMPORTED), CTX0,
      readable(REL_IMPORTED), f=REL_IMPORTED)
    v("late_rule_not_applied",
      "a release carries no $createdAtBlockHeight and is maintainer-gated at consensus, so the height part of the "
      "late-content rule does not apply: a revision under superseded epoch 0 by a since-removed maintainer still "
      "opens (§16.4).", doc_of(REL_V1), CTX01, readable(REL_V1), f=REL_V1)
    burned1 = ctx({0: K0, 1: K1}, {0: ("c0", 10), 1: ("c1", 1000)}, burned=[1])
    v("under_burned_epoch_by_removed_owner",
      "the burned clause of §8.2 needs no height and still applies: a revision under burned epoch 1 whose author is "
      "no longer a maintainer is Unreadable(Late), so a key holder cannot plant a release before a burn.",
      doc_of(REL_V1, K1, 1), burned1, unreadable("late"), f=REL_V1, K=K1)
    v("under_burned_epoch_by_current_maintainer", "the same revision by a current maintainer is shown.",
      doc_of(REL_V1, K1, 1), dict(burned1, members=[H(ownerId)]), readable(REL_V1), f=REL_V1, K=K1)
    v("no_key", "epoch 0 exists but the reader holds only K_1: Unreadable(NoKey).", doc_of(REL_V1),
      ctx({1: K1}, {0: ("c0", 10), 1: ("c1", 1000)}), unreadable("noKey"), enc=v1_enc)
    v("no_epoch", "an epoch without an anchor does not exist: Unreadable(NoEpoch).", doc_of(REL_V1),
      ctx({0: K0}, {1: ("c1", 1000)}), unreadable("noEpoch"), enc=v1_enc)
    v("other_owner", "the AD binds $ownerId: another maintainer cannot re-post this enc as theirs.",
      doc_of(REL_V1, owner=bytes([0x23]) * 32), CTX0, unreadable("badTag"), enc=v1_enc)
    v("enc_moved_to_other_tag", "the AD binds tagName: the enc moved under v1.0.1's tagName fails the tag.",
      dict(doc_of(REL_V1), tagName=tag_name(K0, 0, "v1.0.1")), CTX0, unreadable("badTag"), enc=v1_enc)
    v("enc_version_2", "a release enc is v0x01; a 0x02 frame is malformed before any key is used.", doc_of(REL_V1),
      CTX0, MALFORMED, enc=b"\x02" + bytes(32) + v1_enc[1:])
    v("tag_name_not_43_base64url", "a sealed tagName that is not 43 base64url characters is malformed before any key "
      "is used.", dict(doc_of(REL_V1), tagName="v1.0.0"), CTX0, MALFORMED, enc=v1_enc)
    v("private_without_enc", "the contract admits a private release with a plaintext tagName and no enc; readers do "
      "not: Malformed.", dict(ownerId=H(ownerId), tagName="v1.0.0", vis="private", delta=0), CTX0, MALFORMED, enc=False)
    v("public_with_enc", "a release carrying enc stamped public (a public repository) is malformed: public readers hold "
      "no keys.", dict(doc_of(REL_V1), vis="public"), CTX0, MALFORMED, enc=v1_enc)
    # a (malicious) writer binds and publishes one tagName but seals another tag: the tag verifies, the hash does not
    bad_tn = tag_name(K0, 0, "v1.0.1")
    _, e = seal_release_raw(K0, 0, ownerId, bad_tn, release_tlv(REL_V1))
    v("tag_name_hash_mismatch", "the enc decrypts but its tag (v1.0.0) does not hash to the document's tagName "
      "(v1.0.1's): Malformed, never shown under either tag.", dict(doc_of(REL_V1), tagName=bad_tn), CTX0, MALFORMED, enc=e)
    good = tag_name(K0, 0, "v1.0.0")
    # the last base64url char carries 2 unused bits: another char with the same 4 high bits decodes to the same bytes
    noncanon = good[:-1] + B64URL_ALPHABET[B64URL_ALPHABET.index(good[-1]) ^ 1]
    assert base64.urlsafe_b64decode(noncanon + "=") == base64.urlsafe_b64decode(good + "=")
    _, e = seal_release_raw(K0, 0, ownerId, noncanon, release_tlv(REL_V1))
    v("tag_name_noncanonical_base64",
      "a tagName that decodes to the right hash but is not its canonical encoding (the last character's unused "
      "bits set): readers compare strings, never decode, so it is Malformed (§16.1).",
      dict(doc_of(REL_V1), tagName=noncanon), CTX0, MALFORMED, enc=e)
    ref_tn = b64url(hmac.new(k_ref(K0, 0), b"v1.0.0", hashlib.sha256).digest())
    _, e = seal_release_raw(K0, 0, ownerId, ref_tn, release_tlv(REL_V1))
    v("tag_name_under_ref_key", "a writer that hashed the tag under K_ref instead of K_tag: Malformed.",
      dict(doc_of(REL_V1), tagName=ref_tn), CTX0, MALFORMED, enc=e)
    v("plaintext_yanked_next_to_enc", "a sealed release carries its flags only in enc: a plaintext yanked is Malformed.",
      doc_of(REL_V1, yanked=True), CTX0, MALFORMED, enc=v1_enc)
    v("plaintext_imported_next_to_enc",
      "nor plaintext provenance: imported (whose url the schema requires) would publish the source.",
      doc_of(REL_V1, imported={"url": "https://github.com/acme/secret/releases/tag/v1.0.0"}), CTX0, MALFORMED,
      enc=v1_enc)

    def raw(name, desc, tag, pt, expected):
        tn = tag_name(K0, 0, tag)
        _, e = seal_release_raw(K0, 0, ownerId, tn, pt)
        v(name, desc, dict(ownerId=H(ownerId), epoch=0, tagName=tn, vis="private", delta=0), CTX0, expected, enc=e)

    F0 = (19, b"\x00")
    raw("tlv_without_tag", "TLV 16 is required: a release without its tag is Malformed.", "v1",
        tlv((17, b"name only"), F0), MALFORMED)
    raw("tlv_without_flags", "TLV 19 is always written (0x00 when no flag is set): a release without it is Malformed.",
        "v1", tlv((16, b"v1")), MALFORMED)
    raw("tlv_flags_zero", "a zero flags byte is the normal case: Readable, no flag set.", "v1",
        tlv((16, b"v1"), F0), readable({"tag": "v1"}))
    raw("tlv_flags_unknown_bit", "flag bits above 0x10 are Malformed.", "v1", tlv((16, b"v1"), (19, b"\x20")), MALFORMED)
    raw("tlv_flags_two_bytes", "the flags record is exactly one byte.", "v1", tlv((16, b"v1"), (19, b"\x01\x00")),
        MALFORMED)
    raw("tlv_notes_continue_without_manifest", "flag 0x10 without TLV 21 is Malformed.", "v1",
        tlv((2, b"preview"), (16, b"v1"), (19, b"\x10")), MALFORMED)
    raw("tlv_notes_empty", "a zero-length notes record (tag 2 has no minimum) reads as empty notes; writers never "
        "write it.", "v1", tlv((2, b""), (16, b"v1"), F0), readable({"tag": "v1", "notes": ""}))
    raw("tlv_target_oid_21_bytes", "a target commit id is 20 or 32 bytes.", "v1",
        tlv((16, b"v1"), (18, bytes([0xaa]) * 21), F0), MALFORMED)
    raw("tlv_title_in_release", "tag 1 (title) is not a release field.", "v1", tlv((1, b"t"), (16, b"v1"), F0), MALFORMED)
    raw("tlv_illegal_tag_grammar", "a sealed tag must pass the public tag grammar: v1..2 (with its own matching "
        "tagName) is Malformed.", "v1..2", tlv((16, b"v1..2"), F0), MALFORMED)
    raw("tlv_tag_twice", "a repeated tag 16 is Malformed.", "v1", tlv((16, b"v1"), (16, b"v1"), F0), MALFORMED)
    raw("tlv_extension_before_tag", "records are strictly ascending, extensions included: tag 200 before tag 16 is "
        "Malformed.", "v1", tlv((200, b"x"), (16, b"v1"), F0), MALFORMED)
    raw("tlv_truncated", "two trailing bytes after the last record are Malformed.", "v1",
        tlv((16, b"v1"), F0) + b"\x40\x00", MALFORMED)
    raw("tlv_created_at_over_2_53", "importedCreatedAt is at most 2^53 - 1, the schema's bound.", "v1",
        tlv((14, b"https://x.example/r"), (16, b"v1"), F0, (20, u64(1 << 53))), MALFORMED)
    raw("tlv_imported_without_url", "provenance without its URL (tag 13 or 20 without 14) is Malformed.", "v1",
        tlv((13, b"octocat"), (16, b"v1"), F0), MALFORMED)
    raw("tlv_imported_author_100_chars", "the reader's tag-13 cap is §4.3's (120 characters); only the writer applies "
        "the release schema's 64.", "v1", tlv((13, b"a" * 100), (14, b"https://x.example/r"), (16, b"v1"), F0),
        readable({"tag": "v1", "importedAuthor": "a" * 100, "importedUrl": "https://x.example/r"}))
    raw("tlv_manifest_31_bytes", "assetManifest is exactly 32 bytes.", "v1",
        tlv((16, b"v1"), F0, (21, bytes([0x66]) * 31)), MALFORMED)
    raw("tlv_extension_skipped", "an extension tag (200) is skipped: Readable.", "v1",
        tlv((16, b"v1"), F0, (200, b"future")), readable({"tag": "v1"}))
    raw("tlv_reserved_tag_22", "tags 22-63 stay reserved: Malformed.", "v1", tlv((16, b"v1"), F0, (22, b"x")), MALFORMED)

    # the manifest: fetched by packHash, opened with the header epoch's key, checked against the release
    def m(name, desc, sealed, expected, expect_hash=None, tag="v23.1.8", notes_continue=True, size=None):
        vector("private_release_open", name, desc,
               dict(repoId=H(repoId), keys={"0": H(K0)},
                    manifest=dict(sealed=H(sealed), sizeBytes=len(sealed) if size is None else size,
                                  assetManifest=expect_hash or H(sha256(sealed)), tag=tag,
                                  notesContinue=notes_continue)),
               expected)

    def reseal(obj, fid, raw_bytes=None):
        return seal_pack(K0, 0, raw_bytes if raw_bytes is not None else canonical_json(obj), file_id=fid)[0]

    mm = dict(error="manifestMismatch")
    m("manifest_kind4", "the kind-4 manifest named by TLV 21 opens, and its tag, total and entries check.",
      MANIFEST_SEALED, dict(status="readable", manifest=RELEASE_MANIFEST), expect_hash=MANIFEST_HASH)
    m("manifest_for_another_tag", "a manifest whose tag is not the release's is refused: one manifest cannot be "
      "replayed onto another release.", MANIFEST_SEALED, mm, expect_hash=MANIFEST_HASH, tag="v23.1.9")
    m("manifest_notes_without_flag", "a manifest carries notes exactly when the release sets flag 0x10.",
      MANIFEST_SEALED, mm, expect_hash=MANIFEST_HASH, notes_continue=False)
    m("manifest_over_size_cap", "a manifest whose sizeBytes is over 1 MiB is refused before anything is fetched.",
      MANIFEST_SEALED, mm, expect_hash=MANIFEST_HASH, size=MAX_MANIFEST_BYTES + 1)
    # each test manifest below has its own fileId: no two plaintexts share a pack key (§3.3), even in the vectors
    other = reseal(dict(RELEASE_MANIFEST, total=1), bytes.fromhex("b0" * 16))
    m("manifest_hash_mismatch", "a copy whose sealed bytes do not hash to TLV 21 is refused before decryption.", other,
      mm, expect_hash=MANIFEST_HASH)
    m("manifest_total_mismatch", "total must equal the number of assets.",
      reseal(dict(RELEASE_MANIFEST, total=3), bytes.fromhex("b1" * 16)), mm)
    pretty = json.dumps(RELEASE_MANIFEST, sort_keys=True, indent=1, ensure_ascii=False).encode()
    m("manifest_not_canonical", "the plaintext must be its own canonical re-encoding: whitespace is refused, so two "
      "JSON parsers can never read two different lists.", reseal(None, bytes.fromhex("b2" * 16), pretty), mm)
    as_float = canonical_json(RELEASE_MANIFEST).replace(b'"v":1', b'"v":1.0')
    m("manifest_version_float", "integers are written without a fraction: \"v\":1.0 is refused.",
      reseal(None, bytes.fromhex("b3" * 16), as_float), mm)
    bad_entry = json.loads(json.dumps(RELEASE_MANIFEST))
    bad_entry["assets"][0]["sealedSizeBytes"] = len(ASSET_PLAIN)
    m("manifest_sealed_size_too_small", "a sealed entry's sealedSizeBytes must hold its plaintext (at least "
      "36 + sizeBytes + 16).", reseal(bad_entry, bytes.fromhex("b4" * 16)), mm)
    unhashed = json.loads(json.dumps(RELEASE_MANIFEST))
    unhashed["assets"][0]["sha256"] = ""
    m("manifest_sealed_entry_without_sha256", "a sealed entry always has its plaintext sha256: the writer hashed the "
      "file it sealed.", reseal(unhashed, bytes.fromhex("b5" * 16)), mm)


def release_fold_vectors():
    """§16.3 as a pure function over opened revisions."""
    lo, hi = tie_ids()

    def rid(label):
        return H(cid("rel-" + label))

    def r(label, at, tag, status="readable", epoch=0, enc=None, tn=None, **flags):
        row = dict(id=rid(label) if isinstance(label, str) else H(label), createdAt=at, epoch=epoch,
                   tagName=tn or ("tn-%s-e%d" % (tag, epoch)), status=status, enc=enc or ("e-" + str(label)))
        if status == "readable":
            row["fields"] = dict(tag=tag, **flags)
        return row

    def v(name, desc, rows, expected):
        vector("private_release_fold", name, desc, dict(revisions=rows), expected)

    def out(live, history, count, replays=(), unknown=(), stale=False, hidden=0):
        return dict(live=live, history=list(history), count=count, replays=list(replays), unknownTags=list(unknown),
                    stale=stale, hidden=hidden)

    v("publish_edit_publish", "the newest revision of each tag is the release; older ones are history, newest first.",
      [r("a", 100, "v1"), r("b", 200, "v1"), r("c", 300, "v2")],
      out({"v1": rid("b"), "v2": rid("c")}, [rid("a")], 2))
    v("across_epochs", "revisions are grouped by the decrypted tag, not by tagName: a yank under epoch 1 supersedes "
      "the epoch-0 publish (a yanked release is still live and counted).",
      [r("a", 100, "v1"), r("b", 200, "v1", epoch=1, yanked=True)], out({"v1": rid("b")}, [rid("a")], 1))
    v("unpublish_and_republish", "an unpublish takes the tag down; a later revision without the flag publishes it again.",
      [r("a", 100, "v1"), r("b", 200, "v1", unpublished=True), r("c", 300, "v2"), r("d", 400, "v2", unpublished=True),
       r("e", 500, "v2")],
      out({"v2": rid("e")}, [rid("d"), rid("c"), rid("b"), rid("a")], 1))
    v("draft_not_counted", "a draft is live and listed, but not counted.",
      [r("a", 100, "v1"), r("b", 200, "v2", draft=True)], out({"v1": rid("a"), "v2": rid("b")}, [], 1))
    v("replay_ignored", "a revision whose enc repeats an earlier one's is a replay (a signing key without the "
      "content key can copy an old enc): ignored, so it cannot un-yank.",
      [r("a", 100, "v1", enc="e-A"), r("b", 200, "v1", yanked=True, enc="e-B"), r("c", 300, "v1", enc="e-A")],
      out({"v1": rid("b")}, [rid("a")], 1, replays=[rid("c")]))
    v("tie_by_raw_id_bytes", "equal $createdAt: the larger $id as raw bytes is newer, not the larger base58 string "
      "(§5.3).", [r(lo, 100, "v1"), r(hi, 100, "v1", yanked=True)], out({"v1": H(hi)}, [H(lo)], 1))
    v("newer_unopenable_same_tag_name", "a newer revision under a held epoch with the same tagName that does not open "
      "(badTag) leaves the tag's state unknown; the readable revision is still listed.",
      [r("a", 100, "v1", tn="T1"), r("b", 200, None, status="badTag", tn="T1")],
      out({"v1": rid("a")}, [], 1, unknown=["v1"], hidden=1))
    v("newer_revision_under_missing_key", "a revision under an epoch the reader holds no key for, newer than every "
      "readable one, marks the list stale: its tag cannot be known.",
      [r("a", 100, "v1"), r("b", 200, None, status="noKey", epoch=1)], out({"v1": rid("a")}, [], 1, stale=True, hidden=1))
    v("older_revision_under_missing_key", "an older unreadable revision is hidden and counted, but the list is not "
      "stale.", [r("b", 50, None, status="noKey", epoch=1), r("a", 100, "v1")], out({"v1": rid("a")}, [], 1, hidden=1))
    v("late_and_malformed_hidden", "late and malformed revisions are hidden and counted.",
      [r("a", 100, "v1"), r("b", 200, None, status="late", epoch=1, tn="X"), r("c", 300, None, status="malformed")],
      out({"v1": rid("a")}, [], 1, hidden=2))


# --- mixed visibility: members-only content (enc v0x03) and specific-people letters (v0x04) -----
#
# Members (v0x03, private-repos.md §4.1): a per-object key bound to the nonce and the AD, a key
# commitment, and 64-byte padding for discussion types. Specific people (v0x04): a fresh K_obj
# wrapped to each recipient's ENCRYPTION key by ECDH (the encryptedFor bytes, slot version 0x02),
# the sender in slot 0, the recipients' identity ids in TLV tag 25.

V3, V4 = 0x03, 0x04
LETTER_KINDS = ("issue", "patch", "comment", "review", "event")
MIN_V3 = 1 + 12 + 32 + 16
MAX_ENC = {"issue": 5120, "patch": 5120, "comment": 5120, "review": 5120, "event": 5120, "refUpdate": 1536,
           "protectedRefUpdate": 1536, "config": 1536}
PADDED = ("issue", "patch", "comment", "review")
DOC_PAD_BUCKET = 64
RECIPIENT_TAG = 25
SLOT_VERSION = 0x02
PURPOSE_ENCRYPTION, PURPOSE_AUTHENTICATION = 1, 0
KEY_TYPE_SECP256K1, KEY_TYPE_BLS = 0, 1


def k_obj_members(K, e, nonce, A):
    """K_obj = HKDF-Expand(PRK_e, "dash-forge/v2/obj" ‖ 0x00 ‖ u32(e) ‖ nonce ‖ SHA-256(AD), 32)."""
    return subkey(K, b"obj", e, nonce + sha256(A))


def obj_keys(k_obj, repo=repoId):
    """(K_doc,obj, COMMIT_obj) of a per-object key: PRK_obj = HKDF-Extract(repoId, K_obj)."""
    P = hmac.new(repo, k_obj, hashlib.sha256).digest()
    return expand(P, b"dash-forge/v2/obj-doc\x00"), expand(P, b"dash-forge/v2/obj-commit\x00")


def doc_pad(n, room):
    """The tag-64 record that brings a TLV of n bytes to a multiple of 64 within `room`, or b""."""
    if n + 3 > room:
        return b""
    return rec(64, bytes(min((-(n + 3)) % DOC_PAD_BUCKET, room - 3 - n)))


def members_tlv(doc_type, records):
    room = MAX_ENC[doc_type] - MIN_V3
    return records + (doc_pad(len(records), room) if doc_type in PADDED else b"")


def seal_members(doc, K, records, nonce=NONCE, pt=None):
    """(AD, K_obj, COMMIT_obj, TLV, enc) of a members document; `pt` overrides the padded TLV."""
    A = ad(doc, K, V3)
    pt = members_tlv(doc["type"], records) if pt is None else pt
    ko = k_obj_members(K, doc["epoch"], nonce, A)
    kd, C = obj_keys(ko)
    return A, ko, C, pt, bytes([V3]) + nonce + C + AESGCM(kd).encrypt(nonce, pt, A + C)


def open_members(doc, K, enc):
    """The reference reader of a v0x03 enc (framing aside): commitment, then GCM, then the raw TLV."""
    A = ad(doc, K, V3)
    nonce, C, ct = enc[1:13], enc[13:45], enc[45:]
    kd, C2 = obj_keys(k_obj_members(K, doc["epoch"], nonce, A))
    if C2 != C:
        return "commitMismatch"
    try:
        return AESGCM(kd).decrypt(nonce, ct, A + C)
    except Exception:
        return "badTag"


MDOC = dict(type="comment", vis="public", ownerId=H(ownerId), epoch=0, targetId="33" * 32)
MBODY = "members-only: the fix is in sec/cve-1"
MISSUE = dict(type="issue", vis="public", ownerId=H(ownerId), epoch=0, number=7)
MREVIEW = dict(type="review", vis="public", ownerId=H(ownerId), epoch=0, patchId="44" * 32)
MALLORY_ID = bytes([0x99]) * 32


def private_vis(doc):
    """`doc` as a private repository's document: `vis` absent (the readers' default)."""
    return {k: x for k, x in doc.items() if k != "vis"}


def long_body_text():
    """A comment body at the v0x03 room: a long text's prefix and the forge-v2.md §6.3 trailer."""
    full = ("Members-only post-mortem.\n\n" + "The signing service rotated its key at 03:12 and the old key stayed "
            "cached in two regions. " * 120).encode()
    trailer = b"<!-- forge:body sha256=" + H(sha256(full)).encode() + b" bytes=" + str(len(full)).encode() + b" -->"
    room = MAX_ENC["comment"] - MIN_V3 - 3
    prefix = full[:room - 2 - len(trailer)]
    text = prefix + b"\n\n" + trailer
    assert len(text) == room
    return text.decode()


def mixed_vectors():
    seal_cases = [
        ("v03_comment", MDOC, {"body": MBODY}, tlv((2, MBODY.encode())),
         "a members-only comment: K_obj from PRK_0, the nonce and SHA-256(AD v0x03); COMMIT_obj after the nonce; "
         "the TLV padded to 64 bytes with a tag-64 record (§4.1, D28)."),
        ("v03_issue", MISSUE, ISSUE_FIELDS, ISSUE_TLV, "a members-only issue #7: title and body, padded."),
        ("v03_review", MREVIEW, {"body": "Blocking: the token is logged."}, tlv((2, b"Blocking: the token is logged.")),
         "a members-only review body; its verdict stays a plaintext field of the document."),
        ("v03_inline", MDOC, {"body": "nit: rename", "path": "src/lib.rs"}, COMMENT_TLV,
         "a members-only inline comment: path is TLV tag 10 (line, side, commitOid stay plaintext)."),
        ("v03_long_body", MDOC, {"body": long_body_text()}, tlv((2, long_body_text().encode())),
         "a comment at the v0x03 room (5,120 - 61 - 3 bytes of body): a long text's prefix and its §6.3 trailer; "
         "no room is left for the padding record, so the enc is exactly 5,120 bytes."),
        ("v03_review_empty", MREVIEW, {}, b"", "an empty members-only review is padded to one 64-byte bucket, so "
         "its length says nothing."),
        ("v03_event_not_padded", dict(EVENT, vis="public"), {"eventValue": "bug"}, EVENT_TLV,
         "a members-only event value is not padded (D28: off for events and ref updates)."),
    ]
    for name, doc, fields, records, desc in seal_cases:
        A, ko, C, pt, e = seal_members(doc, K0, records)
        if name == "v03_long_body":
            assert len(e) == 5120 and pt == records
        vector("mixed_doc_seal", name, desc,
               dict(repoId=H(repoId), key=H(K0), doc=doc, fields=fields, nonce=H(NONCE)),
               dict(ad=H(A), kObj=H(ko), commit=H(C), tlv=H(pt), enc=H(e)))
    for name, doc, fields, err, desc in [
        ("v03_private_header_refused", private_vis(MDOC), {"body": MBODY}, "malformed",
         "a writer never seals v0x03 for a private repository's document (v0x01 there)."),
        ("v03_config_refused", dict(CONFIG0, vis="public"), {"defaultBranch": "refs/heads/main"}, "malformed",
         "a config is always v0x02, members lane or not."),
        ("v03_body_over_cap", MDOC, {"body": "b" * (MAX_ENC["comment"] - MIN_V3 - 2)}, "tooLarge",
         "a comment body one byte over the v0x03 room (5,056 bytes) does not fit."),
        ("v03_tag_not_for_kind", MDOC, {"body": "x", "title": "t"}, "malformed", "title is not a comment field."),
    ]:
        vector("mixed_doc_seal", name, desc, dict(repoId=H(repoId), key=H(K0), doc=doc, fields=fields, nonce=H(NONCE)),
               dict(error=err))

    def v(name, desc, doc, context, expected, enc, height=50):
        d = dict(doc, enc=H(enc))
        if "id" in d:
            d["id"] = H(cid(d["id"]))
        if height is not None:
            d.setdefault("createdAtBlockHeight", height)
        vector("mixed_doc_open", name, desc, dict(repoId=H(repoId), context=context, doc=d), expected)

    _, ko, C, pt, enc = seal_members(MDOC, K0, tlv((2, MBODY.encode())))
    assert open_members(MDOC, K0, enc) == pt
    v("member", "a member holding K_0 opens the members-only comment.", MDOC, CTX0, readable({"body": MBODY}), enc)
    v("outsider_placeholder", "an outsider holds no lane key: Unreadable(NoKey), which readers show as a "
      "members-only placeholder (never not-found, never an error).", MDOC, ctx({}, {0: ("c0", 10)}),
      unreadable("noKey"), enc)
    v("no_lane", "a public repository without a members lane has no epoch 0: Unreadable(NoEpoch).", MDOC, ctx({}, {}),
      unreadable("noEpoch"), enc)
    flipped = bytearray(enc)
    flipped[13] ^= 0x01
    assert open_members(MDOC, K0, bytes(flipped)) == "commitMismatch"
    v("commit_mismatch", "COMMIT_obj with one bit flipped: the reader compares it before GCM runs, so "
      "Unreadable(CommitMismatch), never BadTag and never a silent drop.", MDOC, CTX0, unreadable("commitMismatch"),
      bytes(flipped))
    tampered = bytearray(enc)
    tampered[-1] ^= 0x01
    assert open_members(MDOC, K0, bytes(tampered)) == "badTag"
    v("body_tampered", "the commitment matches but the GCM tag does not: Unreadable(BadTag).", MDOC, CTX0,
      unreadable("badTag"), bytes(tampered))
    # A non-member who learned this comment's K_obj (a reveal) re-encrypts her own text under it, with the same
    # nonce and commitment, as her own document. Members derive K_obj from her AD, so the commitment fails.
    forged_doc = dict(MDOC, ownerId=H(MALLORY_ID))
    kd, _ = obj_keys(ko)
    forged = bytes([V3]) + NONCE + C + AESGCM(kd).encrypt(NONCE, members_tlv("comment", tlv((2, b"FORGED"))),
                                                            ad(forged_doc, K0, V3) + C)
    assert open_members(forged_doc, K0, forged) == "commitMismatch"
    v("forged_after_reveal_refused", "Mallory, not a member, re-encrypts her own text under a revealed K_obj, nonce "
      "and commitment as her own comment: members derive K_obj from her AD (the key is AD-bound), get another key, "
      "and refuse it as CommitMismatch.", forged_doc, CTX0, unreadable("commitMismatch"), forged)
    moved = dict(MDOC, targetId="34" * 32)
    assert open_members(moved, K0, enc) == "commitMismatch"
    v("moved_to_other_target", "the enc copied onto another thread: another AD, another K_obj: CommitMismatch.", moved,
      CTX0, unreadable("commitMismatch"), enc)
    _, v1_enc = seal_doc(private_vis(MDOC), K0, tlv((2, MBODY.encode())))
    v("v01_relabelled_refused", "a private repository's v0x01 enc, valid under K_0, on a public repository's document "
      "is malformed: v0x01 is admitted only where vis is private.", MDOC, CTX0, MALFORMED, v1_enc)
    relabelled = bytes([V3]) + v1_enc[1:]
    assert len(relabelled) >= MIN_V3 and open_members(MDOC, K0, relabelled) == "commitMismatch"
    v("v01_byte_relabelled_as_v03", "the same v0x01 bytes with enc[0] rewritten to 0x03 read as a v0x03 envelope "
      "whose commitment is not the derived one: CommitMismatch.", MDOC, CTX0, unreadable("commitMismatch"),
      relabelled)
    v("v03_in_private_refused", "a v0x03 enc on a private repository's document is malformed: members-only content "
      "exists only in public repositories.", private_vis(MDOC), CTX0, MALFORMED, enc)
    v("v03_too_short", "a v0x03 enc under 61 bytes is malformed before any key is used.", MDOC, CTX0, MALFORMED,
      enc[:60])
    padded_issue = members_tlv("issue", ISSUE_TLV)
    assert padded_issue[len(ISSUE_TLV)] == 64 and len(padded_issue) % 64 == 0
    _, _, _, _, issue_enc = seal_members(MISSUE, K0, ISSUE_TLV)
    v("pad_roundtrip", "the padded issue opens to its title and body: the tag-64 record is skipped like every "
      "extension record.", MISSUE, CTX0, readable(ISSUE_FIELDS), issue_enc)
    for name, desc, pt, exp in [
        ("pad_mid_bucket", "a padding record of any length, even one not reaching a bucket boundary, is skipped.",
         ISSUE_TLV + rec(64, bytes(5)), readable(ISSUE_FIELDS)),
        ("pad_twice_refused", "two tag-64 records are a repeated extension tag: malformed.",
         ISSUE_TLV + rec(64, b"") + rec(64, b""), MALFORMED),
        ("pad_before_content_refused", "a padding record before the content breaks the ascending order: malformed.",
         rec(64, b"") + ISSUE_TLV, MALFORMED),
        ("recipient_tag_refused", "tag 25 (a letter's recipient list) is reserved outside enc v0x04: malformed.",
         ISSUE_TLV + rec(25, bytes(32)), MALFORMED),
        ("blind_tags_reserved", "tags 22-24 and 27 (sealed ref values, defined for later clients) stay reserved: "
         "malformed.", ISSUE_TLV + rec(22, bytes(20)), MALFORMED),
        ("reserved_tag_23", "tag 23 (a sealed ref update's real prevOid) stays reserved: malformed.",
         ISSUE_TLV + rec(23, bytes(20)), MALFORMED),
        ("reserved_tag_24", "tag 24 (a head update's real head) stays reserved: malformed.",
         ISSUE_TLV + rec(24, bytes(20)), MALFORMED),
        ("reserved_tag_27", "tag 27 (an OID blind's salt) stays reserved: malformed.", ISSUE_TLV + rec(27, bytes(32)),
         MALFORMED),
    ]:
        _, _, _, _, e = seal_members(MISSUE, K0, b"", pt=pt)
        v(name, desc, MISSUE, CTX0, exp, e)
    late = dict(MISSUE, createdAtBlockHeight=1000 + GRACE_BLOCKS + 1)
    v("late", "the late-content rule applies to the members lane as to a private repository: under epoch 0 after the "
      "epoch-1 anchor + 240 by a non-member, Unreadable(Late).", late, CTX01, unreadable("late"), issue_enc)
    k_obj, nonce, ivs = named_inputs(3)
    letter = seal_named(named_doc(), NAMED_SENDER, 4, [NAMED_SENDER] + NAMED_OTHERS[:2],
                        tlv((2, b"A letter to 3 people (the sender included): the embargo ends on Friday.")), k_obj,
                        nonce, ivs)[5]
    v("v04_public", "a well-framed specific-people letter (v0x04) in a public repository: the epoch keys cannot open "
      "it, and no lane is needed to frame it: Unreadable(Letter); the letter reader opens it.", named_doc(),
      ctx({}, {}), unreadable("letter"), letter)
    v("v04_private", "the same letter on a private repository's document: also Unreadable(Letter), even for a member "
      "holding K_0.", private_vis(named_doc()), CTX0, unreadable("letter"), letter)
    v("config_anchor_public", "the lane-0 anchor of a public repository is a v0x02 config with vis public: it opens "
      "as in a private repository.", dict(CONFIG0, vis="public", id="c0"), CTX0,
      readable({"defaultBranch": "refs/heads/main"}), seal_doc(CONFIG0, K0, CONFIG0_TLV)[1])


# --- specific-people letters (enc v0x04) ------------------------------------------------------------


def named_party(name):
    d = priv(b"dash-forge vectors: named " + name.encode())
    return dict(name=name, id=cid("named " + name), priv=d, pub=comp(ec_mul(d, G)))


NAMED_SENDER = named_party("alice")
NAMED_OTHERS = [named_party(f"r{i}") for i in range(1, 16)]
NAMED_OUTSIDER = named_party("dave")


def named_doc(sender=NAMED_SENDER, **kw):
    return dict(dict(type="comment", vis="public", ownerId=H(sender["id"]), epoch=0, targetId="33" * 32), **kw)


def named_inputs(n):
    label = b"dash-forge vectors: named n%d " % n
    return sha256(label + b"kObj"), sha256(label + b"nonce")[:12], [sha256(label + b"iv %d" % i)[:16] for i in range(n)]


def ecdh(d, pub_bytes):
    """S = SHA-256 of the compressed point d·pub; ValueError when pub is not a compressed point on the curve."""
    if len(pub_bytes) != 33 or pub_bytes[0] not in (2, 3):
        raise ValueError("not a compressed public key")
    x = int.from_bytes(pub_bytes[1:], "big")
    if x >= P:
        raise ValueError("x out of range")
    y = pow((x * x * x + 7) % P, (P + 1) // 4, P)
    if (y * y - (x * x * x + 7)) % P:
        raise ValueError("not on the curve")
    if y % 2 != pub_bytes[0] - 2:
        y = P - y
    return sha256(comp(ec_mul(d, (x, y))))


def seal_named(doc, sender, key_id, recipients, records, k_obj, nonce, ivs, slot_pt=None, slot_override=None,
               tlv_override=None):
    """(shared keys, COMMIT_obj, H, AD', TLV, enc) of a letter; the overrides build negative vectors."""
    n = len(recipients)
    kd, C = obj_keys(k_obj)
    spt = bytes([SLOT_VERSION]) + C[:14] + k_obj if slot_pt is None else slot_pt
    shared = [ecdh(sender["priv"], r["pub"]) for r in recipients]
    slots = [cbc(S, iv, spt) for S, iv in zip(shared, ivs)]
    if slot_override:
        for i, s in slot_override.items():
            slots[i] = s
    head = bytes([n]) + u32(key_id) + C + b"".join(slots)
    A = ad(doc, None, V4) + sha256(head)
    if tlv_override is None:
        body = records + b"".join(rec(RECIPIENT_TAG, r["id"]) for r in recipients)
        room = MAX_ENC[doc["type"]] - (66 + 64 * n)
        pt = body + (doc_pad(len(body), room) if doc["type"] in PADDED else b"")
    else:
        pt = tlv_override
    return shared, C, head, A, pt, bytes([V4]) + head + nonce + AESGCM(kd).encrypt(nonce, pt, A)


def cbc_open(key, data):
    dec = Cipher(algorithms.AES(key), modes.CBC(data[:16]), backend=default_backend()).decryptor()
    out = dec.update(data[16:]) + dec.finalize()
    pad = out[-1] if out else 0
    if not 1 <= pad <= 16 or out[-pad:] != bytes([pad]) * pad:
        return None
    return out[:-pad]


def parse_letter_tlv(pt):
    """(body, recipient ids) of a comment letter's TLV, or None (the strictness the vectors need)."""
    pos, last, body, ids = 0, -1, None, []
    while pos < len(pt):
        if len(pt) - pos < 3:
            return None
        tag, ln = pt[pos], struct.unpack(">H", pt[pos + 1:pos + 3])[0]
        val = pt[pos + 3:pos + 3 + ln]
        if len(val) != ln or tag < last or (tag == last and tag != RECIPIENT_TAG):
            return None
        last, pos = tag, pos + 3 + ln
        if tag >= 64:
            continue
        if tag == 2:
            body = val.decode()
        elif tag == RECIPIENT_TAG and ln == 32:
            ids.append(val)
        else:
            return None
    return (body, ids) if body else None


def open_named(doc, enc, owner_keys, reader_id, reader_privs):
    """The reference reader rule of a letter (§4.1): sender key, slot trial, commitment, GCM, recipient list."""
    if len(enc) < 38 or doc["type"] not in LETTER_KINDS or doc["epoch"] != 0:
        return MALFORMED
    n = enc[1]
    if enc[0] != V4 or not 1 <= n <= 16 or len(enc) < 66 + 64 * n:
        return MALFORMED
    kid = struct.unpack(">I", enc[2:6])[0]
    sk = [k for k in owner_keys if k["id"] == kid]
    if not sk or sk[0]["purpose"] != PURPOSE_ENCRYPTION or sk[0]["keyType"] != KEY_TYPE_SECP256K1 \
            or len(bytes.fromhex(sk[0]["data"])) != 33:
        return MALFORMED
    sender_pub = bytes.fromhex(sk[0]["data"])
    C, head = enc[6:38], enc[1:38 + 64 * n]
    found = None
    for d in reader_privs:
        try:
            S = ecdh(d, sender_pub)
        except ValueError:
            return MALFORMED
        for i in range(n):
            spt = cbc_open(S, enc[38 + 64 * i:38 + 64 * (i + 1)])
            if spt is None or len(spt) != 47 or spt[0] != SLOT_VERSION or spt[1:15] != C[:14]:
                continue
            if obj_keys(spt[15:])[1] == C:
                found = (i, spt[15:])
                break
        if found:
            break
    if found is None:
        return unreadable("notARecipient")
    slot, k_obj = found
    try:
        pt = AESGCM(obj_keys(k_obj)[0]).decrypt(enc[38 + 64 * n:50 + 64 * n], enc[50 + 64 * n:],
                                                ad(doc, None, V4) + sha256(head))
    except Exception:
        return unreadable("badTag")
    parsed = parse_letter_tlv(pt)
    if parsed is None or len(parsed[1]) != n or parsed[1][0] != bytes.fromhex(doc["ownerId"]) \
            or len(set(parsed[1])) != n or parsed[1][slot] != reader_id:
        return MALFORMED
    return dict(status="readable", fields={"body": parsed[0]}, recipients=[H(r) for r in parsed[1]], slot=slot)


def owner_key(party, key_id=4, purpose=PURPOSE_ENCRYPTION, key_type=KEY_TYPE_SECP256K1):
    return dict(id=key_id, purpose=purpose, keyType=key_type, data=H(party["pub"]))


def party_json(p):
    return dict(identityId=H(p["id"]), priv=p["priv"].to_bytes(32, "big").hex(), pub=H(p["pub"]))


def reader_json(p, keys=None):
    return dict(identityId=H(p["id"]), keys=[(p["priv"] if k is None else k).to_bytes(32, "big").hex()
                                             for k in (keys or [None])])


NAMED_N3 = [NAMED_SENDER] + NAMED_OTHERS[:2]


def named_vectors():
    for n in (1, 3, 16):
        recipients = [NAMED_SENDER] + NAMED_OTHERS[:n - 1]
        assert len({p["id"] for p in recipients}) == n
        k_obj, nonce, ivs = named_inputs(n)
        body = f"A letter to {n} people (the sender included): the embargo ends on Friday."
        doc = named_doc()
        shared, C, head, A, pt, enc = seal_named(doc, NAMED_SENDER, 4, recipients, tlv((2, body.encode())), k_obj,
                                                 nonce, ivs)
        assert len(enc) == 66 + 64 * n + len(pt) and (len(pt) % 64 == 0)
        okeys = [owner_key(NAMED_SENDER)]
        opened = []
        for p in recipients:
            r = open_named(doc, enc, okeys, p["id"], [p["priv"]])
            assert r["status"] == "readable", (n, p["name"], r)
            opened.append(r)
        assert open_named(doc, enc, okeys, NAMED_OUTSIDER["id"], [NAMED_OUTSIDER["priv"]]) == unreadable("notARecipient")
        vector("named_envelope", f"n{n}",
               f"a specific-people comment to {n} recipient(s), the sender in slot 0: each slot is IV ‖ "
               "AES-256-CBC(S, IV, 0x02 ‖ KCV_obj ‖ K_obj) under S = SHA-256 of the compressed ECDH point; "
               "AD' = AD(0x04, epoch 0) ‖ SHA-256(H); tag 25 lists the recipients in slot order (§4.1).",
               dict(repoId=H(repoId), doc=doc, fields={"body": body}, sender=dict(party_json(NAMED_SENDER), keyId=4),
                    recipients=[party_json(p) for p in recipients], kObj=H(k_obj), nonce=H(nonce),
                    ivs=[H(i) for i in ivs]),
               dict(shared=[H(s) for s in shared], commit=H(C), kcv=H(C[:14]), headerSha256=H(sha256(head)), ad=H(A),
                    tlv=H(pt), enc=H(enc), opened=opened))

    # negatives over the n = 3 letter (alice, r1, r2)
    k_obj, nonce, ivs = named_inputs(3)
    body = tlv((2, b"A letter to 3 people (the sender included): the embargo ends on Friday."))
    doc = named_doc()
    okeys = [owner_key(NAMED_SENDER)]
    _, C, head, _, _, enc = seal_named(doc, NAMED_SENDER, 4, NAMED_N3, body, k_obj, nonce, ivs)
    readers3 = [reader_json(p) for p in NAMED_N3]

    def neg(name, desc, enc_, readers, owner_keys=okeys, doc_=doc):
        results = []
        for r in readers:
            privs = [int(k, 16) for k in r["keys"]]
            results.append(open_named(doc_, enc_, owner_keys, bytes.fromhex(r["identityId"]), privs))
        vector("named_envelope_open", name, desc,
               dict(repoId=H(repoId), doc=dict(doc_, enc=H(enc_)), ownerKeys=owner_keys, readers=readers),
               dict(results=results))
        return results

    slot = lambda e, i: e[38 + 64 * i:38 + 64 * (i + 1)]
    swapped = enc[:38] + slot(enc, 0) + slot(enc, 2) + slot(enc, 1) + enc[38 + 192:]
    res = neg("swapped_slots", "slots 1 and 2 exchanged, each intact: every reader still finds its slot, but "
              "SHA-256(H) in AD' changed, so BadTag for all three.", swapped, readers3)
    assert all(r == unreadable("badTag") for r in res)
    res = neg("not_a_recipient", "dave holds an ENCRYPTION key but no slot opens under it: NotARecipient.", enc,
              [reader_json(NAMED_OUTSIDER)])
    assert res == [unreadable("notARecipient")]
    flipped = bytearray(enc)
    flipped[38 + 20] ^= 0x01
    res = neg("other_slot_flipped", "one byte flipped inside alice's slot (slot 0): alice's slot no longer opens "
              "(NotARecipient); r2 still opens its own slot, then GCM fails under the changed H (BadTag).",
              bytes(flipped), [reader_json(NAMED_N3[0]), reader_json(NAMED_N3[2])])
    assert res == [unreadable("notARecipient"), unreadable("badTag")]
    # r1's slot re-wrapped to another key K' with its own valid KCV: the KCV no longer matches COMMIT_obj
    k_alt = sha256(b"dash-forge vectors: named equivocating key")
    alt_pt = bytes([SLOT_VERSION]) + obj_keys(k_alt)[1][:14] + k_alt
    eq = seal_named(doc, NAMED_SENDER, 4, NAMED_N3, body, k_obj, nonce, ivs,
                    slot_override={1: cbc(ecdh(NAMED_SENDER["priv"], NAMED_N3[1]["pub"]), ivs[1], alt_pt)})[5]
    res = neg("equivocating_slot", "the sender wraps a different K' (with K''s own KCV) into r1's slot, the "
              "S3 equivocation: r1's slot fails the KCV prefix of the header's COMMIT_obj, so NotARecipient; the "
              "other readers open the letter (the header they hash is the one sealed).", eq, readers3)
    assert res[1] == unreadable("notARecipient") and res[0]["status"] == "readable"
    res = neg("wrong_sender_key_type", "the owner's key 4 is a BLS12_381 key: the sender key must be "
              "ECDSA_SECP256K1 with purpose ENCRYPTION, so the letter is malformed for every reader.", enc, readers3,
              owner_keys=[owner_key(NAMED_SENDER, key_type=KEY_TYPE_BLS)])
    assert all(r == MALFORMED for r in res)
    res = neg("wrong_sender_key_purpose", "the owner's key 4 is an AUTHENTICATION key: malformed.", enc, readers3[:1],
              owner_keys=[owner_key(NAMED_SENDER, purpose=PURPOSE_AUTHENTICATION)])
    assert res == [MALFORMED]
    res = neg("sender_key_missing", "senderKeyId names a key the owner does not have: malformed.", enc, readers3[:1],
              owner_keys=[owner_key(NAMED_SENDER, key_id=5)])
    assert res == [MALFORMED]
    other_owner = dict(doc, ownerId=H(NAMED_OTHERS[5]["id"]))
    res = neg("other_owner", "the same enc as another identity's document, whose key 4 is not alice's: no slot opens "
              "(the ECDH binds the sender), NotARecipient.", enc, readers3[1:2],
              owner_keys=[owner_key(NAMED_OTHERS[5])], doc_=other_owner)
    assert res == [unreadable("notARecipient")]
    res = neg("second_key_opens", "a reader holding two ENCRYPTION keys (after a rekey) tries each: the second opens "
              "its slot.", enc, [reader_json(NAMED_N3[1], keys=[NAMED_OUTSIDER["priv"], None])])
    assert res[0]["status"] == "readable"
    short = seal_named(doc, NAMED_SENDER, 4, NAMED_N3, body, k_obj, nonce, ivs,
                       tlv_override=body + rec(25, NAMED_N3[0]["id"]) + rec(25, NAMED_N3[1]["id"]))[5]
    res = neg("recipient_list_short", "a letter to 3 whose TLV lists 2 recipients: count(tag 25) != n, malformed.",
              short, readers3[:1])
    assert res == [MALFORMED]
    misplaced = seal_named(doc, NAMED_SENDER, 4, NAMED_N3, body, k_obj, nonce, ivs,
                           tlv_override=body + b"".join(rec(25, p["id"]) for p in (NAMED_N3[0], NAMED_N3[2], NAMED_N3[1])))[5]
    res = neg("reader_not_at_its_slot", "the TLV lists r2 at slot 1 and r1 at slot 2: r1 opens slot 1, whose listed "
              "identity is not r1's, so malformed.", misplaced, readers3[1:2])
    assert res == [MALFORMED]
    res = neg("epoch_not_zero", "a letter carries epoch 0 (D20): another epoch is malformed.", enc, readers3[:1],
              doc_=dict(doc, epoch=1))
    assert res == [MALFORMED]
    wrong_ver = seal_named(doc, NAMED_SENDER, 4, NAMED_N3, body, k_obj, nonce, ivs,
                           slot_pt=bytes([0x01]) + obj_keys(k_obj)[1][:14] + k_obj)[5]
    res = neg("slot_version_1_refused", "a slot whose plaintext starts 0x01 (a repoKey wrap's version) never opens as "
              "a letter slot: NotARecipient.", wrong_ver, readers3[:1])
    assert res == [unreadable("notARecipient")]
    ids = lambda *ps: body + b"".join(rec(25, p["id"]) for p in ps)
    not_first = seal_named(doc, NAMED_SENDER, 4, NAMED_N3, body, k_obj, nonce, ivs,
                           tlv_override=ids(NAMED_OTHERS[2], NAMED_N3[1], NAMED_N3[2]))[5]
    res = neg("sender_not_slot0", "the TLV lists r3, not the owner, at slot 0 (r1 and r2 at their own slots): the "
              "sender is always slot 0, so malformed even for r1.", not_first, readers3[1:2])
    assert res == [MALFORMED]
    dup = seal_named(doc, NAMED_SENDER, 4, NAMED_N3, body, k_obj, nonce, ivs,
                     tlv_override=ids(NAMED_N3[0], NAMED_N3[1], NAMED_N3[1]))[5]
    res = neg("duplicate_recipient", "the TLV lists r1 at slots 1 and 2: no identity appears twice, so malformed "
              "even for r1 at its own slot.", dup, readers3[1:2])
    assert res == [MALFORMED]
    res = neg("sender_key_not_a_point", "the owner's key 4 is 33 bytes that are not a point on secp256k1: "
              "malformed.", enc, readers3[:1], owner_keys=[dict(owner_key(NAMED_SENDER), data="02" + "ff" * 32)])
    assert res == [MALFORMED]
    uncompressed = owner_key(NAMED_SENDER)
    x = int.from_bytes(NAMED_SENDER["pub"][1:], "big")
    y = pow((x ** 3 + 7) % P, (P + 1) // 4, P)
    y = y if y % 2 == NAMED_SENDER["pub"][0] - 2 else P - y
    uncompressed["data"] = "04" + x.to_bytes(32, "big").hex() + y.to_bytes(32, "big").hex()
    res = neg("sender_key_uncompressed", "the owner's key 4 is the same point in 65-byte uncompressed form: a "
              "Platform ECDSA_SECP256K1 key is 33 bytes, so malformed.", enc, readers3[:1], owner_keys=[uncompressed])
    assert res == [MALFORMED]
    n0 = bytearray(enc)
    n0[1] = 0
    res = neg("n_zero", "n = 0: malformed before any key is used.", bytes(n0), readers3[:1])
    assert res == [MALFORMED]
    n17 = bytearray(enc)
    n17[1] = 17
    n17 += bytes(64 * 14)
    res = neg("n_seventeen", "n = 17 (with room for 17 slots): more than 16 recipients is malformed.", bytes(n17),
              readers3[:1])
    assert res == [MALFORMED]
    res = neg("truncated", "one byte short of the framing for n = 3: malformed.", enc[:66 + 64 * 3 - 1], readers3[:1])
    assert res == [MALFORMED]
    ref_doc = dict(type="refUpdate", vis="public", ownerId=H(NAMED_SENDER["id"]), epoch=0, refNameHash="55" * 32,
                   newOid="aa" * 20)
    res = neg("ref_update_refused", "a letter is an issue, PR, comment, review or event: a v0x04 refUpdate is "
              "malformed.", enc, readers3[:1], doc_=ref_doc)
    assert res == [MALFORMED]
    res = neg("config_refused", "a v0x04 config is malformed.", enc, readers3[:1],
              doc_=dict(type="config", vis="public", ownerId=H(NAMED_SENDER["id"]), epoch=0))
    assert res == [MALFORMED]

    # the writer refuses what a reader would: the same input shape as named_envelope, `error` expected
    def writer_check(doc_, f, recipients):
        """The letter writer's refusals, in the reader rule's terms."""
        ids_ = [p["id"] for p in recipients]
        if doc_["type"] not in LETTER_KINDS or doc_["epoch"] != 0 or not 1 <= len(ids_) <= 16 \
                or ids_[0] != bytes.fromhex(doc_["ownerId"]) or len(set(ids_)) != len(ids_):
            return "malformed"
        size = sum(3 + len(x.encode()) for x in f.values()) + 35 * len(ids_)
        return "tooLarge" if size > MAX_ENC[doc_["type"]] - (66 + 64 * len(ids_)) else None

    def refused(name, desc, recipients, err, doc_=doc, fields=None, n_ivs=None):
        f = {"body": "x"} if fields is None else fields
        assert writer_check(doc_, f, recipients) == err, name
        k, nn, ivs_ = named_inputs(3)
        ivs_ = [sha256(b"dash-forge vectors: named refused iv %d" % i)[:16] for i in range(len(recipients))]
        vector("named_envelope", name, desc,
               dict(repoId=H(repoId), doc=doc_, fields=f, sender=dict(party_json(NAMED_SENDER), keyId=4),
                    recipients=[party_json(p) for p in recipients], kObj=H(k), nonce=H(nn), ivs=[H(i) for i in ivs_]),
               dict(error=err))

    refused("refused_sender_not_first", "the sender is not the first recipient: the writer refuses.",
            [NAMED_N3[1], NAMED_SENDER], "malformed")
    refused("refused_duplicate_recipient", "r1 listed twice: the writer refuses.",
            [NAMED_SENDER, NAMED_N3[1], NAMED_N3[1]], "malformed")
    refused("refused_seventeen", "17 recipients, the sender included: the writer refuses.",
            [NAMED_SENDER] + NAMED_OTHERS + [NAMED_OUTSIDER], "malformed")
    refused("refused_epoch_1", "a letter carries epoch 0 (D20): the writer refuses epoch 1.", NAMED_N3, "malformed",
            doc_=named_doc(epoch=1))
    refused("refused_ref_update", "a refUpdate is not a letter kind: the writer refuses.", NAMED_N3, "malformed",
            doc_=ref_doc, fields={"refName": "refs/heads/main"})
    room = MAX_ENC["comment"] - (66 + 64 * 3) - 3 * 35 - 3
    refused("refused_over_cap", f"a comment body one byte over the room of a letter to 3 ({room} bytes) does not "
            "fit.", NAMED_N3, "tooLarge", fields={"body": "b" * (room + 1)})


# --- sealed artifacts under a specific-people header (DFPK version 0x02) ---------------------------

ARTIFACT_VERSION = 0x02


def obj_pack_key(k_obj, file_id):
    """K_pack,obj,fileId = HKDF-Expand(PRK_obj, "dash-forge/v2/obj-pack" ‖ 0x00 ‖ 0x02 ‖ fileId, 32)."""
    return expand(hmac.new(repoId, k_obj, hashlib.sha256).digest(), b"dash-forge/v2/obj-pack\x00\x02" + file_id)


def seal_named_artifact(sender, key_id, recipients, plain, k_obj, file_id, ivs, L=14):
    """(header, sealed) of `plain` sealed to `recipients` (slot 0 the sender) under a DFPK 0x02 header."""
    _, C = obj_keys(k_obj)
    spt = bytes([SLOT_VERSION]) + C[:14] + k_obj
    slots = [cbc(ecdh(sender["priv"], r["pub"]), iv, spt) for r, iv in zip(recipients, ivs)]
    block = bytes([len(recipients)]) + u32(key_id) + C + b"".join(slots)
    hdr = b"DFPK" + bytes([ARTIFACT_VERSION, L, 0, 0]) + block + u64(len(plain)) + file_id
    S = 1 << L
    nseg = max(1, -(-len(plain) // S))
    kf = obj_pack_key(k_obj, file_id)
    out = bytearray(hdr)
    for i in range(nseg):
        out += AESGCM(kf).encrypt(u64(i) + b"\x00\x00\x00" + bytes([1 if i == nseg - 1 else 0]), plain[i * S:(i + 1) * S], hdr)
    return hdr, bytes(out)


def open_named_artifact(sealed, size_bytes, owner_keys, reader_id, reader_privs):
    """The reference reader of a DFPK 0x02 artifact: length, header, sender key, slot, segments."""
    if len(sealed) != size_bytes:
        return dict(error="sizeMismatch")
    if len(sealed) < 45 or sealed[:4] != b"DFPK" or sealed[4] != ARTIFACT_VERSION or not 10 <= sealed[5] <= 20 \
            or sealed[6:8] != b"\x00\x00":
        return dict(error="sealedPackCorrupt")
    n = sealed[8]
    hl = 69 + 64 * n
    if not 1 <= n <= 16 or len(sealed) < hl:
        return dict(error="sealedPackCorrupt")
    hdr, block = sealed[:hl], sealed[8:45 + 64 * n]
    plen, file_id, S = struct.unpack(">Q", hdr[hl - 24:hl - 16])[0], hdr[hl - 16:], 1 << sealed[5]
    nseg = max(1, -(-plen // S))
    if hl + plen + 16 * nseg != len(sealed):
        return dict(error="sealedPackCorrupt")
    kid = struct.unpack(">I", block[1:5])[0]
    sk = [k for k in owner_keys if k["id"] == kid]
    if not sk or sk[0]["purpose"] != PURPOSE_ENCRYPTION or sk[0]["keyType"] != KEY_TYPE_SECP256K1:
        return dict(error="malformed")
    C, k_obj = block[5:37], None
    for d in reader_privs:
        S_ = ecdh(d, bytes.fromhex(sk[0]["data"]))
        for i in range(n):
            spt = cbc_open(S_, block[37 + 64 * i:37 + 64 * (i + 1)])
            if spt and len(spt) == 47 and spt[0] == SLOT_VERSION and spt[1:15] == C[:14] and obj_keys(spt[15:])[1] == C:
                k_obj = spt[15:]
                break
        if k_obj:
            break
    if k_obj is None:
        return dict(error="notARecipient")
    kf, out, at = obj_pack_key(k_obj, file_id), b"", hl
    for i in range(nseg):
        ln = min(S, plen - i * S) + 16
        try:
            out += AESGCM(kf).decrypt(u64(i) + b"\x00\x00\x00" + bytes([1 if i == nseg - 1 else 0]), sealed[at:at + ln], hdr)
        except Exception:
            return dict(error="sealedPackCorrupt")
        at += ln
    return dict(plaintextHex=H(out))


def named_artifact_vectors():
    recipients = NAMED_N3
    k_obj = sha256(b"dash-forge vectors: named artifact kObj")
    file_id = sha256(b"dash-forge vectors: named artifact fileId")[:16]
    ivs = [sha256(b"dash-forge vectors: named artifact iv %d" % i)[:16] for i in range(3)]
    snapshot = b'{"env":"production","generatedAt":1767225600000,"vars":{"STRIPE_KEY":{"type":"secret","value":"sk_test_x"}}}'
    plain = snapshot + b" " * (512 - len(snapshot))
    hdr, sealed = seal_named_artifact(NAMED_SENDER, 4, recipients, plain, k_obj, file_id, ivs)
    assert len(hdr) == 69 + 64 * 3 and len(sealed) == len(hdr) + 512 + 16
    okeys = [owner_key(NAMED_SENDER)]
    for p in recipients:
        assert open_named_artifact(sealed, len(sealed), okeys, p["id"], [p["priv"]]) == dict(plaintextHex=H(plain))
    vector("named_artifact", "n3", "an environment snapshot (512 bytes) sealed to three people under a DFPK version 0x02 "
           "header: the slot block of a letter stands where version 0x01 has its epoch; the file key is "
           "HKDF-Expand(PRK_obj, \"dash-forge/v2/obj-pack\" ‖ 0x00 ‖ 0x02 ‖ fileId); the whole header is every "
           "segment's AD (§3.2).",
           dict(repoId=H(repoId), ownerId=H(NAMED_SENDER["id"]), sender=dict(party_json(NAMED_SENDER), keyId=4),
                recipients=[party_json(p) for p in recipients], kObj=H(k_obj), fileId=H(file_id), ivs=[H(i) for i in ivs],
                plaintextHex=H(plain)),
           dict(header=H(hdr), packKey=H(obj_pack_key(k_obj, file_id)), sealedLen=len(sealed),
                packHash=H(sha256(sealed)), sealed=H(sealed)))

    def neg(name, desc, sealed_, readers, owner_keys=okeys, size=None):
        size = len(sealed_) if size is None else size
        results = [open_named_artifact(sealed_, size, owner_keys, bytes.fromhex(r["identityId"]),
                                       [int(k, 16) for k in r["keys"]]) for r in readers]
        vector("named_artifact_open", name, desc,
               dict(repoId=H(repoId), sealed=H(sealed_), sizeBytes=size, ownerKeys=owner_keys, readers=readers),
               dict(results=results))
        return results

    readers3 = [reader_json(p) for p in NAMED_N3]
    res = neg("recipients", "every recipient opens the snapshot; dave, not listed, does not.", sealed,
              readers3 + [reader_json(NAMED_OUTSIDER)])
    assert res[3] == dict(error="notARecipient")
    flipped = bytearray(sealed)
    flipped[8 + 37 + 64 + 20] ^= 0x01
    res = neg("slot_flipped", "a byte flipped inside r1's slot: r1 finds no slot; alice and r2 open theirs, but the "
              "header is every segment's AD, so SealedPackCorrupt.", bytes(flipped), readers3)
    assert res[0] == dict(error="sealedPackCorrupt") and res[1] == dict(error="notARecipient")
    res = neg("size_mismatch", "the manifest's sizeBytes is one byte off: refused before anything is read.", sealed,
              readers3[:1], size=len(sealed) + 1)
    assert res == [dict(error="sizeMismatch")]
    res = neg("wrong_sender_key_type", "the owner's key 4 is a BLS12_381 key: malformed.", sealed, readers3[:1],
              owner_keys=[owner_key(NAMED_SENDER, key_type=KEY_TYPE_BLS)])
    assert res == [dict(error="malformed")]
    trunc = sealed[:-1]
    res = neg("truncated", "one byte short of what the header says (sizeBytes agreeing): SealedPackCorrupt.", trunc,
              readers3[:1])
    assert res == [dict(error="sealedPackCorrupt")]
    v1 = bytearray(sealed)
    v1[4] = 0x01
    res = neg("version_1_refused", "the same bytes labelled header version 0x01 are not a specific-people artifact.",
              bytes(v1), readers3[:1])
    assert res == [dict(error="sealedPackCorrupt")]


# Vector files committed by hand (efbb9f1e, d0e66072) that this generator does not produce yet: kept
# as they are rather than deleted on every run. Porting them here is a follow-up.
HAND_WRITTEN = {
    "private_doc_open__issue_edited_after_stated_height_late.json",
    "private_doc_open__late_cutoff_from_stated_height.json",
    "private_epoch__burned_next_epoch_reanchored_keeps_first_height.json",
    "private_epoch__config_without_enc_not_a_candidate.json",
    "private_epoch__late_cutoff_ignores_other_key_config.json",
    "private_epoch__reanchored_next_epoch_keeps_first_height.json",
}


def write_vectors(out_dir):
    kdf_vectors()
    ref_hash_vectors()
    doc_seal_vectors()
    doc_open_vectors()
    pack_vectors()
    wrap_vectors()
    epoch_vectors()
    collab_seal_vectors()
    hedge_vectors()
    release_seal_vectors()
    release_open_vectors()
    release_fold_vectors()
    mixed_vectors()
    named_vectors()
    named_artifact_vectors()
    for pattern in ("private_*.json", "mixed_doc_*.json", "named_envelope*.json", "named_artifact*.json"):
        for old in glob.glob(os.path.join(out_dir, pattern)):
            if os.path.basename(old) not in HAND_WRITTEN:
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


if __name__ == "__main__":
    out = summary()
    check_against_document(out)
    if "--write-vectors" in sys.argv:
        here = os.path.dirname(os.path.abspath(__file__))
        write_vectors(os.path.join(here, "..", "..", "forge-contracts", "vectors"))
    else:
        print(json.dumps(out, indent=1))

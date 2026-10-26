#!/usr/bin/env python3
"""Independent generator and checker for the passkey vault's test vectors.

Written from RFC 9180 and the format spec (docs/passkey-vault.md), sharing no code with the TypeScript module: HKDF is built
on Python's hmac, X25519 and ChaCha20-Poly1305 come from `cryptography`. It

  1. checks its HPKE against RFC 9180 Appendix A.2.1,
  2. reproduces Yappr's RAW and RING vectors (yappr.json, copied from Yappr lib/crypto/passkey-vault.test.ts),
  3. reproduces govhub's fixed vector and checks it against govhub's snapshot (govhub.json), filling in the full bytes,
  4. writes the Forge vectors (forge.json).

Usage:  python3 generate.py          rewrite govhub.json's derived bytes and forge.json
        python3 generate.py --check  fail if either file differs from what this script computes
"""
import hashlib
import hmac
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

HERE = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------------------------------------------------------
# RFC 9180: DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305, base mode, single shot
# ---------------------------------------------------------------------------------------------------------------------------

KEM_SUITE = b"KEM" + (0x0020).to_bytes(2, "big")
HPKE_SUITE = b"HPKE" + (0x0020).to_bytes(2, "big") + (0x0001).to_bytes(2, "big") + (0x0003).to_bytes(2, "big")


def hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    return hmac.new(salt if salt else b"\x00" * 32, ikm, hashlib.sha256).digest()


def hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    out, block, counter = b"", b"", 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


def labeled_extract(suite: bytes, salt: bytes, label: bytes, ikm: bytes) -> bytes:
    return hkdf_extract(salt, b"HPKE-v1" + suite + label + ikm)


def labeled_expand(suite: bytes, prk: bytes, label: bytes, info: bytes, length: int) -> bytes:
    return hkdf_expand(prk, length.to_bytes(2, "big") + b"HPKE-v1" + suite + label + info, length)


def raw_pub(sk: bytes) -> bytes:
    return X25519PrivateKey.from_private_bytes(sk).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def derive_key_pair(ikm: bytes):
    assert len(ikm) >= 32
    prk = labeled_extract(KEM_SUITE, b"", b"dkp_prk", ikm)
    sk = labeled_expand(KEM_SUITE, prk, b"sk", b"", 32)
    # cryptography clamps internally; report the unclamped sk as RFC 9180 does
    return sk, raw_pub(sk)


def dh(sk: bytes, pk: bytes) -> bytes:
    shared = X25519PrivateKey.from_private_bytes(sk).exchange(X25519PublicKey.from_public_bytes(pk))
    assert shared != b"\x00" * 32
    return shared


def kem_shared(dh_out: bytes, kem_context: bytes) -> bytes:
    prk = labeled_extract(KEM_SUITE, b"", b"eae_prk", dh_out)
    return labeled_expand(KEM_SUITE, prk, b"shared_secret", kem_context, 32)


def key_schedule(shared: bytes, info: bytes):
    psk_id_hash = labeled_extract(HPKE_SUITE, b"", b"psk_id_hash", b"")
    info_hash = labeled_extract(HPKE_SUITE, b"", b"info_hash", info)
    context = b"\x00" + psk_id_hash + info_hash
    secret = labeled_extract(HPKE_SUITE, shared, b"secret", b"")
    return labeled_expand(HPKE_SUITE, secret, b"key", context, 32), labeled_expand(HPKE_SUITE, secret, b"base_nonce", context, 12)


def seal_base(pk_r: bytes, info: bytes, aad: bytes, pt: bytes, ikm_e: bytes):
    sk_e, pk_e = derive_key_pair(ikm_e)
    shared = kem_shared(dh(sk_e, pk_r), pk_e + pk_r)
    key, nonce = key_schedule(shared, info)
    return pk_e, ChaCha20Poly1305(key).encrypt(nonce, pt, aad)


def open_base(enc: bytes, sk_r: bytes, info: bytes, aad: bytes, ct: bytes) -> bytes:
    shared = kem_shared(dh(sk_r, enc), enc + raw_pub(sk_r))
    key, nonce = key_schedule(shared, info)
    return ChaCha20Poly1305(key).decrypt(nonce, ct, aad)


def check_rfc9180_a2():
    h = bytes.fromhex
    sk_e, pk_e = derive_key_pair(h("909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b"))
    sk_r, pk_r = derive_key_pair(h("1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df"))
    assert sk_e.hex() == "f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600"
    assert pk_e.hex() == "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a"
    assert sk_r.hex() == "8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb"
    assert pk_r.hex() == "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a"
    info, aad = h("4f6465206f6e2061204772656369616e2055726e"), h("436f756e742d30")
    pt = h("4265617574792069732074727574682c20747275746820626561757479")
    enc, ct = seal_base(pk_r, info, aad, pt, h("909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b"))
    assert enc == pk_e
    assert ct.hex() == "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28"
    assert open_base(enc, sk_r, info, aad, ct) == pt


# ---------------------------------------------------------------------------------------------------------------------------
# The vault format (docs/passkey-vault.md)
# ---------------------------------------------------------------------------------------------------------------------------

SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


def sha(label: str) -> bytes:
    return hashlib.sha256(label.encode()).digest()


def prf_input(profile, contract: bytes) -> bytes:
    return profile["prfLabel"].encode() + contract


def hpke_info(profile, contract: bytes, owner: bytes) -> bytes:
    return profile["infoLabel"].encode() + b"\x00" + contract + owner


def entry_aad(profile, version: int, cred: bytes, recipient: bytes, auth_key_id: int) -> bytes:
    assert 16 <= len(cred) <= 255 and len(recipient) == 32
    return profile["aadDocType"].encode() + bytes([0, version, len(cred)]) + cred + recipient + auth_key_id.to_bytes(4, "big")


def slot_bundle(fmt: int, length: int, max_keys: int, keys) -> bytes:
    assert 1 <= len(keys) <= max_keys
    out = bytes([fmt, len(keys)])
    for k in keys:
        sk = bytes.fromhex(k["privateKey"])
        assert len(sk) == 32 and 0 < int.from_bytes(sk, "big") < SECP256K1_N
        out += bytes([k["purpose"], k["securityLevel"], k["keyType"]]) + k["keyId"].to_bytes(4, "big") + sk
    assert len(out) <= length
    return out + b"\x00" * (length - len(out))


def build(profile, contract: bytes, owner: bytes, v, fmt):
    """Every derived field of one vector, from its inputs."""
    cred, prf, ikm = bytes.fromhex(v["credentialId"]), bytes.fromhex(v["prfOutput"]), bytes.fromhex(v["ephemeralIkm"])
    sk_r, pk_r = derive_key_pair(prf)
    auth_key_id = v["keys"][0]["keyId"]
    info = hpke_info(profile, contract, owner)
    aad = entry_aad(profile, profile["entryVersion"], cred, pk_r, auth_key_id)
    bundle = slot_bundle(fmt["id"], fmt["length"], fmt["maxKeys"], v["keys"])
    enc, sealed = seal_base(pk_r, info, aad, bundle, ikm)
    assert open_base(enc, sk_r, info, aad, sealed) == bundle
    assert len(sealed) == fmt["length"] + 16
    return {
        "prfInput": prf_input(profile, contract).hex(),
        "recipientSk": sk_r.hex(),
        "recipientKey": pk_r.hex(),
        "authKeyId": auth_key_id,
        "info": info.hex(),
        "aad": aad.hex(),
        "bundle": bundle.hex(),
        "enc": enc.hex(),
        "sealed": sealed.hex(),
    }


def check_yappr():
    data = json.loads((HERE / "yappr.json").read_text())
    profile, contract, owner = data["profile"], bytes.fromhex(data["contractId"]), bytes.fromhex(data["ownerId"])
    assert contract == sha(data["contractIdLabel"]) and owner == sha(data["ownerIdLabel"])
    for v in data["vectors"]:
        fmt = next(f for f in profile["formats"] if f["id"] == v["format"])
        got = build(profile, contract, owner, v, fmt)
        for field, value in got.items():
            if field in v:
                assert v[field] == value, f"yappr {v['name']}: {field} differs"
        assert v["enc"] == got["enc"] and v["sealed"] == got["sealed"]


def govhub(check: bool) -> bool:
    path = HERE / "govhub.json"
    data = json.loads(path.read_text())
    profile, contract, owner = data["profile"], bytes.fromhex(data["contractId"]), bytes.fromhex(data["ownerId"])
    v = data["vector"]
    fmt = next(f for f in profile["formats"] if f["id"] == v["format"])
    got = build(profile, contract, owner, v, fmt)
    snap = v["snapshot"]
    assert got["enc"] == snap["enc"], "govhub enc differs from the snapshot"
    assert got["sealed"][:32] == snap["sealedHead"] and got["sealed"][-32:] == snap["tag"], "govhub sealed differs from the snapshot"
    want = dict(data)
    want["vector"] = {**v, "derived": got}
    return write_or_check(path, want, check)


FORGE_PROFILE = {
    "prfLabel": "dash-forge/passkey-vault/v1/prf",
    "infoLabel": "dash-forge/passkey-vault/v1",
    "aadDocType": "vaultEntry",
    "entryVersion": 1,
    "strictSealedLength": True,
    "formats": [{"id": 1, "codec": "slotKeys", "length": 240, "maxKeys": 6}],
}


def key(purpose, level, key_type, key_id, label):
    return {"purpose": purpose, "securityLevel": level, "keyType": key_type, "keyId": key_id, "privateKey": sha(label).hex(), "label": label}


def forge(check: bool) -> bool:
    contract_label, owner_label = "forge test vector: forge-meta contract id", "forge test vector: owner identity id"
    contract, owner = sha(contract_label), sha(owner_label)
    fmt = FORGE_PROFILE["formats"][0]
    cases = [
        {
            "name": "main key only",
            "credentialId": sha("forge test vector: credential 1")[:16].hex(),
            "prfOutput": sha("forge test vector: prf output 1").hex(),
            "ephemeralIkm": sha("forge test vector: ephemeral 1").hex(),
            "keys": [key(0, 2, 0, 3, "forge test vector: limited key")],
        },
        {
            "name": "main key, four wallet grants and the encryption key (full)",
            "credentialId": sha("forge test vector: credential 2").hex(),
            "prfOutput": sha("forge test vector: prf output 2").hex(),
            "ephemeralIkm": sha("forge test vector: ephemeral 2").hex(),
            "keys": [
                key(0, 2, 0, 5, "forge test vector: group-bound wallet key"),
                key(0, 2, 0, 6, "forge test vector: grant forge-core"),
                key(0, 2, 2, 7, "forge test vector: grant forge-collab"),
                key(0, 2, 0, 8, "forge test vector: grant forge-meta"),
                key(0, 2, 0, 9, "forge test vector: grant forge-community"),
                key(1, 3, 0, 10, "forge test vector: encryption key"),
            ],
        },
        {
            "name": "hash160 main key and the encryption key, 255-byte credential id, key id above 2^31",
            "credentialId": (sha("forge test vector: credential 3a") * 8)[:255].hex(),
            "prfOutput": sha("forge test vector: prf output 3").hex(),
            "ephemeralIkm": sha("forge test vector: ephemeral 3").hex(),
            "keys": [
                key(0, 2, 2, 0x80000001, "forge test vector: hash160 key"),
                key(1, 3, 0, 4, "forge test vector: encryption key 3"),
            ],
        },
    ]
    vectors = [{**c, **build(FORGE_PROFILE, contract, owner, c, fmt)} for c in cases]
    want = {
        "about": "Forge passkey-vault vectors, written by generate.py (Python cryptography, independent of the TypeScript module). "
        "Ids and keys are sha256 of the labels. Regenerate with `python3 generate.py`; never edit by hand.",
        "profile": FORGE_PROFILE,
        "contractIdLabel": contract_label,
        "ownerIdLabel": owner_label,
        "contractId": contract.hex(),
        "ownerId": owner.hex(),
        "vectors": vectors,
    }
    return write_or_check(HERE / "forge.json", want, check)


def write_or_check(path: Path, want, check: bool) -> bool:
    text = json.dumps(want, indent=2) + "\n"
    if check:
        ok = path.exists() and path.read_text() == text
        if not ok:
            print(f"{path.name} is out of date: run python3 generate.py", file=sys.stderr)
        return ok
    path.write_text(text)
    return True


def main() -> int:
    check = "--check" in sys.argv[1:]
    check_rfc9180_a2()
    check_yappr()
    ok = govhub(check) & forge(check)
    print("RFC 9180 A.2, Yappr RAW/RING and govhub's snapshot reproduced;", "vectors up to date" if check else "vectors written")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

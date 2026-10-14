"""Independent Python reference for check runs on members-only branches (mixed-visibility design §4.3
"CI on a members branch"; docs/security/private-repos.md §19.8).

    python3 tools/private-repos-vectors/members_checks.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/members_checks.py --write-vectors  # (re)write the vector files below

Cases it writes (forge-contracts/vectors/members_check__<name>.json):

- `op: name`: the check-name key `K_name = HMAC-SHA256(salt, "dash-forge/v2/check-name")` of a blinded
  commit (the blind's salt, TLV 27) and a check's opaque name `base32(HMAC-SHA256(K_name, 0x01 ‖ name))[0..16]`
  (RFC 4648, lower case).
- `op: seal`: a run's sealed log, `"DFCL" ‖ 0x01 ‖ nonce ‖ AES-256-GCM(K_log, nonce, P, AD)` with
  `K_log = HMAC-SHA256(K_name, 0x02 ‖ nonce)`,
  `AD = "DFCL" ‖ 0x01 ‖ u8(len(blind)) ‖ blind ‖ opaque name` and
  `P = u32(len(H)) ‖ H ‖ u64(len(log)) ‖ log ‖ zeros to a multiple of 4,096`, `H` the JSON header
  `{"head": <real commit hex>, "name": <check name>, "v": 1}`, read only in that one canonical form (keys in
  that order, no spaces, JSON's shortest escapes, lower-case hex).
- `op: open`: what a member reads from a sealed log, or why it refuses it.

The Rust harness (`forge-core` `private::members_check`) runs every file.
"""
import glob
import hashlib
import hmac
import json
import os
import re
import struct
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from members_git import blind, oid, salt  # noqa: E402

CASE = "members_check"
VECTORS = []
MAGIC, VERSION, PAD = b"DFCL", 1, 4096
NAME_LABEL = b"dash-forge/v2/check-name"
B32 = "abcdefghijklmnopqrstuvwxyz234567"


def vector(name, description, inp, expected):
    VECTORS.append(dict(name=name, description=description, case=CASE, rules="v2", input=inp, expected=expected))


def mac(key, *parts):
    return hmac.new(key, b"".join(parts), hashlib.sha256).digest()


def base32(b):
    bits = "".join(f"{x:08b}" for x in b)
    bits += "0" * (-len(bits) % 5)
    return "".join(B32[int(bits[i:i + 5], 2)] for i in range(0, len(bits), 5))


def name_key(s):
    return mac(s, NAME_LABEL)


def opaque(s, name):
    return base32(mac(name_key(s), b"\x01", name.encode())[:10])


def header(head, name):
    return json.dumps(dict(head=head.hex(), name=name, v=1), sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode()


def plaintext(h, log, pad_byte=0, pad=True):
    p = struct.pack(">I", len(h)) + h + struct.pack(">Q", len(log)) + log
    if pad:
        p += bytes([pad_byte]) * (-len(p) % PAD)
    return p


def ad(b, op):
    return MAGIC + bytes([VERSION, len(b)]) + b + op.encode()


def seal_raw(s, b, op, p, nonce, version=VERSION):
    k = mac(name_key(s), b"\x02", nonce)
    return MAGIC + bytes([version]) + nonce + AESGCM(k).encrypt(nonce, p, ad(b, op))


def seal(s, head, name, log, nonce):
    b = blind(s, head)
    return seal_raw(s, b, opaque(s, name), plaintext(header(head, name), log), nonce)


def open_log(s, b, op, sealed):
    """What a member reads, or the refusal (`malformed`, `unknownVersion`)."""
    if len(sealed) < 33 or sealed[:4] != MAGIC:
        return dict(error="malformed")
    if sealed[4] != VERSION:
        return dict(error="unknownVersion", version=sealed[4])
    nonce = sealed[5:17]
    try:
        p = AESGCM(mac(name_key(s), b"\x02", nonce)).decrypt(nonce, sealed[17:], ad(b, op))
    except Exception:
        return dict(error="malformed")
    if not p or len(p) % PAD:
        return dict(error="malformed")
    hl = struct.unpack(">I", p[:4])[0]
    if 4 + hl + 8 > len(p):
        return dict(error="malformed")
    h, at = p[4:4 + hl], 4 + hl
    ll = struct.unpack(">Q", p[at:at + 8])[0]
    if at + 8 + ll > len(p):
        return dict(error="malformed")
    log, rest = p[at + 8:at + 8 + ll], p[at + 8 + ll:]
    if len(rest) >= PAD or any(rest):
        return dict(error="malformed")
    # only the one canonical form (header() writes it): no duplicate keys, other spacing or order,
    # other escapes, number forms or hex case
    try:
        hd = json.loads(h.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return dict(error="malformed")
    if not isinstance(hd, dict) or set(hd) != {"head", "name", "v"} or type(hd["v"]) is not int or hd["v"] != 1 \
            or not isinstance(hd["head"], str) or not isinstance(hd["name"], str) \
            or not re.fullmatch("(?:[0-9a-f]{2})*", hd["head"]) \
            or json.dumps(hd, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode() != h:
        return dict(error="malformed")
    try:
        head = bytes.fromhex(hd["head"])
    except ValueError:
        return dict(error="malformed")
    if len(head) not in (20, 32) or blind(s, head) != b or opaque(s, hd["name"]) != op:
        return dict(error="malformed")
    return dict(name=hd["name"], head=hd["head"], log=log.hex())


def nonce(label):
    return hashlib.sha256(b"dash-forge vectors: check-log nonce " + label.encode()).digest()[:12]


def vectors():
    s1, s2 = salt("c1"), salt("c2")
    for vname, s, name, desc in [
        ("push", s1, "ci.yml / build", "a push run's check name"),
        ("pull_request", s1, "ci.yml / build (pull_request)", "the same job's PR run: another name"),
        ("other_salt", s2, "ci.yml / build", "the same check on another pushed commit (another salt): another "
         "name, so the public cannot link two pushes of a branch by their checks"),
        ("unicode", s1, "tests / ünïcode ✓", "a name with non-ASCII characters: HMAC over its UTF-8 bytes"),
        ("long", s1, "w" * 100, "a 100-character name (the most a check name holds)"),
    ]:
        vector("name__" + vname, desc + ".", dict(op="name", salt=s.hex(), name=name),
               dict(nameKey=name_key(s).hex(), opaque=opaque(s, name)))

    h20, h32 = oid("A"), oid("B", 32)
    seals = [
        ("completed", s1, h20, "ci.yml / build", b"build ok\n", "a completed run's log: header, log, zeros to 4,096 bytes"),
        ("header_only", s1, h20, "ci.yml / build", b"", "a queued or running run: the header alone (members resolve "
         "the name before the run finishes)"),
        ("two_blocks", s1, h20, "ci.yml / test", bytes(range(256)) * 16, "a log that spills into a second 4,096-byte block"),
        ("sha256_commit", s2, h32, "ci.yml / build", b"sha256 repo\n", "a SHA-256 repository's 32-byte commit and blind"),
    ]
    for vname, s, head, name, log, desc in seals:
        n = nonce(vname)
        sealed = seal(s, head, name, log, n)
        b = blind(s, head)
        vector("seal__" + vname, desc + ".",
               dict(op="seal", salt=s.hex(), head=head.hex(), blind=b.hex(), name=name, log=log.hex(), nonce=n.hex()),
               dict(opaque=opaque(s, name), sealed=sealed.hex(), sha256=hashlib.sha256(sealed).hexdigest()))
        assert open_log(s, b, opaque(s, name), sealed) == dict(name=name, head=head.hex(), log=log.hex())

    # opens and refusals
    b = blind(s1, h20)
    op = opaque(s1, "ci.yml / build")
    good = seal(s1, h20, "ci.yml / build", b"build ok\n", nonce("completed"))
    n = nonce("negative")

    def open_vector(vname, desc, s, b_, op_, sealed):
        vector("open__" + vname, desc, dict(op="open", salt=s.hex(), blind=b_.hex(), opaque=op_, sealed=sealed.hex()),
               open_log(s, b_, op_, sealed))

    open_vector("ok", "a member opens the run's log: the real name, commit and log.", s1, b, op, good)
    open_vector("other_name", "the log under another run's opaque name does not open (AD).", s1, b,
                opaque(s1, "ci.yml / test"), good)
    open_vector("other_blind", "the log on another commit's blind does not open (AD).", s1, blind(s1, oid("C")), op, good)
    open_vector("other_salt", "another commit's salt (another K_name) does not open it.", s2, b, op, good)
    flipped = bytearray(good)
    flipped[-1] ^= 1
    open_vector("tag_flipped", "a flipped tag byte: refused.", s1, b, op, bytes(flipped))
    open_vector("later_version", "version 0x02: a later format this client does not open (not corruption).", s1, b, op,
                good[:4] + b"\x02" + good[5:])
    open_vector("bad_magic", "not a sealed check log: refused.", s1, b, op, b"XXXX" + good[4:])
    open_vector("truncated", "shorter than magic, version, nonce and tag: refused.", s1, b, op, good[:32])
    hdr = header(h20, "ci.yml / build")
    open_vector("nonzero_padding", "padding that is not zeros: refused (one sealed form per log).", s1, b, op,
                seal_raw(s1, b, op, plaintext(hdr, b"x", pad_byte=1), n))
    open_vector("unpadded", "a plaintext that is not a whole number of 4,096-byte blocks: refused.", s1, b, op,
                seal_raw(s1, b, op, plaintext(hdr, b"x", pad=False), n))
    open_vector("name_not_the_runs", "a header naming another check than the run's opaque name hashes from "
                "(sealed under the run's AD by a key holder): refused.", s1, b, op,
                seal_raw(s1, b, op, plaintext(header(h20, "ci.yml / test"), b""), n))
    open_vector("head_not_the_blinds", "a header naming a commit whose blind is not the run's: refused.", s1, b, op,
                seal_raw(s1, b, op, plaintext(header(oid("C"), "ci.yml / build"), b""), n))
    extra = json.dumps(dict(head=h20.hex(), name="ci.yml / build", summary="leak", v=1), sort_keys=True,
                       separators=(",", ":")).encode()
    open_vector("unknown_header_field", "a header with a field this version does not define: refused.", s1, b, op,
                seal_raw(s1, b, op, plaintext(extra, b""), n))
    upper = json.dumps(dict(head=h20.hex().upper(), name="ci.yml / build", v=1), sort_keys=True,
                       separators=(",", ":")).encode()
    open_vector("upper_case_head", "a header whose commit is not lower-case hex: refused (one form).", s1, b, op,
                seal_raw(s1, b, op, plaintext(upper, b""), n))
    canon = lambda d: json.dumps(d, separators=(",", ":"), ensure_ascii=False).encode()
    hx = h20.hex()
    for vname, raw, desc in [
        ("duplicate_key", b'{"head":"' + hx.encode() + b'","name":"ci.yml / test","name":"ci.yml / build","v":1}',
         "a header with a key twice (a reader keeping the last would read another name): refused"),
        ("float_version", b'{"head":"' + hx.encode() + b'","name":"ci.yml / build","v":1.0}',
         "a version written 1.0: refused (one form)"),
        ("spaced", b'{"head": "' + hx.encode() + b'", "name": "ci.yml / build", "v": 1}',
         "a header with spaces: refused (one form)"),
        ("keys_reordered", canon(dict(name="ci.yml / build", head=hx, v=1)),
         "a header with its keys in another order: refused (one form)"),
        ("escaped_slash", b'{"head":"' + hx.encode() + b'","name":"ci.yml \\/ build","v":1}',
         "a header escaping a character JSON need not escape: refused (one form)"),
        ("bom", b"\xef\xbb\xbf" + header(h20, "ci.yml / build"), "a header after a byte-order mark: refused"),
    ]:
        open_vector(vname, desc + ".", s1, b, op, seal_raw(s1, b, op, plaintext(raw, b""), n))
    ctl = "tests / tab\there"
    open_vector("escaped_control", "a name with a control character, written with JSON's short escape (\\t): "
                "the one form opens.", s1, b, opaque(s1, ctl),
                seal_raw(s1, b, opaque(s1, ctl), plaintext(header(h20, ctl), b"x"), n))
    open_vector("log_length_past_end", "a log length past the plaintext: refused.", s1, b, op,
                seal_raw(s1, b, op, (struct.pack(">I", len(hdr)) + hdr + struct.pack(">Q", 1 << 20)).ljust(PAD, b"\0"), n))


def write_vectors(out_dir):
    vectors()
    for old in glob.glob(os.path.join(out_dir, CASE + "__*.json")):
        os.remove(old)
    for v in VECTORS:
        with open(os.path.join(out_dir, f"{v['case']}__{v['name']}.json"), "w") as f:
            f.write(json.dumps(v, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(dict(total=len(VECTORS)), indent=1))


def self_check():
    assert base32(b"foobar") == "mzxw6ytboi" and base32(b"f") == "my"
    s = salt("x")
    assert len(opaque(s, "a")) == 16 and opaque(s, "a") != opaque(s, "b")
    sealed = seal(s, oid("A"), "n", b"log", nonce("x"))
    assert len(sealed) == 33 + PAD
    assert open_log(s, blind(s, oid("A")), opaque(s, "n"), sealed)["log"] == b"log".hex()


if __name__ == "__main__":
    self_check()
    if "--write-vectors" in sys.argv:
        here = os.path.dirname(os.path.abspath(__file__))
        write_vectors(os.path.join(here, "..", "..", "forge-contracts", "vectors"))
    else:
        vectors()
        print(json.dumps(dict(total=len(VECTORS)), indent=1))

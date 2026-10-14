"""Independent Python reference for key letters (kind 10; mixed-visibility design §4.3 "Branch keys for CI and
people", §4.9 "Key letters"; docs/security/private-repos.md §20).

    python3 tools/private-repos-vectors/key_letters.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/key_letters.py --write-vectors  # (re)write forge-contracts/vectors/key_letter__*.json

A key letter is a typed JSON object in the canonical form of an environment snapshot (keys sorted by code point, no
whitespace, the escapes \\" \\\\ \\b \\f \\n \\r \\t and a lowercase \\u00xx for any other C0 control, everything else
raw UTF-8; integers 0..2^53-1 only; true, false, null), padded with spaces to a multiple of 512, sealed to specific
people as a DFPK 0x02 artifact (gen.py's seal_named_artifact). `type` and `v` are always present. The `branch` type
(v 1) shares one members-only branch as it is now: the head (blind, real commit, salt), the keyed name hash of the
ref update that set it, the file keys of the members-only packs that hold its history, the check-name key of the
head's salt, and `asOf`.

Every vector has case `key_letter` and an `input.op`: `format` (a typed letter's padded bytes), `decode` (what a reader
takes and refuses, and what the `branch` type reads from it), `seal` (the sealed artifact), `open` (packHash, size,
sender key and slot checks) and `fileKey` (a members-only pack's file key, and opening the pack with it alone). The
Rust harness (`forge_core::private::key_letter`) and the TypeScript harness (`forge-web/lib/private/key-letter`) run
every file and must reproduce it exactly.
"""
import glob
import hashlib
import hmac
import json
import os
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen  # noqa: E402  (the crypto helpers; importing runs no generator)
from gen import (  # noqa: E402
    AESGCM, H, K0, NAMED_OTHERS, NAMED_OUTSIDER, NAMED_SENDER, k_pack, open_named_artifact, owner_key, reader_json,
    repoId, seal_named_artifact, seal_pack, sha256, u64,
)
from members_git import blind  # noqa: E402

CASE = "key_letter"
BUCKET = 512
MAX_LETTER = 64 * 1024
MAX_INT = (1 << 53) - 1
MAX_DEPTH = 16
CHECK_NAME_LABEL = b"dash-forge/v2/check-name"
BRANCH_FIELDS = ("asOf", "checkNameKey", "head", "name", "packs", "refNameHash")

VECTORS = []

ALICE, BOB, CAROL = NAMED_SENDER, NAMED_OTHERS[0], NAMED_OUTSIDER


def vector(name, description, inp, expected):
    VECTORS.append(dict(name=name, description=description, case=CASE, rules="v2", input=inp, expected=expected))


# --- the canonical form ---------------------------------------------------------------------------


def depth(v):
    if isinstance(v, list):
        return 1 + max((depth(x) for x in v), default=0)
    if isinstance(v, dict):
        return 1 + max((depth(x) for x in v.values()), default=0)
    return 0


def valid_value(v):
    if v is None or isinstance(v, (bool, str)):
        return True
    if isinstance(v, int):
        return 0 <= v <= MAX_INT
    if isinstance(v, list):
        return all(valid_value(x) for x in v)
    if isinstance(v, dict):
        return all(isinstance(k, str) and valid_value(x) for k, x in v.items())
    return False


def encode(letter):
    """The padded plaintext of {"type", "v", **fields}, or None (a value with no canonical spelling, too large)."""
    obj = dict(letter["fields"], type=letter["type"], v=letter["v"])
    if "type" in letter["fields"] or "v" in letter["fields"] or not valid_value(obj) or depth(obj) > MAX_DEPTH:
        return None
    if not isinstance(letter["type"], str) or isinstance(letter["v"], bool) or not isinstance(letter["v"], int):
        return None
    try:
        raw = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    except UnicodeEncodeError:
        return None
    size = max(1, -(-len(raw) // BUCKET)) * BUCKET
    return None if size > MAX_LETTER else raw + b" " * (size - len(raw))


def decode(pt):
    """The typed letter of an exactly canonical plaintext, or None (malformed)."""
    if not pt or len(pt) > MAX_LETTER or len(pt) % BUCKET:
        return None
    body = pt.rstrip(b" ")
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("type"), str):
        return None
    v = obj.get("v")
    if isinstance(v, bool) or not isinstance(v, int):
        return None
    letter = dict(type=obj.pop("type"), v=obj.pop("v"), fields=obj)
    return letter if encode(letter) == pt else None


# --- the branch type -----------------------------------------------------------------------------


def check_name_key(salt):
    return hmac.new(salt, CHECK_NAME_LABEL, hashlib.sha256).digest()


def hex_exact(s, n):
    if not isinstance(s, str) or len(s) != 2 * n or s != s.lower():
        return None
    try:
        return bytes.fromhex(s)
    except ValueError:
        return None


def git_ref_name(name):
    """forge-core `is_git_ref_name`: refs/, at most 255 bytes, git check-ref-format's rules."""
    if len(name.encode()) > 255 or not name.startswith("refs/") or name.endswith(".lock"):
        return False
    path = name[len("refs/"):]
    return (bool(path) and ".." not in path and "@{" not in path and not path.endswith(".")
            and not any(b <= 0x20 or b == 0x7F or chr(b) in "~^:?*[\\" for b in path.encode())
            and all(c and not c.startswith(".") and not c.endswith(".lock") for c in path.split("/")))


def valid_branch_name(name):
    return (isinstance(name, str) and git_ref_name(name) and name.startswith("refs/heads/")
            and name != "refs/heads/HEAD" and not any(unicodedata.category(c) == "Cc" for c in name))


def branch_well_formed(b):
    oid, bl, salt = b["head"]
    return (len(oid) in (20, 32) and oid != bytes(len(oid)) and blind(salt, oid) == bl
            and len(b["packs"]) > 0 and all(b["packs"][i][0] < b["packs"][i + 1][0] for i in range(len(b["packs"]) - 1))
            and valid_branch_name(b["name"]) and 0 <= b["asOf"] <= MAX_INT)


def branch_to_typed(b):
    """b: name, refNameHash, head = (oid, blind, salt), packs = [(packHash, key)], asOf (bytes values)."""
    assert branch_well_formed(b)
    oid, bl, salt = b["head"]
    return dict(type="branch", v=1, fields=dict(
        asOf=b["asOf"], checkNameKey=H(check_name_key(salt)), head=[H(bl), H(oid), H(salt)], name=b["name"],
        packs=[[H(h), H(k)] for h, k in b["packs"]], refNameHash=H(b["refNameHash"])))


def branch_from_typed(t):
    """The branch letter of typed letter `t` as JSON (what the harnesses compare), or None."""
    f = t["fields"]
    if t["type"] != "branch" or t["v"] != 1 or sorted(f) != list(BRANCH_FIELDS):
        return None
    head = f["head"]
    if not isinstance(head, list) or len(head) != 3 or not isinstance(head[1], str):
        return None
    oid = hex_exact(head[1], len(head[1]) // 2)
    bl = hex_exact(head[0], len(oid)) if oid is not None else None
    salt = hex_exact(head[2], 32)
    packs = []
    if not isinstance(f["packs"], list):
        return None
    for p in f["packs"]:
        if not isinstance(p, list) or len(p) != 2:
            return None
        h, k = hex_exact(p[0], 32), hex_exact(p[1], 32)
        if h is None or k is None:
            return None
        packs.append((h, k))
    rnh, cnk, as_of = hex_exact(f["refNameHash"], 32), hex_exact(f["checkNameKey"], 32), f["asOf"]
    if None in (oid, bl, salt, rnh, cnk) or isinstance(as_of, bool) or not isinstance(as_of, int):
        return None
    b = dict(name=f["name"], refNameHash=rnh, head=(oid, bl, salt), packs=packs, asOf=as_of)
    if not branch_well_formed(b) or cnk != check_name_key(salt):
        return None
    return branch_json(b)


def branch_json(b):
    oid, bl, salt = b["head"]
    return dict(name=b["name"], refNameHash=H(b["refNameHash"]), head=dict(blind=H(bl), oid=H(oid), salt=H(salt)),
                packs=[dict(packHash=H(h), key=H(k)) for h, k in b["packs"]], asOf=b["asOf"])


def sample_branch(oid_len=20, packs=2, name="refs/heads/fix-auth"):
    salt = sha256(b"dash-forge vectors: key letter salt %d" % oid_len)
    oid = sha256(b"dash-forge vectors: key letter head %d" % oid_len)[:oid_len]
    ps = sorted((sha256(b"dash-forge vectors: key letter pack %d" % i), sha256(b"dash-forge vectors: key letter key %d" % i))
                for i in range(packs))
    return dict(name=name, refNameHash=sha256(b"dash-forge vectors: key letter ref name hash"),
                head=(oid, blind(salt, oid), salt), packs=ps, asOf=1767225600000)


# --- vectors -------------------------------------------------------------------------------------


def format_vectors():
    for name, b, desc in [
        ("format_branch", sample_branch(), "a `branch` letter (v 1) with a SHA-1 head and two packs: the canonical "
         "JSON (keys sorted, `packs` by packHash, `head` as [blind, oid, salt], `checkNameKey` = HMAC-SHA256(salt, "
         "\"dash-forge/v2/check-name\")) padded with spaces to 512 bytes."),
        ("format_branch_sha256", sample_branch(32, 1, "refs/heads/sécurité/日本"), "a `branch` letter with a "
         "SHA-256 head, one pack and a non-ASCII branch name (raw UTF-8)."),
    ]:
        t = branch_to_typed(b)
        pt = encode(t)
        assert decode(pt) == t and branch_from_typed(t) == branch_json(b)
        vector(name, desc, dict(op="format", branch=branch_json(b)), dict(letter=t, plaintextHex=H(pt)))
    generic = dict(type="read", v=1, fields={
        "zeta": [1, 2, 3], "alpha": {"b": None, "a": True, "c": False}, "text": "tab\there \"quoted\" \\ \x1f é 😀",
        "big": MAX_INT, "empty": {}, "list": []})
    pt = encode(generic)
    assert decode(pt) == generic
    vector("format_generic", "any type: every object's keys sorted by code point (`type` and `v` among them), no "
           "whitespace, \\t and \\\" and \\\\ escaped, other C0 controls as lowercase \\u00xx, other characters raw "
           "UTF-8, null/true/false, integers up to 2^53 - 1.", dict(op="format", letter=generic),
           dict(letter=generic, plaintextHex=H(pt)))
    assert encode(dict(type="branch", v=1, fields=dict(x="a" * MAX_LETTER))) is None  # unit-tested in both stacks
    for name, letter in [("format_float", dict(type="x", v=1, fields=dict(n=1.5))),
                         ("format_negative", dict(type="x", v=1, fields=dict(n=-1))),
                         ("format_over_max_int", dict(type="x", v=1, fields=dict(n=MAX_INT + 1)))]:
        assert encode(letter) is None
        vector(name, "the canonical form has no float, negative integer or integer past 2^53 - 1: refused.",
               dict(op="format", letter=letter), dict(error="invalid"))


def pad(b):
    return b + b" " * (max(1, -(-len(b) // BUCKET)) * BUCKET - len(b))


def decode_vectors():
    t = branch_to_typed(sample_branch())
    raw = encode(t).rstrip(b" ")
    f = t["fields"]

    def with_fields(**kw):
        g = dict(f)
        for k, v in kw.items():
            if v is None:
                g.pop(k, None)
            else:
                g[k] = v
        return pad(json.dumps(dict(g, type=t["type"], v=t["v"]), sort_keys=True, separators=(",", ":"),
                              ensure_ascii=False).encode())

    b = sample_branch()
    other_salt = sha256(b"another salt")
    bad_blind = with_fields(head=[H(blind(other_salt, b["head"][0])), H(b["head"][0]), H(b["head"][2])])
    null_head = with_fields(head=[H(bytes(20)), H(bytes(20)), H(b["head"][2])],
                            checkNameKey=H(check_name_key(b["head"][2])))
    cases = [
        ("ok", encode(t)),
        ("whitespace", pad(raw.replace(b",", b", ", 1))),
        ("keys_unsorted", pad(b'{"v":1,"type":"x"}')),
        ("not_a_bucket", raw),
        ("nul_padding", raw + b"\x00" * (BUCKET - len(raw) % BUCKET)),
        ("float", pad(b'{"type":"x","v":1.0}')),
        ("exponent", pad(b'{"type":"x","v":1e0}')),
        ("negative_zero", pad(b'{"n":-0,"type":"x","v":1}')),
        ("past_max_int", pad(b'{"n":9007199254740992,"type":"x","v":1}')),
        ("max_int", pad(b'{"n":9007199254740991,"type":"x","v":1}')),
        ("v_true", pad(b'{"type":"x","v":true}')),
        ("v_missing", pad(b'{"type":"x"}')),
        ("type_not_a_string", pad(b'{"type":1,"v":1}')),
        ("not_an_object", pad(b'["type","v"]')),
        ("duplicate_key", pad(b'{"type":"x","type":"x","v":1}')),
        ("escape_uppercase", pad(b'{"s":"\\u001F","type":"x","v":1}')),
        ("escape_lowercase", pad(b'{"s":"\\u001f","type":"x","v":1}')),
        ("escaped_ascii", pad(b'{"s":"\\u0041","type":"x","v":1}')),
        ("lone_surrogate", pad(b'{"s":"\\ud800","type":"x","v":1}')),
        ("not_utf8", pad(b'{"s":"\xff","type":"x","v":1}')),
        ("unknown_type", pad(b'{"gen":3,"type":"branchKey","v":1}')),
        ("branch_v2", with_fields() .replace(b'"v":1', b'"v":2')),
        ("branch_extra_field", with_fields(extra="x")),
        ("branch_missing_field", with_fields(asOf=None)),
        ("branch_blind_mismatch", bad_blind),
        ("branch_null_head", null_head),
        ("branch_packs_unsorted", with_fields(packs=list(reversed(f["packs"])))),
        ("branch_packs_repeated", with_fields(packs=[f["packs"][0], f["packs"][0]])),
        ("branch_packs_empty", with_fields(packs=[])),
        ("branch_check_name_key_wrong", with_fields(checkNameKey=H(check_name_key(other_salt)))),
        ("branch_uppercase_hex", with_fields(refNameHash=f["refNameHash"].upper())),
        ("branch_not_a_branch", with_fields(name="refs/tags/v1")),
        ("branch_bare_prefix", with_fields(name="refs/heads/")),
        ("branch_control_in_name", with_fields(name="refs/heads/a\u0085b")),
        ("branch_as_of_string", with_fields(asOf="1767225600000")),
        ("branch_name_space", with_fields(name="refs/heads/fix auth")),
        ("branch_name_dotdot", with_fields(name="refs/heads/a..b")),
        ("branch_name_lock", with_fields(name="refs/heads/a.lock/b")),
        ("branch_name_head", with_fields(name="refs/heads/HEAD")),
        ("branch_name_nested_ok", with_fields(name="refs/heads/sec/fix-2")),
        # UTF-16 order and code point order differ: U+FF71 sorts before U+1F600 by code point only
        ("keys_code_point_order", pad('{"type":"x","v":1,"\uff71":1,"\U0001F600":2}'.encode())),
        ("keys_utf16_order", pad('{"type":"x","v":1,"\U0001F600":2,"\uff71":1}'.encode())),
        ("raw_del_and_line_separator", pad('{"s":"a\x7fb\u2028c","type":"x","v":1}'.encode())),
        ("escaped_slash", pad(b'{"s":"a\\/b","type":"x","v":1}')),
        ("nested_16", pad(b'{"d":' + b'[' * 15 + b']' * 15 + b',"type":"x","v":1}')),
        ("nested_17", pad(b'{"d":' + b'[' * 16 + b']' * 16 + b',"type":"x","v":1}')),
    ]
    results = []
    for name, pt in cases:
        letter = decode(pt)
        r = dict(name=name)
        if letter is None:
            r["error"] = "malformed"
        else:
            r["letter"] = letter
            r["branch"] = branch_from_typed(letter)
        results.append(r)
    ok = {r["name"] for r in results if "letter" in r}
    assert ok == {"ok", "max_int", "escape_lowercase", "unknown_type", "keys_code_point_order",
                  "raw_del_and_line_separator", "nested_16"} | {n for n, _ in cases if n.startswith("branch_")}, ok
    branches = {r["name"] for r in results if r.get("branch")}
    assert branches == {"ok", "branch_name_nested_ok"}, branches
    vector("decode", "a reader takes only the exact canonical bytes (a bucket length, space padding, sorted keys, no "
           "whitespace, the writer's escapes, integers 0..2^53 - 1, a string `type` and an integer `v`), and the "
           "`branch` type v 1 only with its six fields, a blind that checks against a non-null head, packs sorted "
           "and distinct, at least one, lowercase hex of the right widths, a refs/heads/ name with no control "
           "character, and the salt's check-name key. Another type reads as a letter but not as a branch.",
           dict(op="decode", cases=[dict(name=n, plaintextHex=H(pt)) for n, pt in cases]), dict(results=results))


def seal_inputs(label, n):
    k_obj = sha256(b"dash-forge vectors: key letter kObj " + label)
    file_id = sha256(b"dash-forge vectors: key letter fileId " + label)[:16]
    ivs = [sha256(b"dash-forge vectors: key letter iv " + label + b" %d" % i)[:16] for i in range(n)]
    return k_obj, file_id, ivs


def party_pub(p):
    return dict(identityId=H(p["id"]), publicKey=H(p["pub"]))


def open_letter(manifest, sealed, owner_keys, reader):
    if sha256(sealed) != bytes.fromhex(manifest["packHash"]):
        return dict(error="packHashMismatch")
    r = open_named_artifact(sealed, manifest["sizeBytes"], owner_keys, bytes.fromhex(reader["identityId"]),
                            [int(k, 16) for k in reader["keys"]])
    if "error" in r:
        return r
    letter = decode(bytes.fromhex(r["plaintextHex"]))
    if letter is None:
        return dict(error="malformed")
    return dict(letter=letter, recipients=sealed[8])


def seal_and_open_vectors():
    t = branch_to_typed(sample_branch())
    recipients = [ALICE, BOB]
    k_obj, file_id, ivs = seal_inputs(b"branch", len(recipients))
    plain = encode(t)
    _, sealed = seal_named_artifact(ALICE, 4, recipients, plain, k_obj, file_id, ivs)
    vector("seal_branch", "a `branch` letter sealed to its recipient, the sender in slot 0: the padded plaintext as a "
           "DFPK 0x02 artifact under K_obj (fixed here, with the fileId and slot IVs, so both stacks make the same bytes).",
           dict(op="seal", repoId=H(repoId), sender=dict(identityId=H(ALICE["id"]),
                priv=ALICE["priv"].to_bytes(32, "big").hex()), senderKeyId=4, ownerId=H(ALICE["id"]),
                recipients=[party_pub(p) for p in recipients], letter=t, kObj=H(k_obj), fileId=H(file_id),
                ivs=[H(iv) for iv in ivs]),
           dict(sealedHex=H(sealed), packHash=H(sha256(sealed)), sizeBytes=len(sealed)))

    man = dict(packHash=H(sha256(sealed)), sizeBytes=len(sealed))
    okeys = [owner_key(ALICE)]
    readers = [reader_json(p) for p in (ALICE, BOB, CAROL)]
    results = [open_letter(man, sealed, okeys, r) for r in readers]
    assert results[0] == results[1] == dict(letter=t, recipients=2) and results[2] == dict(error="notARecipient")
    vector("open_branch", "the sender and the recipient open the letter with the manifest owner's ENCRYPTION key "
           "(the header's n is 2); anyone else is not a recipient.",
           dict(op="open", repoId=H(repoId), manifest=man, sealedHex=H(sealed), ownerKeys=okeys, readers=readers),
           dict(results=results))

    cases = [
        ("open_pack_hash_mismatch", "bytes that do not hash to the manifest's packHash are refused before anything "
         "is decrypted.", dict(man, packHash=H(sha256(b"other"))), sealed, okeys),
        ("open_size_mismatch", "the manifest's sizeBytes must be the length.", dict(packHash=man["packHash"],
         sizeBytes=len(sealed) + 1), sealed, okeys),
        ("open_sender_not_owner", "the sender key must be the manifest owner's: when the owner's key of the header's id "
         "is another key, no slot opens under it (notARecipient).", man, sealed, [owner_key(CAROL)]),
    ]
    for name, desc, m, s, ok in cases:
        r = open_letter(m, s, ok, reader_json(BOB))
        vector(name, desc, dict(op="open", repoId=H(repoId), manifest=m, sealedHex=H(s), ownerKeys=ok,
                                readers=[reader_json(BOB)]), dict(results=[r]))
    bad = pad(b'{"type":"x", "v":1}')
    k_obj, file_id, ivs = seal_inputs(b"not canonical", 2)
    _, s = seal_named_artifact(ALICE, 4, recipients, bad, k_obj, file_id, ivs)
    m = dict(packHash=H(sha256(s)), sizeBytes=len(s))
    r = open_letter(m, s, okeys, reader_json(BOB))
    assert r == dict(error="malformed")
    vector("open_not_canonical", "a letter whose plaintext is not canonical is malformed, even though it opens.",
           dict(op="open", repoId=H(repoId), manifest=m, sealedHex=H(s), ownerKeys=okeys, readers=[reader_json(BOB)]),
           dict(results=[r]))
    s1 = seal_pack(K0, 0, plain, file_id=file_id)[0]
    m = dict(packHash=H(sha256(s1)), sizeBytes=len(s1))
    r = open_letter(m, s1, okeys, reader_json(BOB))
    assert r == dict(error="sealedPackCorrupt")
    vector("open_members_header", "a key letter is always a DFPK 0x02 artifact: one under the members key (0x01) is "
           "refused as damaged.", dict(op="open", repoId=H(repoId), manifest=m, sealedHex=H(s1), ownerKeys=okeys,
                                       readers=[reader_json(BOB)]), dict(results=[r]))


def file_key_vectors():
    plain = gen.mod251(20000)
    file_id = sha256(b"dash-forge vectors: key letter members pack")[:16]
    sealed = seal_pack(K0, 0, plain, file_id=file_id, L=10)[0]
    key = k_pack(K0, 0, file_id)
    vector("file_key", "the file key a `branch` letter hands on for a members-only pack is K_pack,e,fileId "
           "(HKDF-Expand(PRK_e, \"dash-forge/v2/pack\" ‖ 0x00 ‖ u32(e) ‖ 0x01 ‖ fileId)) of the pack's own header: "
           "with it alone the pack opens, and with any other key its first tag fails.",
           dict(op="fileKey", repoId=H(repoId), epoch=0, epochKey=H(K0), sealedHex=H(sealed),
                wrongKey=H(k_pack(K0, 0, bytes(16)))),
           dict(fileKey=H(key), plaintextSha256=H(sha256(plain)), plaintextLen=len(plain), wrongKey="sealedPackCorrupt"))


def build():
    format_vectors()
    decode_vectors()
    seal_and_open_vectors()
    file_key_vectors()


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

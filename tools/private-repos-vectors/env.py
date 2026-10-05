"""Independent Python reference for environment snapshots (mixed-visibility design §4.5, D9, D24).

    python3 tools/private-repos-vectors/env.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/env.py --write-vectors  # (re)write forge-contracts/vectors/env_snapshot__*.json

A sibling of gen.py, whose crypto helpers it reuses (DFPK 0x01 seal under an epoch key, DFPK 0x02
seal to specific people, the parties and their keys). Every vector it writes has case
`env_snapshot` and an `input.op` naming what it checks: `format` (the canonical padded artifact),
`decode` (what a reader refuses), `open` (seal and open one snapshot, D24's packHash and sender
checks), `resolve` (authorization, the chain and fork detection), `exposure` (the removal
checklist) and `defaultAudience` (the name rule). The Rust harness (`forge_core::env`) and the
TypeScript harness (`forge-web/lib/env`) run every file and must reproduce it exactly.

The normative description of each step is in `crates/forge-core/src/env/mod.rs`.
"""
import glob
import json
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen  # noqa: E402  (the crypto helpers; importing runs no generator)
from gen import (  # noqa: E402
    AESGCM, H, K0, K1, KEY_TYPE_BLS, NAMED_OTHERS, NAMED_OUTSIDER, NAMED_SENDER, b58, canonical_json, k_pack,
    open_named_artifact, owner_key, reader_json, repoId, seal_named_artifact, seal_pack, sha256, u64,
)

BUCKET = 512
MAX_SNAPSHOT = 12288
SAFE_INT = (1 << 53) - 1
ENV_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
VAR_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
TYPES = ("secret", "variable")
AUDIENCES = ("members", "maintainers")
MAX_RECIPIENTS = 16
# The one name rule (owner question 3): these names default to Maintainers, every other to Members.
MAINTAINERS_BY_DEFAULT = ("production", "prod*", "staging", "release*")

B58 = gen.B58


def b58decode(s):
    if not isinstance(s, str) or not s or any(c not in B58 for c in s):
        return None
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    out = b"\x00" * (len(s) - len(s.lstrip("1"))) + body
    return out if len(out) == 32 and b58(out) == s else None


def default_audience(name):
    n = name.lower()
    for p in MAINTAINERS_BY_DEFAULT:
        if (p.endswith("*") and n.startswith(p[:-1])) or n == p:
            return "maintainers"
    return "members"


# --- the artifact ---------------------------------------------------------------------------------


def snapshot_obj(s):
    """The JSON object of snapshot `s` (`note` left out when empty; `to` only for maintainers)."""
    obj = {"v": 1, "env": s["env"], "audience": s["audience"], "generatedAt": s["generatedAt"],
           "vars": {k: dict({"type": v["type"], "value": v["value"]}, **({"note": v["note"]} if v.get("note") else {}))
                    for k, v in s["vars"].items()}}
    if s["audience"] == "maintainers":
        obj["to"] = list(s["to"])
    return obj


def encode(s):
    """The artifact plaintext: canonical JSON padded with spaces to a multiple of 512, or None (too large)."""
    raw = canonical_json(snapshot_obj(s))
    size = max(BUCKET, -(-len(raw) // BUCKET) * BUCKET)
    return None if size > MAX_SNAPSHOT else raw + b" " * (size - len(raw))


def valid(obj):
    """Whether `obj` (parsed JSON) is a version-1 snapshot; returns the snapshot dict or None."""
    is_int = lambda x: isinstance(x, int) and not isinstance(x, bool)
    if not isinstance(obj, dict) or not set(obj) <= {"v", "env", "audience", "generatedAt", "to", "vars"}:
        return None
    if obj.get("v") != 1 or not is_int(obj.get("v")) or not isinstance(obj.get("env"), str) \
            or not ENV_NAME.match(obj["env"]) or obj.get("audience") not in AUDIENCES \
            or not is_int(obj.get("generatedAt")) or not 0 <= obj["generatedAt"] <= SAFE_INT \
            or not isinstance(obj.get("vars"), dict):
        return None
    if obj["audience"] == "maintainers":
        to = obj.get("to")
        if not isinstance(to, list) or not 1 <= len(to) <= MAX_RECIPIENTS or len(set(map(str, to))) != len(to) \
                or any(b58decode(t) is None for t in to):
            return None
    elif "to" in obj:
        return None
    out_vars = {}
    for k, v in obj["vars"].items():
        if not VAR_NAME.match(k) or not isinstance(v, dict) or not set(v) <= {"type", "value", "note"}:
            return None
        if v.get("type") not in TYPES or not isinstance(v.get("value"), str) \
                or not isinstance(v.get("note", ""), str):
            return None
        out_vars[k] = dict(type=v["type"], value=v["value"], note=v.get("note", ""))
    s = dict(env=obj["env"], audience=obj["audience"], generatedAt=obj["generatedAt"], vars=out_vars)
    if obj["audience"] == "maintainers":
        s["to"] = list(obj["to"])
    return s


def decode(pt):
    """A reader's parse: a bucket length, padding only spaces, a valid object, and exactly the canonical bytes."""
    if not 0 < len(pt) <= MAX_SNAPSHOT or len(pt) % BUCKET:
        return None
    body = pt.rstrip(b" ")
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    s = valid(obj)
    if s is None:
        return None
    try:
        return s if encode(s) == pt else None
    except UnicodeEncodeError:
        return None


def snapshot_json(s):
    """A decoded snapshot as the vectors carry it (`note` always present)."""
    out = dict(env=s["env"], audience=s["audience"], generatedAt=s["generatedAt"],
               vars={k: dict(type=v["type"], value=v["value"], note=v.get("note", "")) for k, v in s["vars"].items()})
    if s["audience"] == "maintainers":
        out["to"] = list(s["to"])
    return out


# --- opening one snapshot (D24: the owner-signed packHash first, then the key from $ownerId only) -------


def open_members_pack(sealed, keys):
    """DFPK 0x01 under the epoch the header names; keys: {epoch: K}."""
    if len(sealed) < 36 or sealed[6:8] != b"\x00\x00" or not 10 <= sealed[5] <= 20:
        return dict(error="sealedPackCorrupt")
    epoch = struct.unpack(">I", sealed[8:12])[0]
    plen = struct.unpack(">Q", sealed[12:20])[0]
    file_id = sealed[20:36]
    S = 1 << sealed[5]
    nseg = max(1, -(-plen // S))
    if 36 + plen + 16 * nseg != len(sealed):
        return dict(error="sealedPackCorrupt")
    if epoch not in keys:
        return dict(error="noKey")
    kf, out, at = k_pack(keys[epoch], epoch, file_id), b"", 36
    for i in range(nseg):
        ln = min(S, plen - i * S) + 16
        try:
            out += AESGCM(kf).decrypt(u64(i) + b"\x00\x00\x00" + bytes([1 if i == nseg - 1 else 0]),
                                      sealed[at:at + ln], sealed[:36])
        except Exception:
            return dict(error="sealedPackCorrupt")
        at += ln
    return dict(plain=out)


def open_snapshot(manifest, sealed, owner_keys, reader, epoch_keys):
    """`manifest` = {ownerId (base58), packHash (hex), sizeBytes}. Returns {snapshot} or {error}."""
    if H(sha256(sealed)) != manifest["packHash"]:
        return dict(error="packHashMismatch")
    if len(sealed) != manifest["sizeBytes"]:
        return dict(error="sizeMismatch")
    if len(sealed) < 9 or sealed[:4] != b"DFPK":
        return dict(error="sealedPackCorrupt")
    version = sealed[4]
    if version == 0x01:
        r = open_members_pack(sealed, {e["epoch"]: bytes.fromhex(e["key"]) for e in epoch_keys})
        if "error" in r:
            return r
        plain, audience = r["plain"], "members"
    elif version == 0x02:
        r = open_named_artifact(sealed, manifest["sizeBytes"], owner_keys, bytes.fromhex(reader["identityId"]),
                                [int(k, 16) for k in reader["keys"]])
        if "error" in r:
            return r
        plain, audience = bytes.fromhex(r["plaintextHex"]), "maintainers"
    else:
        return dict(error="sealedPackCorrupt")
    s = decode(plain)
    if s is None or s["audience"] != audience:
        return dict(error="malformed")
    if audience == "maintainers" and (len(s["to"]) != sealed[8] or s["to"][0] != manifest["ownerId"]):
        return dict(error="malformed")
    return dict(snapshot=snapshot_json(s))


# --- authorization, the chain and forks (D24) -----------------------------------------------------------


def resolve(maintainers, manifests, opened):
    """`manifests`: [{id, ownerId, packHash, supersedes: [hex], createdAt}]; `opened`: packHash →
    {env, ...} (readable) or {unreadable: reason}. Returns the resolution the vectors expect."""
    order = sorted(manifests, key=lambda m: (m["createdAt"], m["id"]))
    nodes, ignored, passthrough = {}, [], {}
    for m in order:
        if m["ownerId"] not in maintainers:
            ignored.append(dict(id=m["id"], reason="notAMaintainer"))
            passthrough.setdefault(m["packHash"], []).extend(m["supersedes"])
        elif m["packHash"] in nodes:
            ignored.append(dict(id=m["id"], reason="duplicate"))
        else:
            nodes[m["packHash"]] = m
    env_of = lambda h: opened.get(h, {}).get("env")

    def targets(t):
        out, seen, todo = [], {t["packHash"]}, list(t["supersedes"])
        while todo:
            h = todo.pop(0)
            if h in seen:
                continue
            seen.add(h)
            if h in nodes:
                out.append(h)
            elif h in passthrough:
                todo.extend(passthrough[h])
        return out

    edges = set()
    for h, t in nodes.items():
        for s in targets(t):
            a, b = env_of(h), env_of(s)
            if a is not None and b is not None and a != b:
                continue
            edges.add((h, s))
    parent = {h: h for h in nodes}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in sorted(edges):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    comps = {}
    for h in nodes:
        comps.setdefault(find(h), []).append(h)
    key = lambda h: (nodes[h]["createdAt"], nodes[h]["id"])
    envs, hidden = {}, []
    for members in comps.values():
        names = sorted({env_of(h) for h in members if env_of(h) is not None})
        if not names:
            hidden.append(members)
        for e in names:
            envs.setdefault(e, set()).update(h for h in members if env_of(h) in (e, None))

    def heads_of(group):
        heads = sorted((n for n in group if not any((t, n) in edges for t in group)), key=key)
        return heads or sorted(group, key=key)

    def ids(hs):
        return [nodes[h]["id"] for h in sorted(hs, key=key)]

    out_envs = []
    for e in sorted(envs):
        group = envs[e]
        heads = heads_of(group)
        no_heads = not any(not any((t, n) in edges for t in group) for n in group)
        if len(heads) == 1 and not no_heads:
            state = "current" if env_of(heads[0]) is not None else "unreadable"
        else:
            state = "conflict"
        out_envs.append(dict(env=e, state=state, heads=ids(heads), snapshots=ids(group)))
    out_hidden = [dict(heads=ids(heads_of(set(g))), snapshots=ids(g))
                  for g in sorted(hidden, key=lambda g: min(key(h) for h in g))]
    return dict(ignored=ignored, environments=out_envs, hidden=out_hidden)


# --- the removal checklist --------------------------------------------------------------------------


def exposure(environments, removed, held_members_key):
    """`environments`: [{env, heads: [snapshot], snapshots: [snapshot]}] with readable snapshots
    {audience, to?, vars: {NAME: value}}. Which current value names `removed` could read."""
    out = []
    for e in environments:
        names = set()
        for head in e["heads"]:
            for name, value in head["vars"].items():
                for s in e["snapshots"]:
                    if s["vars"].get(name) != value:
                        continue
                    if (s["audience"] == "members" and held_members_key) or \
                            (s["audience"] == "maintainers" and removed in s.get("to", [])):
                        names.add(name)
                        break
        if names:
            out.append(dict(env=e["env"], audience=e["heads"][-1]["audience"], names=sorted(names)))
    return sorted(out, key=lambda x: x["env"])


# --- vectors ------------------------------------------------------------------------------------------

VECTORS = []


def vector(name, description, inp, expected):
    VECTORS.append(dict(name=name, description=description, case="env_snapshot", rules="v2", input=inp,
                        expected=expected))


ALICE, BOB, CAROL = NAMED_SENDER, NAMED_OTHERS[0], NAMED_OTHERS[1]
WRITER = NAMED_OTHERS[2]
B = lambda p: b58(p["id"])
GENERATED_AT = 1767225600000


def var(value, type_="secret", note=""):
    return dict(type=type_, value=value, note=note)


def format_vectors():
    cases = []
    small = dict(env="dev", audience="members", generatedAt=GENERATED_AT, vars={})
    pt = encode(small)
    assert len(pt) == 512 and decode(pt) is not None
    cases.append(dict(snapshot=snapshot_json(small), plaintextHex=H(pt), sizeBytes=len(pt)))
    # canonical JSON of exactly 512 bytes: no padding at all
    base = dict(env="dev", audience="members", generatedAt=GENERATED_AT, vars={"FILL": var("")})
    fill = 512 - len(canonical_json(snapshot_obj(base)))
    exact = dict(base, vars={"FILL": var("x" * fill)})
    pt = encode(exact)
    assert len(pt) == 512 and pt[-1:] == b"}"
    cases.append(dict(snapshot=snapshot_json(exact), plaintextHex=H(pt), sizeBytes=len(pt)))
    over = dict(base, vars={"FILL": var("x" * (fill + 1))})
    pt = encode(over)
    assert len(pt) == 1024
    cases.append(dict(snapshot=snapshot_json(over), plaintextHex=H(pt), sizeBytes=len(pt)))
    named = dict(env="production", audience="maintainers", generatedAt=GENERATED_AT, to=[B(ALICE), B(BOB)],
                 vars={"DB_URL": var("postgres://fake:fake@db.example/app", note="primary"),
                       "LOG_LEVEL": var("info", "variable"),
                       "GREETING": var("héllo \"wörld\"\n\ttab\u0001\\  ", "variable")})
    pt = encode(named)
    assert decode(pt) is not None
    cases.append(dict(snapshot=snapshot_json(named), plaintextHex=H(pt), sizeBytes=len(pt)))
    big = dict(base, vars={"FILL": var("x" * MAX_SNAPSHOT)})
    assert encode(big) is None
    cases.append(dict(snapshot=snapshot_json(big), tooLarge=True))
    vector("padding", "the artifact is canonical JSON (sorted keys, no whitespace, UTF-8 unescaped, `note` left out "
           "when empty, `to` only for Maintainers) padded with spaces to a multiple of 512 bytes; exactly 512 needs no "
           "padding, one byte more takes 1,024; over 12,288 bytes is refused by the writer.",
           dict(op="format", cases=[dict(snapshot=c["snapshot"]) for c in cases]),
           dict(results=[{k: v for k, v in c.items() if k != "snapshot"} for c in cases]))


def decode_vectors():
    good = encode(dict(env="dev", audience="members", generatedAt=GENERATED_AT, vars={"A": var("1")}))
    raw = good.rstrip(b" ")

    def pad(b, n=512):
        return b + b" " * (n - len(b))

    cases = [
        ("canonical", good, True),
        ("short_bucket", good[:511], False),
        ("tab_in_padding", raw + b"\t" + b" " * (511 - len(raw)), False),
        ("nul_padding", raw + b"\x00" * (512 - len(raw)), False),
        ("whitespace_inside", pad(raw.replace(b",", b", ", 1)), False),
        ("keys_unsorted", pad(b'{"v":1,"audience":"members","env":"dev","generatedAt":1767225600000,"vars":{}}'), False),
        ("empty_note", pad(b'{"audience":"members","env":"dev","generatedAt":1767225600000,"v":1,'
                           b'"vars":{"A":{"note":"","type":"secret","value":"1"}}}'), False),
        ("unknown_key", pad(raw[:-1] + b',"x":1}'), False),
        ("unknown_type", pad(raw.replace(b'"secret"', b'"file"')), False),
        ("members_with_to", pad(b'{"audience":"members","env":"dev","generatedAt":1767225600000,"to":["'
                                + B(ALICE).encode() + b'"],"v":1,"vars":{}}'), False),
        ("maintainers_without_to", pad(b'{"audience":"maintainers","env":"dev","generatedAt":1767225600000,"v":1,'
                                       b'"vars":{}}'), False),
        ("bad_var_name", pad(raw.replace(b'"A"', b'"1A"')), False),
        ("bad_env_name", pad(raw.replace(b'"dev"', b'"-dev"')), False),
        ("version_2", pad(raw.replace(b'"v":1', b'"v":2')), False),
        ("escaped_ascii", pad(raw.replace(b'"1"', b'"\\u0031"')), False),
        ("float_time", pad(raw.replace(b"1767225600000", b"1767225600000.0")), False),
        ("not_json", pad(b"KEY=value"), False),
    ]
    for name, pt, ok in cases:
        assert (decode(pt) is not None) == ok, name
    vector("decode_refused", "a reader takes only the exact canonical bytes: a length that is not a multiple of 512, "
           "padding other than spaces, any whitespace or key order other than canonical, an empty `note`, an unknown "
           "key or type, `to` on a Members snapshot or none on a Maintainers one, a bad name, another version, an "
           "escape the writer never makes or a non-integer time is malformed.",
           dict(op="decode", cases=[dict(name=n, plaintextHex=H(pt)) for n, pt, _ in cases]),
           dict(results=[dict(name=n, snapshot=snapshot_json(decode(pt))) if ok else dict(name=n, error="malformed")
                         for n, pt, ok in cases]))


def sealed_members(snap, K=K0, epoch=0, label=b"members"):
    file_id = sha256(b"dash-forge vectors: env snapshot fileId " + label)[:16]
    plain = encode(snap)
    sealed = seal_pack(K, epoch, plain, file_id=file_id)[0]
    return plain, file_id, sealed


def sealed_maintainers(snap, sender, recipients, label=b"maintainers", key_id=4):
    k_obj = sha256(b"dash-forge vectors: env snapshot kObj " + label)
    file_id = sha256(b"dash-forge vectors: env snapshot fileId " + label)[:16]
    ivs = [sha256(b"dash-forge vectors: env snapshot iv " + label + b" %d" % i)[:16] for i in range(len(recipients))]
    plain = encode(snap)
    _, sealed = seal_named_artifact(sender, key_id, recipients, plain, k_obj, file_id, ivs)
    return plain, k_obj, file_id, ivs, sealed


def manifest_of(owner, sealed, packHash=None):
    return dict(ownerId=B(owner), packHash=packHash or H(sha256(sealed)), sizeBytes=len(sealed))


def open_case(manifest, sealed, owner_keys, reader, epoch_keys):
    return open_snapshot(manifest, sealed, owner_keys, reader, epoch_keys)


def open_vectors():
    dev = dict(env="dev", audience="members", generatedAt=GENERATED_AT,
               vars={"API_URL": var("https://api.example.test", "variable"), "API_TOKEN": var("fake-token-1")})
    plain, file_id, sealed = sealed_members(dev)
    man = manifest_of(ALICE, sealed)
    k0 = [dict(epoch=0, key=H(K0))]
    readers = [dict(reader=reader_json(BOB), epochKeys=k0), dict(reader=reader_json(BOB), epochKeys=[])]
    results = [open_case(man, sealed, [], r["reader"], r["epochKeys"]) for r in readers]
    assert results[0] == dict(snapshot=snapshot_json(dev)) and results[1] == dict(error="noKey")
    vector("members", "a Members snapshot is the padded artifact sealed as a DFPK 0x01 file under the lane's epoch key "
           "(K_pack,e,fileId): a member holding epoch 0 opens it; a reader without that epoch's key gets noKey.",
           dict(op="open", repoId=H(repoId), snapshot=snapshot_json(dev), seal=dict(epoch=0, epochKey=H(K0),
                fileId=H(file_id)), manifest=man, sealed=H(sealed), ownerKeys=[], readers=readers),
           dict(plaintextHex=H(plain), packHash=man["packHash"], results=results))

    recipients = [ALICE, BOB, CAROL]
    prod = dict(env="production", audience="maintainers", generatedAt=GENERATED_AT, to=[B(p) for p in recipients],
                vars={"STRIPE_KEY": var("sk_test_fake_1"), "DB_URL": var("postgres://fake:fake@db.example/prod"),
                      "SENTRY_DSN": var("https://fake@sentry.example/1", note="error reporting")})
    plain, k_obj, file_id, ivs, sealed = sealed_maintainers(prod, ALICE, recipients)
    man = manifest_of(ALICE, sealed)
    okeys = [owner_key(ALICE)]
    readers = [dict(reader=reader_json(p), epochKeys=[]) for p in recipients + [WRITER, NAMED_OUTSIDER]]
    results = [open_case(man, sealed, okeys, r["reader"], []) for r in readers]
    assert all(r == dict(snapshot=snapshot_json(prod)) for r in results[:3])
    assert results[3:] == [dict(error="notARecipient")] * 2
    vector("maintainers_named", "a Maintainers snapshot is sealed under a DFPK 0x02 header to the current maintainers' "
           "highest usable ENCRYPTION keys, the sender first, and lists them in `to` in slot order: each maintainer "
           "opens it with the manifest owner's key; a writer and an outsider are not recipients.",
           dict(op="open", repoId=H(repoId), snapshot=snapshot_json(prod),
                seal=dict(senderKeyId=4, sender=reader_json(ALICE), recipients=[dict(identityId=H(p["id"]),
                          pub=H(p["pub"])) for p in recipients], kObj=H(k_obj), fileId=H(file_id),
                          ivs=[H(i) for i in ivs]),
                manifest=man, sealed=H(sealed), ownerKeys=okeys, readers=readers),
           dict(plaintextHex=H(plain), packHash=man["packHash"], results=results))

    # A writer seals a snapshot to the maintainers with their own key as sender, and a maintainer's
    # manifest records it: the slot key is taken from the manifest owner's key only, so nobody opens it.
    forged = dict(prod, to=[B(WRITER), B(ALICE), B(BOB)], vars={"DB_URL": var("postgres://attacker.example/x")})
    _, _, _, _, fsealed = sealed_maintainers(forged, WRITER, [WRITER, ALICE, BOB], label=b"forged")
    man = manifest_of(ALICE, fsealed)
    readers = [dict(reader=reader_json(p), epochKeys=[]) for p in (ALICE, BOB, WRITER)]
    results = [open_case(man, fsealed, okeys, r["reader"], []) for r in readers]
    assert results == [dict(error="notARecipient")] * 2 + [dict(error="malformed")]
    vector("sender_not_owner", "a maintainer's manifest whose artifact was sealed by someone else (a writer as the "
           "sender): the sender key is taken only from the manifest owner's identity, so no maintainer's slot opens; "
           "the writer, whose ECDH with the owner's key equals the one alice's slot was made with, opens that slot but "
           "the content does not list the owner first: malformed. Nobody is served its values.",
           dict(op="open", repoId=H(repoId), manifest=man, sealed=H(fsealed), ownerKeys=okeys, readers=readers),
           dict(results=results))

    man = manifest_of(ALICE, sealed, packHash=H(sha256(fsealed)))
    results = [open_case(man, sealed, okeys, readers[0]["reader"], [])]
    assert results == [dict(error="packHashMismatch")]
    vector("pack_hash_mismatch", "bytes that do not hash to the owner-signed manifest's packHash are refused before "
           "anything is decrypted (a DFPK 0x02 header alone proves only that some key holder wrote it).",
           dict(op="open", repoId=H(repoId), manifest=man, sealed=H(sealed), ownerKeys=okeys,
                readers=readers[:1]),
           dict(results=results))

    # Maintainers content sealed as a Members file, and a 0x02 artifact whose `to` does not start with its owner.
    wrong = dict(dev, audience="maintainers", to=[B(ALICE)])
    _, _, wsealed = sealed_members(wrong, label=b"wrong audience")
    man = manifest_of(ALICE, wsealed)
    r1 = open_case(man, wsealed, [], reader_json(BOB), k0)
    lying = dict(prod, to=[B(BOB), B(ALICE), B(CAROL)])
    _, _, _, _, lsealed = sealed_maintainers(lying, ALICE, recipients, label=b"lying to")
    man2 = manifest_of(ALICE, lsealed)
    r2 = open_case(man2, lsealed, okeys, reader_json(BOB), [])
    assert r1 == r2 == dict(error="malformed")
    vector("audience_mismatch", "an artifact that opens but disagrees with its envelope is malformed: Maintainers "
           "content in a Members (DFPK 0x01) file, and a DFPK 0x02 snapshot whose `to` does not list its owner first.",
           dict(op="open", repoId=H(repoId), cases=[
               dict(manifest=man, sealed=H(wsealed), ownerKeys=[], reader=reader_json(BOB), epochKeys=k0),
               dict(manifest=man2, sealed=H(lsealed), ownerKeys=okeys, reader=reader_json(BOB), epochKeys=[])]),
           dict(results=[r1, r2]))


def hx(label):
    return H(sha256(b"dash-forge vectors: env snapshot packHash " + label.encode()))


def m(label, owner, at, sup=()):
    return dict(id=b58(sha256(b"dash-forge vectors: env manifest " + label.encode())), ownerId=B(owner),
                packHash=hx(label), supersedes=[hx(s) for s in sup], createdAt=at, label=label)


def resolve_vector(name, desc, maintainers, manifests, opened, check):
    op = {hx(k): v for k, v in opened.items()}
    res = resolve({B(p) for p in maintainers}, manifests, op)
    by_id = {mm["id"]: mm["label"] for mm in manifests}
    check({e["env"]: dict(e, heads=[by_id[i] for i in e["heads"]], snapshots=[by_id[i] for i in e["snapshots"]])
           for e in res["environments"]},
          [dict(i, id=by_id[i["id"]]) for i in res["ignored"]],
          [dict(heads=[by_id[i] for i in g["heads"]], snapshots=[by_id[i] for i in g["snapshots"]]) for g in res["hidden"]])
    vector(name, desc, dict(op="resolve", maintainers=sorted(B(p) for p in maintainers),
                            manifests=[{k: v for k, v in mm.items() if k != "label"} for mm in manifests], opened=op),
           res)


def resolve_vectors():
    P, D = dict(env="production"), dict(env="dev")
    R = lambda e: dict(env=e)
    U = lambda why="notARecipient": dict(unreadable=why)

    def lin(envs, ign, hid):
        assert envs["production"]["state"] == "current" and envs["production"]["heads"] == ["s3"]
        assert envs["dev"]["state"] == "current" and envs["dev"]["heads"] == ["d1"]
        assert envs["production"]["snapshots"] == ["s1", "s2", "s3"] and not ign and not hid
    resolve_vector("chain_linear", "three changes to production, each superseding the last, and a separate dev: one "
                   "head each.", [ALICE, BOB],
                   [m("s1", ALICE, 1000), m("s2", BOB, 2000, ["s1"]), m("d1", ALICE, 2500), m("s3", ALICE, 3000, ["s2"])],
                   {"s1": P, "s2": P, "s3": P, "d1": D}, lin)

    def fork(envs, ign, hid):
        assert envs["production"]["state"] == "conflict" and envs["production"]["heads"] == ["s2", "s3"]
        assert envs["dev"]["state"] == "current"
    resolve_vector("chain_fork", "two maintainers changed production at the same time: both snapshots supersede s1, so "
                   "production has two heads, a conflict that is never merged automatically (run, get and export fail "
                   "closed naming both); dev is unaffected.", [ALICE, BOB],
                   [m("s1", ALICE, 1000), m("d1", ALICE, 1500), m("s2", ALICE, 2000, ["s1"]), m("s3", BOB, 2001, ["s1"])],
                   {"s1": P, "s2": P, "s3": P, "d1": D}, fork)

    def roots(envs, ign, hid):
        assert envs["production"]["state"] == "conflict" and envs["production"]["heads"] == ["s1", "s2"]
    resolve_vector("chain_two_roots", "two first snapshots of production that know nothing of each other: two heads, a "
                   "conflict.", [ALICE, BOB], [m("s1", ALICE, 1000), m("s2", BOB, 1001)], {"s1": P, "s2": P}, roots)

    def resolved(envs, ign, hid):
        assert envs["production"]["state"] == "current" and envs["production"]["heads"] == ["s4"]
    resolve_vector("chain_resolved", "a fork resolved by a maintainer's snapshot that supersedes both heads (supersedes "
                   "is a list): one head again.", [ALICE, BOB],
                   [m("s1", ALICE, 1000), m("s2", ALICE, 2000, ["s1"]), m("s3", BOB, 2001, ["s1"]),
                    m("s4", ALICE, 3000, ["s2", "s3"])], {"s1": P, "s2": P, "s3": P, "s4": P}, resolved)

    def unauthorized(envs, ign, hid):
        assert envs["production"]["state"] == "current" and envs["production"]["heads"] == ["s1"]
        assert "staging" not in envs and [i["id"] for i in ign] == ["w1", "w2"]
        assert all(i["reason"] == "notAMaintainer" for i in ign)
    resolve_vector("unauthorized_writer_ignored", "a role-1 writer (consensus admits their packManifest) posts a "
                   "snapshot superseding production's head and a new staging: neither counts, whatever they would "
                   "open to, because their owner is not a current maintainer; production stays at s1 and there is no "
                   "fork.", [ALICE],
                   [m("s1", ALICE, 1000), m("w1", WRITER, 2000, ["s1"]), m("w2", WRITER, 2100)],
                   {"s1": P, "w1": P, "w2": R("staging")}, unauthorized)

    def removed(envs, ign, hid):
        assert envs["production"]["state"] == "current" and envs["production"]["heads"] == ["s3"]
        assert envs["production"]["snapshots"] == ["s1", "s3"] and [i["id"] for i in ign] == ["s2"]
    resolve_vector("removed_maintainer_skipped", "carol's change (s2) stops counting once she is no longer a "
                   "maintainer; alice's later s3 superseded it, and supersedes s1 through it, so production has one "
                   "head and no fork.", [ALICE],
                   [m("s1", ALICE, 1000), m("s2", CAROL, 2000, ["s1"]), m("s3", ALICE, 3000, ["s2"])],
                   {"s1": P, "s2": P, "s3": P}, removed)

    def unreadable(envs, ign, hid):
        assert envs["production"]["state"] == "unreadable" and envs["production"]["heads"] == ["s2"]
    resolve_vector("unreadable_head", "the latest change to production does not open for this reader (sent to the "
                   "maintainers before they had a key): production's head is that change, so values are not served "
                   "from the older snapshot.", [ALICE, BOB],
                   [m("s1", ALICE, 1000), m("s2", BOB, 2000, ["s1"])], {"s1": P, "s2": U()}, unreadable)

    def hidden(envs, ign, hid):
        assert list(envs) == ["dev"] and hid == [dict(heads=["x2"], snapshots=["x1", "x2"])]
    resolve_vector("hidden_environment", "an environment none of whose snapshots open for this reader is counted, "
                   "not named.", [ALICE],
                   [m("x1", ALICE, 1000), m("d1", ALICE, 1100), m("x2", ALICE, 2000, ["x1"])],
                   {"x1": U(), "x2": U(), "d1": D}, hidden)

    def cycle(envs, ign, hid):
        assert envs["production"]["state"] == "conflict" and envs["production"]["heads"] == ["s1", "s2"]
        assert envs["dev"]["state"] == "current" and envs["dev"]["heads"] == ["d1"]
    resolve_vector("chain_cycle", "two snapshots that supersede each other leave production with no head: a conflict "
                   "listing both; a snapshot naming itself is not superseded by itself.", [ALICE],
                   [m("s1", ALICE, 1000, ["s2"]), m("s2", ALICE, 1001, ["s1"]), m("d1", ALICE, 1100, ["d1"])],
                   {"s1": P, "s2": P, "d1": D}, cycle)

    def dup(envs, ign, hid):
        assert envs["production"]["state"] == "current" and ign == [dict(id="s1b", reason="duplicate")]
    s1b = dict(m("s1", BOB, 1500, ["zz"]), id=b58(sha256(b"dash-forge vectors: env manifest s1b")), label="s1b")
    resolve_vector("duplicate_copy", "a second manifest of the same artifact counts once, the earliest.", [ALICE, BOB],
                   [m("s1", ALICE, 1000), s1b], {"s1": P}, dup)

    def cross(envs, ign, hid):
        assert envs["production"]["heads"] == ["s1"] and envs["dev"]["heads"] == ["d1"]
    resolve_vector("cross_environment_link_dropped", "a snapshot of dev naming a production snapshot in supersedes does "
                   "not end production: links count only between snapshots of the same environment.", [ALICE],
                   [m("s1", ALICE, 1000), m("d1", ALICE, 2000, ["s1"])], {"s1": P, "d1": D}, cross)


def exposure_vectors():
    p = lambda to, **vs: dict(audience="maintainers", to=[B(x) for x in to], vars=vs)
    mem = lambda **vs: dict(audience="members", vars=vs)
    prod_old = p([ALICE, CAROL], STRIPE_KEY="sk_test_old", DB_URL="postgres://fake/1")
    prod_new = p([ALICE, BOB], STRIPE_KEY="sk_test_new", DB_URL="postgres://fake/1", NEW_ONLY="x")
    dev = mem(API_TOKEN="fake-dev", LOG_LEVEL="debug")
    envs = [dict(env="production", heads=[prod_new], snapshots=[prod_old, prod_new]),
            dict(env="dev", heads=[dev], snapshots=[dev])]
    cases = [dict(removed=B(CAROL), heldMembersKey=True), dict(removed=B(BOB), heldMembersKey=False),
             dict(removed=B(NAMED_OUTSIDER), heldMembersKey=False)]
    results = [exposure(envs, c["removed"], c["heldMembersKey"]) for c in cases]
    assert results[0] == [dict(env="dev", audience="members", names=["API_TOKEN", "LOG_LEVEL"]),
                          dict(env="production", audience="maintainers", names=["DB_URL"])]
    assert results[1] == [dict(env="production", audience="maintainers", names=["DB_URL", "NEW_ONLY", "STRIPE_KEY"])]
    assert results[2] == []
    vector("removal_checklist", "removing someone lists the current value names they could read: every name of a "
           "Members environment when they held the members key (past values included), and a Maintainers value "
           "whose current value was in a snapshot sent to them. carol saw the old production snapshot: DB_URL is "
           "unchanged since, STRIPE_KEY is not.",
           dict(op="exposure", environments=envs, cases=cases), dict(results=results))


def default_audience_vectors():
    names = ["production", "Production", "prod", "prod-eu", "products", "staging", "staging-2", "release",
             "release-1.2", "releases", "dev", "test", "preview", "my-production", "qa"]
    vector("default_audience", "the one name rule (owner question 3): production, prod*, staging and release* "
           "default to Maintainers, case-insensitively; every other name to Members.",
           dict(op="defaultAudience", names=names), dict(results=[default_audience(n) for n in names]))


def build():
    format_vectors()
    decode_vectors()
    open_vectors()
    resolve_vectors()
    exposure_vectors()
    default_audience_vectors()


def write_vectors(out_dir):
    build()
    for old in glob.glob(os.path.join(out_dir, "env_snapshot__*.json")):
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

"""Independent Python reference for environment snapshots (mixed-visibility design §4.5, D9, D24).

    python3 tools/private-repos-vectors/env.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/env.py --write-vectors  # (re)write forge-contracts/vectors/env_snapshot__*.json

A sibling of gen.py, whose crypto helpers it reuses (DFPK 0x01 seal under an epoch key, DFPK 0x02
seal to specific people, the parties and their keys). Every vector it writes has case
`env_snapshot` and an `input.op` naming what it checks: `format` (the canonical padded artifact),
`decode` (what a reader refuses), `open` (seal and open one snapshot, D24's packHash and sender
checks), `resolve` (authorization, the chain and fork detection) and `exposure` (the removal
checklist). Version-1 snapshots (phase 1) stay readable; every `v2_*` vector is the version-2 artifact
writers make from revision 4 on (D9, D34). The Rust harness (`forge_core::env`) and the
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
ENV_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")  # fullmatch: `$` would admit a trailing newline
VAR_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}")
TYPES = ("secret", "variable")
# Version 1 (phase 1, read only): the audience is a word, Members (a DFPK 0x01 file under the members key) or
# Maintainers (a DFPK 0x02 letter to at most 16 people).
AUDIENCES = ("members", "maintainers")
MAX_RECIPIENTS_V1 = 16
# Version 2 (revision 4, D9, D34): every snapshot is a DFPK 0x02 letter to the people its audience resolves to at
# write time, at most 64; the audience is a group (or none: specific people) plus extra people.
GROUPS = ("maintainers", "writers", "members")
MAX_RECIPIENTS = 64
U32_MAX = (1 << 32) - 1

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


# --- the artifact ---------------------------------------------------------------------------------


def version(s):
    return s.get("v", 1)


def vars_obj(vs):
    return {k: dict({"type": v["type"], "value": v["value"]}, **({"note": v["note"]} if v.get("note") else {}))
            for k, v in vs.items()}


def snapshot_obj(s):
    """The JSON object of snapshot `s`. Version 1: `note` left out when empty, `to` only for maintainers. Version
    2: `markedChanged` left out when empty; `audience` an object with `group` (null for specific people) and
    `also`; `id`, `to` and `toKeys` always."""
    obj = {"v": version(s), "env": s["env"], "audience": s["audience"], "generatedAt": s["generatedAt"],
           "vars": vars_obj(s["vars"])}
    if version(s) == 1:
        if s["audience"] == "maintainers":
            obj["to"] = list(s["to"])
    else:
        obj["audience"] = dict(group=s["audience"]["group"], also=list(s["audience"]["also"]))
        obj["id"] = s["id"]
        obj["to"] = list(s["to"])
        obj["toKeys"] = list(s["toKeys"])
        if s.get("markedChanged"):
            obj["markedChanged"] = list(s["markedChanged"])
    if s.get("savedFor"):
        obj["savedFor"] = s["savedFor"]
    return obj


def encode(s):
    """The artifact plaintext: canonical JSON padded with spaces to a multiple of 512, or None (too large)."""
    raw = canonical_json(snapshot_obj(s))
    size = max(BUCKET, -(-len(raw) // BUCKET) * BUCKET)
    return None if size > MAX_SNAPSHOT else raw + b" " * (size - len(raw))


def ids_ok(xs, lo, hi, ordered=False):
    """A list of `lo`..`hi` canonical base58 identity ids, none twice (and ascending when `ordered`)."""
    return isinstance(xs, list) and lo <= len(xs) <= hi and all(b58decode(t) is not None for t in xs) \
        and len(set(map(str, xs))) == len(xs) and (not ordered or xs == sorted(xs))


def valid(obj):
    """Whether `obj` (parsed JSON) is a version-1 or version-2 snapshot; returns the snapshot dict or None."""
    is_int = lambda x: isinstance(x, int) and not isinstance(x, bool)
    if not isinstance(obj, dict) or not is_int(obj.get("v")) or obj["v"] not in (1, 2):
        return None
    v = obj["v"]
    keys = {"v", "env", "audience", "generatedAt", "savedFor", "to", "vars"}
    if v == 2:
        keys |= {"id", "toKeys", "markedChanged"}
    if not set(obj) <= keys:
        return None
    if not isinstance(obj.get("env"), str) or not ENV_NAME.fullmatch(obj["env"]) \
            or not is_int(obj.get("generatedAt")) or not 0 <= obj["generatedAt"] <= SAFE_INT \
            or not isinstance(obj.get("vars"), dict):
        return None
    s = dict(v=v, env=obj["env"], generatedAt=obj["generatedAt"])
    if v == 1:
        if obj.get("audience") not in AUDIENCES:
            return None
        s["audience"] = obj["audience"]
        if obj["audience"] == "maintainers":
            if not ids_ok(obj.get("to"), 1, MAX_RECIPIENTS_V1):
                return None
            s["to"] = list(obj["to"])
        elif "to" in obj:
            return None
    else:
        aud = obj.get("audience")
        if not isinstance(aud, dict) or set(aud) != {"group", "also"} \
                or (aud["group"] is not None and aud["group"] not in GROUPS) \
                or not ids_ok(aud["also"], 0, MAX_RECIPIENTS, ordered=True) \
                or (aud["group"] is None and not aud["also"]):
            return None
        if not isinstance(obj.get("id"), str) or not re.fullmatch(r"[0-9a-f]{32}", obj["id"]):
            return None
        if not ids_ok(obj.get("to"), 1, MAX_RECIPIENTS):
            return None
        keys_ = obj.get("toKeys")
        if not isinstance(keys_, list) or len(keys_) != len(obj["to"]) \
                or any(not is_int(k) or not 0 <= k <= U32_MAX for k in keys_):
            return None
        marked = obj.get("markedChanged", [])
        if "markedChanged" in obj and (not isinstance(marked, list) or not marked):
            return None
        if any(not isinstance(n, str) or not VAR_NAME.fullmatch(n) for n in marked) \
                or marked != sorted(set(marked)):
            return None
        s.update(audience=dict(group=aud["group"], also=list(aud["also"])), id=obj["id"], to=list(obj["to"]),
                 toKeys=list(keys_), markedChanged=list(marked))
    if "savedFor" in obj and b58decode(obj["savedFor"]) is None:
        return None
    out_vars = {}
    for k, e in obj["vars"].items():
        if not VAR_NAME.fullmatch(k) or not isinstance(e, dict) or not set(e) <= {"type", "value", "note"}:
            return None
        if e.get("type") not in TYPES or not isinstance(e.get("value"), str) \
                or not isinstance(e.get("note", ""), str):
            return None
        out_vars[k] = dict(type=e["type"], value=e["value"], note=e.get("note", ""))
    s["vars"] = out_vars
    if "savedFor" in obj:
        s["savedFor"] = obj["savedFor"]
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
    """A decoded snapshot as the vectors carry it (`v` and `note` always present; for version 2 `markedChanged`
    always present)."""
    out = dict(v=version(s), env=s["env"], audience=s["audience"], generatedAt=s["generatedAt"],
               vars={k: dict(type=v["type"], value=v["value"], note=v.get("note", "")) for k, v in s["vars"].items()})
    if version(s) == 1:
        if s["audience"] == "maintainers":
            out["to"] = list(s["to"])
    else:
        out.update(audience=dict(group=s["audience"]["group"], also=list(s["audience"]["also"])), id=s["id"],
                   to=list(s["to"]), toKeys=list(s["toKeys"]), markedChanged=list(s.get("markedChanged", [])))
    if s.get("savedFor"):
        out["savedFor"] = s["savedFor"]
    return out


def members_key(s):
    """Whether `s` is an old-format Members snapshot (version 1, DFPK 0x01 under the members key)."""
    return version(s) == 1 and s["audience"] == "members"


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
    envelope = sealed[4]
    if envelope == 0x01:
        r = open_members_pack(sealed, {e["epoch"]: bytes.fromhex(e["key"]) for e in epoch_keys})
        if "error" in r:
            return r
        plain = r["plain"]
    elif envelope == 0x02:
        r = open_named_artifact(sealed, manifest["sizeBytes"], owner_keys, bytes.fromhex(reader["identityId"]),
                                [int(k, 16) for k in reader["keys"]])
        if "error" in r:
            return r
        plain = bytes.fromhex(r["plaintextHex"])
    else:
        return dict(error="sealedPackCorrupt")
    s = decode(plain)
    # a DFPK 0x01 file holds only an old-format Members snapshot; a 0x02 letter anything else, its `to` one entry per
    # slot with the manifest owner first
    if s is None or members_key(s) != (envelope == 0x01):
        return dict(error="malformed")
    if envelope == 0x02 and (len(s["to"]) != sealed[8] or s["to"][0] != manifest["ownerId"]):
        return dict(error="malformed")
    return dict(snapshot=snapshot_json(s))


# --- authorization, the chain and forks (D24) -----------------------------------------------------------


def resolve(maintainers, manifests, opened):
    """D24, strictly. `manifests`: [{id, ownerId, packHash, supersedes: [hex], height}] (`height` =
    $createdAtBlockHeight); `opened`: packHash → {env, ...} (readable) or {unreadable: reason}.

    Only a current maintainer's snapshot counts; every other manifest is ignored and none of its
    links is followed. A link counts only between counted snapshots and only strictly back in block
    height (so a snapshot cannot supersede itself or anything later, and there are no cycles). An
    ignored manifest that names an environment's counted head and is higher is reported per
    environment (`ignoredNewer`), never used."""
    order = sorted(manifests, key=lambda m: (m["height"], m["id"]))
    nodes, ignored, others = {}, [], []
    for m in order:
        if m["ownerId"] not in maintainers:
            ignored.append(dict(id=m["id"], reason="notAMaintainer"))
            others.append(m)
        elif m["packHash"] in nodes:
            ignored.append(dict(id=m["id"], reason="duplicate"))
        else:
            nodes[m["packHash"]] = m
    env_of = lambda h: opened.get(h, {}).get("env")
    edges = set()
    for h, t in nodes.items():
        for s_ in t["supersedes"]:
            if s_ not in nodes or nodes[s_]["height"] >= t["height"]:
                continue
            a, b = env_of(h), env_of(s_)
            if a is not None and b is not None and a != b:
                continue
            edges.add((h, s_))
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
    key = lambda h: (nodes[h]["height"], nodes[h]["id"])
    envs, hidden = {}, []
    for members in comps.values():
        names = sorted({env_of(h) for h in members if env_of(h) is not None})
        if not names:
            hidden.append(members)
        for e in names:
            envs.setdefault(e, set()).update(h for h in members if env_of(h) in (e, None))

    def heads_of(group):
        return sorted((n for n in group if not any((t, n) in edges for t in group)), key=key)

    def ids(hs):
        return [nodes[h]["id"] for h in sorted(hs, key=key)]

    def newer(heads):
        return sorted(m["id"] for m in others
                      if any(h in m["supersedes"] and m["height"] > nodes[h]["height"] and m["packHash"] != h
                             for h in heads))

    out_envs = []
    for e in sorted(envs):
        group = envs[e]
        heads = heads_of(group)
        state = ("current" if env_of(heads[0]) is not None else "unreadable") if len(heads) == 1 else "conflict"
        out_envs.append(dict(env=e, state=state, heads=ids(heads), snapshots=ids(group), ignoredNewer=newer(heads)))
    out_hidden = [dict(heads=ids(heads_of(set(g))), snapshots=ids(g))
                  for g in sorted(hidden, key=lambda g: min(key(h) for h in g))]
    return dict(ignored=ignored, environments=out_envs, hidden=out_hidden)


# --- what a new snapshot supersedes ---------------------------------------------------------------

MAX_SUPERSEDES = 32


def window(snapshots, heads):
    """`supersedes` of a new snapshot: the environment's heads, then the newest snapshot of each other
    author, then the rest, newest first; at most 32. `snapshots`: the environment's counted snapshots
    [{id, ownerId, packHash, height}]; `heads`: their ids. Naming each author's newest keeps the chain
    whole when a maintainer with a long run of changes is removed."""
    key = lambda m: (m["height"], m["id"])
    by_id = {m["id"]: m for m in snapshots}
    out = [by_id[h] for h in sorted(heads, key=lambda h: key(by_id[h]), reverse=True)]
    rest = sorted((m for m in snapshots if m["id"] not in heads), key=key, reverse=True)
    authors = {m["ownerId"] for m in out}
    for m in rest:
        if m["ownerId"] not in authors:
            authors.add(m["ownerId"])
            out.append(m)
    out += [m for m in rest if m not in out]
    return [m["packHash"] for m in out[:MAX_SUPERSEDES]]


# --- the removal checklist --------------------------------------------------------------------------


def exposure(environments, removed, held_members_key):
    """`environments`: [{env, heads: [snapshot], snapshots: [snapshot]}] with readable snapshots
    {v?, audience, to?, vars: {NAME: value}}. Which current value names `removed` could read: a name of a head whose
    current value is in some snapshot of the environment they could open (an old-format Members snapshot when they
    held the members key, or any snapshot whose `to` lists them). `oldFormat`: they held the members key and the
    environment has an old-format Members snapshot, which hands over every past value too."""
    out = []
    for e in environments:
        names = set()
        could = lambda s: (members_key(s) and held_members_key) or removed in s.get("to", [])
        for head in e["heads"]:
            for name, value in head["vars"].items():
                if any(s["vars"].get(name) == value and could(s) for s in e["snapshots"]):
                    names.add(name)
        if names:
            old = held_members_key and any(members_key(s) for s in e["snapshots"])
            out.append(dict(env=e["env"], names=sorted(names), oldFormat=old))
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
    resaved = dict(env="production", audience="members", generatedAt=GENERATED_AT, savedFor=B(CAROL),
                   vars={"STRIPE_KEY": var("sk_test_fake_carol")})
    pt = encode(resaved)
    assert b'"savedFor"' in pt and decode(pt)["savedFor"] == B(CAROL)
    cases.append(dict(snapshot=snapshot_json(resaved), plaintextHex=H(pt), sizeBytes=len(pt)))
    big = dict(base, vars={"FILL": var("x" * MAX_SNAPSHOT)})
    assert encode(big) is None
    cases.append(dict(snapshot=snapshot_json(big), tooLarge=True))
    vector("padding", "the artifact is canonical JSON (sorted keys, no whitespace, UTF-8 unescaped, `note` left out "
           "when empty, `to` only for Maintainers, `savedFor` only on a snapshot saved again for a removed maintainer) padded with spaces to a multiple of 512 bytes; exactly 512 needs no "
           "padding, one byte more takes 1,024; over 12,288 bytes is refused by the writer.",
           dict(op="format", cases=[dict(snapshot=c["snapshot"]) for c in cases]),
           dict(results=[{k: v for k, v in c.items() if k != "snapshot"} for c in cases]))


def decode_vectors():
    good = encode(dict(env="dev", audience="members", generatedAt=GENERATED_AT, vars={"A": var("1")}))
    raw = good.rstrip(b" ")

    def pad(b, n=512):
        return b + b" " * (n - len(b))

    one = lambda v: encode(dict(env="dev", audience="members", generatedAt=GENERATED_AT, vars={"A": var(v)}))
    ctl = one("x\u001fy")
    wide = one("a\u2028b\U0001F600")
    assert b"\\u001f" in ctl and "\u2028".encode() in wide and "\U0001F600".encode() in wide

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
        ("saved_for_not_an_id", pad(raw.replace(b'"generatedAt":1767225600000,',
                                                b'"generatedAt":1767225600000,"savedFor":"carol",')), False),
        ("env_name_trailing_newline", pad(raw.replace(b'"dev"', b'"dev\\n"')), False),
        ("duplicate_key", pad(raw.replace(b'"vars":{', b'"vars":{"A":{"type":"secret","value":"0"},', 1)), False),
        ("control_escaped_lowercase", ctl, True),
        ("control_escaped_uppercase", pad(ctl.rstrip(b" ").replace(b"\\u001f", b"\\u001F")), False),
        ("line_separator_and_astral_raw", wide, True),
        ("astral_escaped", pad(wide.rstrip(b" ").replace("\U0001F600".encode(), b"\\ud83d\\ude00")), False),
        ("negative_zero_time", pad(raw.replace(b"1767225600000", b"-0")), False),
        ("exponent_time", pad(raw.replace(b"1767225600000", b"1e3")), False),
    ]
    for name, pt, ok in cases:
        assert (decode(pt) is not None) == ok, name
    vector("decode_refused", "a reader takes only the exact canonical bytes: a length that is not a multiple of 512, "
           "padding other than spaces, any whitespace or key order other than canonical, an empty `note`, an unknown "
           "key or type, `to` on a Members snapshot or none on a Maintainers one, a bad name, another version, an "
           "escape the writer never makes (an uppercase \\u, an escaped astral character), a duplicate key, `-0` or an "
           "exponent is malformed. Raw U+2028 and astral characters, and a lowercase \\u00XX control escape, are "
           "the canonical form.",
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


def open_vectors():
    dev = dict(env="dev", audience="members", generatedAt=GENERATED_AT,
               vars={"API_URL": var("https://api.example.test", "variable"), "API_TOKEN": var("fake-token-1")})
    plain, file_id, sealed = sealed_members(dev)
    man = manifest_of(ALICE, sealed)
    k0 = [dict(epoch=0, key=H(K0))]
    readers = [dict(reader=reader_json(BOB), epochKeys=k0), dict(reader=reader_json(BOB), epochKeys=[])]
    results = [open_snapshot(man, sealed, [], r["reader"], r["epochKeys"]) for r in readers]
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
    results = [open_snapshot(man, sealed, okeys, r["reader"], []) for r in readers]
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
    results = [open_snapshot(man, fsealed, okeys, r["reader"], []) for r in readers]
    assert results == [dict(error="notARecipient")] * 2 + [dict(error="malformed")]
    vector("sender_not_owner", "a maintainer's manifest whose artifact was sealed by someone else (a writer as the "
           "sender): the sender key is taken only from the manifest owner's identity, so no maintainer's slot opens; "
           "the writer, whose ECDH with the owner's key equals the one alice's slot was made with, opens that slot but "
           "the content does not list the owner first: malformed. Nobody is served its values.",
           dict(op="open", repoId=H(repoId), manifest=man, sealed=H(fsealed), ownerKeys=okeys, readers=readers),
           dict(results=results))

    man = manifest_of(ALICE, sealed, packHash=H(sha256(fsealed)))
    results = [open_snapshot(man, sealed, okeys, readers[0]["reader"], [])]
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
    r1 = open_snapshot(man, wsealed, [], reader_json(BOB), k0)
    lying = dict(prod, to=[B(BOB), B(ALICE), B(CAROL)])
    _, _, _, _, lsealed = sealed_maintainers(lying, ALICE, recipients, label=b"lying to")
    man2 = manifest_of(ALICE, lsealed)
    r2 = open_snapshot(man2, lsealed, okeys, reader_json(BOB), [])
    assert r1 == r2 == dict(error="malformed")
    vector("audience_mismatch", "an artifact that opens but disagrees with its envelope is malformed: Maintainers "
           "content in a Members (DFPK 0x01) file, and a DFPK 0x02 snapshot whose `to` does not list its owner first.",
           dict(op="open", repoId=H(repoId), cases=[
               dict(manifest=man, sealed=H(wsealed), ownerKeys=[], reader=reader_json(BOB), epochKeys=k0),
               dict(manifest=man2, sealed=H(lsealed), ownerKeys=okeys, reader=reader_json(BOB), epochKeys=[])]),
           dict(results=[r1, r2]))


def hx(label):
    return H(sha256(b"dash-forge vectors: env snapshot packHash " + label.encode()))


def m(label, owner, height, sup=(), pack=None):
    return dict(id=b58(sha256(b"dash-forge vectors: env manifest " + label.encode())), ownerId=B(owner),
                packHash=hx(pack or label), supersedes=[hx(x) for x in sup], height=height, label=label)


def resolve_vector(name, desc, maintainers, manifests, opened, check):
    op = {hx(k): v for k, v in opened.items()}
    res = resolve({B(p) for p in maintainers}, manifests, op)
    by_id = {mm["id"]: mm["label"] for mm in manifests}
    lab = lambda xs: [by_id[i] for i in xs]
    check({e["env"]: dict(e, heads=lab(e["heads"]), snapshots=lab(e["snapshots"]), ignoredNewer=lab(e["ignoredNewer"]))
           for e in res["environments"]},
          [dict(i, id=by_id[i["id"]]) for i in res["ignored"]],
          [dict(heads=lab(g["heads"]), snapshots=lab(g["snapshots"])) for g in res["hidden"]])
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
    resolve_vector("chain_linear", "three changes to production, each naming the earlier ones (a writer lists every "
                   "counted snapshot of the environment, newest first, up to 32), and a separate dev: one head each.",
                   [ALICE, BOB],
                   [m("s1", ALICE, 1000), m("s2", BOB, 2000, ["s1"]), m("d1", ALICE, 2500),
                    m("s3", ALICE, 3000, ["s2", "s1"])],
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
                    m("s4", ALICE, 3000, ["s2", "s3", "s1"])], {"s1": P, "s2": P, "s3": P, "s4": P}, resolved)

    def unauthorized(envs, ign, hid):
        assert envs["production"]["state"] == "current" and envs["production"]["heads"] == ["s1"]
        assert envs["production"]["ignoredNewer"] == ["w1"]
        assert "staging" not in envs and [i["id"] for i in ign] == ["w1", "w2"]
        assert all(i["reason"] == "notAMaintainer" for i in ign)
    resolve_vector("unauthorized_writer_ignored", "a role-1 writer (consensus admits their packManifest) posts a "
                   "snapshot superseding production's head and a new staging: neither counts, whatever they would "
                   "open to, because their owner is not a current maintainer; production stays at s1 and there is no "
                   "fork. Readers are told a newer change was ignored (`ignoredNewer`), and never use it.", [ALICE],
                   [m("s1", ALICE, 1000), m("w1", WRITER, 2000, ["s1"]), m("w2", WRITER, 2100)],
                   {"s1": P, "w1": P, "w2": R("staging")}, unauthorized)

    def demoted(envs, ign, hid):
        assert envs["production"]["state"] == "current" and envs["production"]["heads"] == ["s1"]
        assert envs["production"]["ignoredNewer"] == ["c1"] and [i["id"] for i in ign] == ["c1"]
    resolve_vector("post_demotion_snapshot_ignored", "carol was a maintainer and is now a writer; a snapshot she "
                   "posts naming production's head counts no more than any writer's: production stays at s1 and "
                   "readers are warned that a newer change was ignored.", [ALICE],
                   [m("s1", ALICE, 1000), m("c1", CAROL, 2000, ["s1"])], {"s1": P, "c1": P}, demoted)

    def removed(envs, ign, hid):
        assert envs["production"]["state"] == "current" and envs["production"]["heads"] == ["s3"]
        assert envs["production"]["snapshots"] == ["s1", "s3"] and [i["id"] for i in ign] == ["s2", "t2"]
        assert envs["production"]["ignoredNewer"] == []
        assert envs["staging"]["state"] == "conflict" and envs["staging"]["heads"] == ["t1", "t3"]
    resolve_vector("removed_maintainer_mid_chain", "carol, no longer a maintainer, saved s2; alice's later s3 names "
                   "s2 and s1, so production has one head without following carol's link (links are read only from "
                   "counted snapshots). staging's t3 named only carol's t2, so t1 and t3 are both heads: a conflict a "
                   "maintainer resolves; it never falls back to t1 silently.", [ALICE],
                   [m("s1", ALICE, 1000), m("t1", ALICE, 1001), m("s2", CAROL, 2000, ["s1"]), m("t2", CAROL, 2001, ["t1"]),
                    m("s3", ALICE, 3000, ["s2", "s1"]), m("t3", ALICE, 3001, ["t2"])],
                   {"s1": P, "s3": P, "t1": R("staging"), "t3": R("staging")}, removed)

    def reuse(envs, ign, hid):
        assert envs["production"]["state"] == "conflict" and envs["production"]["heads"] == ["s2", "s3"]
        assert [i["id"] for i in ign] == ["w1", "w2"]
        assert envs["production"]["ignoredNewer"] == ["w1", "w2"]
    resolve_vector("writer_reuses_pack_hash", "a writer records copies of both fork heads' artifacts (the unique index is "
                   "per owner, so the same packHash is admitted), each naming the other head, to make the fork look "
                   "resolved: the writer's manifests are never links, so production stays a conflict.", [ALICE, BOB],
                   [m("s1", ALICE, 1000), m("s2", ALICE, 2000, ["s1"]), m("s3", BOB, 2001, ["s1"]),
                    m("w1", WRITER, 3000, ["s3"], pack="s2"), m("w2", WRITER, 3001, ["s2"], pack="s3")],
                   {"s1": P, "s2": P, "s3": P}, reuse)

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
        assert envs["production"]["state"] == "current" and envs["production"]["heads"] == ["s2"]
        assert envs["dev"]["state"] == "current" and envs["dev"]["heads"] == ["d1"]
        assert envs["staging"]["state"] == "conflict" and sorted(envs["staging"]["heads"]) == ["t1", "t2"]
    resolve_vector("chain_cycle", "links count only strictly back in block height: s1 naming the later s2 is no link, "
                   "so s2 is production's head; a snapshot naming itself supersedes nothing; two snapshots in one "
                   "block naming each other supersede nothing either (a conflict).", [ALICE],
                   [m("s1", ALICE, 1000, ["s2"]), m("s2", ALICE, 1001, ["s1"]), m("d1", ALICE, 1100, ["d1"]),
                    m("t1", ALICE, 1200, ["t2"]), m("t2", ALICE, 1200, ["t1"])],
                   {"s1": P, "s2": P, "d1": D, "t1": R("staging"), "t2": R("staging")}, cycle)

    def dup(envs, ign, hid):
        assert envs["production"]["state"] == "current" and ign == [dict(id="s1b", reason="duplicate")]
    s1b = dict(m("s1", BOB, 1500, ["zz"]), id=b58(sha256(b"dash-forge vectors: env manifest s1b")), label="s1b")
    resolve_vector("duplicate_copy", "a second maintainer's manifest of the same artifact counts once, the earliest.",
                   [ALICE, BOB], [m("s1", ALICE, 1000), s1b], {"s1": P}, dup)

    def cross(envs, ign, hid):
        assert envs["production"]["heads"] == ["s1"] and envs["dev"]["heads"] == ["d1"]
    resolve_vector("cross_environment_link_dropped", "a snapshot of dev naming a production snapshot in supersedes does "
                   "not end production: links count only between snapshots of the same environment.", [ALICE],
                   [m("s1", ALICE, 1000), m("d1", ALICE, 2000, ["s1"])], {"s1": P, "d1": D}, cross)


def window_vectors():
    snaps = [dict(id=f"x{i:02}", ownerId=B(BOB) if i < 40 else B(ALICE), packHash=hx(f"x{i:02}"), height=1000 + i)
             for i in range(45)]
    snaps.append(dict(id="c0", ownerId=B(CAROL), packHash=hx("c0"), height=999))
    heads = ["x44"]
    res = window(snaps, heads)
    assert res[0] == hx("x44") and hx("x39") in res and hx("c0") in res and len(res) == 32
    small = snaps[:3]
    res2 = window(small, ["x02"])
    assert res2 == [hx("x02"), hx("x01"), hx("x00")]
    vector("window", "what a new snapshot names in supersedes: the heads, then the newest snapshot of each other "
           "author, then the rest newest first, at most 32; so carol's single old snapshot and bob's newest are named "
           "even behind a long run by alice.",
           dict(op="window", cases=[dict(snapshots=snaps, heads=heads), dict(snapshots=small, heads=["x02"])]),
           dict(results=[res, res2]))


def long_run_vectors():
    P, S = dict(env="production"), dict(env="staging")
    ms = [m("a0", ALICE, 1), m("b0", ALICE, 2)]
    ids_p, ids_s = ["a0"], ["b0"]
    for i in range(32):
        lp, ls = f"p{i:02}", f"q{i:02}"
        ms.append(m(lp, CAROL, 10 + 2 * i, list(reversed(ids_p))[:32]))
        ms.append(m(ls, CAROL, 11 + 2 * i, list(reversed(ids_s))[:32]))
        ids_p.append(lp)
        ids_s.append(ls)
    # production's a1 names only the 32 newest (all carol's); staging's b1 names carol's newest, then
    # each other author's newest (b0), then the rest (the window rule)
    ms.append(m("a1", ALICE, 100, list(reversed(ids_p))[:32]))
    snaps_s = [dict(id=x["label"], ownerId=x["ownerId"], packHash=x["packHash"], height=x["height"])
               for x in ms if x["label"] in ids_s]
    w = window(snaps_s, ["q31"])
    ms.append(dict(m("b1", ALICE, 101), supersedes=w))
    opened = {x["label"]: (S if x["label"] in ids_s + ["b1"] else P) for x in ms}

    def check(envs, ign, hid):
        assert envs["production"]["state"] == "conflict" and envs["production"]["heads"] == ["a0", "a1"]
        assert envs["staging"]["state"] == "current" and envs["staging"]["heads"] == ["b1"]
    resolve_vector("long_run_by_removed_maintainer", "carol saved 32 changes in a row to each environment and is then "
                   "removed. production's later a1 named only the 32 newest snapshots (all carol's), so without her "
                   "a0 is a head again beside a1: a conflict (dg collab remove sees this in its dry run and saves "
                   "again first). staging's b1 named carol's newest, then each other author's newest, so it stays "
                   "one chain.", [ALICE], ms, opened, check)


def promotion_vectors():
    P = dict(env="production")
    base = [m("a0", ALICE, 1000), m("w0", WRITER, 2000, ["a0"])]

    def unprotected(envs, ign, hid):
        assert envs["production"]["state"] == "current" and envs["production"]["heads"] == ["w0"]
    resolve_vector("promotion_unprotected", "the writer's old snapshot w0 (ignored while they were a writer) starts "
                   "counting the moment they become a maintainer, and silently replaces production's values: why the "
                   "promoting client first saves a snapshot naming it (next vector).", [ALICE, WRITER], base,
                   {"a0": P, "w0": P}, unprotected)

    def protected(envs, ign, hid):
        assert envs["production"]["state"] == "current" and envs["production"]["heads"] == ["p1"]
    resolve_vector("promotion_protected", "before granting the role, alice saved production's current values again "
                   "(p1) naming both a0 and the writer's dormant w0: after the promotion p1 is the only head and the "
                   "values are unchanged.", [ALICE, WRITER], base + [m("p1", ALICE, 3000, ["a0", "w0"])],
                   {"a0": P, "w0": P, "p1": P}, protected)


def exposure_vectors():
    p = lambda to, **vs: dict(audience="maintainers", to=[B(x) for x in to], vars=vs)
    mem = lambda **vs: dict(audience="members", vars=vs)
    l2 = lambda group, to, **vs: dict(v=2, audience=dict(group=group, also=[]), to=[B(x) for x in to], vars=vs)
    prod_old = p([ALICE, CAROL], STRIPE_KEY="sk_test_old", DB_URL="postgres://fake/1")
    prod_new = l2("maintainers", [ALICE, BOB], STRIPE_KEY="sk_test_new", DB_URL="postgres://fake/1", NEW_ONLY="x")
    dev_old = mem(API_TOKEN="fake-dev", LOG_LEVEL="debug")
    dev_new = l2("members", [ALICE, BOB], API_TOKEN="fake-dev-2", LOG_LEVEL="debug")
    ci = l2("writers", [ALICE, CAROL], NPM_TOKEN="fake-npm")
    envs = [dict(env="production", heads=[prod_new], snapshots=[prod_old, prod_new]),
            dict(env="dev", heads=[dev_new], snapshots=[dev_old, dev_new]),
            dict(env="ci", heads=[ci], snapshots=[ci])]
    cases = [dict(removed=B(CAROL), heldMembersKey=True), dict(removed=B(BOB), heldMembersKey=False),
             dict(removed=B(NAMED_OUTSIDER), heldMembersKey=False)]
    results = [exposure(envs, c["removed"], c["heldMembersKey"]) for c in cases]
    assert results[0] == [dict(env="ci", names=["NPM_TOKEN"], oldFormat=False),
                          dict(env="dev", names=["LOG_LEVEL"], oldFormat=True),
                          dict(env="production", names=["DB_URL"], oldFormat=False)], results[0]
    assert results[1] == [dict(env="dev", names=["API_TOKEN", "LOG_LEVEL"], oldFormat=False),
                          dict(env="production", names=["DB_URL", "NEW_ONLY", "STRIPE_KEY"], oldFormat=False)]
    assert results[2] == []
    vector("removal_checklist", "removing someone lists the current value names they could read: a name whose current "
           "value is in a snapshot sent to them (`to`), or in an old-format Members snapshot when they held the members "
           "key (`oldFormat`: that hands over every past value too). carol saw the old production snapshot: DB_URL is "
           "unchanged since, STRIPE_KEY is not; she held the members key, and dev's LOG_LEVEL is unchanged since its "
           "old-format snapshot.",
           dict(op="exposure", environments=envs, cases=cases), dict(results=results))


BOT = gen.named_party("ci-bot")
# enough people for the largest letter (64 slots)
CROWD = [gen.named_party(f"m{i}") for i in range(1, 60)]
ENV_ID = sha256(b"dash-forge vectors: env id production")[:16].hex()


def v2(env, group, also, to, vars_, marked=(), saved_for=None, id_=ENV_ID, key_ids=None):
    """A version-2 snapshot of `env` for `group` (or None) plus `also`, sent to `to` (parties, the writer first)."""
    s = dict(v=2, env=env, audience=dict(group=group, also=sorted(B(p) for p in also)), id=id_,
             generatedAt=GENERATED_AT, to=[B(p) for p in to], toKeys=key_ids or [4] + [3] * (len(to) - 1),
             markedChanged=sorted(marked), vars=vars_)
    if saved_for:
        s["savedFor"] = B(saved_for)
    return s


def open_v2_vector(name, desc, snap, recipients, readers, expect_open, label):
    plain, k_obj, file_id, ivs, sealed = sealed_maintainers(snap, recipients[0], recipients, label=label)
    man = manifest_of(recipients[0], sealed)
    okeys = [owner_key(recipients[0])]
    rs = [dict(reader=reader_json(p), epochKeys=[]) for p in readers]
    results = [open_snapshot(man, sealed, okeys, r["reader"], []) for r in rs]
    for p, r in zip(readers, results):
        assert (r == dict(snapshot=snapshot_json(snap))) == (p in expect_open), (name, p["name"], r)
        assert p in expect_open or r == dict(error="notARecipient"), (name, r)
    assert sealed[8] == len(recipients)
    vector(name, desc,
           dict(op="open", repoId=H(repoId), snapshot=snapshot_json(snap),
                seal=dict(senderKeyId=4, sender=reader_json(recipients[0]), recipients=[dict(identityId=H(p["id"]),
                          pub=H(p["pub"])) for p in recipients], kObj=H(k_obj), fileId=H(file_id),
                          ivs=[H(i) for i in ivs]),
                manifest=man, sealed=H(sealed), ownerKeys=okeys, readers=rs),
           dict(plaintextHex=H(plain), packHash=man["packHash"], results=results))


def v2_vectors():
    prod_vars = {"STRIPE_KEY": var("sk_test_fake_2"), "DB_URL": var("postgres://fake:fake@db.example/prod")}
    snap = v2("production", "maintainers", [], [ALICE, BOB], prod_vars)
    open_v2_vector("v2_maintainers", "a version-2 snapshot for Maintainers is a DFPK 0x02 letter to the owner and "
                   "maintainers when it was saved (`to`, the writer first; `toKeys` the encryption key each slot was "
                   "sealed to); `audience` is {group, also}; `id` is fixed at the environment's first save. A writer and "
                   "an outsider are not recipients.", snap, [ALICE, BOB], [ALICE, BOB, WRITER, NAMED_OUTSIDER],
                   [ALICE, BOB], b"v2 maintainers")
    snap = v2("staging", "writers", [], [ALICE, BOB, WRITER], {"API_TOKEN": var("fake-staging")})
    open_v2_vector("v2_writers", "Writers and maintainers: the owner, the maintainers and the role-1 writers when it "
                   "was saved. carol (a reader) is not a recipient.", snap, [ALICE, BOB, WRITER],
                   [ALICE, WRITER, CAROL], [ALICE, WRITER], b"v2 writers")
    snap = v2("dev", "members", [], [ALICE, BOB, CAROL, WRITER], {"LOG_LEVEL": var("debug", "variable")})
    open_v2_vector("v2_members", "All members: every human member role when it was saved, readers and triage "
                   "included, as a letter (never the members key). An outsider is not a recipient.", snap,
                   [ALICE, BOB, CAROL, WRITER], [CAROL, WRITER, NAMED_OUTSIDER], [CAROL, WRITER], b"v2 members")
    snap = v2("deploy", None, [ALICE, NAMED_OUTSIDER], [ALICE, NAMED_OUTSIDER], {"DEPLOY_KEY": var("fake-deploy")})
    open_v2_vector("v2_people", "Specific people: no group (`group` null), the people in `also` (sorted; the person who "
                   "set the audience is one of them), members or not: dave is not a member and reads it; bob, a "
                   "maintainer, does not.", snap, [ALICE, NAMED_OUTSIDER], [NAMED_OUTSIDER, BOB],
                   [NAMED_OUTSIDER], b"v2 people")
    snap = v2("ci", "writers", [BOT], [ALICE, BOB, WRITER, BOT], {"NPM_TOKEN": var("fake-npm")},
              marked=["OLD_TOKEN"])
    open_v2_vector("v2_group_also", "a group plus people: Writers and maintainers and the CI bot named in `also` "
                   "(groups never include bots). `markedChanged` lists names whose values held in old-format "
                   "snapshots were changed at their source (`dg env mark-changed`).", snap,
                   [ALICE, BOB, WRITER, BOT], [BOT, WRITER, CAROL], [BOT, WRITER], b"v2 group also")
    crowd = [ALICE, BOB, CAROL, WRITER, BOT] + CROWD
    assert len(crowd) == 64
    snap = v2("dev", "members", [], crowd, {"LOG_LEVEL": var("info", "variable")})
    open_v2_vector("v2_sixty_four", "an environment letter holds at most 64 recipients (n is a u8; 64 slots make a "
                   "4,165-byte header): the last slot opens like the first.", snap, crowd,
                   [crowd[-1], ALICE, NAMED_OUTSIDER], [crowd[-1], ALICE], b"v2 sixty four")

    # format: the canonical v2 artifact
    cases = []
    for snap in (v2("dev", "members", [], [ALICE], {}),
                 v2("production", None, [ALICE, BOB], [ALICE, BOB],
                    {"DB_URL": var("postgres://fake/1", note="primary"), "GREETING": var("héllo\n", "variable")},
                    marked=["A_OLD", "B_OLD"], saved_for=CAROL, key_ids=[4, 7])):
        pt = encode(snap)
        assert snapshot_json(decode(pt)) == snapshot_json(snap)
        cases.append(dict(snapshot=snapshot_json(snap), plaintextHex=H(pt), sizeBytes=len(pt)))
    vector("v2_padding", "version 2 is canonical JSON too (sorted keys, `audience` {also, group}, `group` null for "
           "specific people, `id` 32 lowercase hex digits, `markedChanged` left out when empty, `toKeys` beside `to`), "
           "padded with spaces to a multiple of 512 bytes.",
           dict(op="format", cases=[dict(snapshot=c["snapshot"]) for c in cases]),
           dict(results=[{k: v for k, v in c.items() if k != "snapshot"} for c in cases]))

    good = encode(v2("dev", "members", [], [ALICE, BOB], {"A": var("1")}))
    raw = good.rstrip(b" ")

    def pad(b):
        return b + b" " * (-(-len(b) // 512) * 512 - len(b)) if b else b

    sixty_five = canonical_json(snapshot_obj(v2("dev", "members", [], [ALICE, BOB, CAROL, WRITER, BOT] + CROWD
                                                 + [NAMED_OUTSIDER], {})))
    cases = [
        ("canonical", good, True),
        ("group_writers", pad(raw.replace(b'"group":"members"', b'"group":"writers"')), True),
        ("group_unknown", pad(raw.replace(b'"group":"members"', b'"group":"triage"')), False),
        ("people_without_anyone", pad(raw.replace(b'"group":"members"', b'"group":null')), False),
        ("audience_a_word", pad(raw.replace(b'{"also":[],"group":"members"}', b'"members"')), False),
        ("no_id", pad(raw.replace(b'"id":"' + ENV_ID.encode() + b'",', b"")), False),
        ("id_uppercase", pad(raw.replace(ENV_ID.encode(), ENV_ID.upper().encode())), False),
        ("id_short", pad(raw.replace(ENV_ID.encode(), ENV_ID[:30].encode())), False),
        ("to_keys_short", pad(raw.replace(b'"toKeys":[4,3]', b'"toKeys":[4]')), False),
        ("to_keys_negative", pad(raw.replace(b'"toKeys":[4,3]', b'"toKeys":[4,-3]')), False),
        ("marked_empty", pad(raw.replace(b'"to":', b'"markedChanged":[],"to":', 1)), False),
        ("marked_unsorted", pad(raw.replace(b'"to":', b'"markedChanged":["B","A"],"to":', 1)), False),
        ("marked_sorted", pad(raw.replace(b'"to":', b'"markedChanged":["A","B"],"to":', 1)), True),
        ("marked_bad_name", pad(raw.replace(b'"to":', b'"markedChanged":["1A"],"to":', 1)), False),
        ("also_unsorted", pad(canonical_json(dict(snapshot_obj(v2("dev", "members", [], [ALICE], {})),
                                                  audience=dict(group="members", also=sorted([B(ALICE), B(BOB)])[::-1])))), False),
        ("sixty_five_recipients", pad(sixty_five), False),
        ("version_1_with_id", pad(b'{"audience":"members","env":"dev","generatedAt":1767225600000,"id":"' + ENV_ID.encode()
                                  + b'","v":1,"vars":{}}'), False),
        ("version_3", pad(raw.replace(b'"v":2', b'"v":3')), False),
    ]
    for name, pt, ok in cases:
        assert (decode(pt) is not None) == ok, name
    vector("v2_decode_refused", "a version-2 reader takes only the exact canonical bytes: `group` one of maintainers, "
           "writers, members or null (null needs someone in `also`), `also` sorted, `id` 32 lowercase hex digits, one "
           "`toKeys` entry per `to` entry (u32), `markedChanged` sorted variable names and never empty, at most 64 "
           "recipients; version-2 keys on a version-1 object and an unknown version are malformed.",
           dict(op="decode", cases=[dict(name=n, plaintextHex=H(pt)) for n, pt, _ in cases]),
           dict(results=[dict(name=n, snapshot=snapshot_json(decode(pt))) if ok else dict(name=n, error="malformed")
                         for n, pt, ok in cases]))

    # envelopes: a v2 snapshot is never under the members key; an old Members snapshot never a letter; 65 slots refused
    snap = v2("dev", "members", [], [ALICE, BOB], {"A": var("1")})
    _, _, wsealed = sealed_members(snap, label=b"v2 under members key")
    man = manifest_of(ALICE, wsealed)
    r1 = open_snapshot(man, wsealed, [], reader_json(BOB), [dict(epoch=0, key=H(K0))])
    old = dict(env="dev", audience="members", generatedAt=GENERATED_AT, vars={"A": var("1")})
    _, _, _, _, lsealed = sealed_maintainers(old, ALICE, [ALICE, BOB], label=b"members as letter")
    man2 = manifest_of(ALICE, lsealed)
    r2 = open_snapshot(man2, lsealed, [owner_key(ALICE)], reader_json(BOB), [])
    many = [ALICE, BOB, CAROL, WRITER, BOT] + CROWD + [NAMED_OUTSIDER]
    big = v2("dev", "members", [], many[:64], {})
    k_obj = sha256(b"dash-forge vectors: env snapshot kObj sixty five")
    file_id = sha256(b"dash-forge vectors: env snapshot fileId sixty five")[:16]
    ivs = [sha256(b"dash-forge vectors: env snapshot iv sixty five %d" % i)[:16] for i in range(65)]
    _, msealed = seal_named_artifact(ALICE, 4, many, encode(big), k_obj, file_id, ivs)
    man3 = manifest_of(ALICE, msealed)
    r3 = open_snapshot(man3, msealed, [owner_key(ALICE)], reader_json(BOB), [])
    assert r1 == r2 == dict(error="malformed") and r3 == dict(error="sealedPackCorrupt"), (r1, r2, r3)
    vector("v2_envelope_refused", "a version-2 snapshot in a DFPK 0x01 file (under the members key) and an old Members "
           "snapshot in a 0x02 letter disagree with their envelope: malformed. A letter header with 65 slots is "
           "refused before any slot is tried.",
           dict(op="open", repoId=H(repoId), cases=[
               dict(manifest=man, sealed=H(wsealed), ownerKeys=[], reader=reader_json(BOB),
                    epochKeys=[dict(epoch=0, key=H(K0))]),
               dict(manifest=man2, sealed=H(lsealed), ownerKeys=[owner_key(ALICE)], reader=reader_json(BOB), epochKeys=[]),
               dict(manifest=man3, sealed=H(msealed), ownerKeys=[owner_key(ALICE)], reader=reader_json(BOB),
                    epochKeys=[])]),
           dict(results=[r1, r2, r3]))


def build():
    format_vectors()
    decode_vectors()
    open_vectors()
    resolve_vectors()
    window_vectors()
    long_run_vectors()
    promotion_vectors()
    exposure_vectors()
    v2_vectors()


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

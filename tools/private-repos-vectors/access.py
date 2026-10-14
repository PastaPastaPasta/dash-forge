"""Independent Python reference for bot access (mixed-visibility design §4.9, D33; docs/security/private-repos.md
§22): the `read` key letter (kind 10), access notices (kind 11) and asking a bot (event kind 27).

    python3 tools/private-repos-vectors/access.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/access.py --write-vectors  # (re)write key_letter__read_*.json, access_notice__*.json

`key_letters.py --write-vectors` rewrites the other key_letter__* files and leaves the `read` ones to this module.

The `read` letter (v 1) carries one thread as it was when a member asked a bot to work on it:

    {"asOf":ms,"checkNameKey":hex32|null,"docs":[[id,revision,kObj],...],"heads":[[blind,oid,salt],...],
     "job":hex32,"packs":[[packHash,key],...],"target":{"pr":n}|{"issue":n}|{"branch":hex32},"type":"read","v":1}

docs sorted by (id, revision), each once, revisions >= 1; packs sorted by packHash, each once; every head a blind that
checks against a non-null commit; checkNameKey the first head's (null with no head); a target with one key, numbers
>= 1 and < 2^32. Ops: `readFormat`, `readDecode`, `readOpenDoc` (a document opened with its per-object key alone: what
a bot reads; a pull request's branch names keyed by the epoch are dropped, its plain-SHA-256 names kept).

An access notice (v 1) is a typed object of type "accessNotice" in the same canonical form:

    {"askers":"writers"|"maintainers","bot":hex32,"may":[...],"note":TEXT,"processor":TEXT|null,
     "revokes":[packHash,...],"threads":"all"|[n,...],"type":"accessNotice","until":ms|null,"v":1}

may sorted, each once, ASCII letters and digits (1-40), unknown abilities kept; threads sorted, each once, 1..100 of
them, numbers >= 1; processor 1-100 characters, not blank, no control character; note at most 500 characters, no
control character but a newline; revokes sorted, each once, at most 64; until null or 0..2^53-1; fields of a later
version kept. Ops: `noticeFormat`, `noticeDecode`, `noticeCurrent` (the newest notice per bot from a current
maintainer), `ask` (what a client refuses before signing a request: E813).
"""
import glob
import json
import os
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen import H, K0, ad, k_obj_members, members_tlv, ownerId, ref_hash, repoId, seal_members, sha256, tlv, V3  # noqa: E402
import gen  # noqa: E402
from key_letters import check_name_key, decode, encode, hex_exact, pad, MAX_INT  # noqa: E402
from members_git import blind  # noqa: E402

VECTORS = []
READ_FIELDS = ("asOf", "checkNameKey", "docs", "heads", "job", "packs", "target")
NOTICE_FIELDS = ("askers", "bot", "may", "note", "processor", "revokes", "threads", "until")
U32_MAX = (1 << 32) - 1


def vector(case, name, description, inp, expected):
    VECTORS.append(dict(name=name, description=description, case=case, rules="v2", input=inp, expected=expected))


# --- the read letter ------------------------------------------------------------------------------


def head_ok(h):
    oid, bl, salt = h
    return len(oid) in (20, 32) and oid != bytes(len(oid)) and blind(salt, oid) == bl


def read_well_formed(r):
    docs = all(1 <= d[1] <= MAX_INT for d in r["docs"]) and all(
        (r["docs"][i][0], r["docs"][i][1]) < (r["docs"][i + 1][0], r["docs"][i + 1][1]) for i in range(len(r["docs"]) - 1))
    packs = all(r["packs"][i][0] < r["packs"][i + 1][0] for i in range(len(r["packs"]) - 1))
    kind, val = r["target"]
    target = (kind == "branch" and len(val) == 32) or (kind in ("pr", "issue") and 1 <= val <= U32_MAX)
    return docs and packs and target and all(head_ok(h) for h in r["heads"]) and 0 <= r["asOf"] <= MAX_INT


def target_value(t):
    kind, val = t
    return {kind: H(val) if kind == "branch" else val}


def read_to_typed(r):
    """r: job, asOf, target = (kind, number | hash), docs = [(id, revision, key)], packs = [(hash, key)],
    heads = [(oid, blind, salt)] (bytes values)."""
    assert read_well_formed(r)
    cnk = H(check_name_key(r["heads"][0][2])) if r["heads"] else None
    return dict(type="read", v=1, fields=dict(
        asOf=r["asOf"], checkNameKey=cnk, docs=[[H(i), rev, H(k)] for i, rev, k in r["docs"]],
        heads=[[H(bl), H(oid), H(salt)] for oid, bl, salt in r["heads"]], job=H(r["job"]),
        packs=[[H(h), H(k)] for h, k in r["packs"]], target=target_value(r["target"])))


def read_json(r):
    return dict(job=H(r["job"]), asOf=r["asOf"], target=target_value(r["target"]),
                docs=[dict(id=H(i), revision=rev, key=H(k)) for i, rev, k in r["docs"]],
                packs=[dict(packHash=H(h), key=H(k)) for h, k in r["packs"]],
                heads=[dict(blind=H(bl), oid=H(oid), salt=H(salt)) for oid, bl, salt in r["heads"]])


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def read_from_typed(t):
    """The read letter of typed letter `t` as JSON (what the harnesses compare), or None."""
    f = t["fields"]
    if t["type"] != "read" or t["v"] != 1 or sorted(f) != list(READ_FIELDS):
        return None
    docs, packs, heads = [], [], []
    if not all(isinstance(f[k], list) for k in ("docs", "packs", "heads")):
        return None
    for d in f["docs"]:
        if not isinstance(d, list) or len(d) != 3 or not is_int(d[1]):
            return None
        i, k = hex_exact(d[0], 32), hex_exact(d[2], 32)
        if i is None or k is None or d[1] < 0:
            return None
        docs.append((i, d[1], k))
    for p in f["packs"]:
        if not isinstance(p, list) or len(p) != 2:
            return None
        h, k = hex_exact(p[0], 32), hex_exact(p[1], 32)
        if h is None or k is None:
            return None
        packs.append((h, k))
    for h in f["heads"]:
        if not isinstance(h, list) or len(h) != 3 or not isinstance(h[1], str):
            return None
        oid = hex_exact(h[1], len(h[1]) // 2)
        bl = hex_exact(h[0], len(oid)) if oid is not None else None
        salt = hex_exact(h[2], 32)
        if None in (oid, bl, salt):
            return None
        heads.append((oid, bl, salt))
    tg = f["target"]
    if not isinstance(tg, dict) or len(tg) != 1:
        return None
    (kind, val), = tg.items()
    if kind == "branch":
        val = hex_exact(val, 32)
        if val is None:
            return None
    elif kind in ("pr", "issue"):
        if not is_int(val) or not 0 <= val <= U32_MAX:
            return None
    else:
        return None
    job = hex_exact(f["job"], 32)
    if job is None or not is_int(f["asOf"]) or f["asOf"] < 0:
        return None
    r = dict(job=job, asOf=f["asOf"], target=(kind, val), docs=docs, packs=packs, heads=heads)
    if not read_well_formed(r):
        return None
    cnk = f["checkNameKey"]
    if heads:
        if hex_exact(cnk, 32) != check_name_key(heads[0][2]):
            return None
    elif cnk is not None:
        return None
    return read_json(r)


def sample_read(target=("pr", 42), heads=1, docs=3, packs=1):
    salt = sha256(b"dash-forge vectors: read letter salt")
    oid = sha256(b"dash-forge vectors: read letter head")[:20]
    ds = sorted((sha256(b"dash-forge vectors: read letter doc %d" % (i // 2)), 1 + i % 2,
                 sha256(b"dash-forge vectors: read letter kObj %d" % i)) for i in range(docs))
    ps = sorted((sha256(b"dash-forge vectors: read letter pack %d" % i), sha256(b"dash-forge vectors: read letter key %d" % i))
                for i in range(packs))
    hs = [(oid, blind(salt, oid), salt)] * heads
    return dict(job=sha256(b"dash-forge vectors: read letter job"), asOf=1767225600000, target=target, docs=ds,
                packs=ps, heads=hs)


def read_format_vectors():
    for name, r, desc in [
        ("read_format_pr", sample_read(), "a `read` letter for pull request #42: three document revisions (one "
         "document at revisions 1 and 2), one members-only pack, the head with its check-name key."),
        ("read_format_issue", sample_read(("issue", 7), heads=0, docs=1, packs=0), "a `read` letter for issue #7 with "
         "no code: no pack, no head, checkNameKey null."),
        ("read_format_branch", sample_read(("branch", sha256(b"dash-forge vectors: read letter branch")), docs=0),
         "a `read` letter for a members-only branch (its refNameHash): packs and the head, no document."),
    ]:
        t = read_to_typed(r)
        pt = encode(t)
        assert decode(pt) == t and read_from_typed(t) == read_json(r)
        vector("key_letter", name, desc, dict(op="readFormat", read=read_json(r)), dict(letter=t, plaintextHex=H(pt)))


def read_decode_vectors():
    t = read_to_typed(sample_read())
    f = t["fields"]

    def with_fields(**kw):
        g = dict(f)
        for k, v in kw.items():
            if v is None:
                g.pop(k, None)
            else:
                g[k] = v
        return pad(json.dumps(dict(g, type="read", v=1), sort_keys=True, separators=(",", ":")).encode())

    other_salt = sha256(b"another salt")
    cases = [
        ("read_ok", encode(t)),
        ("read_v2", with_fields().replace(b'"v":1', b'"v":2')),
        ("read_extra_field", with_fields(extra="x")),
        ("read_missing_field", with_fields(job=None)),
        ("read_docs_unsorted", with_fields(docs=list(reversed(f["docs"])))),
        ("read_docs_repeated", with_fields(docs=[f["docs"][0], f["docs"][0]])),
        ("read_doc_revision_zero", with_fields(docs=[[f["docs"][0][0], 0, f["docs"][0][2]]])),
        ("read_doc_revision_string", with_fields(docs=[[f["docs"][0][0], "1", f["docs"][0][2]]])),
        ("read_packs_unsorted", pad(json.dumps(dict(f, packs=[f["packs"][0], [H(bytes(32)), H(bytes(32))]], type="read",
                                                     v=1), sort_keys=True, separators=(",", ":")).encode())),
        ("read_head_blind_mismatch", with_fields(heads=[[H(blind(other_salt, bytes.fromhex(f["heads"][0][1]))),
                                                        f["heads"][0][1], f["heads"][0][2]]],
                                                 checkNameKey=f["checkNameKey"])),
        ("read_check_name_key_wrong", with_fields(checkNameKey=H(check_name_key(other_salt)))),
        ("read_check_name_key_null_with_head", pad(json.dumps(dict(f, checkNameKey=None, type="read", v=1),
                                                              sort_keys=True, separators=(",", ":")).encode())),
        ("read_check_name_key_without_head", with_fields(heads=[])),
        ("read_target_two_keys", with_fields(target={"issue": 1, "pr": 1})),
        ("read_target_zero", with_fields(target={"pr": 0})),
        ("read_target_past_u32", with_fields(target={"issue": U32_MAX + 1})),
        ("read_target_unknown", with_fields(target={"discussion": 1})),
        ("read_target_branch_uppercase", with_fields(target={"branch": H(sha256(b"a branch")).upper()})),
        ("read_job_short", with_fields(job="ab" * 31)),
    ]
    results = []
    for name, pt in cases:
        letter = decode(pt)
        r = dict(name=name)
        if letter is None:
            r["error"] = "malformed"
        else:
            r["letter"] = letter
            r["read"] = read_from_typed(letter)
        results.append(r)
    good = {r["name"] for r in results if r.get("read")}
    assert good == {"read_ok"}, good
    vector("key_letter", "read_decode", "a `read` letter v 1 reads only with its seven fields: documents sorted by "
           "(id, revision) and each once with revisions >= 1, packs sorted and each once, every head a blind that "
           "checks, checkNameKey the first head's (null exactly when there is no head), a target with one key "
           "(pr or issue 1..2^32-1, or a branch's lowercase hex hash), a 32-byte job.",
           dict(op="readDecode", cases=[dict(name=n, plaintextHex=H(pt)) for n, pt in cases]), dict(results=results))


def opened(fields_or_status):
    if isinstance(fields_or_status, dict):
        return dict(status="readable", fields=fields_or_status)
    if fields_or_status == "malformed":
        return dict(status="malformed")
    return dict(status="unreadable", reason=fields_or_status)


def tlv_fields(doc_type, pt):
    """The reference TLV reader for the fields these vectors carry (title 1, body 2, base 4, source 5, value 15),
    padding (64) skipped."""
    names = {1: "title", 2: "body", 4: "baseRefName", 5: "sourceRefName", 15: "eventValue"}
    raw = {24: "headOid", 27: "oidSalt"}  # a members-only PR's real head and its salt (§19), hex
    out, i = {}, 0
    while i < len(pt):
        tag, n = pt[i], int.from_bytes(pt[i + 1:i + 3], "big")
        v = pt[i + 3:i + 3 + n]
        i += 3 + n
        if tag in names:
            out[names[tag]] = v.decode()
        elif tag in raw:
            out[raw[tag]] = H(v)
    return out


def open_with_key(doc, enc, k_obj):
    nonce, C, ct = enc[1:13], enc[13:45], enc[45:]
    kd, C2 = gen.obj_keys(k_obj)
    if C2 != C:
        return opened("commitMismatch")
    A = ad(doc, K0, V3)
    try:
        pt = gen.AESGCM(kd).decrypt(nonce, ct, A + C)
    except Exception:
        return opened("badTag")
    f = tlv_fields(doc["type"], pt)
    if doc["type"] == "patch":
        for hk, nk in (("baseRefNameHash", "baseRefName"), ("sourceRefNameHash", "sourceRefName")):
            if hk in doc and nk in f and H(sha256(f[nk].encode())) != doc[hk]:
                del f[nk]
    return opened(f)


def read_open_doc_vectors():
    patch = dict(type="patch", vis="public", ownerId=H(ownerId), epoch=0, number=42,
                 baseRefNameHash=H(sha256(b"refs/heads/main")),
                 sourceRefNameHash=H(ref_hash(K0, 0, "refs/heads/fix-auth")))
    comment = dict(type="comment", vis="public", ownerId=H(ownerId), epoch=0, targetId="42" * 32)
    event = dict(type="event", vis="public", ownerId=H(ownerId), epoch=0, targetId="42" * 32)
    docs = [
        ("patch", patch, tlv((1, b"Fix the auth bypass"), (2, b"Members-only until the release."),
                            (4, b"refs/heads/main"), (5, b"refs/heads/fix-auth"))),
        ("patch_members_branch", dict(patch, number=43), tlv(
            (1, b"Fix the auth bypass"), (2, b"From a members-only branch."), (4, b"refs/heads/main"),
            (5, b"refs/heads/fix-auth"), (24, sha256(b"dash-forge vectors: read head")[:20]),
            (27, sha256(b"dash-forge vectors: read salt")))),
        ("comment", comment, tlv((2, b"The token is logged in auth.rs"))),
        ("event", event, tlv((15, b"fix the failing test"))),
    ]
    rows = []
    for i, (label, doc, records) in enumerate(docs):
        nonce = sha256(b"dash-forge vectors: read nonce %d" % i)[:12]
        _, ko, _, _, enc = seal_members(doc, K0, records, nonce=nonce)
        assert ko == k_obj_members(K0, 0, nonce, ad(doc, K0, V3))
        rows.append(dict(name=label, header=doc, encHex=H(enc), result=dict(objKey=H(ko), opened=open_with_key(doc, enc, ko))))
    wrong = sha256(b"dash-forge vectors: read wrong key")
    p = rows[0]
    assert p["result"]["opened"]["fields"] == {"title": "Fix the auth bypass", "body": "Members-only until the release.",
                                                "baseRefName": "refs/heads/main"}
    assert rows[1]["result"]["opened"]["fields"]["headOid"] == H(sha256(b"dash-forge vectors: read head")[:20])
    wrong_open = open_with_key(docs[2][1], bytes.fromhex(rows[2]["encHex"]), wrong)
    assert wrong_open == opened("commitMismatch")
    vector("key_letter", "read_open_doc", "what a bot reads with a `read` letter: each members-only document (a pull "
           "request's own text, a comment, a member event's value) opens with its per-object key K_obj alone, which "
           "a member derives under the epoch key and checks against the commitment; the pull request's base branch "
           "(hashed as its plain SHA-256) is kept and its members-only source branch (hashed under the epoch key, "
           "which the bot does not hold) is dropped; a PR from a members-only branch also carries its real head "
           "and that head's salt (TLV 24, 27), read as members read them. Another key fails the commitment before GCM.",
           dict(op="readOpenDoc", repoId=H(repoId), epoch=0, epochKey=H(K0),
                docs=[dict(name=r["name"], header=r["header"], encHex=r["encHex"]) for r in rows], wrongKey=H(wrong)),
           dict(results=[dict(name=r["name"], **r["result"]) for r in rows], wrongKey=wrong_open))


def read_vectors():
    read_format_vectors()
    read_decode_vectors()
    read_open_doc_vectors()


# --- access notices --------------------------------------------------------------------------------


def text_ok(s, n, newline):
    return isinstance(s, str) and len(s) <= n and not any(
        unicodedata.category(c) == "Cc" and not (newline and c == "\n") for c in s)


def notice_well_formed(n):
    may = all(isinstance(m, str) and 1 <= len(m) <= 40 and m.isascii() and m.isalnum() for m in n["may"]) and all(
        n["may"][i] < n["may"][i + 1] for i in range(len(n["may"]) - 1))
    th = n["threads"]
    threads = th == "all" or (isinstance(th, list) and 1 <= len(th) <= 100 and all(is_int(x) for x in th)
                              and th[0] >= 1 and all(th[i] < th[i + 1] for i in range(len(th) - 1))
                              and th[-1] <= U32_MAX)
    proc = n["processor"]
    processor = proc is None or (text_ok(proc, 100, False) and proc.strip() != "")
    rv = n["revokes"]
    revokes = len(rv) <= 64 and all(rv[i] < rv[i + 1] for i in range(len(rv) - 1))
    until = n["until"] is None or (is_int(n["until"]) and 0 <= n["until"] <= MAX_INT)
    return may and threads and processor and revokes and text_ok(n["note"], 500, True) and until


def notice_to_typed(n):
    """n: bot (bytes), may, askers, threads ("all" | [n]), processor, until, revokes ([bytes]), note, extra."""
    assert notice_well_formed(n) and not set(n.get("extra", {})) & set(NOTICE_FIELDS)
    fields = dict(n.get("extra", {}), askers=n["askers"], bot=H(n["bot"]), may=list(n["may"]), note=n["note"],
                  processor=n["processor"], revokes=[H(h) for h in n["revokes"]], threads=n["threads"],
                  until=n["until"])
    return dict(type="accessNotice", v=1, fields=fields)


def notice_json(n):
    return dict(bot=H(n["bot"]), may=list(n["may"]), askers=n["askers"], threads=n["threads"],
                processor=n["processor"], until=n["until"], revokes=[H(h) for h in n["revokes"]], note=n["note"],
                extra=dict(n.get("extra", {})))


def notice_from_typed(t):
    f = t["fields"]
    if t["type"] != "accessNotice" or t["v"] != 1 or not all(k in f for k in NOTICE_FIELDS):
        return None
    bot = hex_exact(f["bot"], 32)
    if bot is None or f["askers"] not in ("writers", "maintainers") or not isinstance(f["may"], list):
        return None
    if not all(isinstance(m, str) for m in f["may"]):
        return None
    th = f["threads"]
    if not (th == "all" or (isinstance(th, list) and all(is_int(x) and 0 <= x <= U32_MAX for x in th))):
        return None
    if not (f["processor"] is None or isinstance(f["processor"], str)) or not isinstance(f["note"], str):
        return None
    if not isinstance(f["revokes"], list):
        return None
    rv = [hex_exact(h, 32) for h in f["revokes"]]
    if None in rv:
        return None
    if not (f["until"] is None or is_int(f["until"])):
        return None
    n = dict(bot=bot, may=f["may"], askers=f["askers"], threads=th, processor=f["processor"], until=f["until"],
             revokes=rv, note=f["note"], extra={k: v for k, v in f.items() if k not in NOTICE_FIELDS})
    return notice_json(n) if notice_well_formed(n) else None


BOT = sha256(b"dash-forge vectors: ci-bot")


def sample_notice(**kw):
    n = dict(bot=BOT, may=["post", "postMembersOnly", "readOnRequest"], askers="writers", threads="all",
             processor="Example AI", until=1767225600000, revokes=[], note="Reviews pull requests when asked.")
    n.update(kw)
    return n


def notice_vectors():
    for name, n, desc in [
        ("format", sample_notice(), "a notice letting @ci-bot post, post members-only replies and read what it is "
         "asked about, asked by writers, on every thread, processed by one service, until a date."),
        ("format_listed", sample_notice(may=["ciMembersBranches", "post"], askers="maintainers", threads=[42, 57],
                                        processor=None, until=None, revokes=[sha256(b"an earlier notice")],
                                        note="line one\nline two é"),
         "a notice for two threads, asked by maintainers, no AI service, no end, replacing an earlier notice; the "
         "note keeps its newline (escaped \\n) and raw UTF-8."),
        ("format_revoked", sample_notice(may=[], processor=None, note="", revokes=[sha256(b"an earlier notice")]),
         "`dg bot revoke`: a newer notice allowing nothing."),
        ("format_later_fields", sample_notice(may=["post", "push"], extra={"push": [], "pushPolicy": {"fastForwardOnly": True}}),
         "fields and abilities of a later version (phase 4E's push) are kept, so the bytes re-encode, and grant "
         "nothing here."),
    ]:
        t = notice_to_typed(n)
        pt = encode(t)
        assert decode(pt) == t and notice_from_typed(t) == notice_json(n)
        vector("access_notice", name, desc, dict(op="noticeFormat", notice=notice_json(n)),
               dict(letter=t, plaintextHex=H(pt)))

    t = notice_to_typed(sample_notice())
    f = t["fields"]

    def with_fields(**kw):
        g = dict(f)
        for k, v in kw.items():
            if v is None:
                g.pop(k, None)
            else:
                g[k] = v
        return pad(json.dumps(dict(g, type="accessNotice", v=1), sort_keys=True, separators=(",", ":"),
                              ensure_ascii=False).encode())

    cases = [
        ("ok", encode(t)),
        ("v2", with_fields().replace(b'"v":1', b'"v":2')),
        ("missing_field", with_fields(note=None)),
        ("may_unsorted", with_fields(may=["readOnRequest", "post"])),
        ("may_repeated", with_fields(may=["post", "post"])),
        ("may_not_alphanumeric", with_fields(may=["post-it"])),
        ("askers_unknown", with_fields(askers="triage")),
        ("threads_empty", with_fields(threads=[])),
        ("threads_zero", with_fields(threads=[0, 1])),
        ("threads_unsorted", with_fields(threads=[57, 42])),
        ("threads_word", with_fields(threads="some")),
        ("processor_blank", with_fields(processor="  ")),
        ("processor_long", with_fields(processor="p" * 101)),
        ("processor_control", with_fields(processor="a\tb")),
        ("note_long", with_fields(note="n" * 501)),
        ("note_control", with_fields(note="a\u0007b")),
        ("note_newline", with_fields(note="a\nb")),
        ("until_string", with_fields(until="soon")),
        ("revokes_unsorted", with_fields(revokes=[H(b"\x02" * 32), H(b"\x01" * 32)])),
        ("bot_uppercase", with_fields(bot=H(BOT).upper())),
        ("not_canonical", pad(b'{"type":"accessNotice", "v":1}')),
        ("wrong_type", pad(json.dumps(dict(f, type="read", v=1), sort_keys=True, separators=(",", ":"),
                                      ensure_ascii=False).encode())),
    ]
    results = []
    for name, pt in cases:
        letter = decode(pt)
        r = dict(name=name)
        if letter is None:
            r["error"] = "malformed"
        else:
            r["notice"] = notice_from_typed(letter)
        results.append(r)
    good = {r["name"] for r in results if r.get("notice")}
    assert good == {"ok", "note_newline"}, good
    vector("access_notice", "decode", "a notice reads only in the exact canonical form with every field of v 1: may "
           "sorted, each once, ASCII letters and digits; askers writers or maintainers; threads \"all\" or 1..100 "
           "sorted distinct numbers >= 1; a processor that is not blank, at most 100 characters, no control character; "
           "a note of at most 500 characters with no control character but a newline; until null or an integer; "
           "revokes sorted; a lowercase bot id.",
           dict(op="noticeDecode", cases=[dict(name=n, plaintextHex=H(pt)) for n, pt in cases]), dict(results=results))

    def entry(i, writer, at, may):
        return dict(id="m%d" % i, writer=writer, createdAt=at, notice=notice_json(sample_notice(may=may)))

    entries = [entry(1, "alice", 100, ["post"]), entry(2, "bob", 200, ["post", "readOnRequest"]),
               entry(3, "mallory", 300, []), entry(4, "carol", 200, ["post"])]
    maintainers = ["alice", "bob", "carol"]
    # ties at the same $createdAt: the larger manifest id wins
    vector("access_notice", "current", "the notice that counts for a bot is the newest (by $createdAt, then manifest "
           "id) from a current maintainer or the owner; a notice from anyone else (here a removed maintainer's newer "
           "one) is ignored.", dict(op="noticeCurrent", entries=entries, maintainers=maintainers),
           dict(current={H(BOT): "m4"}))

    asks = []
    n_all = notice_json(sample_notice())
    n_listed = notice_json(sample_notice(may=["post"], askers="maintainers", threads=[42], until=None))
    n_revoked = notice_json(sample_notice(may=[]))
    for name, notice, role, number, members_only, now, want in [
        ("writer_ok", n_all, "writer", 42, True, 1000, None),
        ("no_notice", None, "writer", 42, False, 1000, dict(why="noAccess")),
        ("revoked", n_revoked, "maintainer", 42, False, 1000, dict(why="noAccess")),
        ("ended", n_all, "writer", 42, False, 1767225600000, dict(why="ended", until=1767225600000)),
        ("triage", n_all, "triage", 42, False, 1000, dict(why="askers", askers="writers", role="triage")),
        ("reader", n_all, "reader", 42, False, 1000, dict(why="askers", askers="writers", role="reader")),
        ("outsider", n_all, None, 42, False, 1000, dict(why="askers", askers="writers", role=None)),
        ("writer_maintainers_only", n_listed, "writer", 42, False, 1000,
         dict(why="askers", askers="maintainers", role="writer")),
        ("thread_not_listed", n_listed, "maintainer", 7, False, 1000, dict(why="thread", number=7)),
        ("members_only_no_read", n_listed, "maintainer", 42, True, 1000, dict(why="noRead")),
        ("public_thread_post_only", n_listed, "maintainer", 42, False, 1000, None),
    ]:
        asks.append(dict(name=name, notice=notice, role=role, number=number, membersOnly=members_only, now=now,
                         refusal=want))
    vector("access_notice", "ask", "before signing a request (event kind 27) a client checks the bot's current "
           "notice, in this order: there is one and it allows something (else noAccess), it has not ended, the "
           "asker's role is among its askers (writers: Write, Maintain or the owner; maintainers: Maintain or the "
           "owner), it covers the thread, and on a members-only thread it lets the bot read on request. Each "
           "refusal is E813, before anything is signed.",
           dict(op="ask", cases=[{k: v for k, v in a.items() if k != "refusal"} for a in asks]),
           dict(results=[dict(name=a["name"], refusal=a["refusal"]) for a in asks]))


def build():
    read_vectors()
    notice_vectors()


def write_vectors(out_dir):
    build()
    for pattern in ("key_letter__read_*.json", "access_notice__*.json"):
        for old in glob.glob(os.path.join(out_dir, pattern)):
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

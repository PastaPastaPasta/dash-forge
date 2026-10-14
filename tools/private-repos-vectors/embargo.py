"""Independent Python reference for publication dates (event kind 28; mixed-visibility design §4.7
"Embargo"; docs/contracts/forge-v2.md §3.5).

    python3 tools/private-repos-vectors/embargo.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/embargo.py --write-vectors  # (re)write the vector files below

Cases it writes (forge-contracts/vectors/embargo__<name>.json):

- `embargo_value`: the value's one canonical JSON form. `parse` reads stored strings (anything that is not
  exactly its own canonical encoding is no value); `encode` writes plans, cancellations and completions, or
  refuses them before signing (a malformed plan, a value over 120 characters).
- `embargo`: kind-28 events of a repository read as records (or not), whether each counts (the owner, or a
  maintainer or role-1 writer at its `$createdAt`), each target's embargo from the counted records (the
  newest schedule, ended by a newer cancellation or completion), whether it is due at `now`, and its
  checklist from what a client knows (`facts`).

The Rust (`forge-core` `rules::embargo`) and TypeScript (`forge-web/lib/rules/embargo.ts`) harnesses run
every file and must reproduce it exactly.
"""
import glob
import json
import os
import sys

CASE_VALUE, CASE = "embargo_value", "embargo"
KIND = 28
VALUE_MAX = (120, 480)
VECTORS = []


def vector(case, name, description, inp, expected):
    VECTORS.append({"name": name, "description": description, "case": case, "rules": "v2", "input": inp,
                    "expected": expected})


# --- names ---------------------------------------------------------------------------------------

def legal_ref(name):
    if len(name.encode()) > 255 or not name.startswith("refs/") or name.endswith(".lock"):
        return False
    path = name[len("refs/"):]
    if not path or ".." in path or "@{" in path or path.endswith("."):
        return False
    if any(ord(c) <= 0x20 or ord(c) == 0x7f or c in "~^:?*[\\" for c in path):
        return False
    return all(c and not c.startswith(".") for c in path.split("/"))


def branch_name(n):
    return not n.startswith("refs/") and legal_ref("refs/heads/" + n)


def tag_name(n):
    return not n.startswith("refs/") and legal_ref("refs/tags/" + n)


def commit(h):
    return len(h) in (40, 64) and all(c in "0123456789abcdef" for c in h)


# --- values --------------------------------------------------------------------------------------

AT_MAX = 2 ** 53 - 1


def plan_problem(p):
    if p.get("at", 0) == 0:
        return "no date"
    if p["at"] > AT_MAX:
        return "out of range"
    pr, b, o = p.get("pr"), p.get("branch"), p.get("onto")
    if pr is not None:
        if pr == 0:
            return "pr 0"
        if b is not None or o is not None:
            return "pr and branch"
    elif b is None:
        return "nothing to publish"
    elif o is None:
        return "no base"
    elif not branch_name(b) or not branch_name(o) or b == o:
        return "bad branch"
    if p.get("tag") is not None and not tag_name(p["tag"]):
        return "bad tag"
    m = p.get("message")
    if m is not None and (all(c in " \n" for c in m) or any(ord(c) < 0x20 and c != "\n" or 0x7f <= ord(c) <= 0x9f for c in m)):
        return "bad message"
    return None


def wire(value):
    if value["type"] == "schedule":
        p = value
        w = {"v": 1, "at": p["at"]}
        for key, short in (("pr", "pr"), ("branch", "b"), ("onto", "o"), ("tag", "t"), ("message", "m")):
            if p.get(key) is not None:
                w[short] = p[key]
        return w
    if value["type"] == "cancel":
        return {"v": 1, "cancel": True}
    return {"v": 1, "done": value["commit"]}


def encode(value):
    if value["type"] == "schedule" and plan_problem(value):
        return None
    if value["type"] == "done" and not commit(value["commit"]):
        return None
    s = json.dumps(wire(value), separators=(",", ":"), ensure_ascii=False)
    try:
        size = len(s.encode())
    except UnicodeEncodeError:  # a lone surrogate: not text any stack can store
        return None
    if len(s) > VALUE_MAX[0] or size > VALUE_MAX[1]:
        return None
    return s


def u32(n):
    return isinstance(n, int) and not isinstance(n, bool) and 0 <= n < 2 ** 32


def u64(n):
    return isinstance(n, int) and not isinstance(n, bool) and 0 <= n < 2 ** 64


class Pairs(list):
    """A JSON object's key-value pairs as written (duplicates kept)."""


def parse(text):
    try:
        w = json.loads(text, object_pairs_hook=Pairs)
    except ValueError:
        return None
    if not isinstance(w, Pairs):
        return None
    keys = [k for k, _ in w]
    if len(keys) != len(set(keys)):
        return None
    w = dict(w)
    allowed = {"v", "at", "pr", "b", "o", "t", "m", "cancel", "done"}
    if set(w) - allowed or w.get("v") != 1 or isinstance(w.get("v"), bool):
        return None
    for k in ("b", "o", "t", "m", "done"):
        if k in w and not isinstance(w[k], str):
            return None
    if "at" in w and not u64(w["at"]):
        return None
    if "pr" in w and not u32(w["pr"]):
        return None
    if "cancel" in w and not isinstance(w["cancel"], bool):
        return None
    plan_keys = {"pr", "b", "o", "t", "m"}
    if "at" in w and "cancel" not in w and "done" not in w:
        v = {"type": "schedule", "at": w["at"]}
        for short, key in (("pr", "pr"), ("b", "branch"), ("o", "onto"), ("t", "tag"), ("m", "message")):
            if short in w:
                v[key] = w[short]
    elif w.get("cancel") is True and "at" not in w and "done" not in w and not plan_keys & set(w):
        v = {"type": "cancel"}
    elif "done" in w and "at" not in w and "cancel" not in w and not plan_keys & set(w):
        v = {"type": "done", "commit": w["done"]}
    else:
        return None
    return v if encode(v) == text else None


# --- records and embargoes -----------------------------------------------------------------------

ROLE_RANK = {"maintainer": 0, "writer": 1, "triage": 2, "reader": 3, "bot": 4}


def approver_at(memberships, identity, at):
    best = None
    for m in memberships:
        if m["identity"] == identity and m["createdAt"] <= at:
            r = ROLE_RANK[m["role"]]
            best = r if best is None else min(best, r)
    return best is not None and best <= 1


def record(repo_id, e):
    if e["kind"] != KIND or e["repoId"] != repo_id or e.get("refId") != repo_id:
        return None
    n = e["targetNumber"]
    if not (0 < n < 2 ** 32) or e.get("value") is None:
        return None
    value = parse(e["value"])
    if value is None:
        return None
    return {"id": e["id"], "targetId": e["targetId"], "number": n, "value": value, "actor": e["actor"],
            "createdAt": e["createdAt"]}


def plan_of(value):
    return {k: v for k, v in value.items() if k != "type"}


def embargo_of(target_id, records):
    mine = sorted((r for r in records if r["targetId"] == target_id), key=lambda r: (r["createdAt"], r["id"]))
    idx = [i for i, r in enumerate(mine) if r["value"]["type"] == "schedule"]
    if not idx:
        return None
    i = idx[-1]
    s = mine[i]
    state = {"state": "scheduled"}
    for r in mine[i + 1:]:
        t = r["value"]["type"]
        if t == "cancel":
            state = {"state": "cancelled", "by": r["actor"], "at": r["createdAt"]}
            break
        if t == "done":
            state = {"state": "done", "commit": r["value"]["commit"], "by": r["actor"], "at": r["createdAt"]}
            break
    return {"targetId": s["targetId"], "number": s["number"], "plan": plan_of(s["value"]), "setBy": s["actor"],
            "setAt": s["createdAt"], "id": s["id"], "state": state}


def checklist(e, is_issue, facts):
    complete = e["state"]["state"] == "done"

    def item(step, fact):
        return dict(step, done=complete or facts.get(fact) is True)
    out = []
    if is_issue:
        out.append(item({"step": "makePublic", "issue": e["number"]}, "issuePublic"))
    out.append(item({"step": "publish"}, "published"))
    if e["plan"].get("tag") is not None:
        out.append(item({"step": "tag", "tag": e["plan"]["tag"]}, "tagged"))
        out.append(item({"step": "release", "tag": e["plan"]["tag"]}, "released"))
    return out


def judge(inp):
    rows, counted = [], []
    for e in inp["events"]:
        r = record(inp["repoId"], e)
        counts = None if r is None else (r["actor"] == inp["owner"] or approver_at(inp["memberships"], r["actor"],
                                                                                    r["createdAt"]))
        rows.append({"record": r, "counts": counts})
        if counts:
            counted.append(r)
    targets = []
    for t in inp["targets"]:
        e = embargo_of(t["targetId"], counted)
        targets.append({
            "embargo": e,
            "due": e is not None and e["state"]["state"] == "scheduled" and inp["now"] >= e["plan"]["at"],
            "checklist": None if e is None else checklist(e, t["isIssue"], t.get("facts", {})),
        })
    return {"records": rows, "targets": targets}


# --- the vectors ---------------------------------------------------------------------------------

REPO = "Repo111111111111111111111111111111111111111"
AT = 1792504800  # 2026-10-20 14:00 UTC
C40 = "ab" * 20
C64 = "cd" * 32


def schedule(**p):
    return {"type": "schedule", "at": AT, **p}


def value_vectors():
    good = [
        schedule(branch="sec/cve-77", onto="main", tag="v1.2.3"),
        schedule(pr=4),
        schedule(pr=4, tag="v2.0.0-rc.1", message="Fix the bounds check (#12)"),
        schedule(branch="fix", onto="release/1.x", message="Fix\n\nSee the advisory."),
        schedule(branch="sec/ü", onto="main", message="Ünïcode is fine"),
        schedule(pr=4, message="\ufeff"),
        schedule(pr=4, at=2 ** 53 - 1),
        {"type": "cancel"},
        {"type": "done", "commit": C40},
        {"type": "done", "commit": C64},
    ]
    texts = [encode(v) for v in good]
    assert all(texts), texts
    vector(CASE_VALUE, "canonical_round_trip",
           "Each value's one canonical form (keys v, at, pr, b, o, t, m; or cancel; or done; no spaces; "
           "JSON's shortest escapes, non-ASCII kept) parses back to the same value. A message of one U+FEFF is "
           "not blank (blank is only spaces and line feeds); the latest date is 2^53 - 1.",
           {"parse": texts, "encode": good}, {"parse": good, "encode": texts})
    bad_texts = [
        '{"v":1, "cancel":true}',
        '{"cancel":true,"v":1}',
        '{"v":1,"cancel":true,"cancel":true}',
        '{"v":1,"at":1792504800,"at":1792504800,"pr":4}',
        '{"v":1,"cancel":true,"x":1}',
        '{"v":2,"cancel":true}',
        '{"v":true,"cancel":true}',
        '{"v":1,"cancel":false}',
        '{"v":1,"cancel":true,"t":"v1"}',
        '{"v":1,"at":1792504800}',
        '{"v":1,"at":1792504800,"pr":4,"b":"x","o":"main"}',
        '{"v":1,"at":1792504800,"b":"x"}',
        '{"v":1,"at":0,"pr":4}',
        '{"v":1,"at":1792504800.0,"pr":4}',
        '{"v":1,"at":"1792504800","pr":4}',
        '{"v":1,"at":1792504800,"pr":0}',
        '{"v":1,"at":1792504800,"b":"a..b","o":"main"}',
        '{"v":1,"at":1792504800,"b":"main","o":"main"}',
        '{"v":1,"at":1792504800,"pr":4,"t":"v 1"}',
        '{"v":1,"at":1792504800,"pr":4,"m":""}',
        '{"v":1,"at":1792504800,"pr":4,"m":"a\\u0007b"}',
        '{"v":1,"at":1792504800,"pr":4,"m":"\\u00e9"}',
        '{"v":1,"at":1792504800,"pr":4,"m":"\\ud800"}',
        '{"v":1,"at":9007199254740992,"pr":4}',
        '{"v":1,"done":"' + C40.upper() + '"}',
        '{"v":1,"done":"abc"}',
        '{"v":1,"done":"' + C40 + '","cancel":true}',
        '[1]',
        'not json',
        '',
    ]
    vector(CASE_VALUE, "not_canonical_is_no_value",
           "A value that is not exactly its own canonical encoding is no value: spacing, key order, duplicate keys, "
           "unknown keys, another version, a cancellation or completion carrying plan keys, a plan with neither or "
           "both of a pull request and a branch, numbers as floats or strings, illegal names, an empty message or "
           "one with control characters, an escape the canonical form does not use, a lone surrogate, a date past "
           "2^53 - 1, an upper-case commit.",
           {"parse": bad_texts, "encode": []}, {"parse": [None] * len(bad_texts), "encode": []})
    long_msg = "x" * 80
    refused = [
        schedule(branch="sec/cve-77", onto="main", tag="v1.2.3", message=long_msg),
        schedule(branch="b" * 100, onto="main"),
        schedule(at=0, pr=4) | {"at": 0},
        schedule(pr=4, branch="x", onto="main"),
        schedule(branch="x"),
        schedule(onto="main"),
        schedule(branch="x", onto="x"),
        schedule(branch="refs/heads/x", onto="main"),
        schedule(pr=4, tag="v1~1"),
        schedule(pr=4, message="  "),
        schedule(pr=4, message=" \n "),
        schedule(pr=4, at=2 ** 53),
        schedule(pr=4, message="tab\there"),
        {"type": "done", "commit": "ABAB" * 10},
    ]
    assert all(encode(v) is None for v in refused)
    vector(CASE_VALUE, "refused_before_signing",
           "Values refused before anything is signed: over 120 characters stored (a long message or branch name), "
           "no date, a pull request and a branch, a branch with no base or a base with no branch, a branch onto "
           "itself, a full ref name, an illegal tag, a message of only spaces and line feeds or one with a tab, "
           "a date past 2^53 - 1, an upper-case commit.",
           {"parse": [], "encode": refused}, {"parse": [], "encode": [None] * len(refused)})


def ev(id_, value, created_at, actor="maint", target="iss12", number=12, **over):
    e = {"id": id_, "repoId": REPO, "targetId": target, "targetNumber": number, "kind": KIND, "refId": REPO,
         "value": value, "actor": actor, "createdAt": created_at}
    e.update(over)
    return e


MEMBERS = [
    {"identity": "maint", "role": "maintainer", "createdAt": 10},
    {"identity": "wri", "role": "writer", "createdAt": 10},
    {"identity": "tri", "role": "triage", "createdAt": 10},
    {"identity": "rdr", "role": "reader", "createdAt": 10},
    {"identity": "late", "role": "writer", "createdAt": 500},
]


def embargo_vectors():
    s1 = encode(schedule(branch="sec/cve-77", onto="main", tag="v1.2.3"))
    s2 = encode(schedule(branch="sec/cve-77", onto="main", tag="v1.2.3") | {"at": AT + 3600})
    pr = encode(schedule(pr=13))
    cancel = encode({"type": "cancel"})
    done = encode({"type": "done", "commit": C40})

    def add(name, description, inp):
        vector(CASE, name, description, inp, judge(inp))

    add("records_and_counting",
        "Kind 28 with refId = the repository and a canonical value is a record. The owner, a maintainer and a "
        "role-1 writer count; triage, a reader, a stranger and a writer before their membership do not. Another "
        "kind, another repository's event, a missing refId, an unreadable (absent) value and target number 0 are no "
        "records.",
        {"repoId": REPO, "owner": "own", "memberships": MEMBERS, "now": AT - 10, "targets": [], "events": [
            ev("e1", s1, 100, actor="maint"),
            ev("e2", s1, 100, actor="wri"),
            ev("e3", s1, 100, actor="own"),
            ev("e4", s1, 100, actor="tri"),
            ev("e5", s1, 100, actor="rdr"),
            ev("e6", s1, 100, actor="stranger"),
            ev("e7", s1, 100, actor="late"),
            ev("e8", s1, 100, kind=26),
            ev("e9", s1, 100, repoId="Other11111111111111111111111111111111111111"),
            ev("e10", s1, 100, refId=None),
            ev("e11", None, 100),
            ev("e12", s1, 100, targetNumber=0),
        ]})
    add("newest_schedule_wins",
        "The newest counted schedule is the embargo (the date moved an hour later). A triage member's later "
        "schedule and cancellation do not count. Due only from its date on.",
        {"repoId": REPO, "owner": "own", "memberships": MEMBERS, "now": AT + 3600,
         "targets": [{"targetId": "iss12", "isIssue": True}], "events": [
             ev("a", s1, 100), ev("b", s2, 200, actor="wri"), ev("c", s1, 300, actor="tri"),
             ev("d", cancel, 400, actor="tri")]})
    add("not_due_before_its_date",
        "One second before the date it is waiting, not due.",
        {"repoId": REPO, "owner": "own", "memberships": MEMBERS, "now": AT - 1,
         "targets": [{"targetId": "iss12", "isIssue": True}], "events": [ev("a", s1, 100)]})
    add("cancelled_then_rescheduled",
        "A cancellation newer than the schedule ends it (never due); a schedule after the cancellation starts a "
        "new embargo. Records are ordered by $createdAt, then id.",
        {"repoId": REPO, "owner": "own", "memberships": MEMBERS, "now": AT + 10,
         "targets": [{"targetId": "iss12", "isIssue": True}, {"targetId": "iss14", "isIssue": True}], "events": [
             ev("b", s1, 100), ev("a", cancel, 200),
             ev("x", s1, 100, target="iss14", number=14), ev("y", cancel, 200, target="iss14", number=14),
             ev("z", s2, 300, target="iss14", number=14)]})
    add("ended_only_by_newer",
        "A cancellation or completion older than the schedule (or at the same time with a smaller id) does not "
        "end it; one written in the same millisecond with a larger id does.",
        {"repoId": REPO, "owner": "own", "memberships": MEMBERS, "now": AT,
         "targets": [{"targetId": "iss12", "isIssue": True}, {"targetId": "iss14", "isIssue": True}], "events": [
             ev("m", cancel, 50), ev("n", s1, 100), ev("a", done, 100),
             ev("p", s1, 100, target="iss14", number=14), ev("q", cancel, 100, target="iss14", number=14)]})
    add("done_ticks_every_step",
        "A completion closes the embargo with its commit and ticks every checklist step, whatever the facts say.",
        {"repoId": REPO, "owner": "own", "memberships": MEMBERS, "now": AT + 99,
         "targets": [{"targetId": "iss12", "isIssue": True, "facts": {"issuePublic": False}}],
         "events": [ev("a", s1, 100), ev("b", done, 900, actor="own")]})
    add("checklist_from_facts",
        "Waiting embargoes: the tracking issue's checklist is make public, publish, tag, release, each done as "
        "the facts say (unknown is not done); a pull request's has no make-public step, and no tag or release "
        "without a tag.",
        {"repoId": REPO, "owner": "own", "memberships": MEMBERS, "now": AT,
         "targets": [
             {"targetId": "iss12", "isIssue": True,
              "facts": {"issuePublic": True, "published": False, "tagged": None, "released": None}},
             {"targetId": "pr13", "isIssue": False, "facts": {"published": True}},
             {"targetId": "none", "isIssue": True}],
         "events": [ev("a", s1, 100), ev("b", pr, 100, target="pr13", number=13)]})


def main():
    value_vectors()
    embargo_vectors()
    # the reference agrees with itself on a round trip of every good value
    for v in VECTORS:
        if v["case"] == CASE_VALUE:
            for value, text in zip(v["input"]["encode"], v["expected"]["encode"]):
                if text is not None:
                    assert parse(text) == value, (value, text)
    if "--write-vectors" in sys.argv:
        out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "forge-contracts", "vectors")
        for old in glob.glob(os.path.join(out, "embargo__*.json")):
            os.remove(old)
        for v in VECTORS:
            with open(os.path.join(out, f"embargo__{v['name']}.json"), "w") as f:
                f.write(json.dumps(v, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"total": len(VECTORS)}))


if __name__ == "__main__":
    main()

"""Independent Python reference for bot push grants (mixed-visibility design §4.9 "Pushing", D42;
docs/security/private-repos.md §24): which grant a bot pushes under, the bounds a maintainer's client checks before
writing one, and how readers mark a bot's push.

    python3 tools/private-repos-vectors/push.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/push.py --write-vectors  # (re)write forge-contracts/vectors/bot_push__*.json

A grant (forge-core `pushGrant`, the mainnet contract only) is {id, granter, bot, prefix | scope, until, createdAt}:
exactly one of `prefix` (public refs starting with it) and `scope` (one members-only ref's name hash under the branch
key, hex). Ops:

* `grantUsable`: a grant can be pushed under now when the bot holds a Bot row written no later than the grant
  (else `notABot` / `olderThanBotRow`), its granter is a current maintainer (else `granterGone`) and now < until
  (else `expired`), checked in that order.
* `grantPick`: of the usable grants covering the target (a public name by prefix, a members-only hash by scope), the
  one that ends last, then the newest, then by id; else `notCovered`, or `unusable` with the newest covering grant's
  reason.
* `prefixOf`: a branch pattern as the prefix it grants (`bot/x/*` and `bot/x/` → `refs/heads/bot/x/`; `gh-pages` →
  `refs/heads/gh-pages`); refused: empty, outside refs/heads/, a glob other than one trailing `*`, malformed.
* `untilFor`: requested (or 30 days) ahead; refused when not after now or more than 90 days ahead; within 10 minutes
  of 90 days brought in to 90 days less 10 minutes.
* `pushMark`: `outside` when the grant named was written before the bot's current row (and the push landed after
  that row), or when the notice in force did not allow pushing; else `granted`.
* `refValid`: a bot's public update whose refNameHash is not sha256(refName) is dropped like anyone's (rules
  `is_update_valid`).
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from access import PUSH_EXTRA, notice_to_typed, sample_notice  # noqa: E402
from key_letters import encode  # noqa: E402

VECTORS = []
DAY = 86_400_000
MAX_TTL = 90 * DAY
DEFAULT_TTL = 30 * DAY
MARGIN = 10 * 60_000
BRANCHES = "refs/heads/"
PREFIX_MAX = 255
BOT = "4tJ7mVo5yJm4b6rKZ2SRsG6YqfJHFDLC2kUwD3nAhZ7b"


def vector(name, description, inp, expected):
    VECTORS.append(dict(name=name, description=description, case="bot_push", rules="v2", input=inp,
                        expected=expected))


def usable(g, ctx):
    row = ctx["botRowAt"]
    if row is None:
        return "notABot"
    if g["createdAt"] < row:
        return "olderThanBotRow"
    if g["granter"] not in ctx["maintainers"]:
        return "granterGone"
    if ctx["now"] >= g["until"]:
        return "expired"
    return None


def covers(g, target):
    if "public" in target:
        return g.get("prefix") is not None and g.get("scope") is None and target["public"].startswith(g["prefix"])
    return g.get("scope") is not None and g.get("prefix") is None and g["scope"].lower() == target["exact"].lower()


def pick(grants, target, ctx):
    covering = [g for g in grants if covers(g, target)]
    ok = [g for g in covering if usable(g, ctx) is None]
    if ok:
        best = max(ok, key=lambda g: (g["until"], g["createdAt"], g["id"]))
        return dict(grant=best["id"])
    if not covering:
        return dict(reason="notCovered")
    newest = max(covering, key=lambda g: (g["createdAt"], g["id"]))
    return dict(reason="unusable", why=usable(newest, ctx))


def prefix_of(pattern):
    p = pattern.strip()
    if p in ("", "*"):
        return dict(refused="empty")
    if p.startswith("refs/"):
        if not p.startswith(BRANCHES):
            return dict(refused="notABranch")
        full = p
    else:
        full = BRANCHES + p
    if full.endswith("*"):
        full = full[:-1]
    if any(c in full for c in "*?["):
        return dict(refused="notAPrefix")
    bad = any(ord(c) < 0x20 or ord(c) == 0x7f or c in " \\~^:" for c in full)
    if len(full.encode()) <= len(BRANCHES) or len(full.encode()) > PREFIX_MAX or ".." in full or "//" in full or bad:
        return dict(refused="malformed")
    return dict(prefix=full)


def until_for(now, requested):
    latest = now + MAX_TTL - MARGIN
    if requested is None:
        return dict(until=now + DEFAULT_TTL)
    if requested <= now:
        return dict(refused="past")
    if requested > now + MAX_TTL:
        return dict(refused="tooFar")
    return dict(until=min(requested, latest))


def mark(at, grant, bot_row_at, notice_allows):
    older = grant is not None and bot_row_at is not None and grant["createdAt"] < bot_row_at
    before_row = bot_row_at is not None and at < bot_row_at
    return "outside" if (older and not before_row) or notice_allows is False else "granted"


def notice_push(extra, may):
    """What a reader takes from a notice: its push entries (None when the list is malformed), its rules (the
    defaults when absent or malformed) and whether it lets the bot push."""
    entries = extra.get("push", [])
    ok = isinstance(entries, list) and len(entries) <= 32
    out = []
    for e in entries if ok else []:
        if not isinstance(e, dict) or len(e) != 3 or not isinstance(e.get("grant"), str) or len(e["grant"]) != 64:
            ok = False
            break
        if e.get("match") == "prefix" and isinstance(e.get("ref"), str) and prefix_of(e["ref"]).get("prefix") == e["ref"]:
            out.append(dict(grant=e["grant"], prefix=e["ref"]))
        elif e.get("members") is True and isinstance(e.get("branch"), str) and len(e["branch"]) == 64:
            out.append(dict(grant=e["grant"], members=e["branch"]))
        else:
            ok = False
            break
    ok = ok and all(out[i]["grant"] < out[i + 1]["grant"] for i in range(len(out) - 1))
    pol = extra.get("pushPolicy")
    keys = ("deleteOwnOnly", "fastForwardOnly", "openPrNotPush")
    if not (isinstance(pol, dict) and len(pol) == 3 and all(isinstance(pol.get(k), bool) for k in keys)):
        pol = dict(deleteOwnOnly=True, fastForwardOnly=True, openPrNotPush=False)
    return dict(entries=out if ok else None, policy=pol, allowsPush="push" in may and ok)


def grant(i, at, until, prefix=None, scope=None, granter="M1"):
    g = dict(id="g%02d" % i, granter=granter, bot=BOT, until=until, createdAt=at)
    if prefix is not None:
        g["prefix"] = prefix
    if scope is not None:
        g["scope"] = scope
    return g


def build():
    ctx = dict(now=10_000, botRowAt=1_000, maintainers=["M1", "M2"])
    p = "refs/heads/bot/ci-bot/"
    scope = hashlib.sha256(b"fix-auth under the branch key").hexdigest()
    cases = [
        ("live", grant(1, 2_000, 20_000, prefix=p), ctx),
        ("expired", grant(2, 2_000, 10_000, prefix=p), ctx),
        ("granter_gone", grant(3, 2_000, 20_000, prefix=p, granter="M9"), ctx),
        ("older_than_bot_row", grant(4, 500, 20_000, prefix=p), ctx),
        ("not_a_bot", grant(5, 2_000, 20_000, prefix=p), dict(ctx, botRowAt=None)),
        ("same_block_as_row", grant(6, 1_000, 20_000, prefix=p), ctx),
        ("older_and_expired_says_older", grant(7, 500, 9_000, prefix=p), ctx),
    ]
    vector("grant_usable", "a grant can be pushed under now when the bot holds a Bot row written no later than the "
           "grant (a bot removed and added again does not get its push back), its granter is still a maintainer, "
           "and now is before its until; checked in that order.",
           dict(op="grantUsable", cases=[dict(name=n, grant=g, ctx=c) for n, g, c in cases]),
           dict(results=[dict(name=n, unusable=usable(g, c)) for n, g, c in cases]))

    grants = [grant(1, 2_000, 20_000, prefix=p), grant(2, 3_000, 30_000, prefix=p),
              grant(3, 4_000, 9_000, prefix="refs/heads/gh-pages"), grant(4, 500, 50_000, prefix="refs/heads/old/"),
              grant(5, 2_000, 20_000, scope=scope)]
    targets = [
        ("prefix_ends_last", dict(public=p + "fix")),
        ("beside_the_prefix", dict(public="refs/heads/bot/ci-bot2")),
        ("one_branch_and_longer", dict(public="refs/heads/gh-pages-2")),
        ("older_than_row", dict(public="refs/heads/old/x")),
        ("default_branch", dict(public="refs/heads/main")),
        ("exact", dict(exact=scope.upper())),
        ("exact_other", dict(exact="00" * 32)),
        ("public_name_never_exact", dict(public=scope)),
    ]
    vector("grant_pick", "a bot pushes a ref under the usable grant covering it that ends last (then the newest, then "
           "by id): a prefix grant covers every public name starting with its prefix (one branch is granted as the "
           "prefix of its name, which covers longer names too), an exact grant one members-only name hash. No "
           "covering grant: notCovered; covering grants none usable: the newest one's reason.",
           dict(op="grantPick", grants=grants, ctx=ctx, targets=[dict(name=n, target=t) for n, t in targets]),
           dict(results=[dict(name=n, pick=pick(grants, t, ctx)) for n, t in targets]))

    patterns = ["bot/ci-bot/*", "bot/ci-bot/", "gh-pages", "refs/heads/release/", "", "*", "refs/tags/v1",
                "refs/remotes/x", "bot/*/x", "bot/ci?/", "bot/[a]/", "refs/heads/", "a..b", "a b", "a\\b",
                "x" * 300, "deep//x"]
    vector("prefix_of", "the grant dialog turns a branch pattern into the prefix it grants: one trailing * is the "
           "prefix itself, a bare branch name is granted as the prefix of its full name; refused: empty, outside "
           "refs/heads/, any other glob (consensus compares prefixes only), malformed.",
           dict(op="prefixOf", patterns=patterns),
           dict(results=[dict(pattern=x, **prefix_of(x)) for x in patterns]))

    now = 1_000_000_000
    asks = [None, now - 1, now, now + DAY, now + MAX_TTL, now + MAX_TTL - MARGIN, now + MAX_TTL + 1]
    vector("until_for", "a grant lasts 30 days by default and at most 90; a client asks for 10 minutes less than 90 "
           "days at most, so consensus (which judges against the block's time) never refuses what it accepted.",
           dict(op="untilFor", now=now, requested=asks),
           dict(results=[until_for(now, r) for r in asks]))

    g_old = grant(1, 500, 50_000, prefix=p)
    g_new = grant(2, 2_000, 50_000, prefix=p)
    marks = [
        ("granted", 3_000, g_new, 1_000, True),
        ("no_notice", 3_000, g_new, 1_000, None),
        ("older_grant_after_readd", 3_000, g_old, 1_000, True),
        ("older_grant_before_readd", 800, g_old, 1_000, True),
        ("suspended", 3_000, g_new, 1_000, False),
        ("grant_deleted_later", 3_000, None, 1_000, True),
    ]
    vector("push_mark", "readers mark a bot's push 'outside the access @ci-bot was given' when the grant it named was "
           "written before the bot's current member row and the push came after that row (a removed and re-added "
           "bot), or when the bot's notice in force when it landed did not allow pushing (a maintainer suspended "
           "it). A grant deleted later takes nothing back.",
           dict(op="pushMark", cases=[dict(name=n, at=a, grant=g, botRowAt=r, noticeAllowsPush=al)
                                      for n, a, g, r, al in marks]),
           dict(results=[dict(name=n, mark=mark(a, g, r, al)) for n, a, g, r, al in marks]))

    notices = [
        ("listed", ["post", "push"], PUSH_EXTRA),
        ("suspended", ["post"], {}),
        ("malformed_list", ["post", "push"], {"push": [{"grant": "zz", "match": "prefix", "ref": p}]}),
        ("unsorted", ["post", "push"], {"push": list(reversed(PUSH_EXTRA["push"])), "pushPolicy": PUSH_EXTRA["pushPolicy"]}),
        ("not_a_branch_prefix", ["push"], {"push": [dict(PUSH_EXTRA["push"][0], ref="refs/tags/")]}),
        ("policy_partial", ["push"], {"push": [], "pushPolicy": {"fastForwardOnly": False}}),
    ]
    rows = []
    for n, may, extra in notices:
        t = notice_to_typed(sample_notice(may=sorted(may), extra=extra))
        rows.append((n, encode(t).hex(), notice_push(extra, may)))
    vector("notice_push", "what a reader takes from an access notice's push fields: the grants it lists (none when "
           "the list is malformed: a reader then treats the notice as allowing no push), the runner's push rules "
           "(the defaults, fast-forward only and delete own only, when absent or malformed) and whether it lets the "
           "bot push (`push` among its abilities and a well-formed list).",
           dict(op="noticePush", notices=[dict(name=n, plaintextHex=h) for n, h, _ in rows]),
           dict(results=[dict(name=n, **r) for n, _, r in rows]))

    name = p + "x"
    good = hashlib.sha256(name.encode()).hexdigest()
    upd = lambda h: dict(id="u1", refNameHash=h, refName=name, prevOid="", newOid="aa" * 20, force=False,
                         protected=False, author=BOT, createdAt=100)
    vector("name_hash_mismatch_ignored", "consensus admits a bot's public update whose refNameHash is not "
           "sha256(refName) (no hash operator); every reader drops it, as it drops anyone's.",
           dict(op="refValid", updates=[upd(good), upd("11" * 32)]),
           dict(results=[True, False]))


def write_vectors(out_dir):
    import glob
    build()
    for old in glob.glob(os.path.join(out_dir, "bot_push__*.json")):
        os.remove(old)
    for v in VECTORS:
        with open(os.path.join(out_dir, f"{v['case']}__{v['name']}.json"), "w") as f:
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

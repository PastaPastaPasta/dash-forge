"""Independent Python reference for making members-only discussion public (mixed-visibility design §4.6, D5).

    python3 tools/private-repos-vectors/make_public.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/make_public.py --write-vectors  # (re)write forge-contracts/vectors/make_public__*.json

Every vector it writes has case `make_public` and an `input.op` naming what it checks:

- `edit`: what a replace does to a document's audience (`keeps`, `makesPublic`, `notAuthor`, `fixed`,
  `malformed`). Before mainnet the clients allow exactly one audience change, the author's edit of
  their own members-only (`enc` v0x03) or letter (v0x04) document to Public in a public repository,
  and refuse every other before signing.
- `replace`: the replace that makes a sealed document public, from its opened content: the plaintext
  fields set, `enc` and `epoch` removed, and the sealed fields the live contracts cannot take
  (`comment.path` is immutable, so an inline comment loses its file name). Sealed import provenance
  is refused (`imported` is immutable: the words would read as the importer's).
- `reviewText`: which public comment carries each sealed review's text (a review is immutable, so
  its author attaches a public comment: `reviewId`, no path, line, reply or commit; the review's
  author only; the newest wins).

The Rust harness (`forge_core::rules`, `rules::make_public`) and the TypeScript harness
(`forge-web/lib/rules/conformance.test.ts`, `lib/rules/make-public.ts`) run every file and must
reproduce it exactly.
"""
import glob
import json
import os
import sys

VECTORS = []


def vector(name, description, inp, expected):
    VECTORS.append(dict(name=name, description=description, case="make_public", rules="v2", input=inp,
                        expected=expected))


# --- the reference rules ------------------------------------------------------------------------

REQUIRED = {"issue": "title", "patch": "title", "comment": "body", "review": None}
CONTENT = {"issue": ("title", "body"), "patch": ("title", "body", "baseRefName", "sourceRefName"),
           "comment": ("body", "path"), "review": ("body",)}


def present(v):
    return isinstance(v, str) and v != ""


def audience(doc):
    enc = doc.get("enc") or ""
    if enc == "":
        return "public"
    return "specificPeople" if enc[:2] == "04" else "members"


def any_plaintext(doc):
    return any(present(doc.get(f)) for f in CONTENT[doc["kind"]])


def public_well_formed(doc):
    req = REQUIRED[doc["kind"]]
    return not present(doc.get("enc")) and (req is None or present(doc.get(req)))


def audience_edit(visibility, stored, edited, author, signer):
    if author != signer:
        return "notAuthor"
    was, now = audience(stored), audience(edited)
    if was == now:
        return "keeps" if now == "public" or not any_plaintext(edited) else "malformed"
    if was == "public" or now != "public" or visibility != "public":
        return "fixed"
    return "makesPublic" if edited.get("epoch") is None and public_well_formed(edited) else "malformed"


def make_public_changes(kind, opened):
    if "importedAuthor" in opened or "importedUrl" in opened:
        return dict(error="imported")
    text = lambda f: opened[f] if isinstance(opened.get(f), str) and opened[f].strip() != "" else None
    out = dict(set={}, remove=["enc", "epoch"], lost=[])
    if kind in ("issue", "patch"):
        if kind == "patch":
            out["lost"] += [f for f in ("baseRefName", "sourceRefName") if f in opened]
        if text("title") is None:
            return dict(error="empty")
        out["set"]["title"] = text("title")
        if text("body") is not None:
            out["set"]["body"] = text("body")
    elif kind == "comment":
        if "path" in opened:
            out["lost"].append("path")
        if text("body") is None:
            return dict(error="empty")
        out["set"]["body"] = text("body")
    else:
        return dict(error="notEditable")
    out["set"] = dict(sorted(out["set"].items()))
    return out


def carries_text(c):
    return (not c.get("sealed", False) and c.get("reviewId") is not None and not c.get("path")
            and c.get("line") is None and not c.get("replyTo") and not c.get("commitOid"))


def review_text_carriers(reviews, comments):
    out = {}
    for r in reviews:
        if not r.get("sealed", False):
            continue
        mine = [c for c in comments if carries_text(c) and c.get("reviewId") == r["id"] and c["owner"] == r["reviewer"]]
        if mine:
            out[r["id"]] = max(mine, key=lambda c: (c["createdAt"], c["id"]))["id"]
    return dict(sorted(out.items()))


# --- vectors ------------------------------------------------------------------------------------

MEMBERS = "03" + "00" * 92  # an `enc` v0x03 (the rule reads only its first byte)
LETTER = "04" + "00" * 160  # an `enc` v0x04
ALICE, BOB = "alice", "bob"


def sealed(kind, enc=MEMBERS):
    return dict(kind=kind, enc=enc, epoch=0)


def edit_vectors():
    cases = [
        ("edit_members_comment_by_author", "public", sealed("comment"), dict(kind="comment", body="now public"), ALICE,
         ALICE, "makesPublic",
         "The author's edit of their own members-only comment to Public: enc and epoch dropped, the body set (DESIGN §4.6)."),
        ("edit_members_issue_by_author", "public", sealed("issue"), dict(kind="issue", title="Rotate the key", body="Done."),
         ALICE, ALICE, "makesPublic", "The author's members-only issue made public: its title and body set."),
        ("edit_letter_comment_by_author", "public", sealed("comment", LETTER), dict(kind="comment", body="for everyone"),
         ALICE, ALICE, "makesPublic", "A letter's author may make it public too (DESIGN D32)."),
        ("edit_inline_comment_without_path", "public", sealed("comment"), dict(kind="comment", body="nit: rename"),
         ALICE, ALICE, "makesPublic",
         "A made-public inline comment carries no path: comment.path is immutable on the live contracts."),
        ("edit_someone_elses_refused", "public", sealed("comment"), dict(kind="comment", body="now public"), ALICE, BOB,
         "notAuthor", "A writer cannot make someone else's comment public: only its author replaces it."),
        ("edit_sealed_edit_of_public_refused", "public", dict(kind="comment", body="public"), sealed("comment"), ALICE,
         ALICE, "fixed", "A public comment cannot be edited into a members-only one (DESIGN §2.4)."),
        ("edit_members_to_letter_refused", "public", sealed("comment"), sealed("comment", LETTER), ALICE, ALICE, "fixed",
         "A members-only comment cannot become a letter."),
        ("edit_letter_to_members_refused", "public", sealed("comment", LETTER), sealed("comment"), ALICE, ALICE, "fixed",
         "A letter cannot become members-only."),
        ("edit_private_repo_refused", "private", sealed("comment"), dict(kind="comment", body="now public"), ALICE, ALICE,
         "fixed", "Nothing in a private repository is made public on its own (the whole repo goes public, §4.10)."),
        ("edit_epoch_left_refused", "public", sealed("comment"), dict(kind="comment", body="now public", epoch=0), ALICE,
         ALICE, "malformed", "A public document carries no epoch: the replace removes it with enc."),
        ("edit_no_body_refused", "public", sealed("comment"), dict(kind="comment"), ALICE, ALICE, "malformed",
         "A comment made public needs its body."),
        ("edit_issue_without_title_refused", "public", sealed("issue"), dict(kind="issue", body="b"), ALICE, ALICE,
         "malformed", "An issue made public needs its title."),
        ("edit_reseal_keeps", "public", sealed("comment"), dict(sealed("comment"), enc="03" + "11" * 92), ALICE, ALICE,
         "keeps", "Re-sealing a members-only comment keeps its audience."),
        ("edit_plaintext_beside_reseal_refused", "public", sealed("comment"), dict(sealed("comment"), body="leak"), ALICE,
         ALICE, "malformed", "A sealed replace carries no plaintext beside enc."),
        ("edit_public_keeps", "public", dict(kind="comment", body="a"), dict(kind="comment", body="b"), ALICE, ALICE,
         "keeps", "A plaintext edit of a public comment keeps it public."),
    ]
    for name, vis, stored, edited, author, signer, expected, desc in cases:
        got = audience_edit(vis, stored, edited, author, signer)
        assert got == expected, (name, got)
        vector(name, desc, dict(op="edit", visibility=vis, stored=stored, edited=edited, author=author, signer=signer),
               expected)


def replace_vectors():
    cases = [
        ("edit_replace_comment", "comment", dict(body="We rotated the key at 03:12."),
         "A members-only comment's replace: body set, enc and epoch removed."),
        ("edit_replace_inline_comment_loses_path", "comment", dict(body="nit: rename", path="src/lib.rs"),
         "An inline comment's path is sealed and comment.path is immutable: it is lost, for members too."),
        ("edit_replace_issue", "issue", dict(title="Rotate the key", body="Done."), "An issue's title and body set."),
        ("edit_replace_issue_title_only", "issue", dict(title="Rotate the key"), "An issue with no body: its title only."),
        ("edit_replace_imported_refused", "comment", dict(body="lgtm", importedAuthor="octocat"),
         "Sealed import provenance cannot be published (imported is immutable), so the item is refused."),
        ("edit_replace_empty_comment_refused", "comment", dict(body="   "),
         "A comment whose opened body is blank has nothing to publish."),
        ("edit_replace_review_refused", "review", dict(body="Blocking."),
         "A review is immutable: its text goes public by an attached comment, never by a replace."),
    ]
    for name, kind, opened, desc in cases:
        vector(name, desc, dict(op="replace", kind=kind, opened=opened), make_public_changes(kind, opened))


def review_text_vectors():
    review = dict(id="R1", reviewer=BOB, sealed=True)

    def c(cid, owner=BOB, at=10, **kw):
        return dict(dict(id=cid, owner=owner, reviewId="R1", createdAt=at), **kw)

    cases = [
        ("review_text_attached_comment", [review], [c("C1")],
         "The review's author's public comment attached to the review, with no anchor, carries its text."),
        ("review_text_newest_wins", [review], [c("C1", at=10), c("C2", at=20)],
         "Published twice: the newest comment wins."),
        ("review_text_other_owner_ignored", [review], [c("C1", owner=ALICE)],
         "Only the review's author's comment counts (consensus admits no other; readers check again)."),
        ("review_text_inline_comment_ignored", [review],
         [c("C1", line=4, commitOid="ab" * 20), c("C2", path="src/lib.rs"), c("C3", replyTo="C0")],
         "A comment with a line, a path or a reply is a review comment, not the review's text."),
        ("review_text_sealed_comment_ignored", [review], [c("C1", sealed=True)],
         "A members-only comment does not make anything public."),
        ("review_text_public_review_untouched", [dict(review, sealed=False)], [c("C1")],
         "A public review keeps its own text."),
    ]
    for name, reviews, comments, desc in cases:
        vector(name, desc, dict(op="reviewText", reviews=reviews, comments=comments),
               review_text_carriers(reviews, comments))


def build():
    VECTORS.clear()
    edit_vectors()
    replace_vectors()
    review_text_vectors()


def write_vectors(out_dir):
    build()
    for old in glob.glob(os.path.join(out_dir, "make_public__*.json")):
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

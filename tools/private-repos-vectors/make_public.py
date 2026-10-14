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
- `bundleKey`, `bundleOpen`, `bundleRead` (`make_public__bundle_*`): a maintainer's make-public
  bundle (packManifest kind 7, `DFRV` entries 0x01 comment, 0x02 issue, 0x03 review: the
  revision's per-object key `K_obj`). `bundleKey` is the key a member publishes (derived under the
  epoch key and checked against the document's commitment; a letter's, unwrapped from the
  maintainer's own slot, so a letter the maintainer was not sent has none); `bundleOpen` opens one
  document with a published key and no epoch key (commitment first: a key that does not commit is
  `commitMismatch`, never shown); `bundleRead` is the reader rule over a repository's bundles: only
  a public repository, only bundles by a current maintainer (or the owner), the first entry of the
  document's revision whose key opens it makes it public, a lying entry is an alert and ignored,
  and an entry for an earlier revision only says it was edited after it was made public.

The Rust harness (`forge_core::rules`, `rules::make_public`) and the TypeScript harness
(`forge-web/lib/rules/conformance.test.ts`, `lib/rules/make-public.ts`) run every file and must
reproduce it exactly.
"""
import glob
import hashlib
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


# Unicode White_Space (Rust `char::is_whitespace`, the contract's `\\S`): not str.strip, which also
# strips U+001C..U+001F, nor JS trim, which strips U+FEFF.
WHITE_SPACE = set("\t\n\v\f\r \u0085\u00a0\u1680\u2028\u2029\u202f\u205f\u3000") | {chr(c) for c in range(0x2000, 0x200B)}


def blank(s):
    return all(c in WHITE_SPACE for c in s)


def make_public_changes(kind, opened):
    if "importedAuthor" in opened or "importedUrl" in opened:
        return dict(error="imported")
    text = lambda f: opened[f] if isinstance(opened.get(f), str) and not blank(opened[f]) else None
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
        ("edit_replace_next_line_only_refused", "comment", dict(body="\u0085\u2003"),
         "Blank is Unicode White_Space only: U+0085 and U+2003 leave nothing to publish."),
        ("edit_replace_byte_order_mark_kept", "comment", dict(body="\ufeff"),
         "U+FEFF is not White_Space (the contract's \\S matches it): the body is kept."),
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
        ("review_text_commit_only_ignored", [review], [c("C1", commitOid="cd" * 20)],
         "A comment naming a commit is a review comment (a made-public file-level one), not the text."),
        ("review_text_sealed_comment_ignored", [review], [c("C1", sealed=True)],
         "A members-only comment does not make anything public."),
        ("review_text_public_review_untouched", [dict(review, sealed=False)], [c("C1")],
         "A public review keeps its own text."),
    ]
    for name, reviews, comments, desc in cases:
        vector(name, desc, dict(op="reviewText", reviews=reviews, comments=comments),
               review_text_carriers(reviews, comments))


# --- maintainer bundles (phase 2B) ------------------------------------------------------------

ENTRY_COMMENT, ENTRY_ISSUE, ENTRY_REVIEW, ENTRY_PATCH, ENTRY_EPOCH = 0x01, 0x02, 0x03, 0x04, 0x06
ENTRY_OF = {"comment": ENTRY_COMMENT, "issue": ENTRY_ISSUE, "review": ENTRY_REVIEW, "patch": ENTRY_PATCH}


def bundled_patch(doc, fields):
    """What a published key shows of an opened PR: a branch name only where its hash is sha256(name) (a public
    branch); a keyed hash (a members-only branch, which the key cannot check) leaves the name out; a hash with no
    name is malformed. The real head and salt (24, 27) are never shown. None: malformed."""
    out = dict(fields)
    for f in ("baseRefName", "sourceRefName"):
        h = doc.get(f + "Hash")
        if h is None:
            continue
        if f not in out:
            return None
        if bytes.fromhex(h) != hashlib.sha256(out[f].encode()).digest():
            del out[f]
    for f in ("headOid", "oidSalt"):
        out.pop(f, None)
    return out


def bundle_vectors():
    import gen as G
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    H = G.H
    repo = G.repoId

    def members_key(doc, K, enc):
        """The K_obj a member derives for a v0x03 doc (None unless it commits; bundles publish issues, comments,
        reviews and pull requests)."""
        if enc[0] != G.V3 or doc["type"] not in ENTRY_OF:
            return None
        A = G.ad(doc, K, G.V3)
        ko = G.k_obj_members(K, doc["epoch"], enc[1:13], A)
        return ko if G.obj_keys(ko)[1] == enc[13:45] else None

    def open_with_key(doc, enc, ko):
        """The reference reader of a published key: (status, raw TLV or reason). A PR's fields are then shown as
        bundled_patch says."""
        if doc["type"] not in ENTRY_OF:
            return "malformed", None
        kd, C2 = G.obj_keys(ko)
        if enc[0] == G.V3:
            nonce, C, ct, A = enc[1:13], enc[13:45], enc[45:], G.ad(doc, None, G.V3) + enc[13:45]
        elif enc[0] == G.V4:
            n = enc[1]
            head = enc[1:38 + 64 * n]
            nonce, C, ct, A = enc[38 + 64 * n:50 + 64 * n], enc[6:38], enc[50 + 64 * n:], G.ad(doc, None, G.V4) + G.sha256(head)
        else:
            return "malformed", None
        if C2 != C:
            return "commitMismatch", None
        try:
            return "readable", AESGCM(kd).decrypt(nonce, ct, A)
        except Exception:
            return "badTag", None

    def open_fields(doc, enc, ko, fields):
        """open_with_key, then what a bundle shows of a PR (`fields`: the TLV as the vector states it)."""
        status, raw = open_with_key(doc, enc, ko)
        if status == "readable" and doc["type"] == "patch":
            shown = bundled_patch(doc, fields)
            return ("readable", shown) if shown is not None else ("malformed", None)
        return status, fields

    TAG_NAMES = {1: "title", 2: "body", 4: "baseRefName", 5: "sourceRefName", 24: "headOid", 27: "oidSalt"}

    def raw_fields(doc, raw):
        """The content records of an opened PR's TLV (type, u16 length, value), the padding and a letter's
        recipients ignored."""
        out, i = {}, 0
        while i + 3 <= len(raw):
            t, n = raw[i], int.from_bytes(raw[i + 1:i + 3], "big")
            if t == 0:
                break
            v = raw[i + 3:i + 3 + n]
            if t in TAG_NAMES:
                out[TAG_NAMES[t]] = v.decode() if t in (1, 2, 4, 5) else v.hex()
            i += 3 + n
        return out

    def opened(status, fields=None):
        if status == "readable":
            return dict(status="readable", fields=fields)
        if status == "malformed":
            return dict(status="malformed")
        return dict(status="unreadable", reason=status)

    MAINT = bytes([0xb0]) * 32
    WRITER = bytes([0xc0]) * 32
    REPO_OWNER = bytes([0xa1]) * 32

    comment = dict(G.MDOC, id=H(G.cid("bundle comment")))
    body = "members-only: the fix is in sec/cve-1"
    _, ko_c, _, pt_c, enc_c = G.seal_members(comment, G.K0, G.tlv((2, body.encode())))
    assert members_key(comment, G.K0, enc_c) == ko_c
    issue = dict(G.MISSUE, id=H(G.cid("bundle issue")))
    _, ko_i, _, _, enc_i = G.seal_members(issue, G.K0, G.ISSUE_TLV)
    review = dict(G.MREVIEW, id=H(G.cid("bundle review")))
    rbody = "Blocking: the token is logged."
    _, ko_r, _, _, enc_r = G.seal_members(review, G.K0, G.tlv((2, rbody.encode())))
    # the same comment re-sealed (an edit): a new nonce, so a new K_obj
    nonce2 = bytes.fromhex("0b0a09080706050403020100")
    body2 = "members-only: edited, the fix moved to sec/cve-2"
    _, ko_c2, _, _, enc_c2 = G.seal_members(comment, G.K0, G.tlv((2, body2.encode())), nonce=nonce2)
    # a letter to alice (sender), r1, r2
    k_obj_l, nonce_l, ivs_l = G.named_inputs(3)
    letter = dict(G.named_doc(), id=H(G.cid("bundle letter")))
    lbody = "A letter to 3 people (the sender included): the embargo ends on Friday."
    _, _, _, _, _, enc_l = G.seal_named(letter, G.NAMED_SENDER, 4, G.NAMED_N3, G.tlv((2, lbody.encode())), k_obj_l,
                                        nonce_l, ivs_l)
    owner_keys = [G.owner_key(G.NAMED_SENDER)]
    # members-only PRs (mixed-visibility §4.4): from a members-only branch into public main (keyed source, public
    # base, the blind head with its real value and salt in 24 and 27), from a public branch (both names public),
    # and into a members-only base (both keyed)
    import members_git as M
    pr_props = dict(M.MPATCH_PROPS, title="Fix the bounds check", body="The upper bound was off by one.")
    real, s_ = M.oid("H1"), M.salt("push-H1")
    pr_docs = {}
    for label, base_public, source_public, head in (("members_branch", True, False, True),
                                                    ("public_branches", True, True, False),
                                                    ("members_base", False, False, True)):
        plain = M.blind(s_, real) if head else M.oid("H2")
        d, _, _, enc, _ = M.seal_patch(pr_props, base_public, source_public, real if head else None, plain,
                                       s_ if head else None)
        d = dict(d, id=H(G.cid("bundle pr " + label)))
        pr_docs[label] = (d, enc, members_key(d, G.K0, enc))
    patch, enc_p, ko_p = pr_docs["members_branch"]
    pr_fields = {"title": pr_props["title"], "body": pr_props["body"]}
    # a PR whose source hash names no sealed name: malformed whatever the key
    d, _, _, enc_nohash, _ = M.seal_patch(pr_props, True, False, None, M.oid("H2"), None,
                                          records=[(1, pr_props["title"].encode()), (4, b"refs/heads/main")])
    pr_nameless = (dict(d, id=H(G.cid("bundle pr nameless"))), enc_nohash)
    pr_nameless = pr_nameless + (members_key(pr_nameless[0], G.K0, enc_nohash),)
    # a PR sent to specific people (enc v0x04): its branch names are public hashes
    k_obj_lp, nonce_lp, ivs_lp = G.named_inputs(3)
    letter_pr = dict(type="patch", vis="public", ownerId=H(G.NAMED_SENDER["id"]), epoch=0, number=9,
                     baseRefNameHash=H(G.sha256(b"refs/heads/main")),
                     sourceRefNameHash=H(G.sha256(b"refs/heads/fix-for-rae")), id=H(G.cid("bundle letter pr")))
    _, _, _, _, _, enc_lp = G.seal_named(letter_pr, G.NAMED_SENDER, 4, G.NAMED_N3,
                                         G.tlv((1, b"A fix for Rae"), (4, b"refs/heads/main"),
                                               (5, b"refs/heads/fix-for-rae")), k_obj_lp, nonce_lp, ivs_lp)

    # --- bundleKey ---
    def key_vector(name, desc, doc, enc, expected, **inp):
        vector(name, desc, dict(op="bundleKey", repoId=H(repo), doc=doc, enc=H(enc), **inp),
               dict(kObj=None if expected is None else H(expected)))

    key_vector("bundle_key_members_comment", "A member derives the comment's K_obj under the epoch key (PRK_e, the "
               "nonce and SHA-256(AD)) and checks it against the commitment: the key a bundle entry publishes.",
               comment, enc_c, ko_c, epochKey=H(G.K0), epoch=0)
    key_vector("bundle_key_members_issue", "An issue revision's K_obj.", issue, enc_i, ko_i, epochKey=H(G.K0), epoch=0)
    key_vector("bundle_key_members_review", "A review's K_obj.", review, enc_r, ko_r, epochKey=H(G.K0), epoch=0)
    key_vector("bundle_key_other_epoch_none", "The epoch key held is not the document's epoch's: no key.",
               dict(comment, epoch=1), enc_c, None, epochKey=H(G.K0), epoch=0)
    key_vector("bundle_key_pr_members", "A members-only PR revision's K_obj (entry type 0x04): derived and checked "
               "like any document's.", patch, enc_p, ko_p, epochKey=H(G.K0), epoch=0)
    key_vector("bundle_key_letter_recipient", "A maintainer the letter was sent to (r1) unwraps K_obj from their own "
               "slot, after the whole letter reader rule: the key a bundle entry publishes.", letter, enc_l, k_obj_l,
               ownerKeys=owner_keys, reader=G.reader_json(G.NAMED_N3[1]))
    key_vector("bundle_key_letter_not_sent_none", "A letter the maintainer (dave) was not sent: no slot opens, so "
               "they cannot bundle it.", letter, enc_l, None, ownerKeys=owner_keys,
               reader=G.reader_json(G.NAMED_OUTSIDER))

    # --- bundleOpen ---
    def open_vector(name, desc, doc, enc, ko, expected_status, fields=None, sealed=None):
        got, raw = open_with_key(doc, enc, ko)
        if got == "readable" and doc["type"] == "patch":
            got = "readable" if bundled_patch(doc, sealed or raw_fields(doc, raw)) is not None else "malformed"
        assert got == expected_status, (name, got)
        if got == "readable" and doc["type"] == "patch":
            assert bundled_patch(doc, raw_fields(doc, raw)) == fields, (name, raw_fields(doc, raw))
        vector(name, desc, dict(op="bundleOpen", repoId=H(repo), doc=doc, enc=H(enc), key=H(ko)),
               opened(expected_status, fields))
        return raw

    raw = open_vector("bundle_open_members_comment", "Anyone holding the published K_obj, and no epoch key, opens "
                      "the comment: the AD is rebuilt from its public fields, the commitment checked, then GCM.",
                      comment, enc_c, ko_c, "readable", {"body": body})
    assert raw == pt_c
    open_vector("bundle_open_members_issue", "An issue's title and body.", issue, enc_i, ko_i, "readable",
                G.ISSUE_FIELDS)
    open_vector("bundle_open_members_review", "A review's text.", review, enc_r, ko_r, "readable", {"body": rbody})
    open_vector("bundle_open_letter", "A letter opens with its K_obj and no recipient key; its recipient list "
                "is still checked (n ids, the owner first, none twice).", letter, enc_l, k_obj_l, "readable",
                {"body": lbody})
    open_vector("bundle_open_wrong_key_mismatch", "A key that is not the document's: the commitment it derives "
                "differs, so CommitMismatch before GCM runs (a lying entry, never shown).", comment, enc_c,
                bytes([0x5a]) * 32, "commitMismatch")
    open_vector("bundle_open_other_revision_mismatch", "The key of revision 1 against revision 2 (re-sealed with a "
                "new nonce by an edit): CommitMismatch. A key opens one revision of one document.", comment,
                enc_c2, ko_c, "commitMismatch")
    mallory = dict(comment, ownerId=H(G.MALLORY_ID))
    kd, C = G.obj_keys(ko_c)
    forged = bytes([G.V3]) + G.NONCE + C + AESGCM(kd).encrypt(
        G.NONCE, G.members_tlv("comment", G.tlv((2, b"FORGED"))), G.ad(mallory, None, G.V3) + C)
    open_vector("bundle_open_forged_opens_with_the_key", "Mallory re-encrypts her own text under the published K_obj "
                "as her own comment, copying the nonce and commitment: the key alone opens it (the AD is public). "
                "This is why a reader uses a key only for the document its entry names by $id "
                "(bundle_read_forged_copy_not_covered), and why members, who derive K_obj from her AD, refuse it "
                "(mixed_doc_open__forged_after_reveal_refused).", mallory, forged, ko_c, "readable", {"body": "FORGED"})
    moved = dict(comment, targetId="55" * 32)
    open_vector("bundle_open_moved_to_other_target_badtag", "The comment's enc copied onto another issue's comment: "
                "the AD binds the target, so BadTag.", moved, enc_c, ko_c, "badTag")
    tampered = bytearray(enc_c)
    tampered[-1] ^= 0x01
    open_vector("bundle_open_body_tampered_badtag", "The right key, a tampered tag: BadTag.", comment, bytes(tampered),
                ko_c, "badTag")
    open_vector("bundle_open_pr_members_branch", "A members-only PR from a members-only branch into public main, "
                "opened with its published key: the title, the body and the public base's name (its hash is "
                "sha256(name)). The source branch's hash is keyed under the epoch's ref key, which the key cannot "
                "check and whose name stays members-only: left out. The real head and salt (24, 27) are never shown.",
                patch, enc_p, ko_p, "readable", dict(pr_fields, baseRefName="refs/heads/main"))
    d, enc, ko = pr_docs["public_branches"]
    open_vector("bundle_open_pr_public_branches", "A members-only PR between public branches: both names shown.",
                d, enc, ko, "readable", dict(pr_fields, baseRefName="refs/heads/main",
                                              sourceRefName=M.MPATCH_PROPS["sourceRefName"]))
    d, enc, ko = pr_docs["members_base"]
    open_vector("bundle_open_pr_members_base", "Into a members-only base: neither name is shown.", d, enc, ko,
                "readable", pr_fields)
    d, enc, ko = pr_nameless
    open_vector("bundle_open_pr_hash_without_name_malformed", "A source hash whose name the PR does not seal: "
                "malformed (the reader disagreement the name check exists to prevent).", d, enc, ko, "malformed")
    open_vector("bundle_open_pr_letter", "A PR sent to specific people: its names are public hashes, checked, "
                "shown.", letter_pr, enc_lp, k_obj_lp, "readable",
                {"title": "A fix for Rae", "baseRefName": "refs/heads/main", "sourceRefName": "refs/heads/fix-for-rae"})

    # --- bundleRead ---
    def bundle(owner, entries):
        return dict(owner=H(owner), bytes=H(G.bundle_bytes(entries)))

    def item(doc, enc, revision):
        return dict(doc=doc, enc=H(enc), revision=revision)

    def read(bundles, items, visibility, maintainers):
        """The reference reader rule: (reads, alerts)."""
        honoured = []
        if visibility == "public":
            for b in bundles:
                if bytes.fromhex(b["owner"]) not in maintainers:
                    continue
                parsed = G.parse_bundle(bytes.fromhex(b["bytes"]))
                if parsed is None:
                    continue
                honoured += [(k, t, r, key, b["owner"]) for k, t, r, key in parsed
                             if k in (ENTRY_COMMENT, ENTRY_ISSUE, ENTRY_REVIEW, ENTRY_PATCH)]
        reads, alerts = [], []
        for it in items:
            doc, enc, rev = it["doc"], bytes.fromhex(it["enc"]), it["revision"]
            mine = [e for e in honoured if e[0] == ENTRY_OF.get(doc["type"]) and e[1] == bytes.fromhex(doc["id"])]
            out = None
            for k, t, r, key, by in mine:
                if r != rev:
                    continue
                status, raw = open_with_key(doc, enc, key)
                if status == "readable":
                    out = dict(id=doc["id"], revision=rev, state="public", by=by)
                    break
                if status == "commitMismatch":
                    alerts.append(dict(id=doc["id"], revision=rev, by=by))
            if out is None:
                earlier = [e for e in mine if e[2] < rev]
                if earlier:
                    e = max(earlier, key=lambda e: e[2])
                    out = dict(id=doc["id"], revision=rev, state="editedAfter", by=e[4], publishedRevision=e[2])
                else:
                    out = dict(id=doc["id"], revision=rev, state="none")
            reads.append(out)
        return dict(reads=reads, alerts=alerts)

    def read_vector(name, desc, bundles, items, expected_states, visibility="public", maintainers=(REPO_OWNER, MAINT),
                    fields=None):
        got = read(bundles, items, visibility, set(maintainers))
        assert [r["state"] for r in got["reads"]] == expected_states, (name, got)
        for r, f in zip(got["reads"], fields or []):
            if f is not None:
                r["fields"] = f
        vector(name, desc, dict(op="bundleRead", repoId=H(repo), visibility=visibility,
                                maintainers=[H(m) for m in maintainers], bundles=bundles, docs=items), got)
        return got

    cid_c, cid_i, cid_r, cid_l = (bytes.fromhex(d["id"]) for d in (comment, issue, review, letter))
    read_vector("bundle_read_maintainer_bundle_public", "A maintainer's bundle naming the comment's current revision: "
                "it is public, for everyone, made public by the maintainer.",
                [bundle(MAINT, [(ENTRY_COMMENT, cid_c, 1, ko_c)])], [item(comment, enc_c, 1)], ["public"],
                fields=[{"body": body}])
    read_vector("bundle_read_owner_bundle_public", "The repository's owner is a maintainer: their bundle counts.",
                [bundle(REPO_OWNER, [(ENTRY_ISSUE, cid_i, 1, ko_i)])], [item(issue, enc_i, 1)], ["public"],
                fields=[G.ISSUE_FIELDS])
    read_vector("bundle_read_thread", "A whole thread in one bundle: the issue, a comment and a review.",
                [bundle(MAINT, [(ENTRY_ISSUE, cid_i, 1, ko_i), (ENTRY_COMMENT, cid_c, 1, ko_c),
                                (ENTRY_REVIEW, cid_r, 1, ko_r)])],
                [item(issue, enc_i, 1), item(comment, enc_c, 1), item(review, enc_r, 1)], ["public"] * 3,
                fields=[G.ISSUE_FIELDS, {"body": body}, {"body": rbody}])
    read_vector("bundle_read_writer_bundle_ignored", "A writer's bundle (a role-1 writer may write a kind-7 manifest "
                "on sakura): readers ignore it, with no alert. On mainnet consensus refuses it (C3).",
                [bundle(WRITER, [(ENTRY_COMMENT, cid_c, 1, ko_c)])], [item(comment, enc_c, 1)], ["none"])
    read_vector("bundle_read_private_repo_ignored", "Bundles are ignored in a private repository: it goes public as a "
                "whole (§4.10).", [bundle(MAINT, [(ENTRY_COMMENT, cid_c, 1, ko_c)])], [item(comment, enc_c, 1)],
                ["none"], visibility="private")
    read_vector("bundle_read_lying_entry_alert", "An entry whose key does not commit to the revision it names: "
                "ignored, and raised as an alert naming the bundle's author.",
                [bundle(MAINT, [(ENTRY_COMMENT, cid_c, 1, bytes([0x5a]) * 32)])], [item(comment, enc_c, 1)], ["none"])
    read_vector("bundle_read_lying_then_honest", "A lying entry and an honest one: the honest one makes it public, "
                "the lying one is still an alert.",
                [bundle(MAINT, [(ENTRY_COMMENT, cid_c, 1, bytes([0x5a]) * 32)]),
                 bundle(REPO_OWNER, [(ENTRY_COMMENT, cid_c, 1, ko_c)])], [item(comment, enc_c, 1)], ["public"],
                fields=[{"body": body}])
    read_vector("bundle_read_edited_after", "The author sealed the comment again after it was made public (revision "
                "2): the entry names revision 1, so revision 2 stays members-only and readers say it was edited "
                "after it was made public.", [bundle(MAINT, [(ENTRY_COMMENT, cid_c, 1, ko_c)])],
                [item(comment, enc_c2, 2)], ["editedAfter"])
    read_vector("bundle_read_history", "Entries for two revisions of one document (the history checkbox writes "
                "one per revision of an issue, whose history Platform keeps): each revision is public on its own key.",
                [bundle(MAINT, [(ENTRY_COMMENT, cid_c, 1, ko_c), (ENTRY_COMMENT, cid_c, 2, ko_c2)])],
                [item(comment, enc_c, 1), item(comment, enc_c2, 2)], ["public", "public"],
                fields=[{"body": body}, {"body": body2}])
    read_vector("bundle_read_letter", "A letter a maintainer was sent, bundled: everyone reads it.",
                [bundle(MAINT, [(ENTRY_COMMENT, cid_l, 1, k_obj_l)])], [item(letter, enc_l, 1)], ["public"],
                fields=[{"body": lbody}])
    read_vector("bundle_read_other_type_ignored", "An entry of type issue naming a comment's id does not apply to "
                "the comment.", [bundle(MAINT, [(ENTRY_ISSUE, cid_c, 1, ko_c)])], [item(comment, enc_c, 1)], ["none"])
    read_vector("bundle_read_epoch_and_pr_entry_on_comment_ignored", "An epoch-key (0x06) entry is not a document "
                "entry here, and a PR (0x04) entry naming a comment's id does not apply to the comment.",
                [bundle(MAINT, [(ENTRY_EPOCH, repo, 0, G.K0), (ENTRY_PATCH, cid_c, 1, ko_c)])],
                [item(comment, enc_c, 1)], ["none"])
    cid_p = bytes.fromhex(patch["id"])
    read_vector("bundle_read_pr_public", "A maintainer's bundle naming a members-only PR's current revision (entry "
                "0x04): public for everyone, shown as a published key shows a PR (title, body, the public base's "
                "name; not the members-only branch's name or the real head).",
                [bundle(MAINT, [(ENTRY_PATCH, cid_p, 1, ko_p)])], [item(patch, enc_p, 1)], ["public"],
                fields=[dict(pr_fields, baseRefName="refs/heads/main")])
    read_vector("bundle_read_pr_issue_entry_ignored", "An issue (0x02) entry naming the PR's id does not apply to it.",
                [bundle(MAINT, [(ENTRY_ISSUE, cid_p, 1, ko_p)])], [item(patch, enc_p, 1)], ["none"])
    mallory_doc = dict(mallory, id=H(G.cid("bundle forged copy")))
    read_vector("bundle_read_forged_copy_not_covered", "Mallory's comment minted under the published key has its "
                "own $id: no entry names it, so it stays members-only (and members refuse it).",
                [bundle(MAINT, [(ENTRY_COMMENT, cid_c, 1, ko_c)])], [item(mallory_doc, forged, 1)], ["none"])
    read_vector("bundle_read_malformed_bundle_ignored", "A bundle that does not parse publishes nothing.",
                [dict(owner=H(MAINT), bytes=H(G.bundle_bytes([(ENTRY_COMMENT, cid_c, 1, ko_c)]) + b"\xff"))],
                [item(comment, enc_c, 1)], ["none"])

    # --- the bytes a maintainer's bundle carries ---
    entries = [(ENTRY_ISSUE, cid_i, 1, ko_i), (ENTRY_COMMENT, cid_c, 1, ko_c)]
    vector("bundle_encode", "A maintainer's bundle: DFRV, version 1, two document entries (type, $id, $revision, "
           "K_obj), no note.", dict(op="bundleEncode", entries=[dict(kind=k, target=H(t), revision=r, key=H(key))
                                                              for k, t, r, key in entries]),
           dict(bytes=H(G.bundle_bytes(entries))))


def build():
    VECTORS.clear()
    edit_vectors()
    replace_vectors()
    review_text_vectors()
    bundle_vectors()


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

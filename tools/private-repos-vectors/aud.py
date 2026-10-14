"""Independent Python reference for the mainnet fields clients write (mixed-visibility DESIGN §4.11,
§8.3 items 1, 4, 6, 9 and 10; phase M-B part 2).

    python3 tools/private-repos-vectors/aud.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/aud.py --write-vectors  # (re)write forge-contracts/vectors/aud__*.json

Every field here is written only where the loaded contract declares it (feature detection): sakura's
three-contract set declares none of them, so the same client writes the same documents there as
before. Each vector's `input.shape` says what the contract declares, and every op is judged against
both shapes.

Every vector it writes has case `aud` and an `input.op` naming what it checks:

- `content`: the `aud` and `mRole` a write of an issue, PR, comment or review carries, from the
  document as it will be stored (after a replace's changes) and the signer's current role. `aud`
  follows `enc`'s version byte (0x01, 0x03 and 0x05 members, 0x04 a letter) and is absent exactly
  when `enc` is; a replace that drops `enc` (making the document public) drops `aud` too, and one
  that keeps it restates the same value (consensus admits no other change). `mRole` is the signer's
  `writer` row role (1 writer, 2 triage, 3 reader, 4 bot) whenever the document carries `asMember`,
  restated on every replace (the `asMember` reference is re-checked with `where {"role": "mRole"}`);
  a maintainer, whose operand checks no role, leaves it out (reads 0). An `enc` of any other
  version is refused before signing (`unknownEnc`).
- `read`: whether a stored document's `aud` agrees with its `enc` (`ok` or `malformed`). A document
  without `aud` is judged by `enc` alone (sakura's, or written before the registration); one with
  `aud` but no `enc`, an `aud` outside 1..2, a members `aud` on a letter or a letter `aud` on
  members-only content is malformed and shown as a placeholder, never as text.
- `event`: an `event` or `authorEvent` on an issue or PR. `tAud` is the target's stored `aud`
  (both `targetId` operands `where {"aud": "tAud"}`: an absent `aud` and an absent `tAud` agree);
  a `value` is plaintext on a public target, sealed under the members key on a members-only one
  (also after a maintainer's bundle when the contract carries `tAud`, whose `tAudSealed` refuses a
  plaintext value), and refused on a letter (an event carries no recipients). An `authorEvent` can
  seal its value only where the contract declares `authorEvent.enc`; elsewhere it is refused.
- `manifestR`: the `r` a pack manifest claims. Where the contract lets `packManifest.r` be 0
  (`maintKinds`), a maintainer's bundle, environment snapshot, reserved kind 9 or access notice
  (kinds 7, 8, 9, 11) claims 0, which only the maintainer operand admits; everything else keeps
  the role it claimed.

The Rust harness (`forge_core::rules::aud`) and the TypeScript harness
(`forge-web/lib/rules/conformance.test.ts`, `lib/rules/aud.ts`) run every file and must reproduce it
exactly.
"""
import glob
import json
import os
import sys

VECTORS = []
CASE = "aud"


def vector(name, description, inp, expected):
    VECTORS.append(dict(name=name, description=description, case=CASE, rules="v2", input=inp, expected=expected))


# --- the reference rules ------------------------------------------------------------------------

ROLE_CODE = {"writer": 1, "triage": 2, "reader": 3, "bot": 4}
MAINT_KINDS = (7, 8, 9, 11)


def enc_version(enc):
    """The version byte of a hex `enc`, or None when there is none."""
    if not enc:
        return None
    return int(enc[:2], 16)


def aud_of(version):
    if version in (0x01, 0x03, 0x05):
        return 1
    if version == 0x04:
        return 2
    return None


def content(shape, doc, role):
    version = enc_version(doc.get("enc"))
    aud = None
    if version is not None:
        aud = aud_of(version)
        if aud is None:
            return dict(error="unknownEnc")
    out = dict(aud=aud if shape.get("aud") else None, mRole=None)
    if shape.get("mRole") and doc.get("asMember"):
        out["mRole"] = ROLE_CODE.get(role)
    return out


def read(doc):
    aud, version = doc.get("aud"), enc_version(doc.get("enc"))
    if aud is None:
        return "ok"
    if version is None or aud not in (1, 2):
        return "malformed"
    return "ok" if aud_of(version) == aud else "malformed"


def event(doc_type, shape, target, has_value):
    t_aud = target.get("aud") if shape.get("tAud") else None
    sealed_target = target.get("enc") is not None or target.get("aud") is not None
    letter = target.get("aud") == 2 or enc_version(target.get("enc")) == 0x04
    if not has_value:
        value = "none"
    elif not sealed_target or (target.get("bundled") and t_aud is None):
        value = "plain"
    elif letter:
        value = "refused"
    elif doc_type == "authorEvent" and not shape.get("authorEnc"):
        value = "refused"
    else:
        value = "sealed"
    return dict(tAud=t_aud, value=value)


def manifest_r(shape, kind, claimed):
    return 0 if shape.get("maintKinds") and kind in MAINT_KINDS else claimed


# --- vectors ------------------------------------------------------------------------------------

SAKURA = dict(aud=False, mRole=False)
MAINNET = dict(aud=True, mRole=True)
MEMBERS = "03" + "00" * 92
PRIVATE = "01" + "00" * 28
LETTER = "04" + "00" * 160
BOT_POST = "05" + "00" * 92
CONFIG = "02" + "00" * 60


def both(name, desc, typ, doc, role, shapes=(("sakura", SAKURA), ("mainnet", MAINNET))):
    for label, shape in shapes:
        got = content(shape, doc, role)
        vector(f"content_{name}__{label}", f"{desc} ({label} contract)",
               dict(op="content", type=typ, shape=shape, doc=doc, role=role), got)


def content_vectors():
    both("public_comment_stranger", "A stranger's public comment carries neither field.", "comment", {}, None)
    both("public_comment_writer", "A writer's public comment: asMember only where a rule needs it (here none), so "
         "no mRole.", "comment", {}, "writer")
    both("public_review_writer_approve", "A writer's public approve carries asMember, so mRole 1 on mainnet.",
         "review", dict(asMember=True), "writer")
    both("public_review_maintainer_approve", "A maintainer's approve: the maintainer operand checks no role, so no "
         "mRole (reads 0).", "review", dict(asMember=True), "maintainer")
    both("members_comment_writer", "A writer's members-only comment (v0x03): aud 1 and mRole 1.", "comment",
         dict(enc=MEMBERS, asMember=True), "writer")
    both("members_comment_triage", "Triage's members-only comment: mRole 2.", "comment",
         dict(enc=MEMBERS, asMember=True), "triage")
    both("members_review_reader", "A reader's members-only review (a comment verdict): mRole 3.", "review",
         dict(enc=MEMBERS, asMember=True), "reader")
    both("members_issue_maintainer", "A maintainer's members-only issue: aud 1, no mRole.", "issue",
         dict(enc=MEMBERS, asMember=True), "maintainer")
    both("members_patch_writer", "A writer's members-only PR: aud 1, mRole 1.", "patch",
         dict(enc=MEMBERS, asMember=True), "writer")
    both("letter_comment_stranger", "A stranger's letter (v0x04): aud 2, no asMember, no mRole.", "comment",
         dict(enc=LETTER), None)
    both("letter_issue_writer", "A writer's letter: aud 2 and mRole 1 (it carries asMember).", "issue",
         dict(enc=LETTER, asMember=True), "writer")
    both("private_comment_writer", "A private repo's comment (v0x01): aud 1 and mRole 1.", "comment",
         dict(enc=PRIVATE, asMember=True), "writer")
    both("private_review_bodyless_maintainer", "A private repo's bodyless approval is sealed too (L1): aud 1.",
         "review", dict(enc=PRIVATE, asMember=True), "maintainer")
    both("bot_post", "A bot's members-only post (v0x05): aud 1 and mRole 4.", "comment",
         dict(enc=BOT_POST, asMember=True), "bot")
    both("made_public_writer", "The replace that makes a writer's comment public drops enc, so aud goes; asMember "
         "stays, so mRole is restated.", "comment", dict(asMember=True), "writer")
    both("edit_after_promotion", "An edit after triage was made a writer restates the new role.", "comment",
         dict(enc=MEMBERS, asMember=True), "writer")
    both("former_member_edit", "A former member's edit: asMember is cleared (a dead reference), so no mRole.",
         "comment", dict(enc=LETTER), None)
    both("config_framing_refused", "A content document never carries a config's v0x02 envelope.", "comment",
         dict(enc=CONFIG, asMember=True), "writer")
    both("unknown_version_refused", "An envelope version this client does not write is refused.", "comment",
         dict(enc="06" + "00" * 60, asMember=True), "writer")
    # one shape at a time: what each flag decides alone
    for label, shape in (("aud_only", dict(aud=True, mRole=False)), ("mrole_only", dict(aud=False, mRole=True))):
        got = content(shape, dict(enc=MEMBERS, asMember=True), "triage")
        vector(f"content_members_comment_triage__{label}", "Each field is written only where the contract declares it.",
               dict(op="content", type="comment", shape=shape, doc=dict(enc=MEMBERS, asMember=True), role="triage"),
               got)


def read_vectors():
    cases = [
        ("read_public", {}, "A public document: no aud, no enc."),
        ("read_legacy_sealed", dict(enc=MEMBERS), "A sealed document without aud (sakura, or written before the "
                                                  "registration) is judged by enc alone."),
        ("read_members", dict(enc=MEMBERS, aud=1), "Members-only content with aud 1."),
        ("read_private", dict(enc=PRIVATE, aud=1), "A private repo's v0x01 with aud 1."),
        ("read_bot_post", dict(enc=BOT_POST, aud=1), "A bot's v0x05 post with aud 1."),
        ("read_letter", dict(enc=LETTER, aud=2), "A letter with aud 2."),
        ("read_members_as_letter", dict(enc=MEMBERS, aud=2), "aud 2 on members-only content is malformed."),
        ("read_letter_as_members", dict(enc=LETTER, aud=1), "aud 1 on a letter is malformed (encFraming refuses it "
                                                             "at consensus too)."),
        ("read_aud_without_enc", dict(aud=1), "aud without enc is malformed (dependentRequired refuses it)."),
        ("read_aud_out_of_range", dict(enc=MEMBERS, aud=3), "aud outside 1..2 is malformed."),
        ("read_config_framing", dict(enc=CONFIG, aud=1), "A content document framed as a config is malformed."),
    ]
    for name, doc, desc in cases:
        vector(name, desc, dict(op="read", type="comment", doc=doc), read(doc))


def event_vectors():
    sakura = dict(tAud=False, authorEnc=False)
    mainnet = dict(tAud=True, authorEnc=True)
    public, members, letter = {}, dict(enc=MEMBERS), dict(enc=LETTER)
    cases = [
        ("label_public_target", "event", public, True, "A label on a public issue: plaintext, no tAud."),
        ("label_members_target", "event", members, True, "A label on a members-only issue: sealed."),
        ("assign_members_target", "event", members, False, "An event without a value on a members-only issue."),
        ("label_letter_target", "event", letter, True, "A value on a letter is refused: an event names no recipients."),
        ("close_reason_letter_target", "event", letter, False, "A valueless event on a letter."),
        ("bundled_target_label", "event", dict(members, bundled=True), True,
         "A label on an issue a maintainer's bundle made public: plaintext before the registration; on mainnet "
         "tAud stays 1 and tAudSealed refuses a plaintext value, so it is sealed."),
        ("retarget_public_target", "authorEvent", public, True, "An author's retarget of a public PR: plaintext."),
        ("retarget_members_target", "authorEvent", members, True,
         "An author's retarget of a members-only PR: refused where authorEvent has no enc, sealed where it has."),
        ("resolve_members_target", "authorEvent", members, False, "An author's valueless event on a members-only PR."),
    ]
    for name, typ, target, has_value, desc in cases:
        for label, shape in (("sakura", sakura), ("mainnet", mainnet)):
            t = dict(target)
            if shape["tAud"] and t.get("enc") is not None:
                t["aud"] = 2 if enc_version(t["enc"]) == 0x04 else 1
            vector(f"event_{name}__{label}", f"{desc} ({label} contract)",
                   dict(op="event", type=typ, shape=shape, target=t, value=has_value),
                   event(typ, shape, t, has_value))


def manifest_vectors():
    cases = [
        ("bundle_maintainer", 7, 1, "A maintainer's make-public bundle (kind 7)."),
        ("env_snapshot_maintainer", 8, 1, "A maintainer's environment snapshot (kind 8)."),
        ("reserved_9", 9, 1, "Kind 9 (reserved) is maintainer-only too."),
        ("access_notice_maintainer", 11, 1, "A maintainer's access notice (kind 11)."),
        ("pack_writer", 0, 1, "A writer's git pack keeps r 1."),
        ("key_letter_writer", 10, 1, "A writer's key letter (kind 10) keeps r 1."),
        ("browse_index_triage", 1, 2, "Any other kind keeps the role it claimed."),
    ]
    for name, kind, claimed, desc in cases:
        for label, shape in (("sakura", dict(maintKinds=False)), ("mainnet", dict(maintKinds=True))):
            vector(f"manifest_r_{name}__{label}", f"{desc} ({label} contract)",
                   dict(op="manifestR", shape=shape, kind=kind, claimed=claimed), manifest_r(shape, kind, claimed))


def build():
    VECTORS.clear()
    content_vectors()
    read_vectors()
    event_vectors()
    manifest_vectors()


def self_check():
    assert content(MAINNET, dict(enc=MEMBERS, asMember=True), "writer") == dict(aud=1, mRole=1)
    assert content(SAKURA, dict(enc=MEMBERS, asMember=True), "writer") == dict(aud=None, mRole=None)
    assert content(MAINNET, dict(enc=LETTER), None) == dict(aud=2, mRole=None)
    assert content(MAINNET, dict(asMember=True), "maintainer") == dict(aud=None, mRole=None)
    assert read(dict(enc=LETTER, aud=1)) == "malformed"
    assert event("authorEvent", dict(tAud=False, authorEnc=False), dict(enc=MEMBERS), True)["value"] == "refused"
    assert manifest_r(dict(maintKinds=True), 8, 1) == 0


def write_vectors(out_dir):
    build()
    for old in glob.glob(os.path.join(out_dir, f"{CASE}__*.json")):
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
    self_check()
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "..", "..", "forge-contracts", "vectors")
    if "--write-vectors" in sys.argv:
        write_vectors(out)
    else:
        build()
        print(json.dumps(dict(total=len(VECTORS)), indent=1))

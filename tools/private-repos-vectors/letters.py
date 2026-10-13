"""Independent Python reference for who a letter goes to (mixed-visibility DESIGN §4.2, D2, D26).

    python3 tools/private-repos-vectors/letters.py                 # check the reference, print counts
    python3 tools/private-repos-vectors/letters.py --write-vectors  # (re)write forge-contracts/vectors/role_group_letter__*.json

A letter (`enc` v0x04) to a role group or to specific people is sealed to a list fixed when it is
posted. Every vector has case `role_group_letter`: from the repository's owner and member documents,
the writer, the identities with no usable encryption key, what the writer asked for (a preset, people,
or the picker's exact list) and the letters it replies under, it says who the letter goes to, who is
left out for having no key, and the group the TLV names (tag 29), or why it is refused before signing:

- a preset resolves to the group's current people: Maintainers = the owner and the maintainers;
  Writers and maintainers = also the role-1 writers (never triage members or readers). The writer is
  always slot 0, in the group or not ("and you"); the rest are in ascending id order;
- a reply re-lists its parents: a Specific-people parent's list, or a group parent's group as it is now
  plus that parent's writer, so someone who joined the group since reads from the reply on (D26);
- a reply may name more people (widening) but never fewer: the picker's exact list must hold every
  parent's recipients, except people a group parent listed who have left the group since;
- people named one by one with no usable encryption key are refused (the picker greys them); a
  group's or a parent's people with none are left out and reported;
- under a members-only parent every recipient must be a member;
- at most 16 recipients, the writer included (the slots sit in one 5,120-byte field);
- the group tag is written only when everyone the letter goes to is in that group, or is the writer.

The Rust harness (`forge_core::rules`, `rules::letters`) and the TypeScript harness
(`forge-web/lib/rules/conformance.test.ts`, `lib/rules/letters.ts`) run every file and must reproduce it
exactly.
"""
import glob
import json
import os
import sys

VECTORS = []
MAX_RECIPIENTS = 16
GROUP_ROLES = {"maintainers": {"maintainer"}, "writers": {"maintainer", "writer"}}


def vector(name, description, inp, expected):
    VECTORS.append(dict(name=name, description=description, case="role_group_letter", rules="v2", input=inp,
                        expected=expected))


# --- the reference rule ---------------------------------------------------------------------------


def group_now(group, owner, members):
    return {owner} | {m["identity"] for m in members if m["role"] in GROUP_ROLES[group]}


def inherited(p, owner, members):
    if p.get("group"):
        return group_now(p["group"], owner, members) | {p["recipients"][0]}
    return set(p["recipients"])


def required(p, owner, members):
    if not p.get("group"):
        return set(p["recipients"])
    now = group_now(p["group"], owner, members)
    return {p["recipients"][0]} | {r for r in p["recipients"][1:] if r in now}


def plan(i):
    owner, sender, members = i["owner"], i["sender"], i["members"]
    keyless, parents = set(i["keyless"]), i["parents"]
    request, exact = i.get("request"), i.get("exact")
    if exact is not None:
        want = set(exact) | {sender}
        missing = set()
        for p in parents:
            missing |= required(p, owner, members) - want
        if missing:
            return dict(error="narrower", people=sorted(missing))
        named = set()
    else:
        if request is None and not parents:
            return dict(error="noRecipients")
        want = {sender}
        for p in parents:
            want |= inherited(p, owner, members)
        named = set(request["people"]) if request else set()
        if request and request.get("group"):
            want |= group_now(request["group"], owner, members)
        want |= named
    no_key = sorted((named - {sender}) & keyless)
    if no_key:
        return dict(error="noEncryptionKey", people=no_key)
    if i["membersOnlyParent"]:
        outside = sorted(want - ({owner} | {m["identity"] for m in members}))
        if outside:
            return dict(error="notMembers", people=outside)
    skipped = sorted((want - {sender}) & keyless)
    recipients = [sender] + sorted(want - {sender} - keyless)
    if len(recipients) > MAX_RECIPIENTS:
        return dict(error="tooMany", count=len(recipients))
    candidate = None
    if exact is None:
        if request is not None:
            candidate = request.get("group") if not request["people"] else None
        else:
            groups = {p.get("group") for p in parents}
            candidate = groups.pop() if len(groups) == 1 else None
    tagged = candidate is not None and set(recipients) <= group_now(candidate, owner, members) | {sender}
    return dict(recipients=recipients, skipped=skipped, group=candidate if tagged else None)


# --- vectors --------------------------------------------------------------------------------------

# base58-shaped ids, fixed so the expected order is plain to read
OWNER = "6owner1111111111111111111111111111111111111"
M1 = "7maint1111111111111111111111111111111111111"
M2 = "7maint2222222222222222222222222222222222222"
W1 = "8writer111111111111111111111111111111111111"
W2 = "8writer222222222222222222222222222222222222"
T1 = "9triage11111111111111111111111111111111111"
R1 = "Areader11111111111111111111111111111111111"
FRANK = "Bfrank111111111111111111111111111111111111"
STRANGER = "Cstranger11111111111111111111111111111111"

TEAM = [dict(identity=M1, role="maintainer"), dict(identity=W1, role="writer"), dict(identity=W2, role="writer"),
        dict(identity=T1, role="triage"), dict(identity=R1, role="reader")]


def case(name, description, *, sender, request=None, exact=None, parents=(), members=TEAM, keyless=(),
         members_only_parent=False, expect=None):
    inp = dict(owner=OWNER, sender=sender, members=list(members), keyless=list(keyless), request=request,
               exact=exact, parents=list(parents), membersOnlyParent=members_only_parent)
    got = plan(inp)
    if expect is not None:
        assert got == expect, (name, got)
    vector(name, description, inp, got)


def req(group=None, people=()):
    return dict(group=group, people=list(people))


def write_all():
    case("maintainers_by_owner", "the owner sends to Maintainers: the owner and the one maintainer; writers, triage "
         "and readers are not in the group; tag 29 names it.", sender=OWNER, request=req("maintainers"),
         expect=dict(recipients=[OWNER, M1], skipped=[], group="maintainers"))
    case("maintainers_and_you", "a writer sends to Maintainers: the writer is slot 0 although not in the group "
         "(\"and you\"), then the owner and the maintainer; still tagged as the group.", sender=W1,
         request=req("maintainers"), expect=dict(recipients=[W1, OWNER, M1], skipped=[], group="maintainers"))
    case("writers_and_maintainers", "Writers and maintainers: the owner, maintainers and role-1 writers, never "
         "triage members or readers.", sender=M1, request=req("writers"),
         expect=dict(recipients=[M1, OWNER, W1, W2], skipped=[], group="writers"))
    case("group_member_without_key_left_out", "a maintainer with no usable encryption key is left out of a "
         "Maintainers letter and reported, not refused.", sender=OWNER, request=req("maintainers"),
         members=TEAM + [dict(identity=M2, role="maintainer")], keyless=[M2],
         expect=dict(recipients=[OWNER, M1], skipped=[M2], group="maintainers"))
    case("person_without_key_refused", "a person named one by one with no usable encryption key is refused before "
         "signing (the picker greys them).", sender=W1, request=req(people=[FRANK]), keyless=[FRANK],
         expect=dict(error="noEncryptionKey", people=[FRANK]))
    many = [dict(identity="M" + "ABCDEFGHJKLMNPQRSTUVWXYZ"[i] + "maint" + "1" * 36, role="maintainer") for i in range(20)]
    case("group_over_16_refused", "a Maintainers preset of 21 people (the owner and 20 maintainers) is refused: a "
         "message goes to at most 16, the writer included.", sender=OWNER, request=req("maintainers"), members=many,
         expect=dict(error="tooMany", count=21))
    case("group_of_16", "16 people, the writer included, fit.", sender=OWNER, request=req("maintainers"),
         members=many[:15], expect=dict(recipients=[OWNER] + sorted(m["identity"] for m in many[:15]), skipped=[],
                                       group="maintainers"))
    case("specific_people", "Specific people: the writer, then the people named in id order; no group tag. "
         "Strangers may be named.", sender=W1, request=req(people=[STRANGER, FRANK]),
         expect=dict(recipients=[W1, FRANK, STRANGER], skipped=[], group=None))
    p3 = dict(recipients=[W1, FRANK, STRANGER], group=None)
    case("reply_inherits_people", "a reply that asks for nothing goes to its parent letter's people, its writer "
         "first.", sender=FRANK, parents=[p3], expect=dict(recipients=[FRANK, W1, STRANGER], skipped=[], group=None))
    case("reply_widens", "a reply naming someone else goes to the parent's people and them: they read from this "
         "reply on.", sender=W1, request=req(people=[M1]), parents=[p3],
         expect=dict(recipients=[W1, M1, FRANK, STRANGER], skipped=[], group=None))
    pm = dict(recipients=[OWNER, M1], group="maintainers")
    team2 = TEAM + [dict(identity=M2, role="maintainer")]
    case("reply_relists_group", "a reply under a Maintainers letter re-lists the group as it is now: a maintainer "
         "added since is on it (reads from this reply on); still tagged.", sender=M1, parents=[pm], members=team2,
         expect=dict(recipients=[M1, OWNER, M2], skipped=[], group="maintainers"))
    demoted = [dict(identity=M1, role="writer")] + TEAM[1:]
    pw = dict(recipients=[W1, OWNER, M1], group="maintainers")
    case("reply_drops_who_left_group", "the parent went to Maintainers from a writer; the maintainer has since "
         "become a writer, so the re-listed group leaves them out; the parent's writer stays (slot 0 of the "
         "parent). No group tag: that writer is neither in the group nor this reply's writer.", sender=OWNER,
         parents=[pw], members=demoted, expect=dict(recipients=[OWNER, W1], skipped=[], group=None))
    case("exact_narrower_refused", "the picker's list leaves out someone the parent letter went to: a narrower "
         "reply is refused.", sender=W1, exact=[W1, FRANK], parents=[p3],
         expect=dict(error="narrower", people=[STRANGER]))
    case("exact_superset", "the picker's list holds every parent recipient and one more: allowed, no group tag.",
         sender=W1, exact=[W1, FRANK, STRANGER, M1], parents=[p3],
         expect=dict(recipients=[W1, M1, FRANK, STRANGER], skipped=[], group=None))
    case("exact_may_drop_who_left_group", "the picker's list may leave out someone a group parent listed who has "
         "left the group since.", sender=OWNER, exact=[OWNER, W1], parents=[pw], members=demoted,
         expect=dict(recipients=[OWNER, W1], skipped=[], group=None))
    case("members_only_parent_stranger_refused", "under a members-only parent every recipient must be a member: "
         "naming a stranger is refused.", sender=W1, request=req(people=[STRANGER]), members_only_parent=True,
         expect=dict(error="notMembers", people=[STRANGER]))
    case("members_only_parent_group", "a Maintainers letter under a members-only parent: everyone is a member.",
         sender=W1, request=req("maintainers"), members_only_parent=True,
         expect=dict(recipients=[W1, OWNER, M1], skipped=[], group="maintainers"))
    case("group_plus_person_untagged", "a preset plus a person named: the letter goes to both and carries no group "
         "tag (not everyone is in the group).", sender=OWNER, request=req("maintainers", [FRANK]),
         expect=dict(recipients=[OWNER, M1, FRANK], skipped=[], group=None))
    case("nothing_asked_no_parent", "no preset, no people and no parent letter: nothing to send to.", sender=W1,
         expect=dict(error="noRecipients"))
    case("mixed_parents_untagged", "a reply under a Maintainers letter and a Writers-and-maintainers one: the union, "
         "and no group tag (the parents disagree).", sender=OWNER,
         parents=[dict(recipients=[OWNER, M1], group="maintainers"), dict(recipients=[W1, OWNER, M1, W2],
                                                                          group="writers")],
         expect=dict(recipients=[OWNER, M1, W1, W2], skipped=[], group=None))


def write_vectors(out_dir):
    for old in glob.glob(os.path.join(out_dir, "role_group_letter__*.json")):
        os.remove(old)
    for v in VECTORS:
        with open(os.path.join(out_dir, f"{v['case']}__{v['name']}.json"), "w") as f:
            f.write(json.dumps(v, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    write_all()
    if "--write-vectors" in sys.argv:
        here = os.path.dirname(os.path.abspath(__file__))
        write_vectors(os.path.join(here, "..", "..", "forge-contracts", "vectors"))
    print(json.dumps(dict(total=len(VECTORS)), indent=1))

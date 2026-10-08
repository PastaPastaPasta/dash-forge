#!/usr/bin/env python3
"""Build the RC2 registration (forge-core, forge-collab, forge-community) from the base schemas,
and with --mainnet the four-contract mainnet set (plus forge-meta, DESIGN rev 4.1 D44).

  python3 forge-contracts/schema/build.py [--check] [--off flag,flag] [--on flag,flag] [--out <dir>]
                                          [--mainnet] [--validate <contract-validate>] [--gate <b7gate>]

`base/` holds the three schemas registered-to-be before RC1 (the #154 build: the `refersTo`
grammar with WIPE-DECISIONS D-2..D-5 applied), with checkRun's set-once fields written as
Platform v5 conditional `immutable` entries (RC2 item M1: v5 refuses `immutableAllowSetting`).
This script applies the RC1 items of `design/SCOPE-DECISION.md` / WIPE-DECISIONS D-10..D-12 and
the RC2 items of `design/v5/PLAN.md` §3 on top, each behind a flag in FLAGS, and writes
`forge-contracts/contracts/{forge-core,forge-collab,forge-community}.json` plus
`contracts/registered/forge-core.v1.json` (RC1 and RC2 register fresh, so the registered core is
the new core).

--check     write nothing; exit 1 when the committed contracts differ from a fresh build (CI).
--off/--on  turn flags off (or on) for a variant: nothing is written unless --out names a directory,
            so the committed contracts always match FLAGS. A registration-time decision (a fee
            probe that turns an RC2 item off) is made by flipping its default in FLAGS and
            regenerating, never by registering an --out variant.
--out       write the three files (four with `layout_meta`) to this directory instead of
            forge-contracts/contracts.
--mainnet   turn on every built MAINNET_FLAGS item (the four-contract layout and the mixed-visibility
            items of DESIGN rev 4.1 §8.3 included): the fresh mainnet registration. Needs --out.
--validate  run tools/contract-validate (rs-dpp v5.0.0-beta.3) on the result and print each
            contract's serialized size and create-transition size against the D-12 budget and
            the 20,480-byte transition limit. forge-contracts/schema/variants.py does this for
            every combination of the RC2 flags and of the mainnet items.
--gate      run b7gate (design/final-schema/b7gate, rs-dpp v4.2.0-beta.7): RC1 only, since beta.7
            refuses RC2's forge-community (an `immutable` entry that is an object).

Item ids (R-xx, O-xx, INV-11, CL-7, CL-8, COMM-9) are those of dash-forge-qa
beta6/RULES-PROPOSAL.md and beta6/OPPORTUNITIES.md; the docs in docs/contracts/forge-v2.md
describe the result.
"""
import argparse
import base64
import copy
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACTS = os.path.join(os.path.dirname(HERE), 'contracts')
# The schemas each network registered (version 1); an in-place update is validated against them.
REGISTERED = os.path.join(CONTRACTS, 'registered')
NAMES = ('forge-core', 'forge-collab', 'forge-community')
# The fourth contract (MAINNET_FLAGS `layout_meta`, DESIGN rev 4.1 D44), registered after the three
META = 'forge-meta'
CORE = 'FORGE_CORE_CONTRACT_ID'
COLLAB = 'FORGE_COLLAB_CONTRACT_ID'
COMMUNITY = 'FORGE_COMMUNITY_CONTRACT_ID'
PLACEHOLDER = {'forge-core': CORE, 'forge-collab': COLLAB, 'forge-community': COMMUNITY}

# D-12: aim for TARGET gate bytes per contract; CEILING is hard (>= 2 KB of real signed room).
TARGET, CEILING = 17408, 17832
# DESIGN rev 4.1 D44: the four-contract mainnet set waives the ceiling where its measured sizes need
# it, and every contract keeps at least ROOM_MIN bytes between its create transition and the limit.
ROOM_MIN = 2000
# Protocol 14's max_state_transition_size (v5: rs-platform-version system_limits/v4.rs:108)
TRANSITION_LIMIT = 20480

# ---- RC1 flags (D-10, D-11). Off: protected_ref (R-05), ref_ledger (O-09), label_tags (O-10).
FLAGS = dict(
    # layout (D-11)
    layout_events_out=True,     # O-01: event, authorEvent, milestone -> forge-community
    layout_runner_out=True,     # O-02: runner -> forge-community
    layout_repokey_collab=True,  # O-03: repoKey -> forge-collab
    # P0
    ref_grammar=True,           # R-01: git ref-name grammar
    ref_no_at_brace=True,       # R-01 refinement: `@{` refused too (D-12 cuts it first)
    vis_core=True,              # R-02: private => no plaintext on forge-core documents
    vis_collab=True,            # R-03: private => sealed on collab documents
    import_provenance=True,     # R-04: imported / upstreamNumber only from a proved member
    member_consent=True,        # R-06: no membership without the member's consent
    url_grammar=True,           # R-07: https-only links, public-DNS webhook targets
    check_sources=True,         # R-08: required checks with a pinned source
    # P1
    pack_complete=True,         # R-09: a Platform manifest proves chunks 0..n-1
    oid_width=True,             # R-10: every oid is 20 or 32 bytes
    pack_kind_shape=True,       # R-11: history index kind 3, release assets kind 4
    repo_shape=True,            # R-12: public forks of public parents, no private branch, no *.git
    wrap_member=True,           # R-13: repoKey wraps only to a current member
    reply_thread=True,          # R-14: replies name a live root comment of the same thread
    thread_lock=True,           # R-15: on-chain lock bit (transition sums mod 16)
    member_verdicts=True,       # R-16: member-proved approve / request changes, verdicts 4/5
    checkrun_sanity=True,       # R-17: ordered ms-epoch times, not in the future
    private_ci=True,            # R-18: a private check run carries no text
    hook_public=True,           # R-19: no webhooks on private repos
    topic_public=True,          # R-20: public-only topics, <= TOPIC_CAP per repo
    release_ledger=True,        # O-04: one live release per tag, no deletes
    pack_bytes=True,            # O-05: proved Platform-stored bytes per repo
    explore_recent=True,        # O-06: public-only Explore feed with proved counters
    check_outcome=True,         # O-07: proved per-commit check summary
    trending_public=True,       # O-08: Trending counts public repos, never the owner's own
    # zero-fee P2 grammar (D-10)
    free_tightenings=True,      # INV-11: enc >= 29 B, config enc v2, unique protected patterns
    text_grammar=True,          # CL-7: titles and bodies hold a visible character
    label_grammar=True,         # CL-8: label names trimmed, no control characters (no cap)
    social_counters=True,       # COMM-9 (provisional, step-8 fee gate): star/watch counts
    # ---- RC2 (Platform v5.0.0-beta.1; design/v5/PLAN.md §3, owner decisions 2026-10-01). M1 is
    # no flag: it is in base/. S2, S3 and C1 are decided at registration by a fee probe on the v5
    # network (S2 and S3 each <= +10 % per review write, C1 <= 54.9 M credits per star): a probe
    # that fails turns its flag off here (python3 build.py --off <flag> --out <dir> builds the
    # probe variants).
    check_evidence_freeze=True,  # S1: a completed run's summary, links, log and artifacts are frozen
    # S2 and S3 OFF: the sakura v5 probe (2026-10-01, n=4) priced a review at 53.94 M credits
    # without either index, +26.73 % with S2 and +26.70 % with S3, against the <= +10 % gate.
    review_to_author=False,      # S2: review index [patchId.$ownerId, $createdAt]: reviews on my PRs
    review_author=False,         # S3: review index [$ownerId, $createdAt]: the reviews I wrote
    fused_star=True,             # C1: star carries the trending window (byWeek, outlivesDelete); no starBeat
                                 # (sakura probe: 45.49 M per star, under star + starBeat 55.09 M and 54.9 M)
    # ---- RC2 riders (design/v5/RIDERS.md): forge-collab only, each in RC2 if ready before registration
    close_reason=True,           # QW-069: transition.reason / dupNumber, judged by readers (no rule)
    review_hunk=True,            # QW2-010: comment.diffHunk for mirrored review comments (immutable, noPlain)
    # ---- RC2 moderation (design/v5/MODERATION.md): forge-community event only. Decided at
    # registration by a fee probe like S2/S3 (<= +10 % per hide), and fixed once registered
    # (refersTo / findBy never change on an update).
    event_as_maintainer=True,    # MOD: a hide / unhide (event kinds 24/25) proves its writer a maintainer
    # ---- RC2 member roles (design/v5/RECUT-OR-NEVER.md, owner decision 2026-10-01): writer.role
    # 1 writer / 2 triage / 3 reader, and a claimed `r` the writer leaf proves on every gated type.
    # Re-cut-or-never: a `where` added to a registered writer leaf is refused on update.
    member_roles=True,           # ROLES: writer.role + r on refUpdate/packManifest/chunk/label/transition/event/milestone/checkRun
    # ---- UPDATE-1 (roadmap D4, owner decision 2026-10-04; dash-forge-qa design/v5/CONTRACT-UPDATE-1.md):
    # one in-place DataContractUpdate of all three registered contracts (version 1 -> 2 on sakura)
    # and the same additions in the mainnet registration. Only what protocol 14 lets an update add
    # (forge-v2.md §9): new optional properties and new document types with their own indexes. No
    # rule, index, reference or required field on an existing type. Each flag off reproduces the
    # registered v1 schema (registered/<contract>.v1.json, checked by --check).
    release_target_oid=True,     # release.targetOid: the commit the tag named at publish (optional, never requiredSince)
    config_moved_to=True,        # config.movedTo: the successor repository's id (TS-11 succession)
    pack_mirror=True,            # packMirror: anyone records an external copy of a listed pack (TS-10, RECUT O-2)
    transition_closed_by_pr=True,  # transition.closedByPr: the PR number whose merge closed this issue
    profile_key_proofs=True,     # profile.keyProofs: possession proofs for profile.pubkeys (client-rules #5)
    profile_bot=True,            # profile.bot: {operator} on a bot, {operates} on its operator (DX-15)
    author_retarget=True,        # authorEvent kind 8 + value: the PR author retargets (power R-STACK-1)
    policy_code_owners=True,     # policy.requireCodeOwners: CODEOWNERS approval declared on chain
    repo_ban=True,               # ban: a maintainer's per-repo ban list, applied by readers (TS-08 c)
)
# The UPDATE-1 items: every one off is the registered v1 set (registered/*.v1.json).
UPDATE1_FLAGS = ('release_target_oid', 'config_moved_to', 'pack_mirror', 'transition_closed_by_pr', 'profile_key_proofs',
                 'profile_bot', 'author_retarget', 'policy_code_owners', 'repo_ban')
# ---- Mainnet-only (a fresh registration may add them; an update never can: rules, references and
# required fields on existing types are frozen, forge-v2.md §9). Off in every devnet build; the mainnet
# registration turns them on with --mainnet. Each is documented in docs/contracts/forge-v2.md §9.1.
MAINNET_FLAGS = dict(
    mainnet_release_target=False,  # release: a public publish (+1) names targetOid; a sealed revision never does
    mainnet_retarget_value=False,  # authorEvent: kind 8 names its new base in `value`; `value` only on kind 8
    mainnet_moved_to_public=False,  # config: no plaintext movedTo beside a sealed config (noPlain)
    mainnet_mirror_public=False,   # packMirror: a stranger's mirror only for a public repo (where vis)
    # ---- Mixed visibility (dash-forge-qa design/mixed-visibility/DESIGN.md rev 4.1 §8.3, items 0-11).
    # Rule numbers (row N) are §8.2's; docs/contracts/forge-v2.md §9.1 describes each.
    layout_meta=False,             # 0 D44: a fourth contract, forge-meta, registered last, takes repoKey, ban,
                                   #   label, topic, packMirror, profile and follow (no rule reads them)
    mainnet_aud=False,             # 1 L1: aud on issue/patch/comment/review; aud = 1 => asMember; a private
                                   #   repo's content is aud + asMember; aud only ever dropped (rows 1-3)
    mainnet_one_way_visibility=False,  # 2 C1: repo.visibility frozen once public (private -> public, once; row 18)
    mainnet_vis_via_repo=False,    # 3 L3 + C4: comment, review, refUpdate, protectedRefUpdate, config, release,
                                   #   webhook prove vis against the repo, not the target or the member row (rows 17, 41)
    mainnet_member_role=False,     # 4 L2: mRole proved by the asMember writer leaf; verdicts 1/2 and provenance
                                   #   need mRole <= 1 (rows 5, 6)
    mainnet_bot_role=False,        # 5 C2 + L4: writer.role 4 (Bot); repoKey.mr, so a wrap never goes to a bot (row 14)
    mainnet_maint_kinds=False,     # 6 C3: packManifest r = 0 is maintainer-only; kinds 7, 8, 9, 11 need it (rows 9-11)
    mainnet_check_aud=False,       # 7 M1: checkRun.aud; a private or aud run carries no text, may carry a log link (rows 12, 13)
    mainnet_event_kinds=False,     # 8 M2: triage writes only the triage event kinds; kind 23 maintainer-only (rows 7, 8)
    mainnet_event_target_aud=False,  # 9 M4: event.tAud = the target's aud; no plaintext value on a sealed target (row 16)
    mainnet_author_event_enc=False,  # 10 M3: authorEvent enc/epoch and tAud; no plaintext value on a sealed target (row 19)
    mainnet_bot_push=False,        # 11 B1: pushGrant; a bot's refUpdate (r = 4) only under a live grant of a current
                                   #   maintainer; bot packs and chunks of the push kinds only (rows 42-45)
    # Declared, not built: each needs a design pass and a re-cut test before it can be switched on.
    mainnet_consensus_archive=False,  # repo.archived refuses every gated write (client-rules #10)
    mainnet_epoch_writes=False,    # sealed writes only under the current epoch (client-rules §11-18)
)
MAINNET_UNBUILT = ('mainnet_consensus_archive', 'mainnet_epoch_writes')
# The mixed-visibility items (DESIGN rev 4.1 §8.3), in its order: variants.py validates every
# combination of them, with and without the four-contract layout.
MV_FLAGS = ('layout_meta', 'mainnet_aud', 'mainnet_one_way_visibility', 'mainnet_vis_via_repo', 'mainnet_member_role',
            'mainnet_bot_role', 'mainnet_maint_kinds', 'mainnet_check_aud', 'mainnet_event_kinds',
            'mainnet_event_target_aud', 'mainnet_author_event_enc', 'mainnet_bot_push')
# What each flag needs: a `where` naming a property the other adds (else 40126 at registration), a
# rule rewriting one the other adds, or (B1) the room only the four-contract layout leaves in
# forge-core. build() refuses a combination that breaks one.
NEEDS = {
    'hook_public': ('vis_core',), 'vis_collab': ('layout_events_out',), 'import_provenance': ('layout_events_out',),
    'thread_lock': ('import_provenance',), 'member_verdicts': ('import_provenance',), 'wrap_member': ('vis_core',),
    'layout_meta': ('layout_events_out', 'layout_repokey_collab'),
    'mainnet_aud': ('vis_collab', 'import_provenance', 'member_verdicts'),
    'mainnet_vis_via_repo': ('vis_core', 'vis_collab', 'hook_public'),
    'mainnet_member_role': ('member_roles', 'member_verdicts', 'import_provenance'),
    # without L2 a role-4 row passes the role-blind asMember leaf, and so memberVerdict and
    # i_provenance (DESIGN §8.2 row 15 is C2 + L2)
    'mainnet_bot_role': ('member_roles', 'wrap_member', 'mainnet_member_role'),
    'mainnet_maint_kinds': ('member_roles',),
    'mainnet_check_aud': ('private_ci',),
    'mainnet_event_kinds': ('member_roles', 'event_as_maintainer'),
    # tAud is the target's aud: the referenced issue and patch must carry it
    'mainnet_event_target_aud': ('mainnet_aud',),
    'mainnet_author_event_enc': ('mainnet_aud',),
    # a bot's push gate admits role 4 rows, and forge-core holds it only with label, topic and
    # packMirror moved to forge-meta (create transition 18,129 B with them out, about 21 KB without)
    'mainnet_bot_push': ('mainnet_bot_role', 'layout_meta'),
}
# The RC2 items with a flag: forge-contracts/schema/variants.py validates every combination.
RC2_FLAGS = ('check_evidence_freeze', 'review_to_author', 'review_author', 'fused_star', 'event_as_maintainer',
             'member_roles')
# The event and transition kinds only a role-1 writer (or a maintainer) may write: retarget (8),
# review dismiss (15), head update (16), pin / unpin (19, 20), policy bypass (23); merge (13),
# draft (14), ready (15).
WRITER_EVENT_KINDS = [8, 15, 16, 19, 20, 23]
# The role-gated types (forge-core, forge-collab, forge-community) and the highest role `r` each
# admits: push class and check runs are role 1 only, the triage types 1..2.
ROLE_GATED = {'refUpdate': 1, 'packManifest': 1, 'chunk': 1, 'transition': 2, 'event': 2, 'label': 2,
              'milestone': 2, 'checkRun': 1}
WRITER_TRANSITION_KINDS = [13, 14, 15]
# M2: the event kinds triage may write (forge-v2.md §2.1): label +/-, assign, unassign, thread
# resolve and unresolve, review request and its removal, milestone set and clear. Every other kind,
# and every kind defined later, is closed to triage.
TRIAGE_EVENT_KINDS = [4, 5, 6, 7, 11, 12, 13, 14, 17, 18]
# M2: a policy bypass (23) proves its writer a maintainer, as a hide does
BYPASS_KIND = 23
# C3: the pack-manifest kinds only a maintainer writes (r = 0): make-public bundle 7, environment
# snapshot 8, reserved 9, access notice 11
MAINT_PACK_KINDS = [7, 8, 9, 11]
# B1: the pack-manifest kinds a bot (r = 4) writes: a push's pack (0) and browse index (1), a long
# body (6), and their members-only forms (64, 65, 70 = 64 + 6)
BOT_PACK_KINDS = [0, 1, 6, 64, 65, 70]
# B1: a push grant lasts at most 90 days (ms)
GRANT_TTL_MS = 90 * 24 * 3600 * 1000
# D44: the types forge-meta takes, from the contract that holds them in the three-contract set
META_TYPES = {'forge-collab': ('repoKey', 'ban'), 'forge-core': ('label', 'topic', 'packMirror'),
              'forge-community': ('profile', 'follow')}
# The riders: independent of the RC2 items (other types and properties), so variants.py turns
# each off only with every RC2 item on, the largest build.
RIDER_FLAGS = ('close_reason', 'review_hunk')
TOPIC_CAP = 20

ID = {"type": "array", "byteArray": True, "minItems": 32, "maxItems": 32,
      "contentMediaType": "application/x.dash.dpp.identifier"}
VIS = {"type": "string", "enum": ["public", "private"]}
PUBLIC = {"equal": ["vis", {"const": "public"}]}


def ident(**kw):
    return dict(ID, **kw)


def idx(t, name):
    return next(i for i in t['indices'] if i['name'] == name)


def next_pos(t):
    return max(p['position'] for p in t['properties'].values()) + 1


def add_prop(t, name, schema, required=False, immutable=False):
    t['properties'][name] = dict(schema, position=next_pos(t))
    if required:
        t['required'].append(name)
    if immutable:
        freeze(t, name)


def freeze(t, name, when=None):
    """List `name` under the type's `immutable`: frozen outright, or (v5) while `when` holds. A
    name frozen outright goes before the conditional entries, which keep their order."""
    imm = t.setdefault('immutable', [])
    if when is not None:
        imm.append({"property": name, "when": when})
        return
    imm.insert(next((k for k, e in enumerate(imm) if isinstance(e, dict)), len(imm)), name)


def leaves(decl):
    return decl['anyOf'] if 'anyOf' in decl else [decl]


def find_leaf(doc_type, contract=None):
    """A `findBy {repoId, memberId: "."}` leaf: the writer (or the value) holds a `doc_type` of the repo."""
    leaf = {"type": "deletableDocument", "documentType": doc_type, "findBy": {"repoId": "repoId", "memberId": "."}}
    return dict({"type": "deletableDocument", "contractId": contract}, **leaf) if contract else leaf


def member_ref(contract=None):
    return {"anyOf": [find_leaf("maintainer", contract), find_leaf("writer", contract)]}


# ---- R-01 patterns ----------------------------------------------------------------------------
# git check-ref-format as a Rust regex (no lookaround). A component character excludes controls,
# space, DEL, ~ ^ : ? * [ \ and the separators / and '.'; `(?:\.?/|\.)` between two component
# characters rules out '..', '/.', '//', a leading or trailing '/' or '.', and a component that
# starts with '.'. With `ref_no_at_brace` a component is also a run with no '@' right before a
# '{' (RP7-01's form), so `@{` is refused. A non-final component ending in `.lock` is not
# (reader rule).
def ref_patterns(at_brace):
    sep = r'(?:\.?/|\.)'
    if at_brace:
        d = r'[^\x00- \x7f~^:?*\[\\/.@{]'
        comp = r'(?:(?:@*' + d + r'|\{)+@*|@+)'
        first = r'(?:@+' + d + r'|\{|[^\x00- \x7f~^:?*\[\\/.@{\-])(?:@*' + d + r'|\{)*@*'
    else:
        comp = r'[^\x00- \x7f~^:?*\[\\/.]'
        first = r'[^\x00- \x7f~^:?*\[\\/.\-]'
    tail = r'(?:' + sep + comp + r')*$'
    return dict(ref=r'^refs/' + comp + tail, tag=r'^' + comp + tail, branch=r'^' + first + tail)


HTTPS = r'^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'
LOG_URL = r'^(https://[^[:space:]/?#@]+|ipfs://[A-Za-z0-9]+)([/?#][^[:space:]]*)?$'
HOOK_URL = r'^https://([A-Za-z0-9-]+[.])+[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9](:[0-9]{1,5})?([/?#][^[:space:]]*)?$'
TOPIC = r'^[a-z0-9]+(-[a-z0-9]+)*$'
TITLE = r'^[^\x00-\x1f\x7f]*[^\s\x00-\x1f\x7f][^\x00-\x1f\x7f]*$'
LABEL = r'^[^\s\x00-\x1f\x7f]([^\x00-\x1f\x7f]*[^\s\x00-\x1f\x7f])?$'


def oid_rule(prop, optional):
    return {"in": [{"count": prop}, [0, 20, 32] if optional else [20, 32]]}


def tsum(target='targetId'):
    return {"sumOf": ["transition", "delta", {"targetId": target}]}


LOCK_KINDS = [3, 4, 18, 19]
# The maintainer moderation event kinds (design/v5/MODERATION.md §2): 24 hide, 25 unhide.
HIDE_KINDS = [24, 25]


def build(flags):
    base = {n: json.load(open(os.path.join(HERE, 'base', f'{n}.json'))) for n in NAMES}
    core, collab, comm = (copy.deepcopy(base[n]) for n in NAMES)
    cd, ld, md = core['documentSchemas'], collab['documentSchemas'], comm['documentSchemas']
    f = flags
    # Flags that only register together: a `where` naming a stamp needs the stamp (else 40126 at
    # registration), and collab's provenance and stamps only fit with events moved out (O-01).
    for flag, deps in NEEDS.items():
        for dep in deps:
            if f[flag] and not f[dep]:
                sys.exit(f'{flag} needs {dep}')

    # ======================= layout (D-11) =======================
    if f['layout_events_out']:
        # O-01. Community takes collab's value defs; the kinds must match for the cross-contract
        # where/findBy (40126).
        for d in ('num', 'u32', 'enc'):
            comm['schemaDefs'][d] = copy.deepcopy(collab['schemaDefs'][d])
        for t in ('event', 'authorEvent', 'milestone'):
            md[t] = ld.pop(t)
        for t in ('event', 'authorEvent'):
            for leaf in leaves(md[t]['properties']['targetId']['refersTo']):
                leaf['contractId'] = COLLAB
        for leaf in leaves(md['authorEvent']['ownerRefersTo']):
            leaf['contractId'] = COLLAB
    if f['layout_runner_out']:
        # O-02. runner.repoId refers across to the core repo; checkRun's runner operand becomes
        # same-contract.
        runner = cd.pop('runner')
        runner['properties']['repoId']['refersTo']['contractId'] = CORE
        md['runner'] = runner
        for leaf in leaves(md['checkRun']['ownerRefersTo']):
            if leaf['documentType'] == 'runner':
                del leaf['contractId']
    if f['layout_repokey_collab']:
        # O-03. collab already has the `id` and `u32` defs repoKey uses.
        rk = cd.pop('repoKey')
        rk['ownerRefersTo']['contractId'] = CORE
        ld['repoKey'] = rk
    rk_home = ld if f['layout_repokey_collab'] else cd
    rk_contract = CORE if f['layout_repokey_collab'] else None
    ev_home = md if f['layout_events_out'] else ld

    # ======================= forge-core =======================
    if f['ref_grammar']:
        pat = ref_patterns(f['ref_no_at_brace'])
        core['schemaDefs']['refName'].update({"minLength": 6, "pattern": pat['ref']})
        core['schemaDefs']['branch'] = {"type": "string", "minLength": 1, "maxLength": 255, "maxBytes": 255,
                                        "pattern": pat['branch']}
        for t in ('repo', 'config'):
            cd[t]['properties']['defaultBranch']['$ref'] = '#/$defs/branch'
        cd['release']['properties']['tagName']['pattern'] = pat['tag']
        for t in ('refUpdate', 'protectedRefUpdate'):
            cd[t]['propertyConstraints']['noLock'] = {"not": {"endsWith": ["refName", {"const": ".lock"}]}}
        collab['schemaDefs']['refName'].update({"minLength": 6, "pattern": pat['ref']})
        ld['patch']['properties']['sourceRefName'].update({"minLength": 6, "pattern": pat['ref']})

    if f['vis_core']:
        # R-02. `label` is left out on purpose: label definitions are plaintext in private repos.
        core['schemaDefs']['vis'] = VIS
        for t in ('maintainer', 'writer'):
            add_prop(cd[t], 'vis', {"$ref": "#/$defs/vis"}, required=True)
            cd[t]['properties']['repoId']['refersTo']['where']['visibility'] = 'vis'
        for t in ('refUpdate', 'protectedRefUpdate', 'config', 'release'):
            add_prop(cd[t], 'vis', {"$ref": "#/$defs/vis"}, required=True)
            for leaf in leaves(cd[t]['ownerRefersTo']):
                leaf.setdefault('where', {})['vis'] = 'vis'
            rule = cd[t]['propertyConstraints']['noPlain']['anyOf']
            assert rule[0] == {"absent": "enc"}, (t, rule)
            rule[0] = {"allOf": [{"absent": "enc"}, PUBLIC]}

    if f['member_consent']:
        # R-06. A member document names a consent its member wrote for the repo, unless the owner
        # enrols itself. The identity reference on memberId is redundant under the rule.
        cd['consent'] = {
            "type": "object", "documentsMutable": False, "canBeDeleted": True,
            "properties": {"repoId": ident(refersTo={"type": "permanentDocument", "documentType": "repo"}, position=0)},
            "indices": [{"name": "byRepoOwner", "properties": [{"repoId": "asc"}, {"$ownerId": "asc"}], "unique": True}],
            "required": ["$createdAt", "repoId"], "additionalProperties": False}
        for t in ('maintainer', 'writer'):
            m = cd[t]
            del m['properties']['memberId']['refersTo']
            add_prop(m, 'consentBy', ident(refersTo={"type": "deletableDocument", "documentType": "consent",
                                                     "findBy": {"repoId": "repoId", "$ownerId": "."}}))
            m['propertyConstraints'] = {"ownerOrConsented": {"anyOf": [
                {"equal": ["memberId", "$ownerId"]}, {"equal": ["consentBy", "memberId"]}]}}

    if f['pack_complete']:
        # R-09. packHash becomes an identifier (a byte array is no total key); `hid` because a
        # type may use a $def once and both types already use `id` for repoId.
        core['schemaDefs']['hid'] = copy.deepcopy(ID)
        for t in ('packManifest', 'chunk'):
            cd[t]['properties']['packHash']['$ref'] = '#/$defs/hid'
        idx(cd['chunk'], 'chunk').pop('rangeCountable', None)
        cd['chunk']['indices'].append({"name": "perPack", "properties": [
            {"repoId": "asc"}, {"$ownerId": "asc"}, {"packHash": "asc"}], "averageable": "seq"})
        pm = cd['packManifest']
        keys = {"repoId": "repoId", "$ownerId": "$ownerId", "packHash": "packHash"}
        pc = pm.setdefault('propertyConstraints', {})
        pc['platformChunks'] = {"ifThen": [{"equal": ["storage", 0]}, {"allOf": [
            {"equal": [{"countOf": ["chunk", keys]}, "chunkCount"]},
            {"equal": [{"sumOf": ["chunk", "seq", keys]},
                       {"divide": [{"multiply": ["chunkCount", {"subtract": ["chunkCount", 1]}]}, 2]}]}]}]}
        pc['storageShape'] = {"ifThenElse": [{"equal": ["storage", 0]},
                                             {"lessThanOrEqual": ["sizeBytes", {"multiply": ["chunkCount", 14700]}]},
                                             {"equal": ["chunkCount", 0]}]}
        del cd['manifestPart']
        del pm['properties']['offsetIndexParts']
        pm['required'].remove('offsetIndexParts')

    if f['oid_width']:
        for t in ('refUpdate', 'protectedRefUpdate'):
            cd[t]['propertyConstraints']['oidWidth'] = {"allOf": [oid_rule('newOid', False), oid_rule('prevOid', True)]}

    if f['pack_kind_shape']:
        # R-11. kind 3 = history index (tips = its tip oids), kind 4 = release assets.
        cd['packManifest'].setdefault('propertyConstraints', {})['kindShape'] = {"allOf": [
            {"equal": [{"modulo": [{"count": "supersedes"}, 32]}, 0]},
            {"ifThen": [{"equal": ["kind", 3]}, {"in": [{"count": "tips"}, [20, 32, 40, 64]]}]}]}

    repo = cd['repo']
    if f['repo_shape'] or f['explore_recent']:
        repo['properties']['visibility']['maxLength'] = 7
    if f['repo_shape']:
        repo['properties']['forkOf']['refersTo']['where'] = {"visibility": "visibility"}
        repo['propertyConstraints'] = {
            "forkIsPublic": {"anyOf": [{"absent": "forkOf"}, {"equal": ["visibility", {"const": "public"}]}]},
            "privateNoBranch": {"anyOf": [{"equal": ["visibility", {"const": "public"}]}, {"absent": "defaultBranch"}]},
            "nameNotDotGit": {"not": {"endsWith": ["name", {"const": ".git"}]}}}
    if f['explore_recent']:
        r = idx(repo, 'recent')
        r['properties'] = [{"visibility": "asc"}, {"$createdAt": "asc"}]
        r['rangeCountable'] = True

    if f['topic_public']:
        tp = cd['topic']
        add_prop(tp, 'vis', {"type": "string", "enum": ["public"], "maxLength": 6}, required=True)
        tp['properties']['repoId']['refersTo']['where']['visibility'] = 'vis'
        tp['properties']['name']['pattern'] = TOPIC
        repo['properties']['topics']['items']['pattern'] = TOPIC
        repo['properties']['topics']['maxItems'] = TOPIC_CAP
        tp['indices'].append({"name": "perRepo", "properties": [{"repoId": "asc"}], "countable": True})
        tp['propertyConstraints'] = {f"atMost{TOPIC_CAP}": {"lessThanOrEqual": [
            {"countOf": ["topic", {"repoId": "repoId"}]}, TOPIC_CAP]}}

    if f['release_ledger']:
        # O-04. delta: +1 publish, 0 edit or yank (and every sealed doc), -1 unpublish.
        rel = cd['release']
        rel['canBeDeleted'] = False
        add_prop(rel, 'delta', {"type": "integer", "minimum": -1, "maximum": 1}, required=True)
        rel['indices'].append({"name": "perTag", "properties": [{"repoId": "asc"}, {"tagName": "asc"}],
                               "summable": "delta", "rangeSummable": True})
        rel['propertyConstraints']['oneLive'] = {"ifThenElse": [
            {"present": "enc"}, {"equal": ["delta", 0]},
            {"equal": [{"sumOf": ["release", "delta", {"repoId": "repoId", "tagName": "tagName"}]},
                       {"min": [{"add": ["delta", 1]}, 1]}]}]}

    if f['pack_bytes']:
        # O-05. A summable property is a signed integer: bounds move into a rule (1 TiB cap).
        pm = cd['packManifest']
        pm['properties']['sizeBytes'] = {"type": "integer", "position": pm['properties']['sizeBytes']['position']}
        pm.setdefault('propertyConstraints', {})['sizeNonNeg'] = {"allOf": [
            {"greaterThanOrEqual": ["sizeBytes", 0]}, {"lessThanOrEqual": ["sizeBytes", 1099511627776]}]}
        pm['indices'].append({"name": "bytes", "properties": [{"repoId": "asc"}, {"storage": "asc"}, {"kind": "asc"}],
                              "summable": "sizeBytes"})

    if f['free_tightenings']:
        # INV-11 (policy.mergeMethods <= 15 is in check_sources).
        core['schemaDefs']['enc']['minItems'] = 29
        collab['schemaDefs']['enc']['minItems'] = 29
        if 'enc' in comm['schemaDefs']:
            comm['schemaDefs']['enc']['minItems'] = 29
        cd['config']['propertyConstraints']['encV2'] = {"anyOf": [{"absent": "enc"}, {"greaterThanOrEqual": [{"count": "enc"}, 61]}]}
        cd['config']['properties']['protectedPatterns']['uniqueItems'] = True

    if f['label_grammar']:
        cd['label']['properties']['name']['pattern'] = LABEL

    if f['wrap_member']:
        # R-13. The wrap's recipient must hold a member document; its key reference moves to
        # recipientKeyId.
        rk = rk_home['repoKey']
        rk['properties']['memberId']['refersTo'] = member_ref(rk_contract)
        rk['properties']['recipientKeyId']['refersTo'] = {
            "type": "identityPublicKey", "identityProperty": "memberId", "keyRequirements": {"purpose": "encryption"}}

    # ======================= forge-collab =======================
    if f['vis_collab']:
        # R-03. The stamp agrees with the repo (issue, patch) or with the target (comment, review).
        collab['schemaDefs']['vis'] = VIS
        for t in ('issue', 'patch', 'comment', 'review'):
            add_prop(ld[t], 'vis', {"$ref": "#/$defs/vis"}, required=True, immutable=t != 'review')
        for t in ('issue', 'patch'):
            ld[t]['properties']['repoId']['refersTo']['where'] = {"visibility": "vis"}
        for leaf in leaves(ld['comment']['properties']['targetId']['refersTo']):
            leaf['where']['vis'] = 'vis'
        ld['review']['properties']['patchId']['refersTo']['where']['vis'] = 'vis'
        sealed = {"present": "enc"}
        for t in ('issue', 'patch', 'comment'):
            ld[t]['propertyConstraints']['p_sealedIfPrivate'] = {"anyOf": [{"notEqual": ["vis", {"const": "private"}]}, sealed]}
        ld['review']['propertyConstraints']['p_sealedIfPrivate'] = {"anyOf": [
            {"notEqual": ["vis", {"const": "private"}]},
            {"allOf": [{"absent": "body"}, {"absent": "imported.author"}, {"absent": "imported.url"}]}]}

    def as_member(t):
        s = ld[t]
        if 'asMember' in s['properties']:
            return
        collab['schemaDefs']['member'] = ident(refersTo=member_ref(CORE))
        add_prop(s, 'asMember', {"$ref": "#/$defs/member"})
        s['propertyConstraints']['m_self'] = {"anyOf": [{"absent": "asMember"}, {"equal": ["asMember", "$ownerId"]}]}

    if f['import_provenance']:
        # R-04. `asMember` proves membership (the $def's refersTo); it is not immutable, so an
        # ex-member's edit can drop it.
        for t in ('issue', 'patch', 'comment'):
            as_member(t)
            freeze(ld[t], 'imported')
        for t in ('issue', 'patch'):
            ld[t]['propertyConstraints']['i_provenance'] = {"anyOf": [
                {"allOf": [{"absent": "imported"}, {"absent": "upstreamNumber"}]}, {"present": "asMember"}]}
        ld['comment']['propertyConstraints']['i_provenance'] = {"anyOf": [{"absent": "imported"}, {"present": "asMember"}]}

    if f['oid_width']:
        for t, p, opt in (('patch', 'headOid', False), ('transition', 'oid', True),
                          ('comment', 'commitOid', True), ('review', 'commitOid', False)):
            ld[t].setdefault('propertyConstraints', {})['oidWidth'] = oid_rule(p, opt)
        for t in ('event', 'authorEvent'):
            ev_home[t]['propertyConstraints']['oidWidth'] = oid_rule('oid', True)

    if f['reply_thread']:
        # R-14. A reply names a live comment of the same target that is itself no reply
        # (`noParent` is never set, so the agreement asks the parent's replyTo to be absent).
        cm = ld['comment']
        cm['properties']['replyTo']['refersTo'] = {"type": "deletableDocument", "documentType": "comment",
                                                   "where": {"targetId": "targetId", "replyTo": "noParent"}}
        add_prop(cm, 'noParent', ID)
        cm['propertyConstraints']['noParentSet'] = {"absent": "noParent"}
        cm['propertyConstraints']['rangeOrder'] = {"anyOf": [
            {"absent": "startLine"}, {"allOf": [{"present": "line"}, {"lessThanOrEqual": ["startLine", "line"]}]}]}

    if f['thread_lock']:
        # R-15. Lock is +16 on the same per-target sum: state rules read it mod 16.
        tr = ld['transition']
        tr['properties']['kind']['enum'] = sorted(set(tr['properties']['kind']['enum']) | set(LOCK_KINDS))
        tr['properties']['delta'].update({"minimum": -16, "maximum": 16})
        pc = tr['propertyConstraints']
        for r in ('c1_closedAfter', 'c2_openAfter', 'c3_mergedAfter', 'c4_draftAfter', 'c5_draftClosedAfter'):
            then = pc[r]['ifThen'][1]['equal']
            assert then[0] == tsum(), r
            then[0] = {"modulo": [tsum(), 16]}
        pc['b4_lockDelta'] = {"ifThen": [{"in": ["kind", LOCK_KINDS]}, {"ifThenElse": [
            {"in": ["kind", [3, 18]]}, {"equal": ["delta", 16]}, {"equal": ["delta", -16]}]}]}
        pc['c6_lockedAfter'] = {"ifThen": [{"in": ["kind", LOCK_KINDS]}, {"equal": [
            {"divide": [tsum(), 16]}, {"divide": [{"add": ["delta", 16]}, 32]}]}]}
        pc['g_memberLock'] = {"anyOf": [{"equal": ["asAuthor", 0]}, {"notIn": ["kind", LOCK_KINDS]}]}
        as_member('comment')
        ld['comment']['propertyConstraints']['lockGate'] = {"anyOf": [
            {"present": "asMember"},
            {"notEqual": ["$createdAtBlockHeight", "$updatedAtBlockHeight"]},
            {"lessThan": [tsum(), 16]}]}
        as_member('review')
        ld['review']['propertyConstraints']['lockGate'] = {"anyOf": [
            {"present": "asMember"}, {"lessThan": [tsum('patchId'), 16]}]}
        ev_home['event']['propertyConstraints']['noState'] = {"notIn": ["kind", [9, 10, 21, 22]]}

    if f['member_verdicts']:
        # R-16. 1/2 = a member's approve / request changes (proved), 3 = comment, 4/5 = a
        # non-member's approve / request changes.
        rv = ld['review']
        rv['properties']['verdict']['maximum'] = 5
        as_member('review')
        rv['propertyConstraints']['memberVerdict'] = {"ifThenElse": [
            {"in": ["verdict", [1, 2]]}, {"present": "asMember"},
            {"ifThen": [{"in": ["verdict", [4, 5]]}, {"absent": "asMember"}]}]}
        rv['indices'].append({"name": "verdicts", "properties": [{"patchId": "asc"}, {"commitOid": "asc"}, {"verdict": "asc"}],
                              "countable": True})

    if f['text_grammar']:
        collab['schemaDefs']['title']['pattern'] = TITLE
        collab['schemaDefs']['body']['pattern'] = r'\S'

    # ======================= forge-community =======================
    cr = md['checkRun']
    if f['url_grammar']:
        cr['properties']['detailsUrl']['pattern'] = HTTPS
        cr['properties']['logUrl']['pattern'] = LOG_URL
        md['profile']['properties']['links']['items']['pattern'] = HTTPS
        md['webhook']['properties']['url']['pattern'] = HOOK_URL

    if f['check_sources']:
        pol = md['policy']
        pol['properties']['mergeMethods']['maximum'] = 15
        runner_leaf = find_leaf("runner", None if f['layout_runner_out'] else CORE)
        add_prop(pol, 'requiredCheckSources', {"type": "array", "maxItems": 10, "items": ident(
            refersTo={"anyOf": [runner_leaf, find_leaf("maintainer", CORE)]})})
        pol['propertyConstraints'] = {"sourcesMatchNames": {"anyOf": [
            {"equal": [{"count": "requiredCheckSources"}, 0]},
            {"equal": [{"count": "requiredCheckSources"}, {"count": "requiredChecks"}]}]}}

    if f['checkrun_sanity']:
        cr['propertyConstraints'].update({
            "doneAfterStart": {"anyOf": [{"absent": "completedAt"}, {"greaterThanOrEqual": ["completedAt", "startedAt"]}]},
            "msEpoch": {"anyOf": [{"absent": "startedAt"}, {"greaterThanOrEqual": ["startedAt", 1000000000000]}]},
            "notFuture": {"lessThanOrEqual": [{"max": [{"ifAbsent": ["startedAt", 0]}, {"ifAbsent": ["completedAt", 0]}]},
                                              {"add": ["$updatedAt", 3600000]}]},
            "oidWidth": oid_rule('headOid', False)})

    if f['check_outcome']:
        # O-07. 0 pending, 1 passed (success / neutral / skipped), 2 failed (anything else).
        add_prop(cr, 'outcome', {"type": "integer", "minimum": 0, "maximum": 2}, required=True)
        cr['indices'].append({"name": "outcome", "properties": [{"repoId": "asc"}, {"headOid": "asc"}, {"outcome": "asc"}],
                              "rangeCountable": True})
        cr['propertyConstraints']['outcomeOf'] = {"ifThenElse": [
            {"notEqual": ["status", {"const": "completed"}]}, {"equal": ["outcome", 0]},
            {"ifThenElse": [{"in": ["conclusion", ["success", "neutral", "skipped"]]},
                            {"equal": ["outcome", 1]}, {"equal": ["outcome", 2]}]}]}

    if f['private_ci'] or f['hook_public']:
        comm['schemaDefs']['vis'] = VIS
    if f['private_ci']:
        cr['properties']['repoId'] = ident(refersTo={"type": "permanentDocument", "contractId": CORE, "documentType": "repo",
                                                     "where": {"visibility": "vis"}}, position=0)
        add_prop(cr, 'vis', {"$ref": "#/$defs/vis"}, required=True, immutable=True)
        cr['propertyConstraints']['privateNoText'] = {"anyOf": [{"notEqual": ["vis", {"const": "private"}]}, {"allOf": [
            {"absent": "summary"}, {"absent": "detailsUrl"}, {"absent": "logUrl"}, {"absent": "artifacts"},
            {"absent": "externalId"}]}]}

    if f['hook_public']:
        wh = md['webhook']
        add_prop(wh, 'vis', {"$ref": "#/$defs/vis"}, required=True)
        wh['ownerRefersTo'].setdefault('where', {})['vis'] = 'vis'
        wh['propertyConstraints'] = {"publicOnly": PUBLIC}

    if f['trending_public']:
        sb = md['starBeat']
        sb['properties'] = {
            "repoId": ident(refersTo={"type": "permanentDocument", "contractId": CORE, "documentType": "repo",
                                      "where": {"visibility": "vis", "$ownerId": "repoOwner"}}, position=0),
            "vis": {"type": "string", "enum": ["public"], "maxLength": 6, "position": 1},
            "repoOwner": ident(distinctFrom="$ownerId", position=2)}
        sb['required'] = ["$createdAt", "repoId", "vis", "repoOwner"]
        sb['entryPayload'] = ["vis", "repoOwner"]

    if f['social_counters']:
        for t in ('star', 'watch'):
            idx(md[t], 'byOwner')['countable'] = True
        wr = idx(md['watch'], 'byRepo')
        wr.pop('countable', None)
        wr['rangeCountable'] = True
        wr['rankedCountable'] = True

    # ======================= RC2 (design/v5/PLAN.md §3) =======================
    if f['check_evidence_freeze']:
        # S1. Once the stored run is completed, its evidence stands (a v5 condition reads the
        # document alone: no fee, book contract-keywords/mutability.md:111). status cannot leave
        # `completed` again: conclusion is set-once (M1) and doneIfConclusion ties it to status,
        # so the freeze is permanent. status and outcome are pinned by the same pair already.
        done = {"equal": ["$old.status", {"const": "completed"}]}
        for p in ('summary', 'detailsUrl', 'logUrl', 'logSha256', 'artifacts'):
            freeze(cr, p, when=done)

    rv = ld['review']
    if f['review_to_author']:
        # S2. A derived index property (v5 book contract-keywords/derived-index-properties.md):
        # Drive files each review under the owner of the patch it reviews. patchId is a
        # same-contract permanentDocument reference and review documents are immutable.
        rv['indices'].append({"name": "toAuthor", "properties": [{"patchId.$ownerId": "asc"}, {"$createdAt": "asc"}]})
    if f['review_author']:
        # S3 (QW2-009, not a v5 feature): every review an identity wrote, newest last.
        rv['indices'].append({"name": "author", "properties": [{"$ownerId": "asc"}, {"$createdAt": "asc"}]})

    if f['fused_star']:
        # C1. The star itself sits in the trending window: an `outlivesDelete` window entry stays
        # (and counts) after an unstar until the window passes, so starBeat, which existed only
        # because its entryPayload rules outlivesDelete out, goes (v5 book
        # contract-keywords/index-only.md:197-230). Trending loses O-08's public-only and
        # no-self-star filter: a client filters on read.
        st = md['star']
        st['required'] = ["repoId", "$createdAt"]
        st['indices'].append({"name": "byWeek", "properties": [{"$createdAt": "asc"}, {"repoId": "asc"}],
                              "timeRange": {"on": "$createdAt", "range": 604800, "step": 86400, "ttl": 604800},
                              "rangeCountable": True, "rankedCountable": True, "outlivesDelete": True})
        del md['starBeat']

    # ======================= RC2 riders (design/v5/RIDERS.md) =======================
    if f['close_reason']:
        # QW-069. 1 completed, 2 not planned, 3 duplicate; dupNumber is the canonical issue's number
        # in this repo. No rule: transition is immutable and already declares 15 of the 16 rules a
        # type may have (v5 rs-platform-version system_limits/v4.rs:105), and every reader judges
        # both from the same document (forge-core rules::transition::close_reason_of). dupNumber
        # is inlined: `targetNumber` already takes the `num` def in this type.
        tr = ld['transition']
        add_prop(tr, 'reason', {"type": "integer", "minimum": 1, "maximum": 3})
        add_prop(tr, 'dupNumber', {"type": "integer", "minimum": 1, "maximum": 4294967295})
    if f['review_hunk']:
        # QW2-010. The source's diff hunk of a mirrored review comment (the importer trims it to the
        # commented lines), frozen, and never in plaintext beside a sealed body (noPlain).
        cm = ld['comment']
        add_prop(cm, 'diffHunk', {"type": "string", "minLength": 1, "maxLength": 1024, "maxBytes": 1024}, immutable=True)
        cm['propertyConstraints']['noPlain']['anyOf'][1]['allOf'].append({"absent": "diffHunk"})

    # ======================= RC2 moderation (design/v5/MODERATION.md) =======================
    if f['event_as_maintainer']:
        # MOD. A hide or unhide (24/25) names its writer's maintainer document of the repo:
        # `asMaintainer` must be the writer (an absent identifier equals nothing, v5 book
        # contract-keywords/property-constraints.md:150, so the one rule also refuses a hide
        # without it), and its findBy proves the writer a maintainer when it is written, so a
        # writer's hide is refused (40120) and a hide outlives its writer's removal. Other kinds
        # may carry it; readers ignore it there. Every hide is a client display rule: v5 contract
        # moderation is contract-wide (book data-model/contract-moderation.md:11), so no
        # consensus delete can be scoped to one repo.
        ev = ev_home['event']
        add_prop(ev, 'asMaintainer', ident(refersTo=find_leaf("maintainer", CORE)))
        ev['propertyConstraints']['hideByMaint'] = {"ifThen": [{"in": ["kind", HIDE_KINDS]},
                                                               {"equal": ["asMaintainer", "$ownerId"]}]}

    # ======================= RC2 member roles (design/v5/RECUT-OR-NEVER.md §3) =======================
    if f['member_roles']:
        # A writer document carries its role: 1 writer, 2 triage, 3 reader (private repos). Every
        # writer-gated type claims a role `r`, and its writer leaf adds `where {"role": "r"}`, so
        # the leaf proves the claim (40127 on a mismatch). The other operands (maintainer,
        # author, runner) prove nothing about `r`; they send 1. A reader (3) matches no gate.
        # `$defs.member` (asMember) and the repoKey recipient operands stay role-blind: a reader
        # receives the repo key; readers count approvals and provenance only from maintainers
        # and role-1 writers (forge-v2.md §3).
        add_prop(cd['writer'], 'role', {"type": "integer", "minimum": 1, "maximum": 3}, required=True)

        def writer_leaf(t):
            return next(leaf for leaf in leaves(t['ownerRefersTo']) if leaf['documentType'] == 'writer')

        homes = {'refUpdate': cd, 'packManifest': cd, 'chunk': cd, 'transition': ld, 'event': ev_home, 'label': cd,
                 'milestone': ev_home, 'checkRun': md}
        for t, hi in ROLE_GATED.items():
            home = homes[t]
            add_prop(home[t], 'r', {"type": "integer", "minimum": 1, "maximum": hi}, required=True)
            writer_leaf(home[t]).setdefault('where', {})['role'] = 'r'
        # Triage closes, reopens and locks; merge, draft and ready need role 1. transition keeps 15
        # of its 16 rules: the role check joins e_mergeOid.
        tr = ld['transition']
        tr['propertyConstraints']['e_mergeOid'] = {"allOf": [
            tr['propertyConstraints']['e_mergeOid'],
            {"ifThen": [{"in": ["kind", WRITER_TRANSITION_KINDS]}, {"equal": ["r", 1]}]}]}
        ev_home['event']['propertyConstraints']['t_triageKinds'] = {
            "ifThen": [{"in": ["kind", WRITER_EVENT_KINDS]}, {"equal": ["r", 1]}]}

    # ======================= UPDATE-1 (roadmap D4; design/v5/CONTRACT-UPDATE-1.md) =======================
    # Each addition is something protocol 14 lets a DataContractUpdate add to a registered contract:
    # an optional property under an existing type's `properties` (rs-json-schema-compatibility-validator
    # rule_set.rs "properties": inner allow_addition), an `enum` that only gains values (rule_set.rs
    # "enum": allow_addition at the element level), or a new document type with its own indexes and
    # references (rs-dpp data_contract/methods/validate_update/v0: new types are validated as at
    # registration). Nothing below adds a rule, index, reference or required field to an existing type.
    up = {**f, **{k: f.get(k, False) for k in MAINNET_FLAGS}}
    for k in MAINNET_UNBUILT:
        if up[k]:
            sys.exit(f'{k} is declared, not built: see docs/contracts/forge-v2.md §9.1')
    if up['release_target_oid']:
        # The commit the tag named when this revision was written. Optional, not `requiredSince`:
        # a sealed revision must not carry it in plaintext and an unpublish names no commit, and a
        # requiredSince property is required of every later create (book contract-keywords/
        # required-since.md: "Every post created or replaced under version 3 or later must have"),
        # so it would refuse both and every installed client's release. Readers compare it with
        # the tag's tip (TS-04); a sealed revision states it inside `enc`.
        rl = cd['release']
        add_prop(rl, 'targetOid', {"$ref": "#/$defs/oid"})
        if up['mainnet_release_target']:
            rl['propertyConstraints']['targetOnPublish'] = {"ifThenElse": [
                {"present": "enc"}, {"absent": "targetOid"},
                {"anyOf": [{"notEqual": ["delta", 1]}, {"present": "targetOid"}]}]}
    if up['config_moved_to']:
        # The successor repository (any network-local repo id). Maintainer-written like every
        # config, so a maintainer can point readers on even with the owner gone (TS-11 c). Readers
        # honour it on a public repo only; a sealed config states it inside `enc`.
        cf = cd['config']
        add_prop(cf, 'movedTo', ident())
        if up['mainnet_moved_to_public']:
            cf['propertyConstraints']['noPlain']['anyOf'][1]['allOf'].append({"absent": "movedTo"})
    if up['pack_mirror']:
        # Anyone records another copy of a pack the members' manifests already list. Bytes verify
        # against packHash, so a mirror can only fail to serve; readers take mirrors only for hashes
        # in the members' pack list, members' first, strangers last and capped (RECUT-B §5). The
        # writer pays, and may delete its own record. `kind` names how `uris` are read (1 https or
        # a public s3 URL, 2 ipfs://<cid>); readers skip a kind they do not know. Only https:// and
        # ipfs:// URIs (no file:, javascript: or credentials in the URL): a pattern can never be
        # added by a later update.
        pm = {"type": "object", "documentsMutable": False, "canBeDeleted": True,
              "properties": {
                  "repoId": ident(refersTo={"type": "permanentDocument", "documentType": "repo"}, position=0),
                  "packHash": {"$ref": "#/$defs/hid", "position": 1},
                  "kind": {"type": "integer", "minimum": 1, "maximum": 255, "position": 2},
                  "uris": {"type": "array", "minItems": 1, "maxItems": 4,
                           "items": {"type": "string", "minLength": 1, "maxLength": 300, "pattern": LOG_URL},
                           "position": 3}},
              "indices": [
                  # The mirrors of one pack (repoId, packHash) and of a whole repo (repoId alone);
                  # unique per writer, so one record per (repo, pack, mirror)
                  {"name": "byHash", "properties": [{"repoId": "asc"}, {"packHash": "asc"}, {"$ownerId": "asc"}],
                   "unique": True},
                  # What one mirror (a pin service) has recorded, newest last
                  {"name": "byOwner", "properties": [{"$ownerId": "asc"}, {"$createdAt": "asc"}]}],
              "required": ["$createdAt", "repoId", "packHash", "kind", "uris"], "additionalProperties": False}
        if up['mainnet_mirror_public']:
            pm['properties']['repoId']['refersTo']['where'] = {"visibility": "vis"}
            # public-only, as on topic and starBeat: the where proves it equals the repo's
            pm['properties']['vis'] = {"type": "string", "enum": ["public"], "maxLength": 6, "position": 4}
            pm['required'].append('vis')
        cd['packMirror'] = pm
    if up['transition_closed_by_pr']:
        # The PR whose merge closed this issue (a "Fixes #N" close). Readers verify that PR is merged
        # and names the issue before showing "closed in #N" (client-rules #12). Inlined: the type
        # already takes the `num` def (targetNumber).
        add_prop(ld['transition'], 'closedByPr', {"type": "integer", "minimum": 1, "maximum": 4294967295})
    if up['profile_key_proofs']:
        # keyProofs[i] proves possession of pubkeys[i]: base64 of an SSH signature (sshsig, namespace
        # `dash-forge`) or a binary OpenPGP signature over `dash-forge-key:v1:<identity id>:<pubkeys[i]
        # key part>`. Consensus cannot check either; the shared reader rule does, and a proven
        # listing outranks an unproven one (client-rules #5). An empty string is "no proof" for that
        # key. 1,200 characters (900 bytes) holds an RSA-3072 sshsig or an RSA-4096 OpenPGP
        # signature; four of them stay under max_field_value_size (5,120 B).
        add_prop(md['profile'], 'keyProofs', {"type": "array", "maxItems": 4, "items": {
            "type": "string", "minLength": 0, "maxLength": 1200, "pattern": "^[A-Za-z0-9+/]*={0,2}$"}})
    if up['profile_bot']:
        # A bot's profile names its operator; the operator's profile lists the bots it runs. Readers
        # show a "bot" badge only when both sides agree (DX-15): neither claim alone proves anything.
        add_prop(md['profile'], 'bot', {"type": "object", "properties": {
            "operator": ident(position=0),
            "operates": {"type": "array", "maxItems": 8, "items": ID, "position": 1}},
            "additionalProperties": False})
    if up['author_retarget']:
        # The PR author may retarget its own PR (power-user R-STACK-1): kind 8 joins the author kinds
        # and `value` carries the new base branch, as on a member's kind-8 event. The enum only
        # gains a value (appended, so no existing element moves). authorEvent's rules are frozen,
        # so "kind 8 needs a value" is a reader rule until mainnet (mainnet_retarget_value); a
        # private repo's author retarget is refused by readers (value would be plaintext).
        ae = md['authorEvent']
        ae['properties']['kind']['enum'].append(8)
        add_prop(ae, 'value', {"type": "string", "minLength": 1, "maxLength": 120, "maxBytes": 480})
        if up['mainnet_retarget_value']:
            ae['propertyConstraints']['retargetValue'] = {"ifThenElse": [
                {"equal": ["kind", 8]}, {"present": "value"}, {"absent": "value"}]}
    if up['policy_code_owners']:
        # The merge box requires an approval from a code owner of every touched path (a client rule
        # like the rest of the policy; power-user #14).
        add_prop(md['policy'], 'requireCodeOwners', {"type": "boolean"})
    if up['repo_ban']:
        # A maintainer bans an identity from a repo: readers hide its issues, PRs, comments and
        # reviews there, as they apply a hide (TS-08 c), from the bans of current maintainers. One
        # write covers every past and future post. Deleting it (its writer) lifts it. Not consensus:
        # the banned identity can still write; v5 moderation is contract-wide (forge-v2.md §3.2).
        ld['ban'] = {"type": "object", "documentsMutable": False, "canBeDeleted": True,
                     "ownerRefersTo": find_leaf("maintainer", CORE),
                     "properties": {
                         "repoId": ident(position=0),
                         "identityId": ident(position=1),
                         "reason": {"type": "integer", "minimum": 0, "maximum": 255, "position": 2}},
                     "indices": [
                         # Every ban in a repo (repoId), one identity's (repoId, identityId); one per
                         # (repo, identity, maintainer)
                         {"name": "byRepo", "properties": [{"repoId": "asc"}, {"identityId": "asc"}, {"$ownerId": "asc"}],
                          "unique": True}],
                     "required": ["$createdAt", "repoId", "identityId"], "additionalProperties": False}

    # ======================= mixed visibility (DESIGN rev 4.1 §8.3) =======================
    # A fresh registration only: each adds a rule, a reference or a required field to a type that
    # exists, which no update can (§9). Row numbers are DESIGN §8.2's; forge-v2.md §9.1 has each.
    def thaw(t, name, when):
        """Freeze `name` only while `when` holds, where it was frozen outright."""
        t['immutable'] = [e for e in t.get('immutable', []) if e != name]
        freeze(t, name, when=when)

    def drop_where(leaf, key):
        leaf.get('where', {}).pop(key, None)
        if leaf.get('where') == {}:
            del leaf['where']

    def repo_vis(t, contract=None):
        """`repoId` proves the document's `vis` equal to the repo's `visibility` (C4, L3)."""
        ref = {"type": "permanentDocument", "contractId": contract, "documentType": "repo", "where": {"visibility": "vis"}}
        if contract is None:
            del ref['contractId']
        t['properties']['repoId'] = ident(refersTo=ref, position=t['properties']['repoId']['position'])

    if up['mainnet_aud']:
        # L1 (rows 1-3). absent = Public, 1 = Members, 2 = a letter. "aud present <=> enc present";
        # a members-only document is a member's (aud = 1 => asMember); a private repo's content is
        # aud + asMember, so a stranger writes nothing into it. The author's replace may drop aud
        # (making it public) and never add or change it; the plaintext fields a sealed document
        # cannot carry become settable once, in that replace (review is immutable): frozen when
        # stored, when the stored document is public, and while the written one keeps aud.
        for t in ('issue', 'patch', 'comment', 'review'):
            s = ld[t]
            add_prop(s, 'aud', {"type": "integer", "minimum": 1, "maximum": 2})
            dr = s.setdefault('dependentRequired', {})
            dr['aud'] = ["enc"]
            dr['enc'] = dr.get('enc', []) + ["aud"]
            pc = s['propertyConstraints']
            pc['audMember'] = {"ifThen": [{"equal": ["aud", 1]}, {"present": "asMember"}]}
            pc['p_sealedIfPrivate'] = {"anyOf": [{"notEqual": ["vis", {"const": "private"}]},
                                                 {"allOf": [{"present": "aud"}, {"present": "asMember"}]}]}
            if t != 'review':
                freeze(s, 'aud', when={"anyOf": [{"absent": "$old.aud"}, {"present": "aud"}]})
        for t, props in (('comment', ('path', 'diffHunk')), ('patch', ('baseRefName', 'sourceRefName'))):
            for p in props:
                if p in ld[t]['properties']:
                    thaw(ld[t], p, {"anyOf": [{"present": f"$old.{p}"}, {"absent": "$old.aud"}, {"present": "aud"}]})

    if up['mainnet_one_way_visibility']:
        # C1 (row 18). Free while private, frozen once public; only the owner replaces a repo.
        thaw(cd['repo'], 'visibility', {"equal": ["$old.visibility", {"const": "public"}]})

    if up['mainnet_vis_via_repo']:
        # L3 (row 17): a comment's or review's vis is the repo's, so a converted repo's old threads
        # take public replies. C4 (row 41): the git-plane types and webhooks prove vis against the
        # repo, not the member row, so no member row is re-issued when a repo goes public.
        for t in ('comment', 'review'):
            repo_vis(ld[t], CORE)
        for leaf in leaves(ld['comment']['properties']['targetId']['refersTo']):
            drop_where(leaf, 'vis')
        drop_where(ld['review']['properties']['patchId']['refersTo'], 'vis')
        for t in ('refUpdate', 'protectedRefUpdate', 'config', 'release'):
            repo_vis(cd[t])
            for leaf in leaves(cd[t]['ownerRefersTo']):
                drop_where(leaf, 'vis')
        repo_vis(md['webhook'], CORE)
        drop_where(md['webhook']['ownerRefersTo'], 'vis')

    if up['mainnet_member_role']:
        # L2 (rows 5, 6). A member restates its current role on every post (the asMember reference
        # is re-checked on each replace); a maintainer's is unproved and may be left out (reads 0).
        for t in ('issue', 'patch', 'comment', 'review'):
            add_prop(ld[t], 'mRole', {"type": "integer", "minimum": 1, "maximum": 4})
        next(leaf for leaf in leaves(collab['schemaDefs']['member']['refersTo'])
             if leaf['documentType'] == 'writer')['where'] = {"role": "mRole"}
        proved = {"allOf": [{"present": "asMember"}, {"lessThanOrEqual": ["mRole", 1]}]}
        ld['review']['propertyConstraints']['memberVerdict'] = {"ifThenElse": [
            {"in": ["verdict", [1, 2]]}, proved, {"ifThen": [{"in": ["verdict", [4, 5]]}, {"absent": "asMember"}]}]}
        for t in ('issue', 'patch'):
            ld[t]['propertyConstraints']['i_provenance'] = {"anyOf": [
                {"allOf": [{"absent": "imported"}, {"absent": "upstreamNumber"}]}, proved]}
        for t in ('comment', 'review'):
            ld[t]['propertyConstraints']['i_provenance'] = {"anyOf": [{"absent": "imported"}, proved]}

    if up['mainnet_bot_role']:
        # C2: a Bot member row (role 4) passes no triage or push gate (r <= 2 there, B1 aside).
        # L4 (row 14): a wrap names its recipient's role, proved by the writer leaf, never 4.
        cd['writer']['properties']['role']['maximum'] = 4
        rk = rk_home['repoKey']
        add_prop(rk, 'mr', {"type": "integer", "minimum": 1, "maximum": 3}, required=True)
        next(leaf for leaf in leaves(rk['properties']['memberId']['refersTo'])
             if leaf['documentType'] == 'writer')['where'] = {"role": "mr"}

    if up['mainnet_maint_kinds']:
        # C3 (rows 9-11). writer.role is never 0, so only the maintainer operand admits r = 0.
        pm = cd['packManifest']
        pm['properties']['r']['minimum'] = 0
        pm['propertyConstraints']['maintKinds'] = {"ifThen": [{"in": ["kind", MAINT_PACK_KINDS]}, {"equal": ["r", 0]}]}

    if up['mainnet_check_aud']:
        # M1 (rows 12, 13): the runner declares a members-only run (aud 1, frozen); a private or
        # members-only run carries no text, and may carry an opaque log link (logSha256 required).
        add_prop(cr, 'aud', {"type": "integer", "minimum": 1, "maximum": 1}, immutable=True)
        del cr['propertyConstraints']['privateNoText']
        cr['propertyConstraints']['sealedNoText'] = {"anyOf": [
            {"allOf": [{"notEqual": ["vis", {"const": "private"}]}, {"absent": "aud"}]},
            {"allOf": [{"absent": "summary"}, {"absent": "detailsUrl"}, {"absent": "artifacts"}, {"absent": "externalId"}]}]}

    if up['mainnet_event_kinds']:
        # M2 (rows 7, 8): an allow-list, so kinds 26, 27 and every kind defined later are closed to
        # triage. Kind 23 joins the hide kinds in hideByMaint (asMaintainer = $ownerId): the same
        # condition as a rule of its own, 79 B smaller (DESIGN Appendix E7).
        ev = ev_home['event']
        ev['propertyConstraints']['t_triageKinds'] = {"ifThen": [{"equal": ["r", 2]}, {"in": ["kind", TRIAGE_EVENT_KINDS]}]}
        ev['propertyConstraints']['hideByMaint']['ifThen'][0] = {"in": ["kind", [BYPASS_KIND] + HIDE_KINDS]}

    for flag, t in (('mainnet_event_target_aud', 'event'), ('mainnet_author_event_enc', 'authorEvent')):
        if up[flag]:
            # M4 (row 16), M3 (row 19): the target's aud, proved by the targetId reference (absent on
            # both sides agrees), and no plaintext value on a members-only or letter target
            s = md[t]
            add_prop(s, 'tAud', {"type": "integer", "minimum": 1, "maximum": 2})
            for leaf in leaves(s['properties']['targetId']['refersTo']):
                leaf['where']['aud'] = 'tAud'
            s['propertyConstraints']['tAudSealed'] = {"anyOf": [{"absent": "tAud"}, {"absent": "value"}]}
    if up['mainnet_author_event_enc']:
        # M3 (row 19): an author's retitle or retarget of a sealed item is sealed too
        ae = md['authorEvent']
        add_prop(ae, 'enc', {"$ref": "#/$defs/enc"})
        add_prop(ae, 'epoch', {"$ref": "#/$defs/u32"})
        ae.setdefault('dependentRequired', {})['enc'] = ["epoch"]
        ae['propertyConstraints']['noPlain'] = {"anyOf": [{"absent": "enc"}, {"absent": "value"}]}
        if 'retargetValue' in ae['propertyConstraints']:
            # mainnet_retarget_value: a sealed retarget carries its base inside enc
            ae['propertyConstraints']['retargetValue'] = {"ifThenElse": [
                {"equal": ["kind", 8]}, {"anyOf": [{"present": "value"}, {"present": "enc"}]}, {"absent": "value"}]}

    if up['mainnet_bot_push']:
        # B1 (rows 42-45; DESIGN §4.9 "Pushing", D42). A maintainer's pushGrant names one bot row
        # (role 4) and either one exact members-only ref (scope: its refNameHash) or a public ref
        # prefix, until at most 90 days after it is written. A bot's refUpdate claims r = 4 and
        # names a grant by id: pg (exact) or pp (prefix), two properties because a deletable
        # document by id is no anyOf operand. The grant's `where` pins the repo, the bot
        # ($ownerId), the granter (grantor, whose maintainer row must still exist), the until (gu)
        # and the scope or prefix (gp); botGrant needs $createdAt <= gu, a ref under gp, and
        # enc for an exact grant, so an exact grant never yields a public ref. Everyone else
        # sends r = 1. protectedRefUpdate stays maintainer-only.
        def grant(match):
            return {"type": "deletableDocument", "documentType": "pushGrant",
                    "where": dict({"repoId": "repoId", "botId": "$ownerId", "until": "gu", "$ownerId": "grantor"}, **match)}
        cd['pushGrant'] = {
            "type": "object", "documentsMutable": False, "canBeDeleted": True,
            "ownerRefersTo": find_leaf("maintainer"),
            "properties": {
                "repoId": {"$ref": "#/$defs/id", "position": 0},
                "botId": ident(refersTo=dict(find_leaf("writer"), where={"role": "br"}), position=1),
                "br": {"type": "integer", "minimum": 4, "maximum": 4, "position": 2},
                "scope": {"$ref": "#/$defs/h32", "position": 3},
                "prefix": {"type": "string", "minLength": 1, "maxLength": 255, "maxBytes": 255, "position": 4},
                "until": {"type": "integer", "minimum": 0, "position": 5}},
            # a bot's grants, oldest first (the runner and readers find them here)
            "indices": [{"name": "byBot", "properties": [{"repoId": "asc"}, {"botId": "asc"}, {"$createdAt": "asc"}]}],
            "required": ["$createdAt", "repoId", "botId", "br", "until"], "additionalProperties": False,
            "propertyConstraints": {
                "ttl90": {"allOf": [{"greaterThan": ["until", "$createdAt"]},
                                    {"lessThanOrEqual": ["until", {"add": ["$createdAt", GRANT_TTL_MS]}]}]},
                "oneScope": {"anyOf": [{"allOf": [{"present": "scope"}, {"absent": "prefix"}]},
                                       {"allOf": [{"absent": "scope"}, {"present": "prefix"}]}]}}}
        ru = cd['refUpdate']
        ru['properties']['r']['maximum'] = 4
        add_prop(ru, 'pg', ident(refersTo=grant({"scope": "refNameHash"})))
        add_prop(ru, 'pp', ident(refersTo=grant({"prefix": "gp"})))
        add_prop(ru, 'grantor', ident(refersTo=find_leaf("maintainer")))
        add_prop(ru, 'gp', {"type": "string", "minLength": 1, "maxLength": 255, "maxBytes": 255})
        add_prop(ru, 'gu', {"type": "integer", "minimum": 0})
        ru['propertyConstraints']['botGrant'] = {"ifThenElse": [{"equal": ["r", 4]}, {"allOf": [
            {"anyOf": [{"present": "pg"}, {"present": "pp"}]},
            {"anyOf": [{"absent": "pp"}, {"startsWith": ["refName", "gp"]}]},
            {"anyOf": [{"absent": "pg"}, {"present": "enc"}]}]}, {"equal": ["r", 1]}]}
        # The time check is a rule of its own, so botGrant reads no time and the offline vectors
        # judge it (contract-validate gives no times; a node judges grantLive with the block's,
        # an SDK pre-check with the device clock). A bot's update without gu fails the grant's
        # `where {"until": "gu"}` (until is required).
        ru['propertyConstraints']['grantLive'] = {"anyOf": [{"absent": "gu"}, {"lessThanOrEqual": ["$createdAt", "gu"]}]}
        # Packs and chunks admit the bot's row (r = 4: the writer leaf proves role 4) for the push
        # and long-body kinds only, never superseding others' packs; raising r alone would also
        # admit triage (2) and readers (3), so the other writers keep r in {0, 1}.
        pm = cd['packManifest']
        pm['properties']['r']['maximum'] = 4
        pm['propertyConstraints']['botPack'] = {"ifThenElse": [{"equal": ["r", 4]}, {"allOf": [
            {"in": ["kind", BOT_PACK_KINDS]}, {"absent": "supersedes"}]}, {"in": ["r", [0, 1]]}]}
        ch = cd['chunk']
        ch['properties']['r']['maximum'] = 4
        ch.setdefault('propertyConstraints', {})['botChunk'] = {"in": ["r", [1, 4]]}

    core['description'] = "Dash Forge v2 core: repositories, refs, packs, members, releases, labels, topics"
    collab['description'] = "Dash Forge v2 collaboration: issues, pull requests, transitions, comments, reviews, repo keys"
    comm['description'] = "Dash Forge v2 community: events, milestones, runners, check runs, policies, stars, webhooks"
    contracts = {'forge-core': core, 'forge-collab': collab, 'forge-community': comm}
    if f['layout_meta']:
        contracts[META] = split_meta(contracts, f['mainnet_bot_push'])
    return contracts


def _walk(node, fn):
    """Call fn on every dict in a JSON tree."""
    if isinstance(node, dict):
        fn(node)
        for v in node.values():
            _walk(v, fn)
    elif isinstance(node, list):
        for x in node:
            _walk(x, fn)


def _defs_used(contract):
    """The schemaDefs a contract's document types (and the defs they use) name by `$ref`."""
    used, todo = set(), [contract['documentSchemas']]
    while todo:
        found = set()
        _walk(todo.pop(), lambda d: found.add(d['$ref'].split('/')[-1]) if isinstance(d.get('$ref'), str) else None)
        for name in found - used:
            used.add(name)
            todo.append(contract['schemaDefs'][name])
    return used


def split_meta(contracts, bot_push):
    """D44 (DESIGN rev 4.1 §8.3 item 0): move META_TYPES into forge-meta, registered last and
    enrolled in the same group. None of them is read by a rule, a total, a derived index or a
    reference of its old contract, so the move changes no consensus rule. A reference left behind is
    refused below; a total or a derived index reads only its own contract, so one left behind would
    fail the registration parse (contract-validate). Their own references into their old contract
    name it by id (a later contract may refer to an earlier one, never the reverse: book
    contract-keywords/refers-to.md:311,328 at v5.0.0-beta.3)."""
    meta = {"$formatVersion": "1", "id": contracts['forge-core']['id'], "ownerId": contracts['forge-core']['ownerId'],
            "version": 1, "description": "Dash Forge v2 meta: repo keys, bans, labels, topics, pack mirrors, profiles, follows",
            "schemaDefs": {}, "documentSchemas": {}}
    moved = {}
    for src, types in META_TYPES.items():
        c = contracts[src]
        for t in types:
            if t not in c['documentSchemas']:
                continue
            s = c['documentSchemas'].pop(t)

            def name_source(d, src=src):
                if d.get('type') in ('permanentDocument', 'deletableDocument') and 'documentType' in d:
                    d.setdefault('contractId', PLACEHOLDER[src])
            _walk(s, name_source)
            meta['documentSchemas'][t] = s
            moved[t] = src
            for d in _defs_used({'documentSchemas': s, 'schemaDefs': c['schemaDefs']}):
                dd = copy.deepcopy(c['schemaDefs'][d])
                _walk(dd, name_source)
                if meta['schemaDefs'].setdefault(d, dd) != dd:
                    sys.exit(f'forge-meta: $defs.{d} differs between the contracts its types come from')

    # Nothing left behind may refer to a moved type in its old contract
    for name, c in contracts.items():
        def check(d, name=name):
            if d.get('documentType') in moved:
                target = next((n for n, ph in PLACEHOLDER.items() if ph == d.get('contractId')), name)
                if target == moved[d['documentType']]:
                    sys.exit(f'{name} refers to {d["documentType"]}, which moved to forge-meta')
        _walk(c['documentSchemas'], check)
        _walk(c['schemaDefs'], check)
        for d in set(c['schemaDefs']) - _defs_used(c):
            del c['schemaDefs'][d]
    contracts['forge-core']['description'] = "Dash Forge v2 core: repositories, refs, packs, members, releases" + (
        ", push grants" if bot_push else "")
    contracts['forge-collab']['description'] = "Dash Forge v2 collaboration: issues, pull requests, transitions, comments, reviews"
    return meta


def dumps(j):
    return json.dumps(j, indent=2, ensure_ascii=False) + '\n'


def gate(gate_bin, contracts):
    """Serialized sizes with beta.7 rs-dpp (full-validation parse), placeholders swapped for
    syntactically valid ids."""
    ids = {CORE: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1', COLLAB: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS'}
    with tempfile.TemporaryDirectory() as tmp:
        empty = os.path.join(tmp, 'empty.docs.json')
        open(empty, 'w').write('{}')
        args = []
        for name, j in contracts.items():
            s = json.dumps(j)
            for k, v in ids.items():
                s = s.replace(k, v)
            p = os.path.join(tmp, f'{name}.json')
            open(p, 'w').write(s)
            args.append(f'{p}:{empty}')
        out = os.path.join(tmp, 'out.json')
        r = subprocess.run([gate_bin, out, *args], capture_output=True, text=True)
        res = json.load(open(out)) if os.path.exists(out) else {}
    sizes = {}
    for name in contracts:
        e = res.get(name, {})
        sizes[name] = len(base64.b64decode(e['bytes'])) if 'bytes' in e else f"REFUSED: {e.get('error') or r.stdout + r.stderr}"
    return sizes


def flags_from(off='', on=''):
    """FLAGS (and the MAINNET_FLAGS, all off) with the comma-separated `off` flags turned off and the
    `on` ones turned on."""
    flags = dict(FLAGS, **MAINNET_FLAGS)
    for value, names in ((False, off), (True, on)):
        for fl in filter(None, names.split(',')):
            if fl not in flags:
                sys.exit(f'unknown flag {fl}')
            flags[fl] = value
    return flags


def validate(validator, contracts, vectors=None):
    """Run tools/contract-validate (its binary) on `contracts`, in registration order; return
    (exit code, its output, {name: (contract bytes, create-transition bytes)})."""
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for name in contracts:
            paths.append(os.path.join(tmp, f'{name}.json'))
            open(paths[-1], 'w').write(dumps(contracts[name]))
        r = subprocess.run([validator, *(['--vectors', vectors] if vectors else []), *paths],
                           capture_output=True, text=True)
    sizes, current = {}, None
    for line in r.stdout.splitlines():
        if line.startswith('== '):
            current = line.split()[1]
        m = re.search(r'size: contract (\d+) B, create transition (\d+) B', line)
        if m and current:
            sizes[current] = (int(m.group(1)), int(m.group(2)))
    return r.returncode, r.stdout + r.stderr, sizes


def budget_note(n):
    return 'over the ceiling' if n > CEILING else 'over the target' if n > TARGET else 'ok'


def over_budget(contracts, size):
    """Whether one contract's (serialized, create-transition) size fails its set's budget: the
    D-12 ceiling for the three-contract set, and at least ROOM_MIN bytes of room under the
    transition limit for the four-contract set, whose ceiling D44 waives."""
    n, st = size
    return TRANSITION_LIMIT - st < ROOM_MIN if META in contracts else n > CEILING


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--gate')
    ap.add_argument('--validate', metavar='CONTRACT_VALIDATE')
    ap.add_argument('--off', default='')
    ap.add_argument('--on', default='')
    ap.add_argument('--out', help='write the three files here instead of forge-contracts/contracts')
    ap.add_argument('--mainnet', action='store_true',
                    help='turn the built MAINNET_FLAGS on (a fresh registration only; needs --out)')
    a = ap.parse_args()
    on = a.on
    if a.mainnet:
        on = ','.join(filter(None, [on, *(k for k in MAINNET_FLAGS if k not in MAINNET_UNBUILT)]))
    variant = bool(a.off or on)
    contracts = build(flags_from(a.off, on))
    if META in contracts and not a.out:
        sys.exit('the four-contract layout is a fresh registration: write it with --out <dir>')
    targets = {n: os.path.join(a.out or CONTRACTS, f'{n}.json') for n in contracts}
    texts = {k: dumps(contracts[k]) for k in targets}
    if a.check and variant:
        sys.exit('--check compares the full build: use it without --off/--on')
    if a.check:
        stale = [p for k, p in targets.items() if not os.path.exists(p) or open(p).read() != texts[k]]
        # the committed set is the three contracts devnets register; forge-meta is --mainnet only
        meta = os.path.join(CONTRACTS, f'{META}.json')
        if os.path.exists(meta):
            stale.append(meta)
            print(f'stale: {os.path.relpath(meta)} (forge-meta is built with --mainnet --out <dir> only)')
        for p in stale:
            print(f'stale: {os.path.relpath(p)} (re-run forge-contracts/schema/build.py)')
        # The registered v1 schemas are frozen copies of what devnet sakura registered on
        # 2026-10-01; the build with every UPDATE-1 item off must still reproduce them, so an edit
        # to an earlier flag cannot silently change what an update is validated against.
        v1 = build(flags_from(','.join(UPDATE1_FLAGS)))
        for n in NAMES:
            p = os.path.join(REGISTERED, f'{n}.v1.json')
            if not os.path.exists(p) or open(p).read() != dumps(v1[n]):
                stale.append(p)
                print(f'differs: {os.path.relpath(p)} is not the build with every UPDATE-1 flag off')
        sys.exit(1 if stale else 0)
    if a.out or not variant:
        if a.out:
            os.makedirs(a.out, exist_ok=True)
        for k, p in targets.items():
            open(p, 'w').write(texts[k])
    failed = False
    if a.validate:
        code, out, sizes = validate(a.validate, contracts)
        for name in contracts:
            if name not in sizes:
                print(f'{name:16} REFUSED: {out[-1500:]}')
                failed = True
                continue
            n, st = sizes[name]
            print(f'{name:16} {n:6} B  target {TARGET} ({TARGET - n:+}), ceiling {CEILING} ({CEILING - n:+})  {budget_note(n)};'
                  f'  create transition {st} B ({100 * st / TRANSITION_LIMIT:.1f} % of {TRANSITION_LIMIT},'
                  f' {TRANSITION_LIMIT - st} B of room)')
            failed = failed or over_budget(contracts, sizes[name])
        if META in contracts:
            print(f'four-contract set (D44): the D-12 ceiling is waived; each contract keeps >= {ROOM_MIN} B of room')
        failed = failed or code != 0
    if a.gate:
        for name, n in gate(a.gate, contracts).items():
            if isinstance(n, str):
                print(f'{name:16} {n[:1500]}')
                failed = True
                continue
            failed = failed or n > CEILING
            print(f'{name:16} {n:6} B  target {TARGET} ({TARGET - n:+}), ceiling {CEILING} ({CEILING - n:+})  {budget_note(n)}')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()

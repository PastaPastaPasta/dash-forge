#!/usr/bin/env python3
"""Build the RC1 registration (forge-core, forge-collab, forge-community) from the base schemas.

  python3 forge-contracts/schema/build.py [--check] [--gate <b7gate>] [--off flag,flag]

`base/` holds the three schemas registered-to-be before RC1 (the #154 build: the beta.7
`refersTo` grammar with WIPE-DECISIONS D-2..D-5 applied). This script applies the RC1 items of
`design/SCOPE-DECISION.md` / WIPE-DECISIONS D-10..D-12 on top, each behind a flag in FLAGS, and
writes `forge-contracts/contracts/{forge-core,forge-collab,forge-community}.json` plus
`contracts/registered/forge-core.v1.json` (RC1 registers fresh, so the registered core is the
new core).

--check   write nothing; exit 1 when the committed contracts differ from a fresh build (CI).
--gate    run b7gate (design/final-schema/b7gate, rs-dpp v4.2.0-beta.7) on the result and print
          each contract's serialized size against the D-12 budget.
--off     turn flags off for a measurement run (implies nothing is written unless --out).

Item ids (R-xx, O-xx, INV-11, CL-7, CL-8, COMM-9) are those of dash-forge-qa
beta6/RULES-PROPOSAL.md and beta6/OPPORTUNITIES.md; the docs in docs/contracts/forge-v2.md
describe the result.
"""
import argparse
import base64
import copy
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACTS = os.path.join(os.path.dirname(HERE), 'contracts')
NAMES = ('forge-core', 'forge-collab', 'forge-community')
CORE = 'FORGE_CORE_CONTRACT_ID'
COLLAB = 'FORGE_COLLAB_CONTRACT_ID'

# D-12: aim for TARGET gate bytes per contract; CEILING is hard (>= 2 KB of real signed room).
TARGET, CEILING = 17408, 17832

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
)
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
        t.setdefault('immutable', []).append(name)


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


def build(flags):
    base = {n: json.load(open(os.path.join(HERE, 'base', f'{n}.json'))) for n in NAMES}
    core, collab, comm = (copy.deepcopy(base[n]) for n in NAMES)
    cd, ld, md = core['documentSchemas'], collab['documentSchemas'], comm['documentSchemas']
    f = flags
    # Flags that only register together: a `where` naming a stamp needs the stamp (else 40126 at
    # registration), and collab's provenance and stamps only fit with events moved out (O-01).
    needs = {'hook_public': 'vis_core', 'vis_collab': 'layout_events_out', 'import_provenance': 'layout_events_out',
             'thread_lock': 'import_provenance', 'member_verdicts': 'import_provenance', 'wrap_member': 'vis_core'}
    for flag, dep in needs.items():
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
            ld[t]['immutable'].append('imported')
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

    core['description'] = "Dash Forge v2 core: repositories, refs, packs, members, releases, labels, topics"
    collab['description'] = "Dash Forge v2 collaboration: issues, pull requests, transitions, comments, reviews, repo keys"
    comm['description'] = "Dash Forge v2 community: events, milestones, runners, check runs, policies, stars, webhooks"
    return {'forge-core': core, 'forge-collab': collab, 'forge-community': comm}


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


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--gate')
    ap.add_argument('--off', default='')
    ap.add_argument('--out', help='write the three files here instead of forge-contracts/contracts')
    a = ap.parse_args()
    flags = dict(FLAGS)
    for fl in filter(None, a.off.split(',')):
        if fl not in flags:
            sys.exit(f'unknown flag {fl}')
        flags[fl] = False
    contracts = build(flags)
    targets = {n: os.path.join(a.out or CONTRACTS, f'{n}.json') for n in NAMES}
    if not a.out and not a.off:
        targets['registered'] = os.path.join(CONTRACTS, 'registered', 'forge-core.v1.json')
    texts = {k: dumps(contracts['forge-core' if k == 'registered' else k]) for k in targets}
    if a.check and a.off:
        sys.exit('--check compares the full build: use it without --off')
    if a.check:
        stale = [p for k, p in targets.items() if not os.path.exists(p) or open(p).read() != texts[k]]
        for p in stale:
            print(f'stale: {os.path.relpath(p)} (re-run forge-contracts/schema/build.py)')
        sys.exit(1 if stale else 0)
    if a.out or not a.off:
        if a.out:
            os.makedirs(a.out, exist_ok=True)
        for k, p in targets.items():
            open(p, 'w').write(texts[k])
    if a.gate:
        failed = False
        for name, n in gate(a.gate, contracts).items():
            if isinstance(n, str):
                print(f'{name:16} {n[:1500]}')
                failed = True
                continue
            note = 'over the ceiling' if n > CEILING else 'over the target' if n > TARGET else 'ok'
            failed = failed or n > CEILING
            print(f'{name:16} {n:6} B  target {TARGET} ({TARGET - n:+}), ceiling {CEILING} ({CEILING - n:+})  {note}')
        sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()

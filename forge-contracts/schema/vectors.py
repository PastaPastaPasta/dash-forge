#!/usr/bin/env python3
"""The RC1 accept/refuse document vectors, one set per contract, written to
forge-contracts/vectors/rc1/<contract>.json (see its README for the format).

  python3 forge-contracts/schema/vectors.py [--check] [--gate <b7gate>]

--check  write nothing; exit 1 when the committed vectors differ from a fresh generation.
--gate   also judge every case with b7gate --cases (rs-dpp v4.2.0-beta.7) against the committed
         contracts and fail on any mismatch.

Every case is a document create judged the way a client pre-check (and a node's basic
validation) judges it: the JSON schema, maxBytes and every `propertyConstraints` rule that reads
no total, time or height. The rules that do (dense, c1..c6, lockGate, platformChunks, oneLive,
atMost20, notFuture), starBeat's distinctFrom and the registration `where` checks are the live suite's
(forge-contracts/scripts/rc1-live.mjs). A refused case names the item it covers and, in `why`,
a substring of the first error (a rule name, or a schema keyword), so a conformance runner can
check it refuses for the same reason.
"""
import argparse
import json
import re
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CONTRACTS = os.path.join(REPO, 'forge-contracts', 'contracts')
OUT = os.path.join(REPO, 'forge-contracts', 'vectors', 'rc1')
NAMES = ('forge-core', 'forge-collab', 'forge-community')
IDS = {'FORGE_CORE_CONTRACT_ID': 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1',
       'FORGE_COLLAB_CONTRACT_ID': 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS'}

DROP = object()
OWNER = 7          # the signer of every case (b7gate / contract-validate owner 0x07 * 32)


def i(n):
    return {"$id": n}


def b(fill, n):
    return {"$b": [fill, n]}


# ---- one valid document per type (RC1 shapes) ----
BASE = {
    # forge-core
    'repo': {"name": "dash-forge", "description": "git on Dash", "defaultBranch": "main", "visibility": "public", "topics": ["git", "dash"]},
    'maintainer': {"repoId": i(1), "memberId": i(OWNER), "vis": "public"},
    'writer': {"repoId": i(1), "memberId": i(9), "vis": "public", "consentBy": i(9)},
    'consent': {"repoId": i(1)},
    'refUpdate': {"repoId": i(1), "refNameHash": b(2, 32), "refName": "refs/heads/main", "newOid": b(1, 20), "vis": "public"},
    'protectedRefUpdate': {"repoId": i(1), "refNameHash": b(2, 32), "refName": "refs/heads/main", "newOid": b(1, 32), "prevOid": b(2, 32), "vis": "public"},
    'config': {"repoId": i(1), "defaultBranch": "main", "protectedPatterns": ["refs/heads/main", "refs/tags/**"], "backend": {"mode": 2, "uris": ["s3://b/p"]}, "vis": "public"},
    'packManifest': {"repoId": i(1), "packHash": i(4), "kind": 0, "sizeBytes": 14700, "objectCount": 10, "chunkCount": 1, "storage": 0, "tips": b(1, 20)},
    'chunk': {"repoId": i(1), "packHash": i(4), "seq": 0, "d0": b(0, 100)},
    'release': {"repoId": i(1), "tagName": "v1.2.3", "name": "one", "notes": "notes", "assets": "[]", "vis": "public", "delta": 1},
    'label': {"repoId": i(1), "name": "good first issue", "color": "#00ff00", "description": "d"},
    'topic': {"repoId": i(1), "name": "web-dev", "vis": "public"},
    # forge-collab
    'issue': {"repoId": i(1), "number": 1, "tk": 0, "title": "A bug", "body": "text", "vis": "public"},
    'patch': {"repoId": i(1), "number": 2, "tk": 1, "title": "A fix", "vis": "public", "baseRefNameHash": b(2, 32), "baseRefName": "refs/heads/main",
              "sourceRepoId": i(1), "sourceRefNameHash": b(3, 32), "sourceRefName": "refs/heads/fix", "headOid": b(1, 20)},
    'transition': {"repoId": i(1), "targetId": i(2), "targetNumber": 7, "targetKind": 0, "kind": 1, "delta": 1, "asAuthor": 0},
    'comment': {"repoId": i(1), "targetId": i(2), "body": "hi", "vis": "public"},
    'review': {"repoId": i(1), "patchId": i(3), "verdict": 3, "commitOid": b(1, 20), "body": "looks fine", "vis": "public"},
    'repoKey': {"repoId": i(1), "memberId": i(OWNER), "epoch": 0, "recipientKeyId": 1, "senderKeyId": 1, "wrapped": b(9, 48)},
    # forge-community
    'event': {"repoId": i(1), "targetId": i(2), "targetNumber": 7, "kind": 4, "value": "bug"},
    'authorEvent': {"repoId": i(1), "targetId": i(2), "targetNumber": 7, "kind": 11, "refId": i(3)},
    'milestone': {"repoId": i(1), "title": "v1"},
    'runner': {"repoId": i(1), "memberId": i(12)},
    'checkRun': {"repoId": i(1), "headOid": b(1, 20), "name": "build", "status": "completed", "conclusion": "success",
                 "startedAt": 1760000000000, "completedAt": 1760000060000, "outcome": 1, "vis": "public",
                 "detailsUrl": "https://ci.example.com/run/1", "summary": "ok", "externalId": "gh-1"},
    'policy': {"repoId": i(1), "requiredApprovals": 1, "requireChecks": True, "mergeMethods": 15, "requiredChecks": ["build", "lint"],
               "requiredCheckSources": [i(12), i(OWNER)]},
    'webhook': {"repoId": i(1), "hookId": b(3, 32), "url": "https://hooks.example.com/dash", "events": ["push"], "relayIdentityId": i(13),
                "relayKeyId": 1, "senderKeyId": 1, "secret": b(9, 48), "vis": "public"},
    'profile': {"displayName": "Al", "links": ["https://a.dev", "https://github.com/al"]},
    'star': {"repoId": i(1)},
    'watch': {"repoId": i(1)},
    'follow': {"identityId": i(9)},
    'starBeat': {"repoId": i(1), "vis": "public", "repoOwner": i(8)},
}
CONTRACT_OF = {t: 'forge-core' for t in ('repo', 'maintainer', 'writer', 'consent', 'refUpdate', 'protectedRefUpdate', 'config',
                                          'packManifest', 'chunk', 'release', 'label', 'topic')}
CONTRACT_OF.update({t: 'forge-collab' for t in ('issue', 'patch', 'transition', 'comment', 'review', 'repoKey')})
CONTRACT_OF.update({t: 'forge-community' for t in ('event', 'authorEvent', 'milestone', 'runner', 'checkRun', 'policy', 'webhook',
                                                    'profile', 'star', 'watch', 'follow', 'starBeat')})

CASES = []


def doc(t, /, **kw):
    d = json.loads(json.dumps(BASE[t]))
    for k, v in kw.items():
        k = k.replace('__', '.')
        if v is DROP:
            d.pop(k, None)
        else:
            d[k] = v
    return d


def case(item, label, t, expect, why, kw):
    owner = kw.pop('signer', None)  # another signer than OWNER (contract-validate judges these; b7gate skips them)
    c = {"item": item, "name": label, "type": t, "expect": expect, **({"why": why} if why else {}),
         **({"owner": owner} if owner is not None else {}), "doc": doc(t, **kw)}
    CASES.append(c)


def ok(item, label, t, /, **kw):
    case(item, label, t, "ok", None, kw)


def no(item, label, t, why, /, **kw):
    case(item, label, t, "refused", why, kw)


SEALED = dict(enc=b(5, 61), epoch=0)

# ---------------- base shapes ----------------
for t in BASE:
    ok('base', f'{t} ok', t)

# ---------------- R-01 ref grammar (+ `@{`) ----------------
for n in ('refs/heads/main', 'refs/heads/release/1.x', 'refs/mirror/pull/12/head', 'refs/tags/v1.2.3', 'refs/heads/ünïcode',
          'refs/heads/v1./x', 'refs/heads/a@b', 'refs/heads/@', 'refs/heads/{x}', 'refs/heads/x@', 'refs/heads/{@', 'refs/' + 'a' * 250):
    ok('R-01', f'ref {n[:40]!r} ({len(n)} B)', 'refUpdate', refName=n)
for n, why in (('refs/heads/a..b', 'pattern'), ('refs/heads/.x', 'pattern'), ('refs/heads/x/', 'pattern'), ('refs//x', 'pattern'),
               ('refs/heads/x.', 'pattern'), ('refs/heads/*', 'pattern'), ('HEAD', 'minLength'), ('heads/main', 'pattern'),
               ('refs/heads/a:b', 'pattern'), ('refs/heads/a\\b', 'pattern'), ('refs/heads/a\tb', 'pattern'), ('refs/heads/a\x7fb', 'pattern'),
               ('refs/heads/a b', 'pattern'), ('refs/heads/a\n' + '0' * 40 + ' refs/heads/main', 'pattern'), ('refs/heads/a~1', 'pattern'),
               ('refs/heads/a^', 'pattern'), ('refs/heads/a?', 'pattern'), ('refs/heads/[x', 'pattern'),
               ('refs/heads/a@{1}', 'pattern'), ('refs/heads/@{', 'pattern'), ('refs/heads/x@@{y', 'pattern'), ('refs/' + 'a' * 251, 'maxLength')):
    no('R-01', f'ref {n[:40]!r} ({len(n)} B)', 'refUpdate', why, refName=n)
no('R-01', 'ref ending .lock', 'refUpdate', 'noLock', refName='refs/heads/x.lock')
no('R-01', 'protected ref ending .lock', 'protectedRefUpdate', 'noLock', refName='refs/heads/main.lock')
ok('R-01', 'ref .lock in a middle component (reader rule)', 'refUpdate', refName='refs/heads/x.lock/y')
ok('R-01', 'zero-oid delete', 'refUpdate', newOid=b(0, 20), prevOid=b(1, 20))
for n in ('main', 'release/1.x', 'refs/heads/main', 'ünï', '@', 'a@b'):
    ok('R-01', f'defaultBranch {n!r}', 'repo', defaultBranch=n)
for n in ('-main', 'ma in', '.main', 'main/', 'a..b', 'a@{1}', 'x.'):
    no('R-01', f'defaultBranch {n!r}', 'repo', 'pattern', defaultBranch=n)
no('R-01', 'config defaultBranch -x', 'config', 'pattern', defaultBranch='-x')
for n in ('v1.2.3', 'release/2026', '-Ab3_x9QkZ', 'v1@b'):
    ok('R-01', f'tagName {n!r}', 'release', tagName=n)
for n in ('v1 beta', 'v1^0', 'v1..2', '.hidden', 'v1@{0}', 'v1/'):
    no('R-01', f'tagName {n!r}', 'release', 'pattern', tagName=n)
no('R-01', 'patch base ref a..b', 'patch', 'pattern', baseRefName='refs/heads/a..b')
no('R-01', 'patch source ref with a newline', 'patch', 'pattern', sourceRefName='refs/heads/a\nb')
no('R-01', 'patch source ref without refs/', 'patch', 'pattern', sourceRefName='feature/x')

# ---------------- R-02 private => no plaintext (core) ----------------
ok('R-02', 'sealed private ref', 'refUpdate', refName=DROP, vis='private', **SEALED)
no('R-02', 'private ref with plaintext name', 'refUpdate', 'noPlain', vis='private')
no('R-02', 'public ref with name and enc', 'refUpdate', 'noPlain', **SEALED)
no('R-02', 'ref without vis', 'refUpdate', 'required', vis=DROP)
no('R-02', 'ref vis internal', 'refUpdate', 'enum', vis='internal')
ok('R-02', 'sealed private protected ref', 'protectedRefUpdate', refName=DROP, vis='private', **SEALED)
no('R-02', 'private protected ref with plaintext name', 'protectedRefUpdate', 'noPlain', vis='private')
ok('R-02', 'sealed private config with plaintext backend', 'config', defaultBranch=DROP, protectedPatterns=DROP, vis='private', archived=True, **SEALED)
no('R-02', 'private config with plaintext branch', 'config', 'noPlain', vis='private')
ok('R-02', 'sealed private release', 'release', tagName='-Ab3_x9QkZ', name=DROP, notes=DROP, assets=DROP, vis='private', delta=0, **SEALED)
no('R-02', 'private plaintext release', 'release', 'noPlain', vis='private')
ok('R-02', 'private member document', 'maintainer', vis='private')
no('R-02', 'maintainer without vis', 'maintainer', 'required', vis=DROP)
ok('R-02', 'label definitions stay plaintext (no stamp)', 'label')
ok('R-02', 'sealed label', 'label', color=DROP, description=DROP, **SEALED)

# ---------------- R-06 member consent ----------------
ok('R-06', 'owner self-enrols a maintainer', 'maintainer')
ok('R-06', 'owner self-enrols with a stray consentBy', 'maintainer', consentBy=i(8))
ok('R-06', 'consented writer', 'writer')
ok('R-06', 'consented maintainer', 'maintainer', memberId=i(9), consentBy=i(9))
no('R-06', 'forced maintainer', 'maintainer', 'ownerOrConsented', memberId=i(9))
no('R-06', 'forced writer', 'writer', 'ownerOrConsented', consentBy=DROP)
no('R-06', 'borrowed consent', 'writer', 'ownerOrConsented', consentBy=i(8))
no('R-06', 'consent with an extra field', 'consent', 'additionalProperties', note='x')

# ---------------- R-09 pack completeness ----------------
ok('R-09', 'fork manifest (storage 1, no chunks, any size)', 'packManifest', storage=1, chunkCount=0, sizeBytes=50_000_000_000)
ok('R-09', 'empty Platform pack', 'packManifest', chunkCount=0, sizeBytes=0)
ok('R-09', 'Platform pack at the chunk bound', 'packManifest', chunkCount=2, sizeBytes=29400)
no('R-09', 'storage 1 with chunks', 'packManifest', 'storageShape', storage=1, chunkCount=3)
no('R-09', 'Platform pack over its chunks', 'packManifest', 'storageShape', chunkCount=1, sizeBytes=14701)
no('R-09', 'offsetIndexParts is gone', 'packManifest', 'additionalProperties', offsetIndexParts=0)
no('R-09', 'packHash of 31 bytes', 'chunk', 'minItems', packHash=b(4, 31))

# ---------------- R-10 oid width ----------------
ok('R-10', 'ref 32/32', 'refUpdate', newOid=b(1, 32), prevOid=b(2, 32))
ok('R-10', 'ref 32 new, 20 prev', 'refUpdate', newOid=b(1, 32), prevOid=b(2, 20))
no('R-10', 'ref newOid 25', 'refUpdate', 'oidWidth', newOid=b(1, 25))
no('R-10', 'ref prevOid 21', 'refUpdate', 'oidWidth', prevOid=b(1, 21))
no('R-10', 'protected ref newOid 31', 'protectedRefUpdate', 'oidWidth', newOid=b(1, 31))
no('R-10', 'patch headOid 25', 'patch', 'oidWidth', headOid=b(1, 25))
no('R-10', 'merge oid 25', 'transition', 'oidWidth', targetKind=1, kind=13, delta=2, oid=b(1, 25))
ok('R-10', 'merge oid 20', 'transition', targetKind=1, kind=13, delta=2, oid=b(1, 20))
no('R-10', 'comment commitOid 25', 'comment', 'oidWidth', commitOid=b(1, 25))
no('R-10', 'review commitOid 30', 'review', 'oidWidth', commitOid=b(1, 30))
no('R-10', 'event headUpdate oid 31', 'event', 'oidWidth', kind=16, value=DROP, oid=b(1, 31))
no('R-10', 'authorEvent headUpdate oid 31', 'authorEvent', 'oidWidth', kind=16, refId=DROP, oid=b(1, 31))
no('R-10', 'checkRun head 21', 'checkRun', 'oidWidth', headOid=b(1, 21))
ok('R-10', 'checkRun head 32', 'checkRun', headOid=b(1, 32))

# ---------------- R-11 pack kind shape ----------------
ok('R-11', 'history index with a 20-byte tip', 'packManifest', kind=3)
ok('R-11', 'history index with two 20-byte tips', 'packManifest', kind=3, tips=b(1, 40))
ok('R-11', 'release assets (kind 4) with no tips', 'packManifest', kind=4, tips=DROP)
ok('R-11', 'repack superseding two', 'packManifest', tips=b(1, 320), supersedes=b(2, 64))
no('R-11', 'history index with no tips', 'packManifest', 'kindShape', kind=3, tips=DROP)
no('R-11', 'history index with 60 B of tips', 'packManifest', 'kindShape', kind=3, tips=b(1, 60))
no('R-11', 'supersedes of 33 B', 'packManifest', 'kindShape', supersedes=b(2, 33))

# ---------------- R-12 repo shape ----------------
ok('R-12', 'public fork', 'repo', forkOf=i(9))
ok('R-12', 'private repo with description and topics', 'repo', visibility='private', defaultBranch=DROP)
for n in ('a.git.b', 'foo.github', 'git'):
    ok('R-12', f'name {n}', 'repo', name=n)
no('R-12', 'private fork', 'repo', 'forkIsPublic', visibility='private', defaultBranch=DROP, forkOf=i(9))
no('R-12', 'private repo with a default branch', 'repo', 'privateNoBranch', visibility='private')
no('R-12', 'name foo.git', 'repo', 'nameNotDotGit', name='foo.git')

# ---------------- R-20 topics (cap 20) ----------------
for n in ('rust', 'c', 'web-dev', 'a1-b2'):
    ok('R-20', f'topic {n}', 'topic', name=n)
for n in ('rust-', 'a--b', '-x', 'Rust'):
    no('R-20', f'topic {n}', 'topic', 'pattern', name=n)
no('R-20', 'topic name of 31', 'topic', 'maxLength', name='a' * 31)
no('R-20', 'topic on a private repo stamp', 'topic', 'enum', vis='private')
no('R-20', 'topic without vis', 'topic', 'required', vis=DROP)
ok('R-20', 'repo with 20 topics', 'repo', topics=[f't{n}' for n in range(20)])
no('R-20', 'repo with 21 topics', 'repo', 'maxItems', topics=[f't{n}' for n in range(21)])
no('R-20', 'repo topic rust-', 'repo', 'pattern', topics=['rust-'])

# ---------------- O-04 release ledger ----------------
ok('O-04', 'edit or yank (delta 0)', 'release', delta=0, yanked=True)
ok('O-04', 'unpublish (delta -1)', 'release', delta=-1)
ok('O-04', 'import with a manifest', 'release', assetManifest=b(3, 32), imported={"url": "https://github.com/x/y/releases/tag/v1", "createdAt": 1})
no('O-04', 'delta 2', 'release', 'maximum', delta=2)
no('O-04', 'release without delta', 'release', 'required', delta=DROP)

# ---------------- O-05 pack bytes ----------------
ok('O-05', '50 GB external pack', 'packManifest', storage=1, chunkCount=0, sizeBytes=50 * 10**9)
ok('O-05', '1 TiB external pack', 'packManifest', storage=1, chunkCount=0, sizeBytes=1099511627776)
no('O-05', 'negative size', 'packManifest', 'sizeNonNeg', sizeBytes=-1)
no('O-05', 'size over 1 TiB', 'packManifest', 'sizeNonNeg', storage=1, chunkCount=0, sizeBytes=1099511627777)

# ---------------- INV-11 free tightenings ----------------
ok('INV-11', 'config enc of 61 B', 'config', defaultBranch=DROP, protectedPatterns=DROP, vis='private', **SEALED)
no('INV-11', 'config enc of 60 B (v1 envelope)', 'config', 'encV2', defaultBranch=DROP, protectedPatterns=DROP, vis='private', enc=b(5, 60), epoch=0)
no('INV-11', 'enc of 28 B', 'issue', 'minItems', title=DROP, body=DROP, vis='private', enc=b(5, 28), epoch=0)
ok('INV-11', 'enc of 29 B', 'issue', title=DROP, body=DROP, vis='private', enc=b(5, 29), epoch=0)
no('INV-11', 'duplicate protected patterns', 'config', 'uniqueItems', protectedPatterns=['refs/heads/main', 'refs/heads/main'])

# ---------------- CL-8 label grammar ----------------
for n in ('bug', 'good first issue', 'área: web', 'a'):
    ok('CL-8', f'label {n!r}', 'label', name=n)
for n in (' bug', 'bug ', 'a\tb', 'a\nb', ' '):
    no('CL-8', f'label {n!r}', 'label', 'pattern', name=n)

# ---------------- R-03 private => sealed (collab) ----------------
ok('R-03', 'sealed private issue', 'issue', title=DROP, body=DROP, vis='private', **SEALED)
no('R-03', 'private issue with a plaintext title', 'issue', 'p_sealedIfPrivate', vis='private')
no('R-03', 'issue without vis', 'issue', 'required', vis=DROP)
no('R-03', 'issue vis internal', 'issue', 'enum', vis='internal')
no('R-03', 'private patch in plaintext', 'patch', 'p_sealedIfPrivate', vis='private')
ok('R-03', 'sealed private comment', 'comment', body=DROP, vis='private', **SEALED)
no('R-03', 'private comment in plaintext', 'comment', 'p_sealedIfPrivate', vis='private')
no('R-03', 'private inline comment with a plaintext path and enc', 'comment', 'noPlain', body=DROP, path='src/a.rs', vis='private', **SEALED)
ok('R-03', 'private bodyless member approval', 'review', verdict=1, body=DROP, asMember=i(OWNER), vis='private')
ok('R-03', 'private imported comment verdict with createdAt only', 'review', body=DROP, imported={"createdAt": 1}, vis='private')
no('R-03', 'private review with a plaintext body', 'review', 'p_sealedIfPrivate', vis='private')

# ---------------- R-04 import provenance ----------------
IMP = {"author": "a", "createdAt": 1, "url": "https://github.com/x/y/issues/7761"}
ok('R-04', 'imported issue with a proof', 'issue', imported=IMP, upstreamNumber=7761, asMember=i(OWNER))
ok('R-04', 'empty imported counts as absent', 'issue', imported={})
no('R-04', 'imported issue without a proof', 'issue', 'i_provenance', imported=IMP)
no('R-04', 'upstreamNumber without a proof', 'issue', 'i_provenance', upstreamNumber=7761)
no('R-04', 'imported patch without a proof', 'patch', 'i_provenance', imported=IMP)
ok('R-04', 'imported patch with a proof', 'patch', imported=IMP, upstreamNumber=12, asMember=i(OWNER))
no('R-04', 'imported comment without a proof', 'comment', 'i_provenance', imported=IMP)
ok('R-04', 'imported comment with a proof', 'comment', imported=IMP, asMember=i(OWNER))
no('R-04', 'proof naming another identity', 'issue', 'm_self', asMember=i(9))
no('R-04', 'patch proof naming another identity', 'patch', 'm_self', asMember=i(9))
no('R-04', 'sealed private import without a proof', 'issue', 'i_provenance', title=DROP, body=DROP, vis='private', imported={"createdAt": 1}, **SEALED)

# ---------------- R-14 reply thread ----------------
ok('R-14', 'reply to a root', 'comment', replyTo=i(6))
ok('R-14', 'line range', 'comment', commitOid=b(1, 20), path='a.rs', line=5, startLine=3, side=1)
ok('R-14', 'outdated import with no line', 'comment', path='a.rs', side=1)
no('R-14', 'noParent set', 'comment', 'noParentSet', noParent=i(6))
no('R-14', 'range start after end', 'comment', 'rangeOrder', commitOid=b(1, 20), path='a.rs', line=3, startLine=5)
no('R-14', 'range start without a line', 'comment', 'rangeOrder', commitOid=b(1, 20), path='a.rs', startLine=5)

# ---------------- R-15 thread lock ----------------
ok('R-15', 'issue lock', 'transition', kind=3, delta=16)
ok('R-15', 'issue unlock', 'transition', kind=4, delta=-16)
ok('R-15', 'PR lock', 'transition', targetKind=1, kind=18, delta=16)
ok('R-15', 'PR unlock', 'transition', targetKind=1, kind=19, delta=-16)
ok('R-15', 'author close still ok', 'transition', asAuthor=7)
no('R-15', 'lock with delta 1', 'transition', 'b4_lockDelta', kind=3, delta=1)
no('R-15', 'unlock with delta 16', 'transition', 'b4_lockDelta', kind=4, delta=16)
no('R-15', 'issue lock on a PR target', 'transition', 'a_kindOfTarget', targetKind=1, kind=3, delta=16)
no('R-15', 'lock by the author', 'transition', 'g_memberLock', kind=3, delta=16, asAuthor=7)
no('R-15', 'delta 17', 'transition', 'maximum', kind=3, delta=17)
no('R-15', 'kind 5 is no transition', 'transition', 'enum', kind=5, delta=0)
no('R-15', 'comment proof of another identity', 'comment', 'm_self', asMember=i(9))
ok('R-15', 'member comment with a proof', 'comment', asMember=i(OWNER))
no('R-15', 'event kind 21 (retired lock event)', 'event', 'noState', kind=21, value=DROP)
no('R-15', 'event kind 22 (retired unlock event)', 'event', 'noState', kind=22, value=DROP)

# ---------------- transitions (STATE-COUNTS, unchanged except mod 16) ----------------
ok('state', 'issue close', 'transition')
no('state', 'issue close with delta 0', 'transition', 'b1_closeDelta', delta=0)
no('state', 'issue close on a PR target', 'transition', 'a_kindOfTarget', targetKind=1)
ok('state', 'PR close', 'transition', targetKind=1, kind=11)
ok('state', 'PR reopen', 'transition', targetKind=1, kind=12, delta=-1)
no('state', 'PR reopen with delta 1', 'transition', 'b2_reopenDelta', targetKind=1, kind=12)
ok('state', 'PR merge', 'transition', targetKind=1, kind=13, delta=2, oid=b(170, 20))
no('state', 'PR merge without oid', 'transition', 'e_mergeOid', targetKind=1, kind=13, delta=2)
no('state', 'PR merge by its author', 'transition', 'f_authorNoMerge', targetKind=1, kind=13, delta=2, asAuthor=7, oid=b(170, 20))
ok('state', 'PR draft', 'transition', targetKind=1, kind=14, delta=8, asAuthor=7)
ok('state', 'PR ready', 'transition', targetKind=1, kind=15, delta=-8, asAuthor=7)
no('state', 'PR draft with delta 1', 'transition', 'b3_otherDelta', targetKind=1, kind=14, delta=1)
ok('state', 'draft PR close', 'transition', targetKind=1, kind=16)
ok('state', 'draft PR reopen', 'transition', targetKind=1, kind=17, delta=-1)
no('state', 'issue with the PR tk', 'issue', 'enum', tk=1)
no('state', 'event close kind', 'event', 'minimum', kind=1, value=DROP)
no('state', 'event draft kind', 'event', 'noState', kind=9, value=DROP)
ok('state', 'event headUpdate', 'event', kind=16, value=DROP, oid=b(2, 20))
no('state', 'authorEvent close kind', 'authorEvent', 'enum', kind=1, refId=DROP)

# ---------------- R-16 member verdicts ----------------
ok('R-16', 'member approve with a proof', 'review', verdict=1, asMember=i(OWNER))
ok('R-16', 'member request changes with a proof', 'review', verdict=2, asMember=i(OWNER))
ok('R-16', 'member comment verdict with a proof', 'review', verdict=3, asMember=i(OWNER))
ok('R-16', 'non-member approve', 'review', verdict=4)
ok('R-16', 'non-member request changes', 'review', verdict=5)
no('R-16', 'approve without a proof', 'review', 'memberVerdict', verdict=1)
no('R-16', 'request changes without a proof', 'review', 'memberVerdict', verdict=2)
no('R-16', 'non-member verdict with a proof', 'review', 'memberVerdict', verdict=4, asMember=i(OWNER))
no('R-16', 'proof of another identity', 'review', 'm_self', verdict=1, asMember=i(9))
no('R-16', 'verdict 6', 'review', 'maximum', verdict=6)

# ---------------- R-13 repoKey (offline: shape only) ----------------
ok('R-13', 'self wrap', 'repoKey')
no('R-13', 'wrap of 16 B', 'repoKey', 'minItems', wrapped=b(9, 16))

# ---------------- CL-7 text grammar ----------------
ok('CL-7', 'title with inner spaces', 'issue', title='a  b')
for t, why in ((' ', 'pattern'), ('  ', 'pattern'), ('a\tb', 'pattern'), ('a\nb', 'pattern')):
    no('CL-7', f'title {t!r}', 'issue', why, title=t)
no('CL-7', 'body of spaces', 'comment', 'pattern', body='   ')
ok('CL-7', 'body with newlines', 'comment', body='a\n\nb')

# ---------------- R-07 URL grammar ----------------
for u in ('https://github.com/o/r/actions/runs/1', 'https://10.0.0.5:8443/job/1', 'https://ci.example.com'):
    ok('R-07', f'detailsUrl {u}', 'checkRun', detailsUrl=u)
for u in ('javascript:alert(1)', 'http://ci.example.com/1', 'https://github.com@evil.example/x', 'https://a b', 'https://a\n', 'HTTPS://a.b', 'https:///x'):
    no('R-07', f'detailsUrl {u!r}', 'checkRun', 'pattern', detailsUrl=u)
ok('R-07', 'logUrl ipfs', 'checkRun', logUrl='ipfs://bafy123', logSha256=b(1, 32))
ok('R-07', 'logUrl https', 'checkRun', logUrl='https://logs.example.com/1.txt', logSha256=b(1, 32))
for u in ('http://logs.example.com/1', 's3://bucket/1'):
    no('R-07', f'logUrl {u}', 'checkRun', 'pattern', logUrl=u, logSha256=b(1, 32))
for u in ('javascript:x', 'http://a.dev', 'data:text/html,x', 'mailto:a@b.c'):
    no('R-07', f'profile link {u}', 'profile', 'pattern', links=[u])
for u in ('https://hooks.example.com:8443/x?y=1', 'https://xn--bcher-kva.example/h'):
    ok('R-07', f'webhook {u}', 'webhook', url=u)
for u in ('https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://localhost:9099/x', 'https://[::1]/x', 'https://u:p@hooks.example.com/x',
          'http://hooks.example.com/x', 'https://127.1/x', 'https://2130706433/x', 'https://hooks.example.com./x'):
    no('R-07', f'webhook {u}', 'webhook', 'pattern', url=u)

# ---------------- R-08 check sources ----------------
ok('R-08', 'names only', 'policy', requiredCheckSources=DROP)
ok('R-08', 'neither', 'policy', requiredChecks=DROP, requiredCheckSources=DROP)
ok('R-08', 'an empty source list', 'policy', requiredCheckSources=[])
ok('R-08', 'the same runner twice', 'policy', requiredCheckSources=[i(12), i(12)])
no('R-08', 'two names, one source', 'policy', 'sourcesMatchNames', requiredCheckSources=[i(12)])
no('R-08', 'sources with no names', 'policy', 'sourcesMatchNames', requiredChecks=DROP)
no('R-08', 'mergeMethods 16', 'policy', 'maximum', mergeMethods=16)
no('R-08', 'eleven sources', 'policy', 'maxItems', requiredCheckSources=[i(12)] * 11)

# ---------------- R-17 check run sanity ----------------
ok('R-17', 'start == end', 'checkRun', completedAt=1760000000000)
ok('R-17', 'a 2012 run', 'checkRun', startedAt=1330000000000, completedAt=1330000000001)
ok('R-17', 'queued, no times', 'checkRun', status='queued', conclusion=DROP, startedAt=DROP, completedAt=DROP, outcome=0)
no('R-17', 'end before start', 'checkRun', 'doneAfterStart', completedAt=1759999999999)
no('R-17', 'seconds, not ms', 'checkRun', 'msEpoch', startedAt=1760000000, completedAt=1760000060)
no('R-17', 'the old fixture startedAt 5', 'checkRun', 'msEpoch', status='in_progress', conclusion=DROP, startedAt=5, completedAt=DROP, outcome=0)

# ---------------- D-5 monotonic check runs (unchanged) ----------------
no('D-5', 'running without startedAt', 'checkRun', 'startedIfRunning', status='in_progress', conclusion=DROP, startedAt=DROP, completedAt=DROP, outcome=0)
no('D-5', 'queued with startedAt', 'checkRun', 'runningIfStarted', status='queued', conclusion=DROP, completedAt=DROP, outcome=0)
no('D-5', 'completed without completedAt', 'checkRun', 'completedAtIfDone', completedAt=DROP)
no('D-5', 'completedAt while running', 'checkRun', 'doneIfCompletedAt', status='in_progress', conclusion=DROP, outcome=0)
no('D-5', 'completed with no conclusion', 'checkRun', 'conclusionIfDone', conclusion=DROP, outcome=2)
no('D-5', 'a log URL without its hash', 'checkRun', 'required', logUrl='https://logs.example.com/1')

# ---------------- O-07 check outcome ----------------
ok('O-07', 'in progress = 0', 'checkRun', status='in_progress', conclusion=DROP, completedAt=DROP, outcome=0)
for c, o in (('success', 1), ('neutral', 1), ('skipped', 1), ('failure', 2), ('cancelled', 2), ('timed_out', 2), ('action_required', 2), ('stale', 2)):
    ok('O-07', f'{c} = {o}', 'checkRun', conclusion=c, outcome=o)
no('O-07', 'failure marked passed', 'checkRun', 'outcomeOf', conclusion='failure', outcome=1)
no('O-07', 'success marked failed', 'checkRun', 'outcomeOf', outcome=2)
no('O-07', 'queued marked passed', 'checkRun', 'outcomeOf', status='queued', conclusion=DROP, startedAt=DROP, completedAt=DROP, outcome=1)
no('O-07', 'outcome 3', 'checkRun', 'maximum', outcome=3)
no('O-07', 'no outcome', 'checkRun', 'required', outcome=DROP)

# ---------------- R-18 private CI ----------------
ok('R-18', 'private completed run with no text', 'checkRun', vis='private', detailsUrl=DROP, summary=DROP, externalId=DROP)
for p, v in (('summary', 'ok'), ('detailsUrl', 'https://ci.example.com/1'), ('externalId', 'gh-1'), ('artifacts', '[]')):
    no('R-18', f'private run with {p}', 'checkRun', 'privateNoText', vis='private',
       **{k: DROP for k in ('detailsUrl', 'summary', 'externalId') if k != p}, **{p: v})
no('R-18', 'private run with a log URL', 'checkRun', 'privateNoText', vis='private', detailsUrl=DROP, summary=DROP, externalId=DROP,
   logUrl='https://logs.example.com/1', logSha256=b(1, 32))
no('R-18', 'run without vis', 'checkRun', 'required', vis=DROP)
no('R-18', 'run vis internal', 'checkRun', 'enum', vis='internal')

# ---------------- R-19 public hooks ----------------
no('R-19', 'webhook on a private repo', 'webhook', 'publicOnly', vis='private')
no('R-19', 'webhook without vis', 'webhook', 'required', vis=DROP)

# ---------------- O-08 trending public ----------------
no('O-08', 'private beat', 'starBeat', 'enum', vis='private')
no('O-08', 'beat without repoOwner', 'starBeat', 'required', repoOwner=DROP)
no('O-08', 'beat without vis', 'starBeat', 'required', vis=DROP)
no('O-08', 'the old {repoId} beat', 'starBeat', 'required', vis=DROP, repoOwner=DROP)

# ---------------- COMM-9 social counters (index-only shapes unchanged) ----------------
no('COMM-9', 'star with an extra field', 'star', 'additionalProperties', note='x')

# ---------------- O-01 / O-02 moved types keep their shapes ----------------
ok('O-01', 'milestone with a due date', 'milestone', description='d', dueOn=1760000000)
no('O-01', 'milestone plaintext description in a sealed doc', 'milestone', 'noPlain', description='d', **SEALED)
ok('O-01', 'authorEvent resolve', 'authorEvent')
no('O-02', 'runner with an extra field', 'runner', 'additionalProperties', kind=1)


# ---------------- the older rules every type keeps ----------------
no('base', 'ref with neither name nor enc', 'refUpdate', 'hasName', refName=DROP)
no('base', 'protected ref with neither name nor enc', 'protectedRefUpdate', 'hasName', refName=DROP)
no('base', 'issue with neither title nor enc', 'issue', 'hasTitle', title=DROP)
no('base', 'patch with neither title nor enc', 'patch', 'hasTitle', title=DROP)
no('base', 'comment with neither body nor enc', 'comment', 'hasBody', body=DROP)
no('base', 'sealed issue with a plaintext title', 'issue', 'noPlain', **SEALED)
no('base', 'sealed patch with a plaintext base ref', 'patch', 'noPlain', title=DROP, **SEALED)
no('base', 'sealed review with a plaintext body', 'review', 'noPlain', **SEALED)
no('base', 'sealed label with a plaintext colour', 'label', 'noPlain', description=DROP, **SEALED)
no('base', 'sealed event with a plaintext value', 'event', 'noPlain', **SEALED)
no('base', 'label event without a value', 'event', 'needValue', value=DROP)
no('base', 'assignee event without refId', 'event', 'needAssignee', kind=6)
no('base', 'resolve event without refId', 'event', 'needRefId', kind=11, value=DROP)
no('base', 'headUpdate event without oid', 'event', 'needOid', kind=16, value=DROP)
no('base', 'author resolve without refId', 'authorEvent', 'needRefId', refId=DROP)
no('base', 'author headUpdate without oid', 'authorEvent', 'needOid', kind=16, refId=DROP)
no('D-5', 'conclusion while running', 'checkRun', 'doneIfConclusion', status='in_progress', completedAt=DROP, outcome=0)


# ---------------- other signers and literal encodings (contract-validate only; b7gate signs as 7) ----------------
ok('R-06', 'a member enrols itself', 'maintainer', memberId=i(9), signer=9)
no('R-06', 'a stranger enrols someone else', 'writer', 'ownerOrConsented', consentBy=DROP, signer=8)
ok('R-04', 'imported issue proved by its signer 9', 'issue', imported=IMP, asMember=i(9), signer=9)
ok('base', 'hex oid and base58 repo id', 'refUpdate', repoId={"$id": "A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1"}, newOid={"$hex": "ab" * 20})
no('R-10', 'hex oid of 21 bytes', 'refUpdate', 'oidWidth', newOid={"$hex": "ab" * 21})

# Rules that read a total, a time or a height: judged on chain only (forge-contracts/scripts/rc1-live.mjs).
LIVE_ONLY = {('issue', 'dense'), ('patch', 'dense'), ('transition', 'c1_closedAfter'), ('transition', 'c2_openAfter'),
             ('transition', 'c3_mergedAfter'), ('transition', 'c4_draftAfter'), ('transition', 'c5_draftClosedAfter'),
             ('transition', 'c6_lockedAfter'), ('comment', 'lockGate'), ('review', 'lockGate'),
             ('packManifest', 'platformChunks'), ('release', 'oneLive'), ('topic', 'atMost20'), ('checkRun', 'notFuture')}


def uncovered():
    """(contract, type, rule) with no refusing vector and not judged on chain only."""
    refused = {(c['type'], c['why']) for c in CASES if c['expect'] == 'refused'}
    out = []
    for name in NAMES:
        for t, d in json.load(open(os.path.join(CONTRACTS, f'{name}.json')))['documentSchemas'].items():
            for rule in d.get('propertyConstraints', {}):
                if (t, rule) not in refused and (t, rule) not in LIVE_ONLY:
                    out.append((name, t, rule))
    return out


def split():
    out = {n: [] for n in NAMES}
    seen = set()
    for c in CASES:
        key = (c['type'], c['name'])
        assert key not in seen, key
        seen.add(key)
        out[CONTRACT_OF[c['type']]].append(c)
    return out


def dumps(cases):
    return json.dumps(cases, indent=1, ensure_ascii=False) + '\n'


def gate(gate_bin, sets):
    bad = 0
    with tempfile.TemporaryDirectory() as tmp:
        for name, cases in sets.items():
            s = open(os.path.join(CONTRACTS, f'{name}.json')).read()
            for k, v in IDS.items():
                s = s.replace(k, v)
            cp = os.path.join(tmp, f'{name}.json')
            open(cp, 'w').write(s)
            cases = [c for c in cases if 'owner' not in c and '"$hex"' not in json.dumps(c) and '"$id": "' not in json.dumps(c)]
            vp = os.path.join(tmp, f'{name}.cases.json')
            open(vp, 'w').write(json.dumps(cases))
            r = subprocess.run([gate_bin, '--cases', cp, vp], capture_output=True, text=True)
            lines = r.stdout.splitlines()
            for c, line in zip(cases, lines):
                mism = line.startswith('MISMATCH')
                got = re.search(r'refused +\[([^\]]+)\]', line)
                wrong_reason = not mism and c['expect'] == 'refused' and (got is None or got.group(1) != c['why'])
                if mism or wrong_reason:
                    bad += 1
                    print(('REASON ' if wrong_reason else '') + line + (f'   [want {c["why"]!r}]' if wrong_reason else ''))
            n_ok = sum(1 for c in cases if c['expect'] == 'ok')
            print(f'{name}: {len(cases)} cases ({n_ok} accept, {len(cases) - n_ok} refuse), gate exit {r.returncode}')
            if len(lines) != len(cases):
                print(r.stdout[-2000:], r.stderr[-2000:])
                bad += 1
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--gate')
    a = ap.parse_args()
    sets = split()
    paths = {n: os.path.join(OUT, f'{n}.json') for n in NAMES}
    missing = uncovered()
    for m in missing:
        print('no refusing vector for rule %s.%s.%s' % m)
    if a.check:
        stale = [p for n, p in paths.items() if not os.path.exists(p) or open(p).read() != dumps(sets[n])]
        for p in stale:
            print(f'stale: {os.path.relpath(p, REPO)} (re-run forge-contracts/schema/vectors.py)')
        sys.exit(1 if stale or missing else 0)
    os.makedirs(OUT, exist_ok=True)
    for n, p in paths.items():
        open(p, 'w').write(dumps(sets[n]))
    print(f'{len(CASES)} cases written to {os.path.relpath(OUT, REPO)}')
    sys.exit(1 if missing or (a.gate and gate(a.gate, sets)) else 0)

if __name__ == '__main__':
    main()

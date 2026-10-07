#!/usr/bin/env python3
"""The JSON Schemas of `dg … --json`, written to docs/schemas/dg/ with an index (README.md and
index.json). One schema per command; the shapes they share are in dg/common.schema.json.

  python3 docs/schemas/generate.py           write the files
  python3 docs/schemas/generate.py --check   write nothing; exit 1 when a committed file differs

The specs below are the source: edit them with the command's output, then regenerate. dg's unit
test `json_schemas` checks that every dg command is in the index, that every schema compiles, and
that the output of dg's own JSON builders validates against them.

Every schema follows the same rules (docs/VERSIONING.md):
- the output is an object carrying `"schemaVersion": 1`;
- `required` lists the fields every success of that command has; others appear in some outcomes;
- `additionalProperties` is true: a new field is not a breaking change;
- a field typed `{}` is passed through as Platform or a sub-tool returns it.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'dg')
# Raw URLs, so a validator can fetch common.schema.json when it resolves a `$ref`.
BASE = 'https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/docs/schemas/dg/'
VERSION = 1

# ---------------------------------------------------------------------------------------------
# Type helpers
# ---------------------------------------------------------------------------------------------

S = {'type': 'string'}
I = {'type': 'integer'}
F = {'type': 'number'}
B = {'type': 'boolean'}
ANY = {}
OBJ = {'type': 'object'}


def nl(t):
    """`t` or null."""
    if set(t) == {'type'} and isinstance(t['type'], str):
        return {'type': [t['type'], 'null']}
    return {'anyOf': [t, {'type': 'null'}]}


def A(items=None):
    return {'type': 'array', 'items': items} if items is not None else {'type': 'array'}


def O(props, req=()):
    o = {'type': 'object', 'properties': props}
    if req:
        o['required'] = list(req)
    return o


def E(*values):
    return {'type': 'string', 'enum': list(values)}


def R(name):
    return {'$ref': f'common.schema.json#/$defs/{name}'}


def D(desc, t):
    return {**t, 'description': desc}


SA = A(S)
COST = R('cost')
NCOST = nl(R('cost'))
STEPS = R('steps')
AUD = R('audience')
OID = R('oid')

# ---------------------------------------------------------------------------------------------
# Shared shapes
# ---------------------------------------------------------------------------------------------

COMMON = {
    'cost': D('Credits spent (or quoted) and the same in DASH; `usd` only when a price was read.',
              O({'credits': I, 'dash': F, 'usd': nl(F), 'usdPrice': nl(F)}, ['credits', 'dash'])),
    'steps': D('What a multi-step write did, in order.',
               A(O({'step': S, 'ok': B, 'detail': S}, ['step', 'ok']))),
    'createSteps': D('Each document a repository create needed, and whether this run wrote it, finished an '
                     'interrupted run\'s write, or found it there already.',
                     {'type': 'object', 'additionalProperties': E('created', 'resumed', 'existed')}),
    'issueQuery': D('A parsed issue search: the filters it applied (the web\'s issue list query).', O({
        'state': E('open', 'closed', 'all'), 'labels': SA, 'author': nl(S), 'assignee': nl(S), 'mentions': B,
        'sort': S, 'q': S, 'page': I, 'notLabels': SA, 'noLabel': B, 'milestone': nl(S), 'noMilestone': B,
        'authorLogin': nl(S), 'scope': E('any', 'title', 'body'), 'comments': nl(S), 'reason': nl(S),
    }, ['state', 'labels', 'sort', 'q'])),
    'pullQuery': D('A parsed pull request search: the filters it applied.', O({
        'state': S, 'labels': SA, 'author': nl(S), 'assignee': nl(S), 'sort': S, 'q': S, 'page': I,
        'notLabels': SA, 'noLabel': B, 'milestone': nl(S), 'noMilestone': B, 'authorLogin': nl(S),
        'scope': E('any', 'title', 'body'), 'comments': nl(S), 'reason': nl(S), 'draft': nl(B),
        'reviewRequested': nl(S),
    }, ['state', 'labels', 'sort', 'q'])),
    'audience': D('Who can read a document: everyone, the repository\'s members, or the people listed.',
                  E('public', 'members', 'specificPeople')),
    'oid': D('A git object id, lowercase hex.', {'type': 'string', 'pattern': '^[0-9a-f]{40}([0-9a-f]{24})?$'}),
    'hiddenBy': D('A maintainer\'s hide of the whole thread, or null.',
                  nl(O({'by': S, 'reason': nl(S), 'at': I, 'eventId': S}))),
    'issueRow': O({
        'number': I, 'title': nl(S), 'author': S, 'open': B, 'state': E('open', 'closed'),
        'labels': SA, 'assignees': SA, 'pinned': B, 'audience': AUD, 'readable': B,
        'why': S, 'hiddenBy': R('hiddenBy'),
    }, ['number', 'author', 'open', 'state', 'labels', 'assignees', 'readable']),
    'pullRow': O({
        'number': I, 'title': nl(S), 'author': S, 'state': E('open', 'closed', 'merged'),
        'baseRef': S, 'baseRefName': S, 'headOid': S, 'draft': B, 'labels': SA, 'assignees': SA,
        'audience': AUD, 'readable': B, 'why': S, 'hiddenBy': R('hiddenBy'),
    }, ['number', 'author', 'state']),
    'error': D('The error block every failing command prints (docs/errors.md).',
               O({'code': S, 'message': S, 'cause': nl(S), 'fix': A(S), 'note': nl(S), 'docs': nl(S), 'exitCode': I},
                 ['code', 'message'])),
    'rotation': D('A key rotation of a private or members-only repository.', OBJ),
    'policy': D('A branch policy, as `dg repo policy show` prints it.',
                nl(O({'requiredApprovals': I, 'maintainersOnly': B, 'requireChecks': B, 'mergeMethods': SA,
                      'requiredChecks': SA, 'requiredCheckSources': SA},
                     ['requiredApprovals', 'maintainersOnly', 'requireChecks', 'mergeMethods']))),
}

# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------

COMMANDS = {}
NO_JSON = {}


def cmd(name, desc, props, req=(), one_of=()):
    """`name`: the command words (`issue view`). `req`: fields every success has. `one_of`: when a
    command prints one of several shapes, each as (the fields it narrows, the fields it requires);
    exactly one must match."""
    COMMANDS[name] = (desc, props, list(req), [O(p, r) for p, r in one_of])


def none(name, why):
    NO_JSON[name] = why


def write_result(extra, req=('status',)):
    return {'status': S, 'cost': COST, **extra}, req


# -- auth -------------------------------------------------------------------------------------
# The Forge contract group's members this dg does not know, and the ones it could not check.
GROUP = {'unknownGroupMembers': SA, 'uncheckedGroupMembers': SA}
cmd('auth new', 'A new identity and the key stored for this computer.', {
    'status': E('created'), 'identityId': S, 'network': S, 'keyId': I, 'budgetCredits': nl(I), 'expiresAt': nl(I),
    'storage': S, 'storedAt': S, 'encryptionKeyIds': A(I), 'assetLockTxid': S, 'proof': E('instant', 'chain'),
    'balanceCredits': I, 'balanceDash': F, 'name': nl(S), 'backupFile': nl(S), **GROUP,
}, ['status', 'identityId', 'network'])
cmd('auth login', 'Signed in: the identity and the key stored for it.', {
    'status': E('logged_in'), 'identityId': S, 'network': S, 'keyId': nl(I), 'fullKey': B, 'encryptionKeyIds': A(I),
    'budgetCredits': nl(I), 'expiresAt': nl(I), 'storage': S, 'storedAt': S, 'source': S,
    'balanceCredits': nl(I), 'balanceDash': nl(F), 'cost': NCOST, **GROUP,
}, ['status', 'identityId', 'network'])
cmd('auth status', 'Who is signed in on this computer, and the key\'s limits.', {
    'network': S, 'authenticated': B, 'identityId': S, 'names': SA, 'keyId': nl(I), 'keyDisabled': nl(B),
    'limited': nl(B), 'capped': nl(B), 'boundDocumentType': nl(S), 'encryptionKeyIds': nl(A(I)),
    'budgetCredits': nl(I), 'budgetRemainingCredits': nl(I), 'expiresAt': nl(I), 'balanceCredits': nl(I),
    'balanceDash': nl(F), 'storage': nl(S), 'storedAt': nl(S), 'defaultIdentityId': nl(S),
    'masterKeyStored': nl(B),
    'keyUnopened': D('Why the stored key could not be opened here (it is sealed and no passphrase is available), '
                     'or null.', nl(S)),
}, ['network', 'authenticated'])
cmd('auth balance', 'An identity\'s proved balance.', {
    'identityId': S, 'network': S, 'balanceCredits': I, 'balanceDash': F,
}, ['identityId', 'network', 'balanceCredits', 'balanceDash'])
cmd('auth keys list', 'The identity\'s keys.', {'identityId': S, 'keys': A(OBJ)}, ['identityId', 'keys'])
cmd('auth keys add', 'A key added to the identity (a limited key, a browser key or an encryption key).', {
    'status': E('added', 'exists'), 'identityId': S, 'keyId': I, 'purpose': S, 'derived': B, 'budgetCredits': nl(I),
    'expiresAt': nl(I), 'replacedKeyId': nl(I), 'encryptionKeyId': nl(I), 'encryptionKeyIds': A(I), 'storedAt': S,
    'reply': ANY, 'warning': ANY, **GROUP,
}, ['status', 'keyId'])
cmd('auth keys disable', 'A key disabled on the identity.', {
    'status': E('disabled', 'already_disabled'), 'keyId': I, 'cost': COST,
}, ['status', 'keyId'])
cmd('auth keys rotate', 'The encryption key rotated, and the repositories it was re-shared to.', {
    'status': E('added', 'replaced'), 'identityId': S, 'oldKeyIds': A(I), 'newKeyId': I,
    'repos': A(O({'repo': S, 'repoId': S, 'status': E('rotated', 'not_maintainer', 'failed'), 'detail': ANY})),
    'askMaintainer': A(O({'repo': S, 'repoId': S})), 'disabledKeyIds': nl(A(I)), 'storedAt': nl(S),
    'storeError': D('Why the new key could not be stored on this computer, or null.', nl(S)), 'cost': COST,
}, ['status', 'identityId', 'repos'])
cmd('auth name register', 'A DPNS name registered for the identity.', {
    'status': E('registered'), 'name': S, 'identityId': S, 'cost': COST,
}, ['status', 'name', 'identityId'])
cmd('auth export', 'The identity file written.', {
    'status': E('exported'), 'path': S, 'identityId': S, 'keyId': nl(I), 'encrypted': B, 'format': S, 'network': S, **GROUP,
}, ['status', 'path', 'identityId'])
cmd('auth logout', 'Signed out on this computer.', {
    'status': E('logged_out'), 'identityId': S, 'removed': ANY, 'disabledKeyId': nl(I),
}, ['status'])

# -- repo -------------------------------------------------------------------------------------
PUBLISH = {
    'status': E('created', 'exists'), 'generation': ANY, 'repoId': S, 'ownerId': S, 'name': S, 'remoteUrl': S,
    'webUrl': nl(S), 'storage': ANY, 'network': S, 'visibility': E('public', 'private'),
    'protectedPatterns': D('What the config this run wrote protects; null when an earlier run wrote it.', nl(SA)),
    'steps': R('createSteps'), 'cost': COST, 'totalCost': COST, 'remote': S, 'gitConfig': SA,
    'push': nl(O({'remote': S, 'branch': S, 'oid': S, 'tracking': B, 'cost': COST, 'indexSkipped': ANY})),
    'balanceCredits': nl(I),
}
cmd('repo create', 'A new repository.', PUBLISH, ['status', 'repoId', 'ownerId', 'name'])
cmd('init', 'The current git repository published as a new repository.', PUBLISH, ['status', 'repoId', 'ownerId', 'name'])
cmd('repo clone', 'Where the repository was cloned.', {
    'remoteUrl': S, 'directory': S, 'network': S, 'gitConfig': ANY,
}, ['remoteUrl', 'directory'])
cmd('repo fork', 'A fork of a repository.', {
    'status': E('forked', 'exists'), 'repoId': S, 'ownerId': S, 'name': S, 'forkOf': S, 'parent': S, 'remoteUrl': S,
    'manifestsWritten': I, 'platformPacksReferenced': I, 'manifestsExisting': I, 'unreferenceablePacks': SA,
    'refsWritten': D('The refs this run wrote to the fork.', SA), 'cost': COST,
}, ['status', 'repoId'])
cmd('repo sync', 'A fork brought up to date with its parent.', {'status': S}, ['status'])
STAR = {'status': S, 'repo': S, 'starred': B, 'stars': nl(I), 'cost': NCOST}
cmd('repo star', 'The repository starred.', STAR, ['status', 'repo'])
cmd('repo unstar', 'The star removed.', STAR, ['status', 'repo'])
WATCH = {'status': S, 'repo': S, 'watchers': nl(I), 'cost': NCOST}
cmd('repo watch', 'The repository watched.', WATCH, ['status', 'repo'])
cmd('repo unwatch', 'The watch removed.', WATCH, ['status', 'repo'])
cmd('repo topic', 'The repository\'s topics (and what changed).', {
    'repo': S, 'topics': SA, 'added': SA, 'removed': SA, 'cost': COST,
}, ['repo', 'topics'])
cmd('repo activity', 'One branch\'s or tag\'s activity, newest first.', {
    'repo': S, 'ref': S,
    'events': A(O({
        'kind': E('created', 'pushed', 'forcePushed', 'updated', 'moved', 'deleted', 'diverged',
                  'protectionAdded', 'protectionLifted', 'protectionRestored'),
        'id': S, 'at': I, 'by': nl(S), 'from': nl(S), 'to': nl(S),
    }, ['kind', 'id', 'at'])),
}, ['repo', 'ref', 'events'])
cmd('repo view', 'A repository: its refs, packs and members.', {
    'repoId': S, 'ownerId': S, 'name': S, 'description': nl(S), 'visibility': E('public', 'private'),
    'archived': D('Whether the repository is archived; null when its config could not be read.', nl(B)),
    'defaultBranch': nl(S), 'refs': A(O({'name': S, 'state': ANY}, ['name'])), 'packCount': I, 'packBytes': I, 'members': ANY, 'remoteUrl': S,
}, ['repoId', 'ownerId', 'name', 'visibility'])
cmd('repo list', 'An identity\'s repositories.', {
    'ownerId': S, 'count': I, 'repos': A(O({'name': S, 'repoId': S, 'description': nl(S)}, ['name', 'repoId'])),
}, ['ownerId', 'count', 'repos'])
cmd('repo backend set', 'The repository\'s storage backend.', {
    'status': E('backend_set', 'unchanged'), 'repoId': S, 'backend': S, 'mode': ANY, 'configDocumentId': nl(S), 'network': S,
}, ['status', 'repoId'])
cmd('repo keys status', 'A private or members-only repository\'s key epochs and who can read them.', {
    'epoch': ANY, 'anchorId': ANY, 'currentEpoch': ANY, 'writeEpoch': ANY, 'readableEpochs': ANY, 'burnedEpochs': ANY,
    'nonMembers': ANY, 'missingWraps': ANY, 'rotate': ANY,
})
cmd('repo keys repair', 'Keys shared again, or the key rotated, so every member can read.', {
    'status': E('repaired', 'nothing_to_do'), 'rotated': nl(R('rotation')), 'nonMembers': ANY, 'wrapped': ANY,
    'skipped': ANY, 'cost': COST,
}, ['status'])
cmd('repo keys rotate', 'A new key epoch.', {'status': E('rotated'), 'rotation': R('rotation'), 'cost': COST}, ['status'])
cmd('repo members enable', 'Members-only content turned on. When it is on already and the key needs a repair (a '
    'member with no key yet, a rotation), the command repairs it and prints what `dg repo keys repair` prints.', {
    'status': S, 'repo': S, 'epoch': ANY, 'wrapped': ANY, 'skipped': ANY, 'cost': COST,
}, ['status'], one_of=[
    ({'status': E('enabled', 'finished', 'already_on')}, ['repo']),
    ({'status': E('repaired', 'nothing_to_do'), 'rotated': nl(R('rotation')), 'nonMembers': ANY}, []),
])
cmd('repo members status', 'Whether members-only content is on, and who has no key yet.', {
    'repo': S, 'on': B, 'epoch': ANY, 'youCanRead': B, 'noKeyYet': ANY,
}, ['repo', 'on'])
cmd('repo edit', 'The repository\'s description, topics or default branch changed.', {
    'status': E('edited', 'unchanged'), 'repo': S, 'defaultBranch': nl(S), 'description': nl(S), 'topics': nl(SA),
    'configDocumentId': nl(S), 'repoEdited': B, 'cost': COST,
}, ['status', 'repo'])
cmd('repo protect list', 'The repository\'s protected patterns.', {
    'repo': S, 'protectedPatterns': SA, 'defaultBranch': nl(S),
}, ['repo', 'protectedPatterns'])
PROTECT = {
    'status': E('protected', 'unprotected', 'unchanged'), 'repo': S, 'pattern': ANY, 'protectedPatterns': SA,
    'configDocumentId': nl(S), 'cost': COST,
}
for c, d in [('add', 'A pattern protected.'), ('remove', 'A pattern no longer protected.'),
             ('defaults', 'The default branch and every tag protected.')]:
    cmd(f'repo protect {c}', d, PROTECT, ['status', 'repo', 'protectedPatterns'])
cmd('repo policy show', 'The branch policy in force.', {'repo': S, 'policy': R('policy'), 'note': S}, ['repo', 'policy'])
cmd('repo policy set', 'A new branch policy.', {
    'status': E('set', 'unchanged'), 'repo': S, 'policy': R('policy'), 'documentId': S, 'id': S, 'note': S, 'cost': COST,
}, ['status', 'repo', 'policy'])
cmd('repo reindex', 'The browse index published again.', {
    'status': E('indexed', 'reindexed', 'unchanged', 'partial'), 'repoId': S, 'indexedPacks': I, 'indexObjects': I,
    'skipped': A(O({'packHash': S, 'reason': S})), 'missingPacks': I, 'history': ANY, 'locatorManifestId': nl(S),
    'cost': D('Null when the balance could not be read after the write.', NCOST),
}, ['status'])
ARCHIVE = {'status': S, 'repo': S, 'archived': B, 'configDocumentId': nl(S), 'cost': COST}
cmd('repo archive', 'The repository archived (read-only).', ARCHIVE, ['status', 'repo', 'archived'])
cmd('repo unarchive', 'The repository writable again.', ARCHIVE, ['status', 'repo', 'archived'])

# -- issues -----------------------------------------------------------------------------------
EVENT = O({'id': S, 'kind': S, 'actor': S, 'value': nl(S), 'createdAt': I})
TRANSITION = O({'id': S, 'kind': ANY, 'actor': S, 'asAuthor': ANY, 'createdAt': I, 'reason': ANY, 'dupNumber': ANY, 'closedIn': ANY})
cmd('issue status', 'Issues assigned to you, mentioning you, and opened by you.', {
    'repo': S, 'assigned': A(OBJ), 'mentioned': A(OBJ), 'authored': A(OBJ), 'hidden': I, 'membersOnly': I, 'hiddenOmitted': I,
}, ['repo', 'assigned', 'mentioned', 'authored'])
cmd('issue list', 'A page of issues.', {
    'count': I, 'total': I, 'membersOnly': I, 'page': I, 'pages': I, 'issues': A(R('issueRow')), 'hidden': I,
    'hiddenOmitted': I, 'truncated': B,
}, ['count', 'total', 'page', 'pages', 'issues', 'truncated'])
cmd('issue view', 'An issue, its comments, events and state.', {
    'number': I, 'title': nl(S), 'body': nl(S), 'bodyIncomplete': ANY, 'author': S, 'documentId': S, 'id': S,
    'audience': AUD, 'readable': B, 'why': S, 'createdAt': I, 'state': E('open', 'closed'), 'open': B, 'labels': SA,
    'assignees': SA, 'stateReason': nl(S), 'duplicateOf': nl(I), 'milestone': nl(S), 'pinned': B, 'locked': B,
    'comments': A(O({'id': S, 'author': S, 'body': nl(S), 'bodyIncomplete': ANY, 'audience': AUD, 'createdAt': I},
                    ['id', 'author'])),
    'membersOnlyComments': A(OBJ), 'membersOnlyHidden': I, 'events': A(EVENT), 'transitions': A(TRANSITION),
    'hiddenComments': ANY, 'moderation': ANY, 'hiddenEventValues': ANY, 'plaintextEventValues': ANY,
}, ['number', 'author', 'id', 'readable', 'state', 'open', 'labels', 'assignees'])
cmd('issue create', 'A new issue.', {
    'status': E('created'), 'number': I, 'documentId': S, 'id': S, 'title': S, 'audience': AUD, 'resumed': B, 'cost': COST,
}, ['status', 'number', 'documentId'])
cmd('pr edit', 'A pull request\'s title, body or metadata edited.', {
    'status': E('edited', 'unchanged'), 'pr': I, 'written': B, 'title': ANY, 'bodyChanged': B, 'changes': A(OBJ),
    'eventIds': SA, 'unchanged': ANY, 'cost': COST,
}, ['status', 'pr'])
cmd('issue edit', 'An issue\'s title, body or metadata edited.', {
    'status': E('edited', 'unchanged'), 'issue': I, 'written': B, 'title': ANY, 'bodyChanged': B, 'changes': A(OBJ),
    'eventIds': SA, 'unchanged': ANY, 'cost': COST,
}, ['status', 'issue'])
cmd('issue comment', 'A comment posted.', {
    'status': E('commented'), 'issue': I, 'commentId': S, 'audience': AUD, 'cost': COST,
}, ['status', 'issue', 'commentId'])
cmd('issue edit-comment', 'A comment edited.', {'status': E('edited', 'unchanged'), 'comment': S, 'cost': COST}, ['status', 'comment'])
cmd('issue delete-comment', 'A comment deleted.', {'status': E('deleted', 'absent'), 'comment': S, 'cost': COST}, ['status', 'comment'])
OPEN = {
    'status': S, 'issue': I, 'via': ANY, 'transitionId': nl(S), 'kind': ANY, 'open': nl(B), 'state': nl(E('open', 'closed')),
    'stateReason': nl(S), 'duplicateOf': nl(I), 'written': B, 'cost': COST,
}
cmd('issue close', 'An issue closed.', OPEN, ['status', 'issue'])
cmd('issue reopen', 'An issue reopened.', OPEN, ['status', 'issue'])
cmd('issue label', 'Labels added to or removed from an issue.', {
    'status': E('labeled', 'unchanged'), 'issue': I, 'label': nl(S), 'labels': SA, 'action': E('add', 'remove'),
    'eventId': nl(S), 'eventIds': SA, 'unchanged': ANY, 'written': B, 'cost': COST,
}, ['status', 'issue', 'labels', 'action'])
ASSIGN = {'status': S, 'issue': I, 'assignees': SA, 'eventIds': SA, 'unchanged': ANY, 'written': B, 'cost': COST}
cmd('issue assign', 'People assigned to an issue.', ASSIGN, ['status', 'issue', 'assignees'])
cmd('issue unassign', 'People unassigned from an issue.', ASSIGN, ['status', 'issue', 'assignees'])
cmd('issue milestone', 'An issue\'s milestone set or cleared.', {
    'status': E('set', 'cleared'), 'issue': I, 'milestone': nl(S), 'eventId': S, 'cost': COST,
}, ['status', 'issue'])
FLAG = {'status': S, 'issue': I, 'written': B, 'eventId': S, 'transitionId': S, 'cost': COST}
cmd('issue pin', 'An issue pinned or unpinned.', FLAG, ['status', 'issue'])
cmd('issue lock', 'An issue\'s conversation locked or unlocked.', FLAG, ['status', 'issue'])
cmd('issue hide', 'An issue or a comment hidden or shown again (maintainers).', {
    'status': E('hidden', 'unhidden'), 'issue': I, 'comment': nl(S), 'reason': nl(S), 'eventId': S, 'cost': COST,
}, ['status', 'issue'])

# -- pull requests ----------------------------------------------------------------------------
PRS_STATUS = A(OBJ)
cmd('pr status', 'Your pull requests: the current branch\'s, the ones you opened, the ones waiting for your review.', {
    'repo': S, 'currentBranch': nl(O({'name': S, 'pr': nl(OBJ)})), 'createdBy': PRS_STATUS, 'needsReview': PRS_STATUS,
    'searchedNewest': I, 'truncated': B, 'hiddenOmitted': I,
}, ['repo', 'createdBy', 'needsReview'])
cmd('pr create', 'A new pull request.', {
    'status': E('created'), 'number': I, 'documentId': S, 'id': S, 'title': S, 'baseRef': S, 'headRef': S, 'headOid': S,
    'sourceRepoId': S, 'sourceRepo': S, 'draft': B, 'draftTransitionId': nl(S), 'resumed': B, 'codeOwners': ANY, 'cost': COST,
}, ['status', 'number', 'documentId', 'baseRef', 'headRef'])
cmd('pr list', 'A page of pull requests.', {
    'count': I, 'membersOnly': I, 'prs': A(R('pullRow')), 'hidden': I, 'hiddenOmitted': I, 'truncated': B, 'otherStates': ANY,
}, ['count', 'prs', 'truncated'])
cmd('pr view', 'A pull request: its state, head, reviews, threads and comments.', {
    'number': I, 'id': S, 'repoId': S, 'title': nl(S), 'body': nl(S), 'bodyIncomplete': ANY, 'author': S, 'createdAt': I,
    'state': E('open', 'closed', 'merged'), 'draft': B, 'labels': SA, 'assignees': SA, 'retargetedTo': nl(S), 'baseRef': S,
    'baseRefName': S, 'baseTip': nl(S), 'headOid': S, 'initialHeadOid': S, 'headOnBase': B, 'headUpdates': A(OBJ),
    'resolvedThreads': SA, 'milestone': nl(S), 'sourceRepoId': S, 'sourceRepo': ANY, 'sourceRefName': nl(S),
    'approvedBy': SA, 'changesRequestedBy': SA, 'reviewers': A(OBJ), 'requestedReviewers': A(OBJ), 'dismissedReviews': A(OBJ),
    'sinceYourReview': ANY, 'policy': R('policy'), 'approvals': ANY, 'reviews': A(OBJ), 'threads': A(OBJ),
    'generalComments': A(OBJ), 'comments': A(OBJ), 'hiddenComments': ANY, 'hiddenReviews': ANY, 'moderation': ANY,
    'hiddenEventValues': ANY, 'plaintextEventValues': ANY, 'audience': AUD, 'readable': B, 'why': S,
    'membersOnlyComments': A(OBJ), 'membersOnlyHidden': I, 'membersOnlyReviewsHidden': I, 'mergeContent': ANY,
}, ['number', 'id', 'author', 'state', 'labels', 'assignees', 'readable'])
cmd('pr verify', 'Whether a merged pull request\'s recorded merge contains it.', {
    'pr': I, 'merged': B, 'mergeContent': nl(O({'oid': S, 'verdict': E('contains', 'squash', 'rebase', 'missing', 'unknown'),
                                                'combined': SA}, ['oid', 'verdict'])),
    'rulesAtMerge': ANY,
}, ['pr', 'merged', 'mergeContent'])
cmd('pr checkout', 'The pull request\'s head checked out as a local branch.', {
    'pr': I, 'headOid': S, 'branch': S, 'sourceRepoId': S, 'fetched': B, 'branchCreated': B, 'switched': B,
}, ['pr', 'headOid', 'branch'])
cmd('pr review', 'A review: submitted, kept pending, or discarded.', {
    'status': E('reviewed', 'pending', 'discarded', 'no_pending_review'), 'pr': I, 'verdict': ANY, 'verdictLabel': ANY,
    'audience': AUD, 'commitOid': S, 'reviewId': nl(S), 'comments': A(ANY), 'documents': ANY, 'landed': ANY, 'failed': ANY,
    'resumed': ANY, 'counts': D('Whether the verdict counts toward the required approvals (yours is an approver\'s).', B),
    'added': I, 'anchoredTo': S, 'headMoved': B, 'encrypted': B, 'draftFile': S,
    'discarded': D('How many pending comments were thrown away; null when the pending review could not be read.', nl(I)),
    'cost': COST,
}, ['status', 'pr'])
cmd('pr comment', 'A comment on a pull request: general, inline, or a reply.', {
    'status': E('commented'), 'pr': I, 'commentId': S, 'kind': S, 'audience': AUD, 'replyTo': nl(S), 'location': ANY,
    'commitOid': nl(S),
}, ['status', 'pr', 'commentId', 'kind'])
cmd('pr sync', 'The pull request\'s head moved to its branch\'s tip.', {
    'status': S, 'pr': I, 'written': B, 'previousHead': S, 'headOid': S, 'via': ANY, 'eventId': S, 'cost': COST,
}, ['status', 'pr', 'written'])
DRAFT = {'status': S, 'pr': I, 'written': B, 'draft': B, 'via': ANY, 'transitionId': S, 'kind': ANY, 'cost': COST}
cmd('pr ready', 'A draft marked ready for review.', DRAFT, ['status', 'pr', 'written'])
cmd('pr draft', 'A pull request converted to a draft.', DRAFT, ['status', 'pr', 'written'])
cmd('pr lock', 'A pull request\'s conversation locked or unlocked.', {
    'status': S, 'pr': I, 'locked': B, 'transitionId': S, 'written': B, 'cost': COST,
}, ['status', 'pr'])
cmd('pr hide', 'A pull request, a comment or a review hidden or shown again (maintainers).', {
    'status': E('hidden', 'unhidden'), 'pr': I, 'item': nl(S), 'reason': nl(S), 'eventId': S, 'cost': COST,
}, ['status', 'pr'])
RESOLVE = {'status': S, 'pr': I, 'written': B, 'threadId': S, 'resolved': B, 'via': ANY, 'eventId': S, 'cost': COST}
cmd('pr resolve', 'A review thread resolved.', RESOLVE, ['status', 'pr', 'written'])
cmd('pr unresolve', 'A review thread unresolved.', RESOLVE, ['status', 'pr', 'written'])
REQ = {'pr': I, 'reviewers': A(OBJ), 'status': S, 'written': B}
cmd('pr request-review', 'Reviews requested.', REQ, ['pr'])
cmd('pr unrequest-review', 'Review requests withdrawn.', REQ, ['pr'])
cmd('pr dismiss-review', 'A review dismissed.', {
    'status': S, 'pr': I, 'written': B, 'reviewId': S, 'reviewer': S, 'reason': nl(S), 'via': ANY, 'eventId': S, 'cost': COST,
}, ['status', 'pr', 'written'])
cmd('pr checks', 'The checks on the pull request\'s head, and the required ones.', {
    'pr': I, 'headOid': S, 'checks': A(OBJ), 'passed': I, 'failed': I, 'pending': I, 'required': ANY, 'requiredMet': ANY,
}, ['pr', 'headOid', 'checks'])
cmd('pr commits', 'The pull request\'s commits.', {
    'pr': I, 'baseOid': nl(S), 'headOid': S, 'total': I, 'truncated': B, 'commits': A(OBJ),
}, ['pr', 'headOid', 'commits'])
cmd('pr merge', 'A pull request merged (or a merge recorded).', {
    'status': E('merged', 'merge_recorded', 'already_merged'), 'pr': I, 'method': S, 'mergeOid': S, 'transitionId': S,
    'merged': B, 'mergeOnBase': ANY, 'branchDeleted': ANY, 'branchCheckNote': nl(S), 'bypassedRules': ANY,
    'checksNotPassing': ANY, 'closedIssues': ANY, 'linkedIssuesOmitted': ANY, 'linkedIssuesImported': ANY, 'cost': COST,
    'steps': STEPS,
}, ['status', 'pr', 'merged'])
cmd('pr update-branch', 'The base merged into the pull request\'s branch.', {
    'status': E('updated', 'up_to_date'), 'pr': I, 'written': B, 'headOid': S, 'baseOid': S, 'eventId': nl(S), 'steps': STEPS,
}, ['status', 'pr', 'written'])
cmd('pr suggestion apply', 'Suggested changes committed to the pull request\'s branch.', {
    'status': E('applied', 'nothing_to_apply'), 'pr': I, 'written': B, 'commit': S, 'applied': SA, 'headOid': S,
    'eventId': nl(S), 'steps': STEPS,
}, ['status', 'pr', 'written', 'applied'])
PRSTATE = {'status': S, 'pr': I, 'via': ANY, 'transitionId': S, 'kind': ANY, 'draft': B, 'written': B, 'cost': COST}
cmd('pr close', 'A pull request closed.', PRSTATE, ['status', 'pr'])
cmd('pr reopen', 'A pull request reopened.', PRSTATE, ['status', 'pr'])
cmd('pr diff', 'The pull request\'s diff.', {'pr': I, 'range': S, 'diffAvailable': B, 'diff': S}, ['pr', 'diff'])
cmd('pr revert', 'A pull request that reverts a merged one, opened on a new branch.', {
    'status': E('created'), 'pr': D('The merged pull request reverted.', I),
    'number': D('The new pull request.', I), 'documentId': S, 'title': S, 'baseRef': S, 'headRef': S,
    'revertCommit': OID, 'mergeOid': OID, 'landed': E('merge-commit', 'squash', 'rebase', 'fast-forward'),
    'cost': COST, 'steps': STEPS,
}, ['status', 'pr', 'number', 'documentId', 'baseRef', 'headRef', 'revertCommit'])

# -- releases, labels, milestones -------------------------------------------------------------
REL = {
    'status': S, 'tag': S, 'sealed': B, 'documentId': S, 'id': S, 'assets': A(ANY), 'assetListKept': ANY,
    'assetListReused': ANY, 'warnings': ANY, 'cost': COST,
}
cmd('release create', 'A release published.', REL, ['status', 'tag', 'documentId'])
cmd('release unpublish', 'A release taken down.', REL, ['status', 'tag'])
cmd('release list', 'The repository\'s releases.', {
    'count': I, 'releases': A(OBJ), 'previous': A(OBJ), 'hidden': ANY, 'earlierUse': ANY, 'stale': ANY,
    'assetListLateCheckError': ANY,
}, ['count', 'releases'])
cmd('release download', 'A release\'s assets downloaded and checked.', {
    'status': E('downloaded'), 'tag': S, 'count': I,
    'assets': A(O({'name': S, 'sha256': S, 'bytes': I, 'output': S})),
}, ['status', 'tag', 'assets'])
cmd('release verify', 'Whether a release\'s tag and assets are still what was first published.', {
    'repo': S, 'tag': S, 'altered': B, 'provenance': ANY, 'signature': ANY,
}, ['repo', 'tag', 'altered'])
cmd('label list', 'The repository\'s labels.', {
    'count': I, 'labels': A(O({'name': S, 'color': nl(S), 'description': nl(S), 'retired': B}, ['name'])),
}, ['count', 'labels'])
LABEL = {'status': S, 'name': S, 'documentId': S, 'id': S, 'retired': ANY, 'deletedDocuments': ANY, 'cost': COST}
cmd('label create', 'A label defined.', LABEL, ['status', 'name'])
cmd('label retire', 'A label retired.', LABEL, ['status', 'name'])
cmd('label delete', 'A label retired, and your definitions of it deleted.', LABEL, ['status', 'name'])
cmd('milestone list', 'The repository\'s milestones.', {
    'count': I, 'milestones': A(O({'title': S, 'description': nl(S), 'dueOn': ANY, 'closed': ANY, 'open': ANY,
                                  'closedItems': ANY}, ['title'])),
}, ['count', 'milestones'])
MS = {'status': S, 'title': S, 'closed': B, 'documentId': S, 'id': S, 'cost': COST}
cmd('milestone create', 'A milestone defined.', MS, ['status', 'title'])
cmd('milestone close', 'A milestone closed.', MS, ['status', 'title'])

# -- profile, signing keys, collaborators -----------------------------------------------------
cmd('profile show', 'An identity\'s public profile.', {
    'identityId': S, 'profile': nl(OBJ),
    'bot': D('The identity\'s operator when both profiles agree, else null.', nl(O({'operator': S}, ['operator']))),
}, ['identityId', 'profile'])
cmd('profile set', 'Your profile changed.', {'status': S, 'documentId': S, 'fields': OBJ, 'cost': COST}, ['status'])
cmd('profile delete', 'Your profile deleted.', {'status': E('deleted', 'absent'), 'documentId': S}, ['status'])
BOT_CLAIM = D('The signer\'s bot claim as written: the identity that operates it, and the bots it operates.',
              O({'operator': S, 'operates': SA}))
for _verb, _desc in (('operator', 'Your profile names (or stops naming) the identity that operates it as a bot.'),
                     ('add', 'Your profile lists a bot you operate.'),
                     ('remove', 'Your profile stops listing a bot you operate.')):
    cmd(f'profile bot {_verb}', _desc, {
        'status': E('created', 'updated', 'unchanged'), 'documentId': S, 'bot': BOT_CLAIM, 'cost': COST,
    }, ['status'])
cmd('profile key list', 'The signing keys on your profile.', {'keys': A(OBJ)}, ['keys'])
cmd('profile key add', 'A signing key added to your profile.', {'status': S, 'entry': S, 'fingerprint': ANY, 'cost': COST}, ['status'])
cmd('profile key remove', 'A signing key removed from your profile.', {'status': E('removed', 'unchanged')}, ['status'])
cmd('verify-commit', 'Each commit\'s signature checked against the keys members publish.', {
    'repo': S, 'commits': A(O({'rev': S, 'oid': S, 'signature': ANY})),
}, ['repo', 'commits'])
cmd('verify-mirror', 'A plain-git mirror checked against Platform.', {
    'url': S, 'repo': S, 'verdict': S, 'refs': ANY, 'manifest': nl(OBJ), 'manifestError': ANY, 'manifestProblems': ANY,
}, ['url', 'verdict'])
cmd('verify-app', 'A deployed copy of the web app checked against a published build.', {
    'url': S, 'manifest': ANY, 'source': ANY, 'commit': ANY, 'network': ANY, 'variant': ANY, 'servedManifestAgrees': ANY,
    'files': ANY, 'matched': ANY, 'differ': ANY, 'missing': ANY, 'ok': B,
}, ['url', 'ok'])
cmd('collab add', 'A member added, or their role changed.', {
    'status': S, 'member': S, 'role': S, 'previousRole': nl(S), 'environmentsSavedFirst': ANY, 'documentId': S, 'id': S,
    'repo': S, 'cost': COST, 'keyShared': B, 'keyPending': ANY, 'rotation': nl(R('rotation')),
}, ['status', 'member', 'role'])
cmd('collab accept', 'An invitation accepted (or withdrawn).', {
    'status': S, 'repo': S, 'identityId': S, 'documentId': S, 'id': S, 'cost': COST,
}, ['status', 'repo'])
cmd('collab remove', 'A member removed.', {
    'status': E('removed', 'not_a_member'), 'member': S, 'role': S, 'repo': S, 'rotation': nl(R('rotation')),
    'droppedEpochs': ANY, 'losingMembers': ANY, 'environments': ANY, 'resavedEnvironments': ANY,
}, ['status', 'member'])
cmd('collab list', 'The repository\'s members and their roles.', {
    'count': I, 'members': A(OBJ), 'ownerId': S, 'roles': {'const': True},
}, ['count', 'members', 'ownerId', 'roles'])

# -- cost, maintenance, storage ---------------------------------------------------------------
cmd('cost estimate', 'What a first push of the current repository would cost.', {
    'mode': E('first_push'), 'bytes': I, 'objects': I, 'objectsCounted': ANY, 'sealed': B, 'backend': S,
    'platformStoresBytes': ANY, 'externalTargets': ANY, 'manifests': ANY, 'refUpdates': I, 'historyIndexBytes': nl(I),
    'historyIndexSkipped': ANY, 'metadataCredits': I, 'chunkCredits': I, 'depositCredits': I, 'totalCredits': I,
    'cost': COST, 'storageDeposit': COST, 'notPriced': ANY, 'upperBound': B, 'note': S,
}, ['mode', 'totalCredits', 'cost'])
cmd('cost audit', 'What an identity spent, or what a repository\'s storage holds.', {
    'mode': S, 'identityId': S, 'sinceMs': ANY, 'documentCount': I, 'totalCredits': I, 'cost': COST, 'byType': A(OBJ),
    'byRepo': A(OBJ), 'excludedTypes': ANY, 'note': S, 'scopeNote': ANY, 'chunkGapNote': ANY, 'repoId': S, 'packCount': I,
    'packBytes': I, 'platformPacks': I, 'platformBytes': I, 'externalPacks': I, 'externalBytes': I, 'depositLocked': COST,
}, ['mode'])
cmd('cost prices', 'What each kind of write costs, at most.', {
    'mode': E('per_operation_estimates'), 'operations': A(OBJ), 'note': S,
}, ['mode', 'operations'])
cmd('repack', 'The repository\'s packs combined into one.', {
    'status': E('repacked'), 'repoId': S, 'newPackHash': S, 'newManifestId': S, 'locatorManifestId': ANY,
    'newPackBytes': I, 'objectCount': I, 'newUris': SA, 'supersededCount': I, 'supersededBytes': I,
    'unnamedLivePacks': ANY, 'deletedDocuments': I, 'cost': COST,
}, ['status', 'repoId'])
cmd('reseed', 'Packs stored again where the storage policy wants them.', {
    'status': E('reseeded', 'partial'), 'repoId': S, 'target': ANY, 'targets': ANY, 'packs': ANY, 'unreadable': SA,
    'restored': ANY, 'healthy': I, 'missingLocally': ANY,
}, ['status', 'repoId'])
cmd('storage status', 'Where the repository\'s packs are stored.', {
    'repoId': S, 'packCount': I, 'ipfsGateways': SA, 'packs': A(OBJ),
}, ['repoId', 'packs'])
cmd('storage add', 'A storage profile added.', {
    'status': E('added', 'replaced'), 'profile': S, 'kind': S, 'path': S, 'unresolvedSecrets': ANY, 'warnings': ANY,
    'allowPrivateUri': B,
}, ['status', 'profile'])
cmd('storage list', 'The storage profiles.', {'path': S, 'profiles': A(OBJ), 'ipfsGateways': SA}, ['profiles'])
cmd('storage remove', 'A storage profile removed.', {'status': E('removed'), 'profile': S, 'keychain': ANY}, ['status', 'profile'])
cmd('storage test', 'A storage profile tried end to end.', {
    'profile': S, 'kind': S, 'ok': B, 'steps': A(OBJ), 'fixes': ANY,
}, ['profile', 'ok'])
cmd('storage use', 'Which storage profiles pushes use.', {
    'storage': D('The profiles pushes store on, comma-separated, as git config `dash.storage` holds them.', S),
    'replicas': ANY, 'platformFallback': ANY, 'scope': E('global', 'repo'), 'warnings': ANY,
    'advertisedMode': ANY, 'existingPacks': ANY,
}, ['storage', 'scope'])
cmd('storage advertise', 'The storage the repository advertises to forks and mirrors.', {
    'status': E('advertised', 'unchanged'), 'mode': ANY, 'uris': SA, 'configDocId': nl(S),
}, ['status'])

# -- webhooks, CI -----------------------------------------------------------------------------
cmd('webhook add', 'A webhook registered with a relay.', {
    'status': E('created'), 'repo': S, 'repoId': S, 'documentId': S, 'id': S, 'hookId': S, 'url': S, 'events': SA,
    'relayIdentityId': S, 'relayKeyId': ANY, 'senderKeyId': ANY, 'secretFile': nl(S), 'estimate': COST, 'cost': COST,
}, ['status', 'hookId'])
cmd('webhook list', 'The repository\'s webhooks.', {'repo': S, 'count': I, 'webhooks': A(OBJ)}, ['repo', 'count', 'webhooks'])
cmd('webhook remove', 'A webhook removed.', {
    'status': E('removed'), 'repo': S, 'hookId': S, 'deleted': ANY, 'tombstone': ANY,
}, ['status', 'hookId'])
cmd('ci runner new', 'A runner identity and key created, and enrolled.', {
    'status': E('created'), 'repo': S, 'runner': S, 'keyId': I, 'boundTo': OBJ, 'budgetCredits': I, 'expiresAt': nl(I),
    'path': S, 'enrolled': nl(S), 'alreadyEnrolled': nl(S), 'keyCost': COST, 'enrolCost': COST,
}, ['status', 'runner'])
cmd('ci runner add', 'A runner enrolled.', {
    'status': E('enrolled', 'exists'), 'runner': S, 'documentId': S, 'id': S, 'written': B, 'cost': COST,
}, ['status', 'runner'])
cmd('ci runner list', 'The repository\'s runners.', {'count': I, 'runners': A(OBJ)}, ['count', 'runners'])
cmd('ci runner revoke', 'A runner no longer trusted.', {'status': E('revoked', 'not_a_runner'), 'runner': S}, ['status', 'runner'])
cmd('ci report', 'A check run reported on a commit.', {
    'status': S, 'documentId': S, 'id': S, 'name': S, 'checkStatus': S, 'conclusion': nl(S), 'headOid': S,
    'logUrl': nl(S), 'logSha256': nl(S), 'artifacts': ANY, 'artifactsLeftOut': ANY, 'leftOut': ANY, 'url': nl(S),
    'cost': COST, 'policyNote': nl(S), 'supersedes': ANY,
}, ['status', 'documentId', 'name'])
cmd('ci status', 'The newest check run per name on a commit.', {
    'headOid': S, 'checks': A(OBJ), 'url': nl(S),
}, ['headOid', 'checks'])
cmd('ci rerun', 'A re-run of a pull request\'s checks requested.', {
    'status': E('requested'), 'pr': I, 'sha': S, 'check': nl(S), 'eventId': S, 'cost': COST,
}, ['status', 'pr', 'sha'])
cmd('ci reruns', 'The re-run requests written since a time.', {
    'since': I, 'count': I, 'requests': A(OBJ),
}, ['count', 'requests'])

# -- search, status, doctor, import -----------------------------------------------------------
cmd('search issues', 'Issues matching a query.', {
    'repo': S, 'query': R('issueQuery'), 'notApplied': SA, 'total': I, 'count': I, 'hidden': I, 'membersOnly': I,
    'hiddenOmitted': I,
    'issues': A(O({'number': I, 'title': nl(S), 'state': E('open', 'closed'), 'author': S, 'labels': SA, 'assignees': SA,
                   'milestone': nl(S), 'createdAt': I, 'hiddenBy': R('hiddenBy')}, ['number', 'state', 'author'])),
}, ['repo', 'query', 'count', 'issues'])
cmd('search prs', 'Pull requests matching a query.', {
    'repo': S, 'query': R('pullQuery'), 'notApplied': SA, 'total': I, 'count': I, 'searchedNewest': I, 'truncated': B,
    'hiddenOmitted': I,
    'prs': A(O({'number': I, 'title': nl(S), 'state': E('open', 'closed', 'merged'), 'draft': B, 'author': S,
                'labels': SA, 'assignees': SA, 'milestone': nl(S), 'baseRefName': S, 'headRefName': nl(S),
                'createdAt': I, 'hiddenBy': R('hiddenBy')}, ['number', 'state', 'author'])),
}, ['repo', 'query', 'count', 'prs'])
cmd('search repos', 'Repositories matching a query.', {
    'count': I, 'repos': A(O({'ownerId': S, 'name': S, 'repoId': S, 'fullName': S, 'description': nl(S),
                              'visibility': E('public', 'private')}, ['ownerId', 'name', 'repoId'])),
}, ['count', 'repos'])
cmd('doctor', 'Each check of the setup, and what fixes it.', {
    'ok': B, 'network': S, 'forgeV2': nl(O({'core': S, 'collab': S, 'community': S, 'group': ANY})), 'failed': I,
    'warnings': I,
    'sections': A(O({'name': S, 'checks': A(O({'name': S, 'status': S, 'ok': B, 'detail': S, 'fix': nl(S),
                                              'autoFix': nl(S)}, ['name', 'status', 'ok']))}, ['name', 'checks'])),
    'fixesApplied': A(ANY),
}, ['ok', 'network', 'failed', 'warnings', 'sections'])
IMPORT_COUNTS = ('refs', 'packs', 'packBytes', 'issues', 'prs', 'comments', 'reviews', 'events', 'transitions',
                 'releases', 'labels', 'skipped', 'gitSkipped', 'unprovedMerges', 'assetsOmitted', 'assetsUnhashed',
                 'assetsLinked')
cmd('import', 'What an import or re-sync mirrored (the Mirror Action reads this). A run that did not finish exits '
    'non-zero and prints the same object with `error` holding the error block, so it matches error.schema.json.', {
    'status': E('ok', 'dry_run', 'partial', 'cap_exceeded', 'error'), 'network': S, 'source': S,
    'repo': O({'owner': S, 'name': S, 'id': S, 'url': S, 'created': B}, ['owner', 'name', 'id', 'url', 'created']),
    'counts': O({c: I for c in IMPORT_COUNTS}, IMPORT_COUNTS), 'estimateCredits': I, 'spentCredits': I,
    'creditsPerDash': I, 'balanceCredits': nl(I),
    'key': O({'id': nl(I), 'budgetCredits': nl(I), 'remainingCredits': nl(I), 'expiresAt': nl(I)}),
    'warnings': SA,
    'error': D('Null when the run finished; the error block when it did not (and dg exits non-zero).',
               {'anyOf': [{'type': 'null'}, S, R('error')]}),
}, ['status', 'network', 'source', 'repo', 'counts'])

# -- environments -----------------------------------------------------------------------------
ENV_SAVE = {
    'status': E('saved', 'unchanged'), 'env': S, 'audience': ANY, 'to': ANY, 'skipped': ANY, 'changes': ANY, 'id': S,
    'packHash': S, 'sizeBytes': I, 'quote': COST, 'spent': COST,
}
cmd('env ls', 'The repository\'s environments, or one environment\'s variables (names and types, not values).', {
    'environments': A(OBJ), 'hidden': ANY, 'ignored': ANY, 'env': S, 'audience': ANY, 'to': ANY, 'updatedBy': S,
    'updatedAt': I, 'entries': A(O({'name': S, 'type': S, 'note': nl(S)})),
})
cmd('env get', 'One variable of an environment.', {'env': S, 'name': S, 'type': S, 'value': S}, ['env', 'name', 'value'])
for c, d in [('set', 'A variable set.'), ('unset', 'A variable removed.'), ('edit', 'An environment edited.'),
             ('import', 'Variables imported from a file.')]:
    cmd(f'env {c}', d, ENV_SAVE, ['status', 'env'])
cmd('env export', 'An environment written to a file. Only with `--output`: without it, `dg env export` prints '
    'the variables as a .env file, not JSON, even with `--json`.', {
    'status': E('written'), 'env': S, 'file': S, 'entries': I, 'mode': S, 'ignored': ANY,
}, ['status', 'env', 'file'])
cmd('env history', 'An environment\'s saved versions.', {
    'env': S, 'state': ANY, 'heads': ANY, 'changes': A(OBJ), 'ignored': ANY,
}, ['env', 'changes'])

# A command that prints JSON only when given one of these flags (and otherwise prints its own
# format, even with --json).
JSON_ONLY_WITH = {'env export': ['--output', '-o']}

# -- no --json output -------------------------------------------------------------------------
none('completions', 'prints a shell completion script')
none('env run', 'runs a command with the environment; its output is the command\'s')
none('api query', 'prints raw Platform documents as they are, with no `schemaVersion` (like `gh api`)')

# ---------------------------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------------------------


def file_of(name):
    return name.replace(' ', '-') + '.schema.json'


def schema_of(name, desc, props, req, one_of):
    schema = {
        '$schema': 'https://json-schema.org/draft/2020-12/schema',
        '$id': BASE + file_of(name),
        'title': f'dg {name} --json',
        'description': desc,
        'type': 'object',
        'properties': {'schemaVersion': {'const': VERSION}, **props},
        'required': ['schemaVersion', *req],
        'additionalProperties': True,
    }
    if one_of:
        schema['oneOf'] = one_of
    return schema


def common_schema():
    return {
        '$schema': 'https://json-schema.org/draft/2020-12/schema',
        '$id': BASE + 'common.schema.json',
        'title': 'Shapes shared by dg\'s --json output',
        '$defs': COMMON,
    }


def error_schema():
    return {
        '$schema': 'https://json-schema.org/draft/2020-12/schema',
        '$id': BASE + 'error.schema.json',
        'title': 'dg --json: a failed command',
        'description': 'Printed on stdout instead of the command\'s output when it fails. A command that '
                       'finished part of its work adds that part\'s fields beside `error`.',
        'type': 'object',
        'properties': {'schemaVersion': {'const': VERSION}, 'error': R('error')},
        'required': ['schemaVersion', 'error'],
        'additionalProperties': True,
    }


def dumps(v):
    return json.dumps(v, indent=2, ensure_ascii=False) + '\n'


def readme():
    lines = [
        '# dg `--json` output schemas',
        '',
        '<!-- Generated by docs/schemas/generate.py; edit the specs there, then run it. -->',
        '',
        f'Every `dg` command run with `--json` prints one JSON object with `"schemaVersion": {VERSION}`. '
        'The schemas here (JSON Schema draft 2020-12) describe each command\'s object. A failed command prints '
        '[`error.schema.json`](dg/error.schema.json) instead, and the shapes several commands share are in '
        '[`common.schema.json`](dg/common.schema.json). [Versioning](../VERSIONING.md#json-output) says when '
        '`schemaVersion` changes.',
        '',
        'The exit code says which schema applies: 0, the command\'s own; anything else, the error schema. A '
        'command that finished part of its work before it failed adds that part\'s fields beside `error`. '
        '`dg env export` prints JSON only with `--output`; without it, it prints a .env file.',
        '',
        '[`index.json`](dg/index.json) maps each command to its schema, for tools. The CLI end-to-end suite '
        'checks every `--json` output it captures against them (`e2e/cli/json_check.py`).',
        '',
        '| Command | Schema |',
        '|---|---|',
    ]
    for name in sorted(set(COMMANDS) | set(NO_JSON)):
        if name in COMMANDS:
            lines.append(f'| `dg {name}` | [`{file_of(name)}`](dg/{file_of(name)}) |')
        else:
            lines.append(f'| `dg {name}` | none: {NO_JSON[name]} |')
    return '\n'.join(lines) + '\n'


def index():
    return {
        'schemaVersion': VERSION,
        'commands': {n: file_of(n) for n in sorted(COMMANDS)},
        'noJson': dict(sorted(NO_JSON.items())),
        'error': 'error.schema.json',
        'jsonOnlyWith': {n: flags for n, flags in sorted(JSON_ONLY_WITH.items())},
    }


def outputs():
    out = {os.path.join(OUT, 'common.schema.json'): dumps(common_schema()),
           os.path.join(OUT, 'error.schema.json'): dumps(error_schema()),
           os.path.join(OUT, 'index.json'): dumps(index()),
           os.path.join(HERE, 'README.md'): readme()}
    for name, (desc, props, req, one_of) in COMMANDS.items():
        out[os.path.join(OUT, file_of(name))] = dumps(schema_of(name, desc, props, req, one_of))
    return out


def main():
    check = '--check' in sys.argv[1:]
    want = outputs()
    have = {os.path.join(OUT, f) for f in os.listdir(OUT)} if os.path.isdir(OUT) else set()
    stale = sorted(have - set(want))
    diff = [p for p, text in want.items() if not os.path.exists(p) or open(p, encoding='utf-8').read() != text]
    if check:
        for p in diff + stale:
            print(f'out of date: {os.path.relpath(p, os.path.dirname(HERE))}', file=sys.stderr)
        if diff or stale:
            print('run: python3 docs/schemas/generate.py', file=sys.stderr)
            sys.exit(1)
        return
    os.makedirs(OUT, exist_ok=True)
    for p in stale:
        os.remove(p)
    for p, text in want.items():
        with open(p, 'w', encoding='utf-8') as f:
            f.write(text)
    print(f'{len(COMMANDS)} command schemas, {len(NO_JSON)} commands without JSON')


if __name__ == '__main__':
    main()

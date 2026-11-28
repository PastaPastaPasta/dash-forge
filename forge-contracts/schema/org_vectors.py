#!/usr/bin/env python3
"""The forge-org accept/refuse document vectors (docs/design/organizations.md §10.1), written to
forge-contracts/vectors/org/forge-org{,.replace,.indices}.json in the rc1 format (vectors.py).

  python3 forge-contracts/schema/org_vectors.py [--check]

forge-org has no rule or reference, so the cases cover its shapes, bounds and indexes. CI judges
them with `contract-validate --vectors` against the JSON `deploy-org.mjs --emit` writes.
"""
import argparse
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, 'forge-contracts', 'vectors', 'org')
DROP = object()
CASES, REPLACES, INDICES = [], [], []


def i(n):
    return {"$id": n}


def b(fill, n):
    return {"$b": [fill, n]}


ROOM = "a52b096e14d5b482f1d9462bd59c8e7b"
BASE = {
    'orgMember': {"org": i(1), "room": ROOM, "authPub": b(2, 32), "proof": b(3, 64)},
    'orgShare': {"org": i(1), "cid": b(5, 32), "sealed": b(4, 72)},
    'org': {"room": ROOM, "relay": "https://multisig.dashhq.org", "cid": b(5, 32), "keyId": 2, "groupKey": b(6, 48),
            "threshold": 2, "members": b(7, 96), "pubShares": b(8, 144)},
    'orgMessage': {"org": i(1), "digest": b(9, 32), "part": 0, "parts": 1, "fmt": 0, "body": b(10, 600)},
}


def doc(t, **kw):
    d = json.loads(json.dumps(BASE[t]))
    for k, v in kw.items():
        if v is DROP:
            d.pop(k, None)
        else:
            d[k] = v
    return d


def ok(label, t, **kw):
    CASES.append({"item": "ORG", "name": label, "type": t, "expect": "ok", "doc": doc(t, **kw)})


def no(label, t, why, **kw):
    CASES.append({"item": "ORG", "name": label, "type": t, "expect": "refused", "why": why, "doc": doc(t, **kw)})


def bounds(t, prop, fill, lo, hi):
    ok(f'{t}.{prop} of {lo} bytes', t, **{prop: b(fill, lo)})
    ok(f'{t}.{prop} of {hi} bytes', t, **{prop: b(fill, hi)})
    if lo > 0:
        no(f'{t}.{prop} of {lo - 1} bytes', t, 'minItems', **{prop: b(fill, lo - 1)})
    no(f'{t}.{prop} of {hi + 1} bytes', t, 'maxItems' if hi < 5120 else '10417', **{prop: b(fill, hi + 1)})


def integer(t, prop, lo, hi):
    ok(f'{t}.{prop} {lo}', t, **{prop: lo})
    ok(f'{t}.{prop} {hi}', t, **{prop: hi})
    no(f'{t}.{prop} {lo - 1}', t, 'minimum', **{prop: lo - 1})
    no(f'{t}.{prop} {hi + 1}', t, 'maximum', **{prop: hi + 1})


for _t in BASE:
    ok(f'{_t} ok', _t)
    no(f'{_t} with another property', _t, 'additionalProperties', extra=1)
for _t in ('orgMember', 'org'):
    ok(f'{_t}.room of 64 characters', _t, room='a' * 64)
    no(f'{_t}.room of 65 characters', _t, 'maxLength', room='a' * 65)
    no(f'{_t}.room empty', _t, 'minLength', room='')

for _p in ('authPub', 'proof'):
    no(f'orgMember.{_p} of the wrong size', 'orgMember', 'minItems', **{_p: b(2, 31)})
for _p in ('org', 'room', 'authPub', 'proof'):
    no(f'orgMember without {_p}', 'orgMember', 'required', **{_p: DROP})
no('orgMember with a sealed share (orgShare holds it)', 'orgMember', 'additionalProperties', sealedShare=b(4, 72))

no('orgShare.cid of 31 bytes', 'orgShare', 'minItems', cid=b(5, 31))
no('orgShare.cid of 33 bytes', 'orgShare', 'maxItems', cid=b(5, 33))
bounds('orgShare', 'sealed', 4, 1, 128)
for _p in ('org', 'cid', 'sealed'):
    no(f'orgShare without {_p}', 'orgShare', 'required', **{_p: DROP})

ok('org without relay', 'org', relay=DROP)
ok('org.relay of 200 characters', 'org', relay='h' * 200)
no('org.relay of 201 characters', 'org', 'maxLength', relay='h' * 201)
no('org.cid of 31 bytes', 'org', 'minItems', cid=b(5, 31))
no('org.groupKey of 47 bytes', 'org', 'minItems', groupKey=b(6, 47))
no('org.groupKey of 49 bytes', 'org', 'maxItems', groupKey=b(6, 49))
integer('org', 'keyId', 0, 4294967295)
integer('org', 'threshold', 2, 64)
bounds('org', 'members', 7, 64, 2048)
bounds('org', 'pubShares', 8, 96, 3072)
for _p in ('room', 'cid', 'keyId', 'groupKey', 'threshold', 'members', 'pubShares'):
    no(f'org without {_p}', 'org', 'required', **{_p: DROP})

no('orgMessage.digest of 31 bytes', 'orgMessage', 'minItems', digest=b(9, 31))
integer('orgMessage', 'part', 0, 15)
integer('orgMessage', 'parts', 1, 16)
integer('orgMessage', 'fmt', 0, 1)
bounds('orgMessage', 'body', 10, 1, 5120)
for _p in ('org', 'digest', 'part', 'parts', 'fmt', 'body'):
    no(f'orgMessage without {_p}', 'orgMessage', 'required', **{_p: DROP})

# The organization republishes its roster with a replace (orgMember and orgMessage are immutable types)
REPLACES.append({"item": "ORG", "name": "a roster republished", "type": "org", "expect": "ok", "stored": doc('org'),
                 "doc": doc('org', relay=DROP, cid=b(11, 32), keyId=3, groupKey=b(12, 48), threshold=3,
                            members=b(13, 128), pubShares=b(14, 192))})


def index(label, t, name, properties, unique):
    INDICES.append({"item": "ORG", "name": label, "type": t, "index": name, "expect": "present",
                    "properties": properties, "has": {"unique": unique}})


index("one binding per organization and member identity", 'orgMember', 'byOrg', ['org', '$ownerId'], True)
index("an organization's identities for one participant key, earliest first", 'orgMember', 'byKey', ['org', 'authPub', '$createdAt'], False)
index("a member identity's organizations", 'orgMember', 'byOwner', ['$ownerId', 'org'], False)
index('one sealed share per member identity and ceremony', 'orgShare', 'byCeremony', ['org', '$ownerId', 'cid'], True)
index('one roster per organization', 'org', 'owner', ['$ownerId'], True)
index("one member's messages for an organization, by time", 'orgMessage', 'log', ['org', '$ownerId', '$createdAt'], False)

FILES = {'forge-org.json': CASES, 'forge-org.replace.json': REPLACES, 'forge-org.indices.json': INDICES}


def dumps(cases):
    return json.dumps(cases, indent=1, ensure_ascii=False) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    if a.check:
        stale = [f for f, c in FILES.items()
                 if not os.path.exists(os.path.join(OUT, f)) or open(os.path.join(OUT, f)).read() != dumps(c)]
        for f in stale:
            print(f'stale: forge-contracts/vectors/org/{f} (re-run forge-contracts/schema/org_vectors.py)')
        sys.exit(1 if stale else 0)
    os.makedirs(OUT, exist_ok=True)
    for f, c in FILES.items():
        open(os.path.join(OUT, f), 'w').write(dumps(c))
    print(f'{len(CASES)} create, {len(REPLACES)} replace and {len(INDICES)} index cases written to forge-contracts/vectors/org')


if __name__ == '__main__':
    main()

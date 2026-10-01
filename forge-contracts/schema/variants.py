#!/usr/bin/env python3
"""Validate every combination of the RC2 flags, and report each contract's size.

  python3 forge-contracts/schema/variants.py <contract-validate binary> [--markdown]

S2, S3, C1 and MOD (design/v5/MODERATION.md: a hide proves its writer a maintainer) are decided
at registration by fee probes on the v5 network, S1 could be dropped the same way, and ROLES (member
roles, design/v5/RECUT-OR-NEVER.md) by its +1 % fee gate, so any combination of build.RC2_FLAGS (the other flags at their FLAGS
defaults) may be the one registered. The riders (build.RIDER_FLAGS: R1 = QW-069 close reasons,
R2 = QW2-010 review-comment hunks) ride only if ready, and touch other properties, so each of
their combinations is run once, with every RC2 item on. For each, this builds the three contracts
(`build.py --off ... --out`), generates that variant's vectors (`vectors.py --off ... --out`) and
runs tools/contract-validate on them: the full v5 parse, the registration reference checks,
the create, replace and index vectors, and the create-transition size. It prints one row per
combination with each contract's serialized size against the D-12 budget (build.TARGET,
build.CEILING) and its create transition against the 20,480-byte limit, and exits 1 when any
combination fails validation or goes over the ceiling.

A probe variant to register (and measure) is the same build:
  python3 forge-contracts/schema/build.py --off review_to_author --out /tmp/probe-s2
"""
import itertools
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True  # no __pycache__ beside the schemas
import build  # noqa: E402

SHORT = {'check_evidence_freeze': 'S1', 'review_to_author': 'S2', 'review_author': 'S3', 'fused_star': 'C1',
         'event_as_maintainer': 'MOD', 'member_roles': 'ROLES', 'close_reason': 'R1', 'review_hunk': 'R2'}


def combinations():
    """(the flags turned off) for every combination of RC2_FLAGS with the riders on, then every
    combination of RIDER_FLAGS with the RC2 items on (the riders touch other properties)."""
    for on in itertools.product((True, False), repeat=len(build.RC2_FLAGS)):
        yield [f for f, v in zip(build.RC2_FLAGS, on) if not v]
    for on in itertools.product((True, False), repeat=len(build.RIDER_FLAGS)):
        if not all(on):
            yield [f for f, v in zip(build.RIDER_FLAGS, on) if not v]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) != 1:
        sys.exit(__doc__)
    validator = os.path.abspath(args[0])
    markdown = '--markdown' in sys.argv
    rows, failed = [], 0
    for off_flags in combinations():
        off = ','.join(off_flags)
        label = '+'.join(['M1'] + [s for f, s in SHORT.items() if f not in off_flags])
        with tempfile.TemporaryDirectory() as tmp:
            vectors = os.path.join(tmp, 'vectors')
            gen = subprocess.run([sys.executable, os.path.join(HERE, 'vectors.py'), '--off', off, '--out', vectors],
                                 capture_output=True, text=True)
            if gen.returncode == 0:
                code, out, sizes = build.validate(validator, build.build(build.flags_from(off)), vectors)
            else:
                code, out, sizes = gen.returncode, f'vectors.py --off {off!r} failed:\n{gen.stdout}{gen.stderr}', {}
        bad = code != 0 or len(sizes) != len(build.NAMES) or any(n > build.CEILING for n, _ in sizes.values())
        failed += bad
        rows.append((label, sizes, 'FAIL' if bad else 'ok'))
        if bad:
            print(f'{label}: FAILED\n{out[-3000:]}', file=sys.stderr)
    head = ['flags'] + [f'{n} (contract / transition B)' for n in build.NAMES] + ['result']
    cell = lambda s: f'{s[0]} / {s[1]} ({100 * s[1] / build.TRANSITION_LIMIT:.1f} %)' if s else 'refused'
    lines = [[label] + [cell(sizes.get(n)) for n in build.NAMES] + [result] for label, sizes, result in rows]
    if markdown:
        print('| ' + ' | '.join(head) + ' |')
        print('|' + '---|' * len(head))
        for line in lines:
            print('| ' + ' | '.join(line) + ' |')
    else:
        widths = [max(len(x[k]) for x in [head] + lines) for k in range(len(head))]
        for line in [head] + lines:
            print('  '.join(x.ljust(w) for x, w in zip(line, widths)))
    print(f'\nbudget: target {build.TARGET} B, ceiling {build.CEILING} B per contract; '
          f'limit {build.TRANSITION_LIMIT} B per transition. {len(rows) - failed}/{len(rows)} combinations valid.')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()

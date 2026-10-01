#!/usr/bin/env python3
"""Validate every combination of the RC2 flags, and report each contract's size.

  python3 forge-contracts/schema/variants.py <contract-validate binary> [--markdown]

S2, S3 and C1 are decided at registration by fee probes on the v5 network, and S1 could be
dropped the same way, so any combination of build.RC2_FLAGS (the other flags at their FLAGS
defaults) may be the one registered. For each, this builds the three contracts
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

SHORT = {'check_evidence_freeze': 'S1', 'review_to_author': 'S2', 'review_author': 'S3', 'fused_star': 'C1'}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) != 1:
        sys.exit(__doc__)
    validator = os.path.abspath(args[0])
    markdown = '--markdown' in sys.argv
    rows, failed = [], 0
    for on in itertools.product((True, False), repeat=len(build.RC2_FLAGS)):
        off = ','.join(f for f, v in zip(build.RC2_FLAGS, on) if not v)
        label = '+'.join(['M1'] + [SHORT[f] for f, v in zip(build.RC2_FLAGS, on) if v])
        with tempfile.TemporaryDirectory() as tmp:
            vectors = os.path.join(tmp, 'vectors')
            subprocess.run([sys.executable, os.path.join(HERE, 'vectors.py'), '--off', off, '--out', vectors],
                           check=True, capture_output=True, text=True)
            code, out, sizes = build.validate(validator, build.build(build.flags_from(off)), vectors)
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

#!/usr/bin/env python3
"""Validate every combination of the RC2 flags and of the mainnet items, and report each contract's size.

  python3 forge-contracts/schema/variants.py <contract-validate binary> [--markdown] [--all] [--jobs N]

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

RC2 is registered (devnet sakura, 2026-10-01), so its matrix is run as it was decided: with every
UPDATE-1 item (build.UPDATE1_FLAGS, roadmap D4) off. UPDATE-1 is one in-place update on top of the
registered RC2 set, so its rows follow with every RC2 item and rider on: all of it, and each item
left out alone (U1-<item>), every one of which must fit the ceiling too.

The mainnet registration (`build.py --mainnet`) is decided item by item before mainnet (dash-forge-qa
design/mixed-visibility/DESIGN.md rev 4.1 §8.3, phase M-C), so every combination of build.MV_FLAGS
that build.NEEDS allows is validated the same way, with its own vectors and the other mainnet flags
on. A combination with the four-contract layout (`layout_meta`) is a candidate registration: each
of its contracts must keep build.ROOM_MIN bytes of room under the transition limit (D44 waives the
D-12 ceiling there). One without it must validate, which includes fitting the transition limit;
its sizes are reported against the ceiling but not held to it, since the three-contract layout
cannot hold the items (DESIGN §8.3: forge-collab 19,762 B). The mainnet rows print as a summary
(the full set, each item left out of it, each alone, and the largest contract per position); --all
prints every row. Combinations run in parallel (--jobs, default the CPU count).

A probe variant to register (and measure) is the same build:
  python3 forge-contracts/schema/build.py --off review_to_author --out /tmp/probe-s2
"""
import concurrent.futures
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
# DESIGN rev 4.1 §8.3's names for the mainnet items
MV_SHORT = {'layout_meta': 'META', 'mainnet_aud': 'L1', 'mainnet_one_way_visibility': 'C1v', 'mainnet_vis_via_repo': 'L3C4',
            'mainnet_member_role': 'L2', 'mainnet_bot_role': 'C2L4', 'mainnet_maint_kinds': 'C3', 'mainnet_check_aud': 'M1',
            'mainnet_event_kinds': 'M2', 'mainnet_event_target_aud': 'M4', 'mainnet_author_event_enc': 'M3',
            'mainnet_bot_push': 'B1'}
# The mainnet flags that are not mixed-visibility items: on in every mainnet row, as --mainnet has them
MAINNET_OTHERS = [k for k in build.MAINNET_FLAGS if k not in build.MAINNET_UNBUILT and k not in build.MV_FLAGS]


def combinations():
    """(the flags turned off) for every combination of RC2_FLAGS with the riders on, then every
    combination of RIDER_FLAGS with the RC2 items on (the riders touch other properties), each
    with UPDATE-1 off (as registered); then UPDATE-1 whole, and with each of its items left out."""
    u1 = list(build.UPDATE1_FLAGS)
    for on in itertools.product((True, False), repeat=len(build.RC2_FLAGS)):
        yield [f for f, v in zip(build.RC2_FLAGS, on) if not v] + u1
    for on in itertools.product((True, False), repeat=len(build.RIDER_FLAGS)):
        if not all(on):
            yield [f for f, v in zip(build.RIDER_FLAGS, on) if not v] + u1
    yield []
    for f in u1:
        yield [f]


def allowed(on):
    flags = build.flags_from('', ','.join(MAINNET_OTHERS + list(on)))
    return all(not flags[f] or flags[d] for f, deps in build.NEEDS.items() for d in deps)


def mv_combinations():
    """(the mixed-visibility items turned on) for every combination of MV_FLAGS that NEEDS allows."""
    for bits in itertools.product((False, True), repeat=len(build.MV_FLAGS)):
        on = [f for f, v in zip(build.MV_FLAGS, bits) if v]
        if allowed(on):
            yield on


def run(off, on):
    """Build the variant, generate its vectors and validate; return (exit code, output, sizes, contracts)."""
    with tempfile.TemporaryDirectory() as tmp:
        vectors = os.path.join(tmp, 'vectors')
        gen = subprocess.run([sys.executable, os.path.join(HERE, 'vectors.py'), '--off', off, '--on', on, '--out', vectors],
                             capture_output=True, text=True)
        contracts = build.build(build.flags_from(off, on))
        if gen.returncode != 0:
            return gen.returncode, f'vectors.py --off {off!r} --on {on!r} failed:\n{gen.stdout}{gen.stderr}', {}, contracts
        code, out, sizes = build.validate(VALIDATOR, contracts, vectors)
        return code, out, sizes, contracts


def judge(label, off, on, mainnet):
    code, out, sizes, contracts = run(off, on)
    names = list(contracts)
    bad = code != 0 or set(sizes) != set(names)
    if mainnet:
        # a four-contract set keeps ROOM_MIN of room; a three-contract one only fits the limit (checked by the validator)
        bad = bad or (build.META in contracts and any(build.over_budget(contracts, s) for s in sizes.values()))
    else:
        bad = bad or any(n > build.CEILING for n, _ in sizes.values())
    return label, sizes, names, bad, out


def cell(s):
    return f'{s[0]} / {s[1]} ({100 * s[1] / build.TRANSITION_LIMIT:.1f} %)' if s else '—'


def table(rows, names, markdown):
    head = ['flags'] + [f'{n} (contract / transition B)' for n in names] + ['result']
    lines = [[label] + [cell(sizes.get(n)) for n in names] + ['FAIL' if bad else 'ok'] for label, sizes, _, bad, _ in rows]
    if markdown:
        print('| ' + ' | '.join(head) + ' |')
        print('|' + '---|' * len(head))
        for line in lines:
            print('| ' + ' | '.join(line) + ' |')
    else:
        widths = [max(len(x[k]) for x in [head] + lines) for k in range(len(head))]
        for line in [head] + lines:
            print('  '.join(x.ljust(w) for x, w in zip(line, widths)))


def main():
    global VALIDATOR
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    argv = sys.argv[1:]
    jobs = os.cpu_count() or 1
    for k, a in enumerate(argv):
        if a == '--jobs' and k + 1 < len(argv):
            jobs = int(argv[k + 1])
            args.remove(argv[k + 1])
        elif a.startswith('--jobs='):
            jobs = int(a.split('=', 1)[1])
    if len(args) != 1:
        sys.exit(__doc__)
    VALIDATOR = os.path.abspath(args[0])
    markdown = '--markdown' in sys.argv
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        rc2 = []
        for off_flags in combinations():
            label = '+'.join(['M1'] + [s for f, s in SHORT.items() if f not in off_flags])
            u1_off = [f for f in build.UPDATE1_FLAGS if f in off_flags]
            if len(u1_off) < len(build.UPDATE1_FLAGS):
                label += '+U1' + ''.join(f'-{f}' for f in u1_off)
            rc2.append(pool.submit(judge, label, ','.join(off_flags), '', False))
        mv = [pool.submit(judge, 'MN+' + ('+'.join(MV_SHORT[f] for f in on) or 'none'), '', ','.join(MAINNET_OTHERS + on), True)
              for on in mv_combinations()]
        rc2 = [f.result() for f in rc2]
        mv = [f.result() for f in mv]
    failed = 0
    for label, _, _, bad, out in rc2 + mv:
        if bad:
            failed += 1
            print(f'{label}: FAILED\n{out[-3000:]}', file=sys.stderr)

    table(rc2, build.NAMES, markdown)
    print(f'\nbudget: target {build.TARGET} B, ceiling {build.CEILING} B per contract; '
          f'limit {build.TRANSITION_LIMIT} B per transition. {len(rc2) - sum(r[3] for r in rc2)}/{len(rc2)} RC2 combinations valid.\n')

    # The mainnet matrix: the full set, each item left out of it and each alone, then the worst case
    every = {r[0]: r for r in mv}
    full = 'MN+' + '+'.join(MV_SHORT[f] for f in build.MV_FLAGS)
    pick = [full]
    for f in build.MV_FLAGS:
        pick.append('MN+' + '+'.join(MV_SHORT[g] for g in build.MV_FLAGS if g != f))
        pick.append('MN+' + MV_SHORT[f])
    pick.append('MN+none')
    shown = mv if '--all' in sys.argv else [every[p] for p in dict.fromkeys(pick) if p in every]
    names = list(build.NAMES) + [build.META]
    table(shown, names, markdown)
    print()
    for meta in (True, False):
        rows = [r for r in mv if (build.META in r[2]) == meta and len(r[1]) == len(r[2])]
        for n in (names if meta else build.NAMES) if rows else ():
            worst = max(rows, key=lambda r: r[1][n][1])
            print(f'{"with" if meta else "without"} forge-meta: largest {n} create transition {worst[1][n][1]} B '
                  f'({build.TRANSITION_LIMIT - worst[1][n][1]} B of room) in {worst[0]}')
    print(f'\nmainnet: with forge-meta each contract keeps >= {build.ROOM_MIN} B of room (D44); without it, the transition '
          f'limit only. {len(mv) - sum(r[3] for r in mv)}/{len(mv)} mainnet combinations valid.')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()

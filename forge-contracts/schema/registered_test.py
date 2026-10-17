#!/usr/bin/env python3
"""build.py stale_registered (CONT-03): the frozen registered/<network>/ sets.

  python3 forge-contracts/schema/registered_test.py

Offline and stdlib only. Uses a temp registered root: the legacy three files are copied from the committed
ones, and a production network's directory is copied from contracts/mainnet/.
"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build  # noqa: E402

MAINNET = {'testnet': {'set': 'mainnet', 'since': ()}}


def copy_set(src, dst, suffix='.json', new_suffix='.v1.json'):
    os.makedirs(dst, exist_ok=True)
    for f in os.listdir(src):
        if f.endswith(suffix):
            shutil.copy(os.path.join(src, f), os.path.join(dst, f[:-len(suffix)] + new_suffix))


class StaleRegistered(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, 'registered')
        os.makedirs(self.root)
        for n in build.NAMES:
            shutil.copy(os.path.join(build.REGISTERED, f'{n}.v1.json'), self.root)
        self.addCleanup(self.tmp.cleanup)

    def frozen_testnet(self):
        copy_set(build.MAINNET_DIR, os.path.join(self.root, 'testnet'))

    def stale(self, registrations):
        return [os.path.relpath(p, self.root) for p, _ in build.stale_registered(self.root, registrations)]

    def test_empty_table_and_no_directory_is_clean(self):
        self.assertEqual(self.stale({}), [])

    def test_the_committed_registered_dir_is_clean_with_the_committed_table(self):
        self.assertEqual([p for p, _ in build.stale_registered(build.REGISTERED, build.NETWORK_REGISTRATIONS)], [])

    def test_a_frozen_network_set_equal_to_the_build_is_clean(self):
        self.frozen_testnet()
        self.assertEqual(self.stale(MAINNET), [])

    def test_one_edited_byte_makes_that_file_stale(self):
        self.frozen_testnet()
        p = os.path.join(self.root, 'testnet', 'forge-meta.v1.json')
        with open(p, 'a') as f:
            f.write(' ')
        self.assertEqual(self.stale(MAINNET), [os.path.join('testnet', 'forge-meta.v1.json')])

    def test_a_missing_file_is_stale(self):
        self.frozen_testnet()
        os.remove(os.path.join(self.root, 'testnet', 'forge-core.v1.json'))
        self.assertEqual(self.stale(MAINNET), [os.path.join('testnet', 'forge-core.v1.json')])

    def test_an_extra_file_is_stale(self):
        self.frozen_testnet()
        open(os.path.join(self.root, 'testnet', 'forge-extra.v1.json'), 'w').write('{}')
        self.assertEqual(self.stale(MAINNET), [os.path.join('testnet', 'forge-extra.v1.json')])

    def test_a_directory_without_a_table_entry_is_stale(self):
        self.frozen_testnet()
        found = build.stale_registered(self.root, {})
        self.assertEqual([os.path.relpath(p, self.root) for p, _ in found], ['testnet'])
        self.assertIn('NETWORK_REGISTRATIONS has no testnet entry', found[0][1])

    def test_a_table_entry_without_a_directory_is_stale(self):
        self.assertEqual(self.stale(MAINNET), ['testnet'])

    def test_a_legacy_file_that_drifted_is_stale(self):
        p = os.path.join(self.root, 'forge-core.v1.json')
        open(p, 'a').write(' ')
        self.assertEqual(self.stale({}), ['forge-core.v1.json'])

    def test_since_turns_a_later_flag_off(self):
        # The frozen set is the build without the flag added after it: with the flag listed in `since`
        # the committed mainnet set (flag on) is NOT what the network registered when the flag changes it.
        self.frozen_testnet()
        flag = next(f for f in build.MAINNET_BUILT
                    if build.dumps(build.build(build.mainnet_flags(off=f))['forge-core'])
                    != build.dumps(build.build(build.mainnet_flags())['forge-core']))
        found = self.stale({'testnet': {'set': 'mainnet', 'since': (flag,)}})
        self.assertTrue(found, f'turning {flag} off must change the expected frozen set')
        # and a set frozen without the flag matches the table that lists it
        shutil.rmtree(os.path.join(self.root, 'testnet'))
        os.makedirs(os.path.join(self.root, 'testnet'))
        for n, c in build.build(build.mainnet_flags(off=flag)).items():
            open(os.path.join(self.root, 'testnet', f'{n}.v1.json'), 'w').write(build.dumps(c))
        self.assertEqual(self.stale({'testnet': {'set': 'mainnet', 'since': (flag,)}}), [])


if __name__ == '__main__':
    unittest.main()

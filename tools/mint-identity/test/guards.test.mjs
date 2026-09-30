// Offline tests for the mint-identity guards: BIP39 validation before anything is spent, the
// exclusive top-up lock, and the 0700 --out directory. Nothing here contacts a faucet or node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDir, withExclusiveLock } from '../src/backup.mjs';
import { assertValidMnemonic, resolveMnemonicArg } from '../src/mnemonic-arg.mjs';

// Published BIP39 test vectors: hold no funds.
const VALID_12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BAD_CHECKSUM = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
const BAD_WORD = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zzzzzzzz';
const BAD_COUNT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
const VALID_24 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote';

const mode = (path) => statSync(path).mode & 0o777;
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-guards-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('valid phrases (12 and 24 words) pass through unchanged', () => {
  assert.equal(resolveMnemonicArg({ mnemonic: VALID_12 }, { warn: () => {} }), VALID_12);
  assert.equal(resolveMnemonicArg({ mnemonic: VALID_24 }, { warn: () => {} }), VALID_24);
});

const INVALID = [
  ['bad checksum', BAD_CHECKSUM, /checksum/],
  ['a word outside the wordlist', BAD_WORD, /wordlist/],
  ['the wrong word count', BAD_COUNT, /11 words/],
];

for (const [name, phrase, pattern] of INVALID) {
  test(`${name}: rejected from --mnemonic, --mnemonic-file and stdin before any network call, never echoed`, () => {
    // Stand-in for everything mint does once it has a phrase (faucet, UTXO lookup, broadcast).
    let networkCalls = 0;
    const network = () => {
      networkCalls++;
    };
    const sources = [
      { args: { mnemonic: phrase }, opts: { warn: () => {} } },
      { args: { 'mnemonic-file': '/fake/phrase.txt' }, opts: { readFile: () => `${phrase}\n` } },
      { args: { mnemonic: '-' }, opts: { readStdin: () => `${phrase}\n`, stdinIsTTY: false } },
    ];
    const words = [...new Set(phrase.split(' '))];
    for (const { args, opts } of sources) {
      assert.throws(
        () => {
          network(resolveMnemonicArg(args, opts));
        },
        (err) => pattern.test(err.message) && !words.some((w) => err.message.includes(w))
      );
    }
    assert.equal(networkCalls, 0);
  });
}

test('assertValidMnemonic rejects an uppercase phrase without echoing it', () => {
  assert.throws(
    () => assertValidMnemonic(VALID_12.toUpperCase()),
    (err) => /wordlist/.test(err.message) && !/ABANDON/i.test(err.message)
  );
});

test('mint validates the phrase before it touches a directory, the network or funding', () => {
  // mint.mjs runs main() on import and spends funds, so it is never executed here: check the
  // order of cmdMint's first steps in the source instead.
  const src = readFileSync(fileURLToPath(new URL('../mint.mjs', import.meta.url)), 'utf8');
  const body = src.slice(src.indexOf('async function cmdMint'), src.indexOf('// --- mint the 9-role pool'));
  const at = (needle) => {
    const i = body.indexOf(needle);
    assert.notEqual(i, -1, needle);
    return i;
  };
  const phraseAt = at('resolveMnemonicArg(args)');
  for (const later of ['networkFromArgs(args)', 'ensureOutDir(', 'fundingMode(', 'fundDeposit(', 'saveRole(outFile']) {
    assert.ok(phraseAt < at(later), `resolveMnemonicArg must come before ${later}`);
  }
  assert.equal(body.split('resolveMnemonicArg(').length, 2, 'the phrase is resolved exactly once');
});

test('withExclusiveLock refuses a second run, runs the first, and removes the lock afterwards', async (t) => {
  const dir = tempDir(t);
  const pending = join(dir, 'OWNER.identity.json.topup-pending.json');
  let inner;
  let second = 0;
  const result = await withExclusiveLock(pending, 'top-up', async () => {
    assert.ok(existsSync(`${pending}.lock`));
    assert.equal(mode(`${pending}.lock`), 0o600);
    inner = await withExclusiveLock(pending, 'top-up', async () => {
      second++;
    }).catch((err) => err);
    return 'first ran';
  });
  assert.equal(result, 'first ran');
  assert.equal(second, 0);
  assert.match(inner.message, /another top-up is in progress, or remove .*topup-pending\.json\.lock if a previous run crashed/i);
  assert.deepEqual(readdirSync(dir), []);
  // Free again.
  assert.equal(await withExclusiveLock(pending, 'top-up', async () => 'again'), 'again');
});

test('withExclusiveLock removes the lock when the work throws, and keeps a stale lock it did not make', async (t) => {
  const dir = tempDir(t);
  const pending = join(dir, 'p.json');
  await assert.rejects(
    withExclusiveLock(pending, 'top-up', async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  assert.deepEqual(readdirSync(dir), []);
  writeFileSync(`${pending}.lock`, 'crashed run\n');
  await assert.rejects(
    withExclusiveLock(pending, 'top-up', async () => assert.fail('must not run')),
    /remove .*p\.json\.lock/
  );
  assert.equal(readFileSync(`${pending}.lock`, 'utf8'), 'crashed run\n');
});

test('ensurePrivateDir creates a missing --out directory 0700', (t) => {
  const dir = join(tempDir(t), 'a', 'out');
  assert.equal(ensurePrivateDir(dir), dir);
  assert.equal(mode(dir), 0o700);
});

test('ensurePrivateDir tightens an existing looser directory to 0700 and leaves its files alone', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'keep.txt'), 'x');
  for (const loose of [0o755, 0o777, 0o750, 0o705]) {
    chmodSync(dir, loose);
    ensurePrivateDir(dir);
    assert.equal(mode(dir), 0o700, loose.toString(8));
  }
  assert.deepEqual(readdirSync(dir), ['keep.txt']);
});

test('ensurePrivateDir refuses a path that is a file', (t) => {
  const file = join(tempDir(t), 'file');
  writeFileSync(file, 'x');
  assert.throws(() => ensurePrivateDir(file));
});

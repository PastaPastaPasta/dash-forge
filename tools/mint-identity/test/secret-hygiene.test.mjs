// Offline tests: how files holding keys are written, and where a recovery phrase is read from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIdentityFile, writeSecretFile } from '../src/backup.mjs';
import { MNEMONIC_ARGV_WARNING, resolveMnemonicArg } from '../src/mnemonic-arg.mjs';

// Obviously fake: not a valid BIP39 phrase.
const FAKE_PHRASE = 'fake one two three four five six seven eight nine ten eleven';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-secret-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const mode = (path) => statSync(path).mode & 0o777;

test('writeSecretFile creates a 0600 file and leaves no temp file behind', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'OWNER.identity.json');
  writeSecretFile(path, 'fake secret\n');
  assert.equal(readFileSync(path, 'utf8'), 'fake secret\n');
  assert.equal(mode(path), 0o600);
  assert.deepEqual(readdirSync(dir), ['OWNER.identity.json']);
});

test('writeSecretFile replaces a 0644 file with a 0600 one (the pending -> final rewrite)', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'OWNER.identity.json');
  writeFileSync(path, '{"pending":true}\n');
  chmodSync(path, 0o644);
  writeIdentityFile(path, { identityId: 'fake-id' });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { identityId: 'fake-id' });
  assert.equal(mode(path), 0o600);
  assert.deepEqual(readdirSync(dir), ['OWNER.identity.json']);
});

test('writeSecretFile replaces a symlink at the destination instead of writing through it', (t) => {
  const dir = tempDir(t);
  const target = join(dir, 'elsewhere.txt');
  writeFileSync(target, 'untouched\n');
  chmodSync(target, 0o644);
  const path = join(dir, 'x.topup-pending.json');
  symlinkSync(target, path);
  writeSecretFile(path, 'fake wif\n');
  assert.equal(readFileSync(target, 'utf8'), 'untouched\n');
  assert.equal(mode(target), 0o644);
  assert.equal(lstatSync(path).isSymbolicLink(), false);
  assert.equal(readFileSync(path, 'utf8'), 'fake wif\n');
  assert.equal(mode(path), 0o600);
  assert.deepEqual(readdirSync(dir).sort(), ['elsewhere.txt', 'x.topup-pending.json']);
});

test('writeSecretFile removes its temp file when the write fails', (t) => {
  const dir = tempDir(t);
  // The destination is a non-empty directory: rename fails after the temp file was written.
  const path = join(dir, 'occupied');
  mkdirSync(path);
  writeFileSync(join(path, 'keep'), '');
  assert.throws(() => writeSecretFile(path, 'fake secret\n'));
  assert.deepEqual(readdirSync(dir), ['occupied']);
});

test('--mnemonic-file reads the file, trimmed, without a warning', () => {
  const warnings = [];
  const got = resolveMnemonicArg(
    { 'mnemonic-file': '/fake/phrase.txt' },
    { readFile: (p) => (p === '/fake/phrase.txt' ? `\n  ${FAKE_PHRASE}  \n` : ''), warn: (m) => warnings.push(m) }
  );
  assert.equal(got, FAKE_PHRASE);
  assert.deepEqual(warnings, []);
});

test('--mnemonic-file reads a real file', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'phrase.txt');
  writeFileSync(file, `${FAKE_PHRASE}\n`);
  assert.equal(resolveMnemonicArg({ 'mnemonic-file': file }, { warn: () => assert.fail('no warning expected') }), FAKE_PHRASE);
});

test('--mnemonic - reads stdin, without a warning', () => {
  const warnings = [];
  const got = resolveMnemonicArg({ mnemonic: '-' }, { readStdin: () => `${FAKE_PHRASE}\n`, warn: (m) => warnings.push(m) });
  assert.equal(got, FAKE_PHRASE);
  assert.deepEqual(warnings, []);
});

test('--mnemonic <words> still works, with a warning that never echoes the phrase', () => {
  const warnings = [];
  assert.equal(resolveMnemonicArg({ mnemonic: FAKE_PHRASE }, { warn: (m) => warnings.push(m) }), FAKE_PHRASE);
  assert.deepEqual(warnings, [MNEMONIC_ARGV_WARNING]);
  assert.match(warnings[0], /ps/);
  assert.match(warnings[0], /--mnemonic-file/);
  assert.ok(!warnings[0].includes('eleven'));
});

test('no mnemonic flag: undefined (a fresh phrase is generated); bad combinations are errors', () => {
  assert.equal(resolveMnemonicArg({}), undefined);
  assert.throws(() => resolveMnemonicArg({ mnemonic: true }), /needs a value/);
  assert.throws(() => resolveMnemonicArg({ 'mnemonic-file': true }), /needs a path/);
  assert.throws(() => resolveMnemonicArg({ mnemonic: '-', 'mnemonic-file': 'x' }), /not both/);
  assert.throws(() => resolveMnemonicArg({ 'mnemonic-file': 'x' }, { readFile: () => '  \n' }), /No recovery phrase/);
});

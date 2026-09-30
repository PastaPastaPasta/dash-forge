// `--mnemonic -` through a real pipe with a slow writer (`pass show … | node mint.mjs
// --mnemonic -`). Runs only the arg-resolution module in a child node, never mint.mjs (which
// spends testnet faucet funds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODULE = fileURLToPath(new URL('../src/mnemonic-arg.mjs', import.meta.url));
// Obviously fake: not a valid BIP39 phrase.
const FAKE_PHRASE = 'fake one two three four five six seven eight nine ten eleven';

test('--mnemonic - reads a pipe whose writer is slow (no EAGAIN)', { skip: process.platform === 'win32' }, () => {
  const reader =
    `import(${JSON.stringify(MODULE)}).then((m) => ` +
    `process.stdout.write(m.resolveMnemonicArg({ mnemonic: '-' }, { warn: () => { throw new Error('unexpected warning'); } })))`;
  // The shell's `|` is a real pipe; the writer only starts after the reader is running.
  const out = execFileSync('sh', ['-c', `(sleep 1; echo "  $PHRASE") | "$NODE" --input-type=module -e "$READER"`], {
    env: { ...process.env, PHRASE: FAKE_PHRASE, NODE: process.execPath, READER: reader },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(out, FAKE_PHRASE);
});

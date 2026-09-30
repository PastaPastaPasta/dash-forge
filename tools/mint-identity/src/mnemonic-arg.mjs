// Where `mint` reads an existing recovery phrase from. A phrase on argv is visible to other
// users in `ps` and lands in shell history, so a file or stdin is preferred; `--mnemonic
// <words>` still works, with a warning. The phrase itself is never printed.
import { readFileSync } from 'node:fs';
import { isatty } from 'node:tty';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export const MNEMONIC_ARGV_WARNING =
  'WARNING: a recovery phrase passed with --mnemonic is visible to other users in ps and is saved in your shell history. ' +
  'Use --mnemonic-file <path> or --mnemonic - (read from stdin) instead.';

const VALID_WORD_COUNTS = [12, 15, 18, 21, 24];
const WORDS = new Set(wordlist);

/**
 * Throw unless `words` (single-space separated) is a valid English BIP39 phrase: a legal word
 * count, every word in the wordlist, and a matching checksum. Runs before anything is spent: an
 * invalid phrase would otherwise only fail at registration, after the faucet paid and the asset
 * lock was broadcast. The messages never carry the phrase or any word of it.
 */
export function assertValidMnemonic(words, source = 'the recovery phrase') {
  const list = words.split(' ');
  if (!VALID_WORD_COUNTS.includes(list.length)) {
    throw new Error(`The recovery phrase from ${source} is not valid BIP39: it has ${list.length} words, expected ${VALID_WORD_COUNTS.join(', ')}`);
  }
  if (!list.every((w) => WORDS.has(w))) {
    throw new Error(`The recovery phrase from ${source} is not valid BIP39: a word is not in the English BIP39 wordlist`);
  }
  if (!validateMnemonic(words, wordlist)) {
    throw new Error(`The recovery phrase from ${source} is not valid BIP39: the checksum does not match`);
  }
}

function phrase(text, source) {
  const words = text.trim().split(/\s+/).join(' ');
  if (!words) throw new Error(`No recovery phrase in ${source}`);
  assertValidMnemonic(words, source);
  return words;
}

/**
 * Read `--mnemonic-file`. Like funding.mjs readKeyFile, no error carries the value: someone who
 * pastes the phrase itself as the path would otherwise see it echoed in fs's ENOENT message.
 */
function readMnemonicFile(path, readFile) {
  if (/\s/.test(path)) {
    throw new Error('--mnemonic-file takes a path (without spaces), not the phrase itself; to pipe the phrase in, use --mnemonic -');
  }
  try {
    return readFile(path);
  } catch (err) {
    throw new Error(`Cannot read the --mnemonic-file file (${err?.code ?? 'read error'})`);
  }
}

/**
 * The mnemonic from parsed args, or undefined when none was given:
 *   --mnemonic-file <path>  read the file (trimmed)
 *   --mnemonic -            read stdin (a pipe or redirect: a terminal would echo the words)
 *   --mnemonic <words>      the words themselves (warns: visible in ps and shell history)
 */
export function resolveMnemonicArg(
  args,
  {
    readFile = (path) => readFileSync(path, 'utf8'),
    readStdin = () => readFileSync(0, 'utf8'),
    // isatty(0), not process.stdin.isTTY: touching process.stdin makes a pipe on fd 0
    // non-blocking, and readFileSync(0) then fails with EAGAIN when the writer is slow.
    stdinIsTTY = isatty(0),
    warn = (msg) => process.stderr.write(`${msg}\n`),
  } = {}
) {
  const file = args['mnemonic-file'];
  const inline = args.mnemonic;
  if (file !== undefined && inline !== undefined) throw new Error('Give either --mnemonic-file or --mnemonic, not both');
  if (file !== undefined) {
    if (file === true) throw new Error('--mnemonic-file needs a path');
    return phrase(readMnemonicFile(String(file), readFile), 'the --mnemonic-file file');
  }
  if (inline === undefined) return undefined;
  if (inline === true) throw new Error('--mnemonic needs a value: - to read it from stdin (or use --mnemonic-file <path>)');
  if (inline === '-') {
    if (stdinIsTTY) throw new Error('--mnemonic - reads a pipe or redirect, not a terminal (typing would echo the words); use --mnemonic-file <path>');
    return phrase(readStdin(), 'stdin');
  }
  warn(MNEMONIC_ARGV_WARNING);
  return phrase(String(inline), '--mnemonic');
}

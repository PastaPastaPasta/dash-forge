// Where `mint` reads an existing recovery phrase from. A phrase on argv is visible to other
// users in `ps` and lands in shell history, so a file or stdin is preferred; `--mnemonic
// <words>` still works, with a warning. The phrase itself is never printed.
import { readFileSync } from 'node:fs';
import { isatty } from 'node:tty';

export const MNEMONIC_ARGV_WARNING =
  'WARNING: a recovery phrase passed with --mnemonic is visible to other users in ps and is saved in your shell history. ' +
  'Use --mnemonic-file <path> or --mnemonic - (read from stdin) instead.';

function phrase(text, source) {
  const words = text.trim().split(/\s+/).join(' ');
  if (!words) throw new Error(`No recovery phrase in ${source}`);
  return words;
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
    return phrase(readFile(String(file)), String(file));
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

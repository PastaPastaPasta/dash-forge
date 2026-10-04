/**
 * TEST HELPER ONLY — random inputs for the git-parity suites (`xdiff.parity.test.ts`,
 * `git-parity.test.ts`, `rebase.parity.test.ts`): a seeded PRNG and files built to make diffs
 * and merges ambiguous. Never imported by app code.
 */

/** A tiny deterministic PRNG (xorshift), so a failure is reproducible from its seed. */
export function prng(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 0x1_0000_0000
  }
}

/** A random element of `xs`. */
export const pick = <T,>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T

/** Lines drawn from a small alphabet, so most lines repeat and diffs are ambiguous. */
const ALPHABET = ['a', 'b', 'c', '', '}', '{', 'x', 'y', '  return', 'fn f() {', '# x', 'z']

/**
 * A random file's lines: mostly a few distinct lines; sometimes a long run of one line, so the
 * histogram diff falls back to Myers (a line more than 64 times).
 */
export function randomLines(rand: () => number, max = 25): string[] {
  const kind = rand()
  const n = kind < 0.1 ? 70 + Math.floor(rand() * 80) : Math.floor(rand() * max)
  const out: string[] = []
  const alphabet = ALPHABET.slice(0, 2 + Math.floor(rand() * (ALPHABET.length - 1)))
  for (let i = 0; i < n; i++) {
    if (kind < 0.1 && rand() < 0.85) out.push('')
    else out.push(pick(rand, alphabet))
  }
  return out
}

/** A random edit of `lines`: runs inserted, deleted or replaced, sometimes next to each other. */
export function editLines(lines: readonly string[], rand: () => number, tag: string): string[] {
  const out = [...lines]
  for (let k = 1 + Math.floor(rand() * 4); k > 0; k--) {
    const at = Math.floor(rand() * (out.length + 1))
    const r = rand()
    const len = 1 + Math.floor(rand() * 3)
    const fresh = (): string => (rand() < 0.5 ? pick(rand, ALPHABET) : `${tag}${Math.floor(rand() * 5)}`)
    if (r < 0.35) out.splice(at, 0, ...Array.from({ length: len }, fresh))
    else if (r < 0.65) out.splice(at, len)
    else out.splice(at, len, ...Array.from({ length: len }, fresh))
  }
  return out
}

/** A file's text: `\n` (sometimes `\r\n`) line ends, and sometimes no final newline. */
export function linesText(lines: readonly string[], rand: () => number): string {
  if (lines.length === 0) return ''
  const eol = rand() < 0.1 ? '\r\n' : '\n'
  return lines.join(eol) + (rand() < 0.8 ? eol : '')
}

/** {@link linesText} as bytes. */
export function toBytes(lines: readonly string[], rand: () => number): Uint8Array {
  return new TextEncoder().encode(linesText(lines, rand))
}

/** git with no user or system configuration (a `core.autocrlf` or `merge.*` setting would change answers). */
export const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

/**
 * Lazy syntax highlighting for the blob view.
 *
 * Uses highlight.js's **common** language bundle (~35 languages), loaded via dynamic
 * `import()` so it lands in its own async chunk — never in the initial paint. The blob view
 * renders plain text immediately and swaps in highlighted lines once this resolves.
 *
 * Output is per-line HTML (spans reopened across line breaks) so it drops straight into the
 * existing line-numbered table. highlight.js escapes all text and emits only `hljs-*`-classed
 * spans, so the result is safe to inject. Any failure (unknown language, oversized file,
 * import error) degrades to `null` and the caller keeps the plain rendering.
 */

/** Files larger than this stay plain — highlighting a huge blob is not worth the jank. */
const MAX_HIGHLIGHT_BYTES = 512 * 1024
/** Above this line count we also stay plain (very long minified/generated files). */
const MAX_HIGHLIGHT_LINES = 20_000

/** Filename extension → highlight.js language id (only ids present in the common bundle). */
const EXT_LANGUAGE: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  rs: 'rust',
  py: 'python',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  dockerfile: 'dockerfile',
  make: 'makefile',
  mk: 'makefile',
  diff: 'diff',
  patch: 'diff',
}

/** The resolved highlight for a blob: per-line HTML plus the language actually used. */
export interface HighlightedBlob {
  readonly lines: string[]
  readonly language: string | null
}

/** Map a filename to a language id (by extension, then a couple of well-known basenames). */
function languageForFilename(filename: string): string | undefined {
  const base = filename.split('/').pop()?.toLowerCase() ?? ''
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  const dot = base.lastIndexOf('.')
  if (dot === -1) return undefined
  return EXT_LANGUAGE[base.slice(dot + 1)]
}

/**
 * Split highlight.js output HTML into per-line HTML fragments, reopening any spans that are
 * still open at a line break (highlight.js only emits `<span class="…">` / `</span>`).
 */
function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []
  const open: string[] = [] // stack of the currently-open opening-tag strings
  let current = ''
  const token = /<span[^>]*>|<\/span>|[^<]+/g
  let m: RegExpExecArray | null
  while ((m = token.exec(html)) !== null) {
    const piece = m[0]
    if (piece.startsWith('<span')) {
      open.push(piece)
      current += piece
    } else if (piece === '</span>') {
      open.pop()
      current += piece
    } else {
      // Text run — may contain newlines. Break the line, closing/reopening open spans.
      const parts = piece.split('\n')
      for (let i = 0; i < parts.length; i++) {
        current += parts[i]
        if (i < parts.length - 1) {
          for (let k = open.length - 1; k >= 0; k--) current += '</span>'
          lines.push(current)
          current = open.join('')
        }
      }
    }
  }
  lines.push(current)
  return lines
}

/**
 * Highlight a text blob, returning per-line HTML — or `null` to keep the plain rendering
 * (oversized file, unknown+unconfident language, or highlight.js unavailable).
 */
export async function highlightBlob(text: string, filename: string): Promise<HighlightedBlob | null> {
  if (text.length > MAX_HIGHLIGHT_BYTES) return null

  try {
    const hljs = (await import('highlight.js/lib/common')).default
    const wanted = languageForFilename(filename)
    let value: string
    let language: string | null
    if (wanted && hljs.getLanguage(wanted)) {
      value = hljs.highlight(text, { language: wanted, ignoreIllegals: true }).value
      language = wanted
    } else {
      const auto = hljs.highlightAuto(text)
      // Auto-detection is noisy on prose/config; only trust a reasonably relevant match.
      if ((auto.relevance ?? 0) < 5) return null
      value = auto.value
      language = auto.language ?? null
    }
    const lines = splitHighlightedLines(value)
    if (lines.length > MAX_HIGHLIGHT_LINES) return null
    return { lines, language }
  } catch {
    return null
  }
}

#!/usr/bin/env node
// Copy lint: finds the strings a user can read in forge-web and fails on internal
// vocabulary, lazy plurals and help text that runs too long. The rules are the
// "Voice and tone" section of docs/design/style-guide.md; agents write most of the
// copy, so this gate is what keeps protocol jargon out of the UI.
//
//   node scripts/copy-lint.mjs            # lint app, components, lib, hooks, contexts
//   node scripts/copy-lint.mjs --list     # print every extracted string (tab separated)
//
// A string that is genuinely not user-facing (a developer error, a log line) can be
// exempted with a `copy-lint-ignore: <reason>` comment on the line above it, and a
// whole file with `// copy-lint-ignore-file: <reason>` as its first line.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks', 'contexts']

/** Longest help text, in words, that the UI may show in one string. */
export const MAX_WORDS = 40

/**
 * Banned in anything a user reads. Each pattern names an internal identifier, a
 * protocol term users never need, or a formatting tell. Keep this list and the
 * style guide's banned list in step.
 */
export const RULES = [
  { id: 'release-name', pattern: /\bRC\d\b|\bforge-v[12]\b|\bPV1\d\b|\bprotocol 1\d\b/i, why: 'internal release or contract-set name' },
  { id: 'tracker-id', pattern: /\bQW\d|\bD-\d+\b|\bP\d-\d+\b|§/, why: 'internal tracker id' },
  {
    id: 'code-identifier',
    pattern: /FORGE_RULES|objectLocator|packManifest|starBeat|headUpdate|\bforkOf\b|\basMember\b|\basMaintainer\b|\bauthorEvent\b/,
    why: 'code identifier',
  },
  { id: 'fold', pattern: /\bfold(s|ed|ing)?\b/i, why: 'say "read", "load" or "build" instead of "fold"' },
  { id: 'consensus', pattern: /\bconsensus\b/i, why: 'use the "Enforced by" chip instead of explaining consensus' },
  { id: 'client-rule', pattern: /\bclient rules?\b|\bForge clients?\b/i, why: 'say "Forge apps" or use the "Enforced by" chip' },
  {
    id: 'document',
    pattern: /\bdocuments?\b/i,
    why: 'name the thing (repo, issue, profile) rather than its Platform document',
  },
  {
    id: 'banned-phrase',
    pattern: /Platform refused it|Nothing was charged|\b(proof|hash)-checked\b|\brecovery words\b|\bbrowser key\b|\bseamless(ly)?\b|\bleverag(e|es|ing)\b|\bsimply\b/i,
    why: 'banned phrase; see the glossary in the style guide',
  },
  { id: 'doc-path', pattern: /\bdocs\/[\w./-]*\.md\b|forge-contracts\//, why: 'repository path; link to the docs page instead' },
  { id: 'lazy-plural', pattern: /\w\(s\)/, why: 'use plural() instead of "(s)"' },
]

function walk(dir, files) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (!/^(node_modules|__tests__|e2e|e2e-drill)$/.test(name)) walk(path, files)
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$|fixtures?\.tsx?$|\.d\.ts$/.test(name)) {
      files.push(path)
    }
  }
}

// Attribute names whose values are never prose.
const NON_PROSE_ATTR =
  /^(className|href|src|key|id|type|role|variant|size|tone|rel|target|method|name|htmlFor|viewBox|d|fill|stroke|xmlns|autoComplete|inputMode|as|side|align|testId|icon|kind|state|mode|accept|pattern|lang|dir|enterKeyHint|spellCheck|wrap|form|value|defaultValue|sizes|media|charSet|content|property|style)$|^data-|^on[A-Z]/
// Call targets whose string arguments are not shown to users.
const NON_PROSE_CALL =
  /^(console\.\w+|cn|clsx|cva|twMerge|classNames|require|import|fetch|new URL|URL|encodeURIComponent|decodeURIComponent|JSON\.parse|localStorage\.\w+|sessionStorage\.\w+|document\.\w+|querySelector\w*|\w+\.querySelector\w*|\w+\.getAttribute|\w+\.setAttribute|\w+\.startsWith|\w+\.endsWith|\w+\.includes|\w+\.split|\w+\.replace|\w+\.match|\w+\.test|RegExp|new RegExp|Symbol|\w+\.addEventListener|\w+\.removeEventListener|\w+\.postMessage|\w+\.get|\w+\.set|\w+\.has|\w+\.delete|\w+\.toLocaleString|\w+\.toLocaleDateString|\w+\.toLocaleTimeString|Intl\.\w+|new Intl\.\w+|describe|it|test|expect)$/
const CLASSY = /^(flex|grid|text-|bg-|border|px-|py-|p-|m[trblxy]?-|inline|hidden|block|rounded|w-|h-|absolute|relative|sr-only|min-|max-|gap|items|justify|space|font|shrink|overflow|pointer|cursor|transition|focus|hover|group|peer|dark:|md:|sm:|lg:|xl:|motion-|animate-|ring|outline|z-|top-|left-|right-|bottom-|inset|opacity|select-|whitespace|break-|truncate|tabular|leading|tracking|underline|align|order|col-|row-|self-|place-|content-|object-|aspect)/

function isProse(text) {
  // Two or more words with letters; not a class list, a selector or an identifier.
  if (!/[A-Za-z]{2,}[^\n]*\s+[^\n]*[A-Za-z]{2,}/.test(text)) return false
  if (CLASSY.test(text)) return false
  if (/^[\w\s:\/\-\[\]\.\(\)=#&>@*+,"'~]+$/.test(text) && !/[A-Z][a-z]+\s|\b(a|an|the|is|are|to|of|and|or|your|you|this)\b/.test(text)) return false
  return true
}

// Inline JSX: its text reads as part of the surrounding sentence.
const INLINE_TAGS = /^(a|b|i|em|strong|code|kbd|abbr|span|small|sup|sub|mark|br|Link|ExternalLink|DocsLink)$/
const BLOCK_TAGS = /^(div|p|ul|ol|li|section|article|aside|nav|header|footer|main|table|thead|tbody|tr|td|th|form|fieldset|h[1-6]|details|summary|dl|dt|dd|label|button|pre|figure|blockquote)$/

function tagName(el) {
  if (ts.isJsxFragment(el)) return ''
  const opening = ts.isJsxElement(el) ? el.openingElement : el
  return opening.tagName.getText()
}

/** A sentence-level JSX element: text with only inline markup or values inside. */
function isParagraph(el) {
  if (!el.children.some((c) => ts.isJsxText(c) && /[A-Za-z]{2}/.test(c.getText()))) return false
  return !el.children.some((c) => (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) && BLOCK_TAGS.test(tagName(c)))
}

/** The text of JSX children; a value or a component counts as one word. */
function flatten(children) {
  let out = ''
  for (const c of children) {
    if (ts.isJsxText(c)) out += c.text
    else if (ts.isJsxExpression(c)) {
      const e = c.expression
      if (!e) continue
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out += e.text
      else out += ' … '
    } else if (ts.isJsxElement(c) && INLINE_TAGS.test(tagName(c))) out += flatten(c.children)
    else if (ts.isJsxSelfClosingElement(c) && tagName(c) === 'br') out += ' '
    else out += ' … '
  }
  return out
}

/** Inline scripts and other source text kept in strings. */
function looksLikeCode(text) {
  return /\bfunction\s*\(|=>|\bvar\s+\w+\s*=|\bconst\s+\{|\brequire\(|;\s*}\s*/.test(text)
}

function calleeName(call) {
  const expr = call.expression
  const text = expr.getText()
  if (ts.isNewExpression(call)) return `new ${text}`
  return text
}

function hasIgnoreComment(src, sf, node) {
  const line = sf.getLineAndCharacterOfPosition(node.getStart()).line
  for (const l of [line, line - 1, line - 2]) {
    if (l < 0) continue
    const start = sf.getPositionOfLineAndCharacter(l, 0)
    const end = l + 1 < sf.getLineStarts().length ? sf.getPositionOfLineAndCharacter(l + 1, 0) : src.length
    if (src.slice(start, end).includes('copy-lint-ignore')) return true
  }
  return false
}

/** Returns { file, line, kind, text } for every user-visible string in one file. */
export function extractFile(path, root = WEB_ROOT) {
  const src = readFileSync(path, 'utf8')
  // A whole file that no user reads (a test or script helper) opts out on its first line.
  if (/^\/\/ copy-lint-ignore-file:/.test(src)) return []
  const kindOf = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kindOf)
  const out = []
  const rel = relative(root, path)
  const emit = (node, kind, raw) => {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text || looksLikeCode(text)) return
    if (hasIgnoreComment(src, sf, node)) return
    out.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind, text })
  }
  const skipped = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isTypeNode(p)) return true
      if (ts.isPropertyAssignment(p) && p.name === node) return true
      if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true
      if (ts.isJsxAttribute(p)) return NON_PROSE_ATTR.test(p.name.getText())
      if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(node)) {
        return NON_PROSE_CALL.test(calleeName(p))
      }
      if (ts.isCaseClause(p) || ts.isBinaryExpression(p)) {
        if (ts.isBinaryExpression(p) && /^(===|!==|==|!=)$/.test(p.operatorToken.getText())) return true
        if (ts.isCaseClause(p) && p.expression === node) return true
      }
      if (ts.isBlock(p) || ts.isSourceFile(p)) return false
    }
    return false
  }
  const visit = (node) => {
    const inlineInParagraph =
      ts.isJsxElement(node) && INLINE_TAGS.test(tagName(node)) && ts.isJsxElement(node.parent) && isParagraph(node.parent)
    if ((ts.isJsxElement(node) || ts.isJsxFragment(node)) && isParagraph(node) && !inlineInParagraph) {
      // The whole paragraph, inline markup and all, for the length rule.
      emit(node, 'paragraph', flatten(node.children))
    }
    if (ts.isJsxText(node)) {
      // Inside a paragraph, the paragraph carries the length rule.
      if (/[A-Za-z]{2}/.test(node.text)) emit(node, isParagraph(node.parent) ? 'jsx-in-paragraph' : 'jsx', node.text)
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!skipped(node)) {
        const attr = ts.isJsxAttribute(node.parent) ? node.parent.name.getText() : null
        if (attr ? /[A-Za-z]{2}/.test(node.text) : isProse(node.text)) emit(node, attr ? `attr:${attr}` : 'str', node.text)
      }
    } else if (ts.isTemplateExpression(node)) {
      if (!skipped(node)) {
        // Interpolations count as one word each.
        const text = node.getText().slice(1, -1).replace(/\$\{[^}]*\}/g, '…')
        if (isProse(text)) emit(node, 'tpl', text)
      }
      return // nested literals inside ${} are code
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

export function extractAll(root = WEB_ROOT, dirs = SOURCE_DIRS) {
  const files = []
  for (const d of dirs) if (existsSync(join(root, d))) walk(join(root, d), files)
  return files.sort().flatMap((f) => extractFile(f, root))
}

export function wordCount(text) {
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9…]/.test(w)).length
}

/** Every rule a string breaks. A paragraph is checked for length only: its text nodes carry the rest. */
export function violations(entry) {
  const hits = entry.kind === 'paragraph' ? [] : RULES.filter((r) => r.pattern.test(entry.text)).map((r) => ({ id: r.id, why: r.why }))
  const words = wordCount(entry.text)
  if (words > MAX_WORDS && entry.kind !== 'jsx-in-paragraph') hits.push({ id: 'too-long', why: `${words} words; keep help text to ${MAX_WORDS} or fewer` })
  return hits
}

export function lint(root = WEB_ROOT) {
  return extractAll(root).flatMap((entry) => violations(entry).map((v) => ({ ...entry, ...v })))
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  if (process.argv.includes('--list')) {
    for (const e of extractAll()) console.log(`${e.file}:${e.line}\t${e.kind}\t${e.text}`)
  } else {
    const found = lint()
    for (const v of found) console.log(`${v.file}:${v.line}  [${v.id}] ${v.why}\n    ${v.text.slice(0, 200)}`)
    if (found.length) {
      console.log(`\n${found.length} copy problem${found.length === 1 ? '' : 's'}. See docs/design/style-guide.md, "Voice and tone".`)
      process.exit(1)
    }
    console.log('Copy lint: clean.')
  }
}

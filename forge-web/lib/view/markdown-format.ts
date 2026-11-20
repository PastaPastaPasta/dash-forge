/**
 * The formatting shortcuts of the Markdown editor (Cmd/Ctrl+B, I, E, K): wrap the selection,
 * or unwrap it when it is wrapped already, and say where the selection lands.
 */

export type MarkdownFormat = 'bold' | 'italic' | 'code' | 'link'

export interface Edited {
  readonly value: string
  readonly start: number
  readonly end: number
}

const MARKS: Readonly<Record<Exclude<MarkdownFormat, 'link'>, string>> = { bold: '**', italic: '_', code: '`' }

/** The format a Cmd/Ctrl+key press asks for, if any. */
export function formatForKey(key: string): MarkdownFormat | null {
  switch (key.toLowerCase()) {
    case 'b':
      return 'bold'
    case 'i':
      return 'italic'
    case 'e':
      return 'code'
    case 'k':
      return 'link'
    default:
      return null
  }
}

/** `value` with `[start, end)` formatted as `format`, and the selection after it. */
export function applyFormat(value: string, start: number, end: number, format: MarkdownFormat): Edited {
  const selected = value.slice(start, end)
  const before = value.slice(0, start)
  const after = value.slice(end)
  if (format === 'link') {
    // A selected URL becomes the target; any other selection the text, with `url` selected.
    if (/^https?:\/\/\S+$/.test(selected)) {
      const text = 'text'
      const out = `${before}[${text}](${selected})${after}`
      return { value: out, start: start + 1, end: start + 1 + text.length }
    }
    const out = `${before}[${selected}](url)${after}`
    const urlAt = start + selected.length + 3
    return { value: out, start: urlAt, end: urlAt + 3 }
  }
  const mark = MARKS[format]
  // Wrapped already, just outside the selection: unwrap.
  if (before.endsWith(mark) && after.startsWith(mark)) {
    const out = `${before.slice(0, -mark.length)}${selected}${after.slice(mark.length)}`
    return { value: out, start: start - mark.length, end: end - mark.length }
  }
  const out = `${before}${mark}${selected}${mark}${after}`
  return { value: out, start: start + mark.length, end: end + mark.length }
}

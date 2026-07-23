/**
 * MarkdownView — renders the safe Markdown AST (lib/view/markdown) as React elements.
 *
 * Only known elements with escaped text are emitted (no raw HTML injection), so untrusted
 * README / issue bodies are XSS-safe by construction. Prose is set at 15px with foundry link
 * accents; code blocks render monospace in an inset surface.
 */

import { Fragment, type ReactNode } from 'react'
import { parseMarkdown, type Block, type Inline } from '@/lib/view'
import { cn } from '@/lib/utils'

function renderInline(nodes: readonly Inline[], keyPrefix: string): ReactNode {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}-${i}`
    switch (n.t) {
      case 'text':
        return <Fragment key={key}>{n.v}</Fragment>
      case 'strong':
        return <strong key={key} className="font-semibold">{renderInline(n.c, key)}</strong>
      case 'em':
        return <em key={key}>{renderInline(n.c, key)}</em>
      case 'del':
        return <del key={key} className="text-anvil-400">{renderInline(n.c, key)}</del>
      case 'code':
        return (
          <code key={key} className="rounded bg-anvil-100 px-1 py-0.5 text-[0.9em] text-forge-700 dark:bg-anvil-800 dark:text-forge-300">
            {n.v}
          </code>
        )
      case 'link':
        return (
          <a
            key={key}
            href={n.href}
            target={n.href.startsWith('http') ? '_blank' : undefined}
            rel="noreferrer noopener"
            className="text-forge-600 underline decoration-forge-600/30 underline-offset-2 hover:decoration-forge-600 dark:text-forge-400"
          >
            {renderInline(n.c, key)}
          </a>
        )
      case 'image':
        return (
          <img
            key={key}
            src={n.src}
            alt={n.alt}
            className="my-2 inline-block max-w-full rounded"
            loading="lazy"
          />
        )
      default:
        return null
    }
  })
}

function renderBlock(b: Block, key: string): ReactNode {
  switch (b.t) {
    case 'heading': {
      const cls =
        b.level === 1
          ? 'mt-6 mb-3 border-b border-anvil-200 pb-2 text-2xl dark:border-anvil-800'
          : b.level === 2
            ? 'mt-6 mb-3 border-b border-anvil-200 pb-1.5 text-xl dark:border-anvil-800'
            : 'mt-5 mb-2 text-lg'
      const content = renderInline(b.c, key)
      if (b.level <= 2) return <h2 key={key} className={cls}>{content}</h2>
      if (b.level === 3) return <h3 key={key} className={cls}>{content}</h3>
      return <h4 key={key} className={cls}>{content}</h4>
    }
    case 'paragraph':
      return <p key={key} className="my-3 leading-relaxed">{renderInline(b.c, key)}</p>
    case 'code':
      return (
        <pre key={key} className="my-3 overflow-x-auto rounded-md border border-anvil-200 bg-anvil-50 p-3 text-[13px] dark:border-anvil-800 dark:bg-anvil-950">
          <code>{b.v}</code>
        </pre>
      )
    case 'list':
      return b.ordered ? (
        <ol key={key} className="my-3 list-decimal space-y-1 pl-6">
          {b.items.map((it, i) => <li key={i}>{renderInline(it, `${key}-${i}`)}</li>)}
        </ol>
      ) : (
        <ul key={key} className="my-3 list-disc space-y-1 pl-6">
          {b.items.map((it, i) => <li key={i}>{renderInline(it, `${key}-${i}`)}</li>)}
        </ul>
      )
    case 'quote':
      return (
        <blockquote key={key} className="my-3 border-l-2 border-forge-500/40 pl-4 text-anvil-500 dark:text-anvil-400">
          {b.c.map((inner, i) => renderBlock(inner, `${key}-${i}`))}
        </blockquote>
      )
    case 'hr':
      return <hr key={key} className="my-5 border-anvil-200 dark:border-anvil-800" />
    default:
      return null
  }
}

export function MarkdownView({ source, className }: { source: string; className?: string }): JSX.Element {
  const blocks = parseMarkdown(source)
  return (
    <div className={cn('text-prose text-anvil-700 dark:text-anvil-200', className)}>
      {blocks.map((b, i) => renderBlock(b, `b-${i}`))}
    </div>
  )
}

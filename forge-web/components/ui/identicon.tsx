/**
 * Identicon: the 5×5 pattern `lib/design/identicon.ts` draws from SHA-256 of a seed, as an SVG
 * on a light tile (the same in both themes, like an image).
 *
 * Every identity pill draws it from the full identity id, never from `profile.avatarConfig`: a
 * profile picture is the owner's choice and anyone can copy one, while the pattern follows from
 * all 44 characters of the id, so an impostor who ground a matching prefix still looks
 * different. Sized by the CSS variable `--avatar` unless `size` is given.
 */

import type { CSSProperties } from 'react'
import { identicon, IDENTICON_SIZE } from '@/lib/design/identicon'
import { cn } from '@/lib/utils'

/** The 5×5 grid fits the circle's inscribed square (side ≈ 0.707 of the diameter). */
const PAD = 1.1
const BOX = IDENTICON_SIZE + PAD * 2

export function Identicon({ seed, size, className }: { seed: string; size?: number; className?: string }): JSX.Element {
  const { cells, fill } = identicon(seed)
  const side = size === undefined ? 'var(--avatar)' : `${size}px`
  const style: CSSProperties = { width: side, height: side }
  return (
    <svg
      viewBox={`0 0 ${BOX} ${BOX}`}
      shapeRendering="crispEdges"
      className={cn('shrink-0 rounded-full', className)}
      style={style}
      aria-hidden
      data-testid="avatar-identicon"
    >
      <rect width={BOX} height={BOX} fill="#f3f4f6" />
      {cells.flatMap((row, r) => row.map((on, c) => (on ? <rect key={`${r}-${c}`} x={PAD + c} y={PAD + r} width={1} height={1} fill={fill} /> : null)))}
    </svg>
  )
}

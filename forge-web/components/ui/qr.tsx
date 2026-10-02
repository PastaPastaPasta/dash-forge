'use client'

import { useMemo } from 'react'
import encodeQR from 'qr'

/**
 * A QR code (SVG, quiet zone included) with its text beneath it (spec §10: QR carries text).
 * `caption`: the text to show when the code carries more (a payment URI shows its address), or
 * null when the text is beside the code already (a copy field with the same address, QW4-022).
 */
export function Qr({ value, label, size = 184, caption }: { value: string; label: string; size?: number; caption?: string | null }): JSX.Element {
  const svg = useMemo(() => encodeQR(value, 'svg', { ecc: 'medium', border: 2 }), [value])
  return (
    <figure className="flex flex-col items-center gap-2">
      <div
        role="img"
        aria-label={label}
        className="rounded-md bg-white p-1 [&>svg]:h-full [&>svg]:w-full"
        style={{ width: size, height: size }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {caption === null ? null : (
        <figcaption className="max-w-full break-all text-center font-mono text-[12px] text-anvil-600 dark:text-anvil-300">{caption ?? value}</figcaption>
      )}
    </figure>
  )
}

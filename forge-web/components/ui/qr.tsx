'use client'

import { useMemo } from 'react'
import encodeQR from 'qr'

/** A QR code (SVG, quiet zone included) with its text beneath it (spec §10: QR carries text). */
export function Qr({ value, label, size = 184 }: { value: string; label: string; size?: number }): JSX.Element {
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
      <figcaption className="max-w-full break-all text-center font-mono text-[12px] text-anvil-600 dark:text-anvil-300">{value}</figcaption>
    </figure>
  )
}

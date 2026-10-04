'use client'

/**
 * ProfileAvatar — an identity's large avatar (its profile page, Settings → Profile), drawn from
 * `profile.avatarConfig` (`lib/rules/profile.ts` {@link avatarSpec}):
 *
 * - none (or a value no convention reads): the initial on the identity's own colour, as the
 *   identity pill draws it;
 * - `identicon[:seed]`: a pattern drawn here from the seed (`lib/design/identicon.ts`);
 * - an https image link: the default until the viewer loads that host's images, as Markdown
 *   images in issues and comments (D-053): fetching it tells the host who looked and when.
 *   Nothing is hosted by Forge.
 *
 * One picture, sized by the CSS variable `--avatar` (a pixel length): a caller that wants one size
 * on a phone and another from `md` sets it with breakpoint classes (`[--avatar:72px]
 * md:[--avatar:256px]`) instead of rendering two avatars.
 */

import { useMemo, useState, type CSSProperties } from 'react'
import { avatarFill, avatarHue } from '@/lib/design/avatar'
import { identiconCells, identiconFill, IDENTICON_SIZE } from '@/lib/design/identicon'
import { avatarSpec } from '@/lib/rules/profile'
import { urlHostOf } from '@/lib/view/markdown-links'
import { allowHost, useHostAllowed } from '@/hooks/use-image-hosts'
import { cn } from '@/lib/utils'

export interface ProfileAvatarProps {
  readonly identityId: string
  /** The name its initial is drawn from (DPNS name or display name). */
  readonly name?: string | null
  /** `profile.avatarConfig`, as stored. */
  readonly config?: string | null
  /** Pixels per side; omit it when `className` sets `--avatar` (one size per breakpoint). */
  readonly size?: number
  readonly className?: string
}

/** The picture's box: `--avatar` square. */
const BOX: CSSProperties = { width: 'var(--avatar)', height: 'var(--avatar)' }

/** The first character of `s`, whole (an emoji is two UTF-16 units; `charAt` would split it). */
function initialOf(s: string): string {
  return (Array.from(s)[0] ?? '').toUpperCase()
}

function Initial({ identityId, name }: { identityId: string; name?: string | null }): JSX.Element {
  return (
    <span
      className="flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white"
      style={{ ...BOX, fontSize: 'calc(var(--avatar) * 0.42)', backgroundColor: avatarFill(avatarHue(identityId)) }}
      aria-hidden
      data-testid="avatar-initial"
    >
      {initialOf(name || identityId)}
    </span>
  )
}

/** The `identicon` pattern as an SVG on a light tile (the same in both themes, like an image). */
export function Identicon({ seed }: { seed: string }): JSX.Element {
  const { cells, fill } = useMemo(() => ({ cells: identiconCells(seed), fill: identiconFill(seed) }), [seed])
  // The 5×5 grid fits the circle's inscribed square (side ≈ 0.707 of the diameter).
  const pad = 1.1
  const box = IDENTICON_SIZE + pad * 2
  return (
    <svg viewBox={`0 0 ${box} ${box}`} shapeRendering="crispEdges" className="shrink-0 rounded-full" style={BOX} aria-hidden data-testid="avatar-identicon">
      <rect width={box} height={box} fill="#f3f4f6" />
      {cells.flatMap((row, r) => row.map((on, c) => (on ? <rect key={`${r}-${c}`} x={pad + c} y={pad + r} width={1} height={1} fill={fill} /> : null)))}
    </svg>
  )
}

export function ProfileAvatar({ identityId, name, config, size, className }: ProfileAvatarProps): JSX.Element {
  const spec = avatarSpec(config, identityId)
  const url = spec.kind === 'url' ? spec.url : null
  const host = url === null ? null : urlHostOf(url)
  const allowed = useHostAllowed(host)
  const [failed, setFailed] = useState<string | null>(null)

  let picture: JSX.Element
  if (spec.kind === 'identicon') picture = <Identicon seed={spec.seed} />
  else if (url !== null && allowed && failed !== url) {
    picture = (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        className="shrink-0 rounded-full object-cover"
        style={BOX}
        referrerPolicy="no-referrer"
        onError={() => setFailed(url)}
        data-testid="avatar-image"
      />
    )
  } else picture = <Initial identityId={identityId} name={name} />

  return (
    <span className={cn('inline-flex flex-col items-center gap-1.5', className)} style={size === undefined ? undefined : ({ '--avatar': `${size}px` } as CSSProperties)}>
      {picture}
      {url !== null && host !== null && !allowed ? (
        <button
          type="button"
          onClick={() => allowHost(host, false)}
          className="hit-area max-w-full truncate text-[12px] font-medium text-forge-700 hover:underline dark:text-forge-400"
          title={`Loading it tells ${host} your IP address and when you looked`}
          data-testid="avatar-load"
        >
          Load avatar from {host}
        </button>
      ) : null}
      {url !== null && failed === url ? (
        <span className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="avatar-failed">
          Avatar did not load from {host ?? 'its host'}
        </span>
      ) : null}
    </span>
  )
}

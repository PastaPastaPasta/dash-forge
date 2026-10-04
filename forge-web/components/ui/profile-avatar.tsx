'use client'

/**
 * ProfileAvatar — an identity's large avatar (its profile page, Settings → Profile), drawn from
 * `profile.avatarConfig` (`lib/rules/profile.ts` {@link avatarSpec}):
 *
 * - none (or a value no convention reads): the identicon of the identity id, as every identity
 *   pill draws it;
 * - `identicon[:seed]`: the pattern of the seed (`lib/design/identicon.ts`);
 * - an https image link: the default until the viewer loads that host's images, as Markdown
 *   images in issues and comments (D-053): fetching it tells the host who looked and when.
 *   Nothing is hosted by Forge.
 *
 * One picture, sized by the CSS variable `--avatar` (a pixel length): a caller that wants one size
 * on a phone and another from `md` sets it with breakpoint classes (`[--avatar:72px]
 * md:[--avatar:256px]`) instead of rendering two avatars.
 */

import { useState, type CSSProperties } from 'react'
import { Identicon } from '@/components/ui/identicon'
import { avatarSpec } from '@/lib/rules/profile'
import { urlHostOf } from '@/lib/view/markdown-links'
import { allowHost, useHostAllowed } from '@/hooks/use-image-hosts'
import { cn } from '@/lib/utils'

export interface ProfileAvatarProps {
  readonly identityId: string
  /** `profile.avatarConfig`, as stored. */
  readonly config?: string | null
  /** Pixels per side; omit it when `className` sets `--avatar` (one size per breakpoint). */
  readonly size?: number
  readonly className?: string
}

/** The picture's box: `--avatar` square. */
const BOX: CSSProperties = { width: 'var(--avatar)', height: 'var(--avatar)' }

export function ProfileAvatar({ identityId, config, size, className }: ProfileAvatarProps): JSX.Element {
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
  } else picture = <Identicon seed={identityId} />

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

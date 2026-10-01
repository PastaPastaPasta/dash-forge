'use client'

/**
 * Settings → Stars: "Count my stars toward Trending" (platform-parity-spec §4.3). On (the
 * default), a new star also writes a small `starBeat` document that the Explore page's Trending
 * ranks by; off, a star is just the star. Stored in this browser.
 *
 * On a fused-star contract (RC2 C1, `lib/repo/star-shape.ts`) there is no choice to make: every
 * star is its own Trending entry (Explore leaves out private repos, and an owner's star on a
 * repo created inside the window, on read), so the panel says so instead of offering the toggle.
 */

import { useState } from 'react'

import { useStarShape } from '@/hooks/use-star-shape'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { previewCreate } from '@/lib/sdk'
import { setTrendingPref, trendingPref } from '@/lib/repo/trending'
import { creditsAsDash } from '@/lib/view/format'

export function TrendingPrefPanel(): JSX.Element {
  const [on, setOn] = useState(() => trendingPref())
  const beat = previewCreate('starBeat', {})
  if (useStarShape(ACTIVE_NETWORK.v2) === 'fused') {
    return (
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="trending-pref">
        Your stars count toward Trending on Explore for the week they were made. On this network a star carries that week itself, so there is
        nothing to turn off; unstarring takes the star away, but not the week it already counted in. Trending leaves out private repos, and
        your star on a repo of your own while the repo is less than a week old.
      </p>
    )
  }
  return (
    <div className="space-y-2" data-testid="trending-pref">
      <label className="flex items-center gap-2 text-dense coarse:min-h-11">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setTrendingPref(e.target.checked)
            setOn(e.target.checked)
          }}
          data-testid="trending-pref-toggle"
        />
        Count my stars toward Trending
      </label>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        Each new star also writes one small document (about {creditsAsDash(beat.credits)} DASH) that Trending on Explore counts for a week. It
        is not refunded, and unstarring does not remove it; starring the same repo again writes no second one. A star on a repo of your own
        never counts toward Trending, so it writes none.
      </p>
    </div>
  )
}

'use client'

/**
 * Settings → Stars: "Count my stars toward Trending" (platform-parity-spec §4.3). On (the
 * default), a new star also writes a small `starBeat` document that the Explore page's Trending
 * ranks by; off, a star is just the star. Stored in this browser.
 */

import { useState } from 'react'

import { previewCreate } from '@/lib/sdk'
import { setTrendingPref, trendingPref } from '@/lib/repo/trending'
import { creditsAsDash } from '@/lib/view/format'

export function TrendingPrefPanel(): JSX.Element {
  const [on, setOn] = useState(() => trendingPref())
  const beat = previewCreate('starBeat', {})
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
        is not refunded, and unstarring does not remove it; starring the same repo again writes no second one.
      </p>
    </div>
  )
}

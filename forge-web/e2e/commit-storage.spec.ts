import { test, expect } from '@playwright/test'
import { atRoute, collectPageErrors, repoUrl, skipWithoutFixture } from './helpers'
import { quorumGuard } from './quorum-sync'

skipWithoutFixture()
test.beforeEach(quorumGuard)

for (const failure of ['denied', 'quota'] as const) {
  test(`commit history remains usable when session storage is ${failure}`, async ({ page }) => {
    await page.addInitScript((mode) => {
      if (mode === 'denied') {
        Object.defineProperty(window, 'sessionStorage', {
          get() { throw new DOMException('Session storage is disabled', 'SecurityError') },
        })
      } else {
        const setItem = Storage.prototype.setItem
        Storage.prototype.setItem = function (key: string, value: string): void {
          if (this === window.sessionStorage) throw new DOMException('Session storage is full', 'QuotaExceededError')
          setItem.call(this, key, value)
        }
      }
    }, failure)
    const { errors } = collectPageErrors(page)
    await page.goto(repoUrl('commits'), { waitUntil: 'domcontentloaded' })
    const log = page.getByTestId('commit-log')
    await expect(log).toBeVisible({ timeout: 60_000 })
    await log.getByTestId('commit-row').first().getByRole('link').first().click()
    await expect(page).toHaveURL(atRoute(/\/repo\/commit\//))
    expect(errors, errors.join('\n')).toEqual([])
  })
}

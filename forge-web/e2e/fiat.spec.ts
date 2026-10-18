import { test, expect } from '@playwright/test'
import { FIAT_PROVIDER_HOSTS } from '../lib/fiat/providers'

// Read-only and independent of Platform fixtures: all egress is served locally or aborted.
test.beforeEach(async ({ page, baseURL }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return url.origin === baseURL ? route.continue() : route.abort()
  })
})

test('costs show their mainnet equivalent and follow the selected currency', async ({ page }) => {
  const rates: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/__e2e/fiat-rates.json' || FIAT_PROVIDER_HOSTS.some((host) => host === url.hostname)) rates.push(request.url())
  })
  await page.goto('/start/')
  await expect(page.getByTestId('fiat-note').first()).toContainText('on mainnet')
  await expect(page.getByTestId('fiat-note').first()).toContainText('$')
  expect(rates).toHaveLength(1)
  expect(new URL(rates[0]!).pathname).toBe('/__e2e/fiat-rates.json')

  await page.goto('/settings/')
  await page.getByTestId('fiat-currency').selectOption('EUR')
  await expect(page.getByTestId('fiat-provenance')).toContainText('1 DASH ≈ €36.00')
  await page.goto('/start/')
  await expect(page.getByTestId('fiat-note').first()).toContainText('€')
  expect(rates).toHaveLength(1)

  await page.goto('/settings/')
  await page.getByTestId('fiat-enabled').uncheck()
  await expect(page.getByTestId('fiat-note')).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('forge:fiat-rates:v1'))
  rates.length = 0
  await page.goto('/start/')
  await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible()
  await expect(page.getByTestId('fiat-note')).toHaveCount(0)
  expect(rates).toEqual([])
})

test('prices off before hydration makes no rate request', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('forge:fiat:v1', JSON.stringify({ v: 1, enabled: false, currency: 'USD' }))
  })
  const requests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/__e2e/fiat-rates.json' || FIAT_PROVIDER_HOSTS.some((host) => host === url.hostname)) requests.push(request.url())
  })
  await page.goto('/settings/')
  await expect(page.getByTestId('fiat-enabled')).not.toBeChecked()
  await page.goto('/start/')
  await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible()
  await expect(page.getByTestId('fiat-note')).toHaveCount(0)
  expect(requests).toEqual([])
})

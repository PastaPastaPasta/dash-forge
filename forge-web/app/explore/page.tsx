import { ExploreClient } from './client'

/**
 * `/explore[?q=]` — search repos by name, most starred, recently updated, recent, and "mine".
 * No page-level Suspense: the client reads the query string only inside its search section,
 * so the static HTML is the real page shell and focus (the skip link) survives hydration.
 */
export default function ExplorePage(): JSX.Element {
  return <ExploreClient />
}

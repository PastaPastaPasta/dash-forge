import { notFound } from 'next/navigation'
import { DocsView } from '@/components/docs/docs-view'
import { DOC_PAGES, docBySlug } from '@/lib/docs/catalog'
import { readDoc } from '@/lib/docs/source'

/** `/docs/<slug>/` — one listed document from the repository's `docs/`, rendered at build time. */
export const dynamicParams = false

export function generateStaticParams(): { slug: string }[] {
  return DOC_PAGES.filter((p) => p.slug !== '').map((p) => ({ slug: p.slug }))
}

export default function DocPage({ params }: { params: { slug: string } }): JSX.Element {
  const page = docBySlug(params.slug)
  if (page === undefined || page.slug === '') notFound()
  const { title, body } = readDoc(page)
  return <DocsView slug={page.slug} title={title} body={body} />
}

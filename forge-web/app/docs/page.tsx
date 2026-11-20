import { DocsView } from '@/components/docs/docs-view'
import { DOCS_INDEX } from '@/lib/docs/catalog'
import { readDoc } from '@/lib/docs/source'

/** `/docs/` — the user guides' index (docs/guides/README.md), rendered at build time. */
export default function DocsIndexPage(): JSX.Element {
  const { title, body } = readDoc(DOCS_INDEX)
  return <DocsView slug={DOCS_INDEX.slug} title={title} body={body} />
}

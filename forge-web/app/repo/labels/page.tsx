import { QueryPage } from '@/components/route-loading'
import { LabelsClient } from './client'

/** `/repo/labels?owner=&name=` — the repo's labels: list, create, edit, delete (QW-019). */
export default function LabelsPage(): JSX.Element {
  return (
    <QueryPage wide>
      <LabelsClient />
    </QueryPage>
  )
}

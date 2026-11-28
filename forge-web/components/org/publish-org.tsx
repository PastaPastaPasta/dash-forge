'use client'

import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { DEFAULT_NETWORK, NETWORKS } from '@/lib/constants'
import { declaresRoster, publishRequest } from '@/lib/org/actions'
import { orgNetworkName } from '@/lib/org/gate'
import { orgWriteScope } from '@/lib/org/transport'
import { orgPortFor, type OrgView } from '@/lib/org/service'
import { readProfile } from '@/lib/repo/profile'
import { useOrgRequester } from './use-org-requester'

const writesOrgOrProfile = (r: OrgView['requests'][number]): boolean => r.proposals.some((p) => p.decoded?.documentType === 'org' || p.decoded?.documentType === 'profile')

/**
 * "Publish organization" (§10.5): shown to a member while the organization has no current roster
 * on Platform or its profile does not declare it, and no request to publish it is open.
 */
export function PublishOrg({ view }: { view: OrgView }): JSX.Element | null {
  const { sdk, ready } = useSdk()
  const guard = useWriteGuard()
  const org = useOrgRequester(view.record.orgId)
  const [confirming, setConfirming] = useState(false)
  const [published, setPublished] = useState(false)
  const forge = NETWORKS[DEFAULT_NETWORK].v2
  const network = orgNetworkName()
  const { roster, record } = view
  const landedPublish = view.requests.filter((r) => r.status === 'done' && writesOrgOrProfile(r)).length
  const profile = useAsync(() => readProfile(sdk!, forge!, record.orgId), [record.orgId, ready, roster.source, landedPublish], { enabled: ready && sdk !== null && forge !== null })
  const pending = view.requests.some((r) => (r.status === 'collecting' || r.status === 'ready') && writesOrgOrProfile(r))
  const declared = declaresRoster(profile.data?.fields.links ?? [], network, roster)
  if (forge === null || published || view.reconnect || view.unreadLogs > 0 || !profile.settled || profile.error !== null || pending || (roster.source === 'org' && declared)) return null
  const size = record.members.length
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="org-publish">
      <p className="text-dense text-anvil-700 dark:text-anvil-200">
        Publish {record.label} so visitors see it as an organization and members can sign on any device.
      </p>
      <Button
        variant="primary"
        onClick={() => {
          if (guard.check(org.cost(2), orgWriteScope(forge), 'publish the organization')) setConfirming(true)
        }}
        data-testid="org-publish-start"
      >
        Publish organization
      </Button>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Publish ${record.label}?`}
        description={`This asks the members to sign two writes: the organization's roster on Platform, and a link on its profile that says it is ${roster.threshold} of ${size}. Once ${roster.threshold} members sign, visitors see “Organization · ${roster.threshold} of ${size}”.`}
        cost={org.cost(2)}
        confirmLabel="Sign & ask co-signers"
        request
        onConfirm={async (intent) => {
          if (!(await org.submit((s) => publishRequest(s, forge, orgPortFor(s, forge), roster, network, record.label), intent))) setPublished(true)
        }}
      />
      {org.dialog}
    </section>
  )
}

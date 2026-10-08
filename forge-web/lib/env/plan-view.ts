/**
 * The sentences of a member change's environment plan and of what it did (DESIGN §10 "Role-change
 * plan", "Removing a member"; dg `collab add|remove` prints the same facts). `name` is how the
 * page names an identity (its DPNS name, else a short id). Pure: vitest pins them.
 */

import { ROLE_NOUN } from '../rules/roles'
import { creditsAsDash } from '../view/format'
import { audienceLabel } from './format'
import type { MemberChange, MemberEnvPlan, SaveOutcome } from './member-change'
import type { NotUpdated, Pin } from './regroup'
import { changeSummary } from './edit'
import { count } from './view'

type Name = (id: string) => string

/** "staging, ci" */
function list(envs: readonly string[]): string {
  return envs.join(', ')
}

/** The environments a plan saves again whose readers gain or lose `member`. */
export function accessOf(plan: MemberEnvPlan): { readonly gains: string[]; readonly loses: string[] } {
  const m = plan.change.member
  const pins = [...plan.first, ...plan.removal, ...plan.regroup]
  return {
    gains: [...new Set(plan.regroup.filter((p) => p.added.includes(m)).map((p) => p.env))],
    loses: [...new Set(pins.filter((p) => p.gone.includes(m)).map((p) => p.env))],
  }
}

/**
 * The plan's headline (DESIGN §10): "Adding dana as a writer gives them access to 2 environments:
 * staging, ci. Saving them again costs about 0.004 DASH." `null` when it saves nothing.
 */
export function planHeadline(plan: MemberEnvPlan, name: Name): string | null {
  const saves = plan.first.length + plan.removal.length + plan.regroup.length
  if (saves === 0) return null
  const who = name(plan.change.member)
  const { gains, loses } = accessOf(plan)
  const parts: string[] = []
  const c: MemberChange = plan.change
  if (gains.length > 0) {
    const doing = c.kind === 'grant' ? `Adding ${who} as ${ROLE_NOUN[c.role]}` : c.kind === 'change' ? `Making ${who} ${ROLE_NOUN[c.to]}` : `This`
    parts.push(`${doing} gives them access to ${count(gains.length, 'environment')}: ${list(gains)}.`)
  }
  if (loses.length > 0) {
    parts.push(`${who} can no longer read ${loses.length === 1 ? loses[0] : `${count(loses.length, 'environment')} (${list(loses)})`} once it's saved again without them.`)
  }
  parts.push(`Saving ${saves === 1 ? 'it' : `${count(saves, 'environment')}`} again costs about ${creditsAsDash(plan.credits)} DASH.`)
  return parts.join(' ')
}

/** One planned save, values never shown. */
export function pinLine(p: Pin, name: Name): string {
  switch (p.why.kind) {
    case 'regroup': {
      const changes = [...p.added.map((a) => `adds ${name(a)}`), ...p.gone.map((g) => `takes out ${name(g)}`)]
      return `${p.env} (${audienceLabel(p.audience)}): saved again for the people it covers${changes.length > 0 ? `, ${changes.join(', ')}` : ''}.`
    }
    case 'theirs':
      return `${p.env}: saved again as you with the values ${name(p.why.member)} last saved (${audienceLabel(p.audience)}). Their change: ${changeSummary(p.why.changes)}. Values are not shown.`
    case 'chain':
      return `${p.env}: saved again as you, unchanged, so its history stays in one piece without ${name(p.why.member)}.`
    case 'conflict':
      return `${p.env} has versions saved at the same time; ${name(p.why.member)}'s is saved again as you so it stays one of them. Values are not shown.`
    case 'promotion':
      return `${p.env}: ${name(p.why.member)}'s earlier changes would replace its values, so it's saved first with its current values, which stay.`
  }
}

/** An environment a change affects that can't be saved from here ("not updated: ask @x"). */
export function notUpdatedLine(n: NotUpdated, name: Name): string {
  switch (n.kind) {
    case 'conflict':
      return `${n.env}: not updated: it has versions saved at the same time. Keep one, then save it again.`
    case 'unreadable':
      return `${n.env}: not updated: you can't read its latest change. Ask ${name(n.author)} to save it again.`
    case 'onlyRemoved':
      return `${n.env}: not updated: it is only for ${name(n.member)}. Give it another audience.`
    case 'tooMany':
      return `${n.env}: not updated: ${audienceLabel(n.audience)} is ${n.n} people. An environment can be shared with at most 64. Choose a smaller group or specific people.`
    case 'tooLarge':
      return `${n.env}: not updated: its values for ${n.n} people don't fit one save. Split it, or share it with fewer people.`
    case 'hidden': {
      const ask = n.authors.length === 0 ? 'a maintainer' : n.authors.map(name).join(', ')
      return n.removed !== null
        ? `${name(n.removed)} may be able to read ${count(n.n, 'environment')} you can't open. Ask ${ask} to save ${n.n === 1 ? 'it' : 'them'} again without ${name(n.removed)}.`
        : `${count(n.n, 'environment')} you can't open ${n.n === 1 ? 'is' : 'are'} not updated. Ask ${ask}.`
    }
    case 'cannot':
      return `${n.env}: it changes, and you can't read it, so you can't save it first. Ask a maintainer who can read it.`
    case 'appeared':
      return `${n.env}: ${name(n.member)} saved it while not a maintainer; it appears once the role lands.`
  }
}

/** One line of what the saves after the change did. */
export function outcomeLine(o: SaveOutcome, name: Name): string {
  switch (o.kind) {
    case 'saved': {
      const skipped = o.skipped.length === 0 ? '' : ` ${o.skipped.map(name).join(', ')} ${o.skipped.length === 1 ? 'has' : 'have'} no encryption key and can't read it.`
      return `Saved ${o.env} again (${o.audience}, sent to ${o.to === 1 ? '1 person' : `${o.to} people`}).${skipped}`
    }
    case 'moved':
      return `${o.env} changed after the plan was shown, so it wasn't saved. Check it, then save it again.`
    case 'failed':
      return `Couldn't save ${o.env} again: ${o.reason}. Save it again from Settings → Environments.`
    case 'unread':
      return `${o.reason}. Save the environments again from Settings → Environments.`
  }
}

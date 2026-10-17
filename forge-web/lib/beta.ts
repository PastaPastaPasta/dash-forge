/**
 * Which features are beta (MIXE-09): the one place that decides. A beta feature works and is
 * exercised live, but its edges are rougher than the core of members-only content, so its
 * surface wears a {@link BetaBadge} (`components/ui/beta-badge.tsx`) and the guide lists it under
 * "Known limitations" (docs/guides/collaborating.md). Shipping as normal, with no badge: members-only
 * discussion on public repos, private-only repos, letters and role groups, maintainer bundles and
 * an author's make-public, environments, and members-only branches and PRs with `dg publish`.
 *
 * The keys are the phases of the mixed-visibility design (DESIGN rev 4.2 section 9). Removing a
 * key here, with its badges, is all it takes to graduate a feature.
 */

export const BETA_FEATURES = {
  /** 3F: a branch only some members can read. */
  narrowerBranches: 'Narrower branches',
  /** 3G: sharing a members-only branch with people outside the members (dg only). */
  branchSharing: 'Branch sharing',
  /** 4A: bots and runners with their own access to members-only content. */
  bots: 'Bots and runners',
  /** 4B: the access notice a bot's access is read from, and read letters. */
  accessNotices: 'Access notices and read letters',
  /** 4C: asking an agent bot to work on an issue or pull request. */
  agents: 'Agents',
  /** 4D/4E: a bot's push access to branches. */
  botPushGrants: 'Bot push access',
  /** 5A/5B: making the whole repo public, with Code only or Everything. */
  makeRepoPublic: 'Make this repo public',
  /** 5C: a publication date for an issue or pull request. */
  embargo: 'Publication dates',
} as const

export type BetaFeature = keyof typeof BETA_FEATURES

/** Whether `feature` is beta. Every key of {@link BETA_FEATURES} is. */
export function isBeta(feature: string): feature is BetaFeature {
  return Object.prototype.hasOwnProperty.call(BETA_FEATURES, feature)
}

/** The badge's tooltip (also its accessible description). */
export const BETA_TOOLTIP = 'Beta: works, but expect rough edges; see Known limitations'

/** The names of the beta features, in registry order (the guide's list is checked against it). */
export function betaFeatureNames(): readonly string[] {
  return Object.values(BETA_FEATURES)
}

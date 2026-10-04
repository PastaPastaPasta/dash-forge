import { REPO_URL } from './build-info'

/**
 * Where the user guides live (QA wave bonsia, QW-013): `docs/guides/` in the source repository,
 * rendered by GitHub. Forge hosts nothing itself, so the in-app "Getting started" page (`/start`)
 * explains the basics and links here for the rest.
 */

const GUIDES = `${REPO_URL}/blob/master/docs/guides`

export const DOCS = {
  /** The guides' index. */
  guides: `${GUIDES}/README.md`,
  quickStart: `${GUIDES}/quick-start.md`,
  identity: `${GUIDES}/identity-and-keys.md`,
  costs: `${GUIDES}/costs.md`,
  movingFromGithub: `${GUIDES}/moving-from-github.md`,
  storage: `${GUIDES}/bring-your-own-storage.md`,
  mirror: `${GUIDES}/mirror-a-github-repo.md`,
  /** Which rules Dash Platform enforces and which the Forge apps apply (the EnforcedBy chip). */
  enforcement: `${GUIDES}/collaborating.md#who-enforces-what`,
  /** What the move to a new devnet (bonsia to sakura) loses and keeps, and how to re-push (the devnet notice). */
  devnetMove: `${GUIDES}/devnet-move.md`,
} as const

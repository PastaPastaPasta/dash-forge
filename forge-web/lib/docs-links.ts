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
} as const

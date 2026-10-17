/**
 * What the browser cannot do in a private repo yet (FEAT-20): the sealed pack writer is `dg`'s, so a
 * merge, a branch commit, Update branch and applying a suggestion need `dg`. Reading, reviewing,
 * issues and pull requests all work here. One place, so the create flow and the merge box say the
 * same thing as docs/guides/collaborating.md ("From the web app").
 */

/** The create flow's line, before the repo exists. */
export const PRIVATE_BROWSER_LIMITS =
  'In the browser you can read, review and discuss a private repo. Merges, branch commits, Update branch and applying suggestions need dg.'

/** The merge box's reason (replaces the merge button for a private repo). */
export const PRIVATE_MERGE_REASON =
  'Private repositories are merged with dg pr merge for now. Branch commits, Update branch and applying suggestions need dg there too.'

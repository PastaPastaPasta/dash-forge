# Security policy

Dash Forge holds keys that can spend DASH and read sealed repositories, so we treat security reports as our first priority.

## Report a vulnerability privately

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/PastaPastaPasta/dash-forge/security/advisories/new)). Only the maintainers can read the report.

Please do not open a public issue, pull request or Forge issue for a vulnerability, and do not post it in chat. Issues on Forge are public and permanent: they cannot be deleted from chain history.

Include what you can of:

- what an attacker gains, and what they need first (a malicious page, a member role, a compromised host);
- the component and version: `dg --version`, or **About this build** in the web app's footer;
- steps to reproduce, ideally on devnet sakura with identities you created for the test;
- any proof of concept. Never send real recovery phrases, identity files or private keys, yours or anyone else's.

We reply within 3 working days, agree a disclosure date with you, and credit you in the advisory unless you ask us not to.

## Supported versions

Forge has not reached 1.0. We fix security issues on `master` and in the latest release. Older releases get no fixes: upgrade instead.

## In scope

- **Keys**: identity and limited keys in `dg`, `git-remote-dash` and the OS keychain; keys held by the web app in the browser; the CLI-to-browser key handoff; any path that leaks a key, a recovery phrase or a webhook secret.
- **Private repositories**: the sealing of packs, refs, issues, pull requests and releases, key epochs and rotation, and anything that lets a non-member read sealed content ([private-repos.md](docs/security/private-repos.md)).
- **Proof checks**: anything that makes the web app or `dg` show data as verified when Platform did not prove it ([verify-forge.md](docs/guides/verify-forge.md)).
- **Client rules**: a way to make a reader accept a merge, approval, protected-ref update, release or role change that the rules in [forge-v2.md](docs/contracts/forge-v2.md) refuse.
- **The web app as served**: script injection, framing, or a build at forge.dashhq.org that differs from the published one ([verify-the-app.md](docs/guides/verify-the-app.md)).
- **forge-relay, forge-import and forge-runner**: secret handling, server-side request forgery, and escape from a runner's sandbox.

## Out of scope

- Bugs in Dash Platform, Dash Core, the Platform SDKs or DAPI nodes. Report those to Dash Core Group, which maintains them in [dashpay/platform](https://github.com/dashpay/platform).
- Spam and abuse that the protocol allows by design, such as paid issues on a public repository. Report missing reader-side defences as ordinary issues.
- Denial of service against a public devnet, faucet or DAPI node.
- Findings that need a compromised operating system, browser or storage provider you chose, unless Forge could reasonably have detected it.
- Reports from automated scanners with no demonstrated impact.

## Testing safely

Test on devnet sakura with identities and repositories you created yourself. Do not write to repositories you do not own, and do not try to read other people's private repositories.

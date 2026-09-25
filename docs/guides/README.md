# User guides

Task-oriented guides for using Dash Forge. For how it is built, see the [document index](../../README.md#document-index).

| Guide | Read it when you want to… |
|---|---|
| [Quick start](quick-start.md) | install, get an identity, create a repository, push, and see it on the web |
| [Mirror a GitHub repository](mirror-a-github-repo.md) | keep a copy of a GitHub repository that nobody can take down |
| [Bring your own storage](bring-your-own-storage.md) | keep pack bytes in your own R2, B2, S3, MinIO or IPFS instead of on Platform |
| [Collaborating](collaborating.md) | add collaborators, work with issues, pull requests and releases |
| [Identity and keys](identity-and-keys.md) | understand your identity, back it up, and keep keys safe |
| [What things cost](costs.md) | know what you pay, what comes back, and how to see it before you pay |
| [Check that Forge isn't lying to you](verify-forge.md) | verify proofs, hashes and the web app yourself |

Also:

- [FAQ](../FAQ.md): who hosts it, takedowns, moderation, mainnet timing, private repositories.
- [Error codes](../errors.md): what every `[Exxx]` means and how to fix it.
- [Installing](../INSTALL.md) and [building from source](../BUILDING.md).

## What "coming soon" means

These guides describe what is on `master` today. Features that are specified but not built yet are marked **Coming soon**, and nothing marked that way works yet. forge-v2 behavior is described as planned. Its contracts are registered on devnet moutai, but `dg`, `git-remote-dash`, `forge-import` and the web app still create and use v1 repositories only. Client support is being built now, and forge-v2 comes to mainnet after Platform protocol 14 activates. When it lands on moutai, the forge-v2 notes in these guides become instructions.

The product specification the planned features come from (`docs/design/ux-dx-spec.md` and `docs/roadmap.md`) is not on `master` yet.

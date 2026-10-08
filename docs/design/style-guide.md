# Dash Forge — Style Guide

Two halves: visual design system (forge-web) and engineering conventions (all packages).

## A. Visual design

### Direction
"Foundry, not startup SaaS." A code-forward, quietly industrial aesthetic: dense information, warm dark metals + ember accent, zero decorative gradients. Must not read as a GitHub clone or a Tailwind template — but must feel instantly familiar to git users.

### Design tokens (Tailwind config)

```js
colors: {
  forge: {  // ember/molten accent ramp (primary)
    50:'#fff7ed',100:'#ffedd5',200:'#fed7aa',300:'#fdba74',400:'#fb923c',
    500:'#f97316',600:'#ea580c',700:'#c2410c',800:'#9a3412',900:'#7c2d12',950:'#431407'
  },
  anvil: {  // neutral ramp, warm-tinted grays (bg/surfaces/text)
    50:'#fafaf9',100:'#f5f5f4',200:'#e7e5e4',300:'#d6d3d1',400:'#a8a29e',
    500:'#78716c',600:'#57534e',700:'#44403c',750:'#3a3835',800:'#292524',850:'#211e1c',900:'#1c1917',950:'#0f0d0c'
  },
  verify: {            // proof/hash verified
    DEFAULT:'#16a34a', // icons, borders, tints
    400:'#22c55e',     // TEXT on dark surfaces and dark tints
    700:'#16713a'      // TEXT on light surfaces and tints; solid fill behind white text
  },
  caution: {           // degraded availability
    DEFAULT:'#d97706', // icons, borders, tints only
    400:'#f59e0b',     // TEXT on dark
    700:'#a14a08'      // TEXT on light
  },
  danger: {            // force-push, delete, failed verification
    DEFAULT:'#dc2626', // icons, borders, tints
    400:'#f87171',     // TEXT on dark
    700:'#b91c1c'      // TEXT on light
  },
  dash: {              // Dash brand blue — reserved for identity/credits/network UI only
    DEFAULT:'#008de4', // fills, tints, icons
    400:'#4aaef0',     // TEXT on dark surfaces
    600:'#006bb0',     // TEXT on light surfaces
    700:'#005a94'      // solid fill behind white text
  }
}
```
- **Dash-blue text is `text-dash-600 dark:text-dash-400`**, never plain `text-dash`: the brand value is under WCAG AA's 4.5:1 as text on every surface in both themes (4.28:1 on `anvil-800`). `forge-web/lib/design/contrast.test.ts` pins the ratios and fails on a raw `text-dash` that is not an icon.
- **Every text colour is a light/dark pair**, never a bare semantic or ember value: `text-{verify|caution|danger}-700 dark:text-{…}-400`, `text-forge-700 dark:text-forge-400` for links (`text-forge-800` on an ember tint), and `text-anvil-500 dark:text-anvil-400` for muted text (`anvil-400` is 2.4:1 as light text). Pairs are checked on the plain surfaces *and* on their own 5–15 % tints (chips, note boxes, the network badge). The same test fails on a light-theme text class it has measured under AA, outside an `aria-hidden` icon.
- **White text sits on `-700` fills**: `bg-dash-700`, `bg-verify-700`, `bg-forge-700`, and a hover darkens (`hover:bg-forge-800`) rather than brightens. The base `dash` (3.54:1) and `verify` (3.3:1) values and `forge-600` (3.56:1) fail AA behind white. The same test checks every `bg-*` (hover:/dark: variants included) behind `text-white`, and fails on any fill it cannot resolve. The identicon fill is darkened per hue until it clears 4.5:1 against white (`lib/design/avatar.ts`).
- **Dark mode is the primary theme** (class-based, `next-themes`); light mode fully supported. Backgrounds: `anvil-950/900/850` layered surfaces (dark), `anvil-50/white` (light).
- Semantic colors are *meaningful*, never decorative: green = cryptographically verified, amber = availability risk, red = destructive/unverified, dash-blue = platform identity & credits. Don't repurpose.
- **Theme tokens.** New colour roles are CSS variables in `forge-web/app/globals.css` (`:root` for light, `.dark` for dark), exposed to Tailwind as `rgb(var(--name) / <alpha-value>)`, so one class serves both themes with no `dark:` twin. The contrast test reads both blocks and checks every pair. Today: `--focus`, `--state-*`, `--fg-muted`, the diff tints (`--diff-*`), the syntax colours (`--syn-*`) and `--line-highlight`.
- **Issue and PR states are not trust colours.** Use `STATE_TEXT` / `STATE_FILL` from `forge-web/lib/design/state.ts`: open green, merged and completed violet, closed PR red, draft and not planned grey, as on GitHub. Never `verify`, `danger`, `dash` or the ember accent for a state. Each state also has its own icon.
- **The accent means "act here".** Ember is for links, primary actions, selection, focus and the current tab. Decorative icons (folders, menu and section icons, an empty state's disc) use `text-fg-muted` (and `bg-surface-raised`); inline code is body text on a sunken chip.
- **Code and diffs.** Syntax colours are the `--syn-*` tokens; keywords have their own violet, never the ember accent (an ember word reads as a link). A selected line or range is `bg-line-highlight/15` (an accent tint), not amber. Diff rows use the `diff-add` / `diff-del` classes: a tint (10 % light, 16 % dark), a 2 px edge in the marker colour, the changed words marked a step stronger, and the `+`/`−` markers always shown; the table's `data-diff-palette` picks standard or blue/orange. The contrast test checks every syntax colour on every row and word tint, in both palettes and themes. Side-by-side cells wrap at word boundaries (`overflow-wrap: anywhere`), never `break-all`.

### Typography
- UI: system stack (`-apple-system, Segoe UI, Roboto, …`) — fast, no font payload.
- Code/OIDs/hashes/CIDs: `ui-monospace, SFMono-Regular, JetBrains Mono, Menlo` — monospace is a first-class citizen; OIDs always mono, 7-char abbreviated, click-to-copy full.
- Scale: 13px base for dense surfaces (file lists, commit log), 15px prose (README, issues); headings 1.25 ratio, semibold not bold.

### Layout & components
- Max content width 1280px; repo pages: left = content, right 296px rail (metadata, verification panel, storage health). Code pages (file, blame, commit, compare, a pull request) have no rail: the code gets the full width. File, blame and commit pages lead with the Verification card of the code they show, collapsed to one line; compare shows the head's card once both refs resolve. Every repo tab starts at the repo header's left edge (no `mx-auto` columns), so switching tabs never moves the content; a narrow form may cap its width, left-aligned.
- Radix primitives wrapped in `components/ui/` (yappr/shadcn conventions: `clsx` + `tailwind-merge` + CVA variants).
- Density: tables/lists at 36px rows; generous only around prose.
- Iconography: Lucide, 16px inline / 20px nav; git-specific glyphs (branch, tag, commit) used consistently.
- Motion: 150ms ease-out enter/fade only (yappr keyframes); no scroll-jacking, no skeleton shimmer > 1 s (show cached data + refresh instead).

### Signature elements
1. **Verification chip** — every repo view carries a compact chip row: `refs ✓ proof · packs ✓ sha256 · src: platform/ipfs/s3`. Colors per semantic palette. Clicking opens the trust panel explaining the verification chain.
2. **Cost preview** — any write button shows cost inline before signing, **DASH primary, USD secondary** (`~0.0003 DASH ≈ $0.01`); destructive deletes show refund estimate in green. Running spend surfaced in settings.
3. **Identity pill** — identicon + DPNS name + short identity id; consistent everywhere an owner/author appears. The identicon is drawn from SHA-256 of the whole id, never from the profile's own picture, and the id shows its first 7 and last 5 characters (`G6D3ejK…7nB2q`, `shortId`), as the Dash wallets' approval screens do: an identity id is a hash an attacker can grind until its prefix matches someone else's, so a prefix alone never identifies anyone. Anywhere else a raw identity or document id is shown in text, it uses the same 7…5 form. On an issue or pull request, each author carries a role badge (Owner, Maintain, Write, Triage, Read; Bot for an automated account) from the repository's current membership documents.
4. **Backend badge** — `platform` (Lucide `Link2`), `ipfs` (`Globe`), `s3`/`https` (`HardDrive`), `mixed` (`Link2` + `Globe`) on repo headers and clone box. Line icons, never emoji (they render differently per OS).

### Accessibility
- WCAG 2.1 AA contrast in **both** themes (validate ember-on-dark combos); all interactive elements keyboard-reachable with visible `:focus-visible` ring (the `--focus` token: forge-700 on light, forge-400 on dark, 3:1 or more on every surface); diff colors pass for color-blind users (blue/orange diff option, which also recolors the A/D file letters); `prefers-reduced-motion` kills all animation.
- Keyboard: a "Skip to content" link is the first Tab stop; `/` focuses the jump box; modals (`components/ui/dialog.tsx`) move focus to their `autoFocus` field, trap Tab/Shift+Tab, answer Escape, and return focus to the opener. Scroll containers (code, diffs, wide tables) use `ScrollRegion`, which joins the Tab order only while it overflows.
- Theme: the header toggle cycles system → dark → light; Settings → Appearance (signed out too) offers the same three plus the diff choices. Persisted (`localStorage.theme`) and applied before first paint. Test the light theme by setting that key, not by emulating `prefers-color-scheme`. `e2e/a11y.spec.ts` runs axe on every route in both themes.

## B. Engineering conventions

### Rust (forge-core, git-remote-dash, dg, forge-relay, forge-import)
- One cargo workspace; edition 2021+; `clippy -D warnings`, `rustfmt` CI-enforced; `#![forbid(unsafe_code)]` outside vetted FFI.
- Depend on rs-sdk/rs-dpp workspace-pinned to a Platform release tag; SDK touched only inside `forge-core::platform` (PlatformClient) — binaries consume forge-core services.
- Errors: `thiserror` taxonomy mirroring the product error classes (insufficient credits → bridge link, not a member (write refused at consensus), timeout-retryable…); every user-facing failure maps to an actionable message.
- All Platform writes via WriteEngine (idempotent ST lifecycle + journal); no ad-hoc document creation.
- Secrets: OS keychain/agent only; no WIF/mnemonic in logs, journals, or `Debug` impls (newtype with redacted Debug).

### TypeScript (forge-web)
- Inherited from yappr `CLAUDE.md`: `strict: true`; **no `any`, no `@ts-ignore`, no `eslint-disable`** (CI-enforced); ESM only.
- **Zero backend**: no `/api` routes, no SSR, no dynamic route segments; query-param routing.
- Zod schemas at every trust boundary: documents read from Platform are *parsed, not cast*.
- Heavy work (materialization, search indexing, pack assembly) in web workers; main thread renders.

### Cross-language parity
- Ref-resolution / event-fold / cost rules exist twice (Rust + TS) by necessity → both implement `FORGE_RULES_V2` against **shared JSON conformance vectors** (`forge-contracts/vectors/`); CI runs both suites on every vector change.
- Every list read: index-backed orderBy + cursor pagination; never assume < 100 results.
- Constants (contract IDs, fee schedule) generated from `forge-contracts/deployments/*.json` into both languages.

### Repo layout (monorepo)
```
crates/
  forge-core/        # platform/, pack/, backends/, rules/, cost/, keystore/
  git-remote-dash/   # helper bin
  dg/              # CLI bin (clap; gh-style aliases)
  forge-relay/       # webhook daemon
  forge-import/      # importer (Forgejo-semantics mapping)
forge-contracts/     # forge-v2 contract JSON (forge-core, forge-collab), deploy-v2 + fixture scripts, deployments/, vectors/
forge-web/           # Next.js static app (pnpm)
spikes/              # Phase 0 throwaway prototypes
```

### Quality gates
- CI: cargo test/clippy/fmt + TS typecheck/lint/vitest + the copy lint (`pnpm lint:copy`, section C) + builds on every PR; devnet (sakura) integration suite nightly + pre-release (see e2e plan).
- Conventional commits; PRs small and single-purpose.
- Logging: `tracing` (Rust) / `debug` namespaces (TS); helper honors git's `GIT_TRACE` conventions.
- Cost discipline: any code path that broadcasts a state transition must route through CostEngine so estimates/audits never drift from reality.

## C. Voice and tone

Forge sounds like a senior maintainer explaining it to a colleague: plain, exact, brief and calm. Be precise about the three things users must not get wrong (money, permanence and who can see it) and quiet about everything else. Don't narrate the architecture in the UI. The docs are where it is explained.

### Rules

1. **Lead with the outcome, not the mechanism.** Write "You'll be its maintainer", not "Writes the repo document, makes you its first maintainer".
2. **Help text is two sentences and about 25 words at most.** No UI string may pass 40 words (the copy lint fails it). Anything longer becomes a link to the docs.
3. **One idea per sentence.** No semicolons in UI or CLI copy. Colons only before a value or a list. At most one parenthetical per string. Prefer a period to an em dash.
4. **Active voice, second person, present tense.** "You weren't charged", not "Nothing was charged".
5. **Say each fact once per screen.** One banner, not a note under every card.
6. **Numbers.** Round prices to one or two significant figures with "about" ("about 0.005 DASH"). Exact figures belong in the confirm dialog and `dg cost`. Never print a tilde with eight decimals.
7. **Enforcement** gets the `EnforcedBy` chip (`components/ui/enforced-by.tsx`), not prose. Its two labels are "Enforced by Dash Platform" and "Forge apps enforce this", and it links to [Who enforces what](../guides/collaborating.md#who-enforces-what).
8. **Errors have three beats:** what happened, whether you were charged, what to do next. A Platform error code goes last ("Error code 10422."), only when no sentence explains the refusal. In `dg` it goes on the `detail:` line.
9. **Empty states** say what will appear and how to make it appear. Titles are five words or fewer, with no period.
10. **Case.** Sentence case for headings, buttons and menu items, with no periods. Help text and errors take periods.
11. **CLI help.** A command's `about` is an imperative phrase of eight words or fewer ("Create a repo"). Details go in `long_about` or the docs. Pluralise with a helper, never `(s)`.
12. **Don't defend the design.** Write "Cloning needs git-remote-dash", not "No https clone URL: that needs a git server, and Forge runs none."

### Tone by moment

| Moment | Tone | Example |
|---|---|---|
| First visit | Confident and concrete | "Git hosting with no server. Your browser verifies what it shows." |
| Spending | Exact and neutral | "Create repo · about 0.002 DASH" |
| Irreversible action | Direct, no softening | "Repo names are permanent." |
| Waiting on the network | Calm, specific about time | "Waiting for your deposit. This can take a few minutes." |
| Failure | Short, blameless, actionable | "Someone changed this while you were editing. Reload and try again." |
| Verification | Factual, no hype | "Verified · 214 files checked" |

### Banned in UI strings and `dg --help`

The copy lint (`forge-web/scripts/copy-lint.mjs`, run in CI as `pnpm lint:copy`) and the `dg --help` snapshot test enforce this list. Keep the three in step.

- **Release and contract-set names:** RC1, RC2, forge-v2, PV14, "protocol 14".
- **Tracker ids:** QW…, D-…, P1-…, §.
- **Code identifiers:** `FORGE_RULES_V2`, `objectLocator`, `packManifest`, `starBeat`, `headUpdate`, `forkOf`, `asMember`, `asMaintainer`, `authorEvent`.
- **Protocol jargon:** fold, consensus, client rule, Forge clients, document.
- **Banned phrases:** "Platform refused it", "Nothing was charged", proof-checked, hash-checked, recovery words, browser key, on chain, on-chain, seamless, leverage, simply.
- **Repository paths:** `docs/….md`, `forge-contracts/`.
- **Formatting tells:** `(s)` plurals, and any string over 40 words.

A string no user reads (a developer error, a log line) opts out with a `copy-lint-ignore: <reason>` comment on its line or one of the two lines above it. A test or script helper opts out as a whole with `// copy-lint-ignore-file: <reason>` as its first line.

### Terminology

| Use | Not | Notes |
|---|---|---|
| **repo** in the UI and CLI help; **repository** at a doc's first mention and in permanent statements | both on one screen | |
| **pull request** in headings, navigation and first mention; **PR** in counts, buttons and inline | patch, MR (except "GitLab merge request" when importing) | |
| **identity**: your Dash identity, which is your account | account (except once: "Your identity is your account") | |
| **sign in** (verb), **sign-in** (noun); **unlock** reopens a key already in this browser | log in, login (except the `dg auth login` command) | |
| **recovery phrase**: the 12 words | recovery words, mnemonic, seed | The `--mnemonic` flag keeps its name; its help says "recovery phrase". |
| **limited key**: the spend-capped key Forge signs with; "this browser's key" only where the location matters | browser key, signing key | |
| **balance**: the identity's DASH; **budget**: what a limited key may still spend | credits as a unit | Show amounts in DASH. |
| **top up** (verb), **top-up** (noun) | Add credits, Add budget | |
| **member**; roles **Read**, **Triage**, **Write**, **Maintain**, **Owner**, **Bot** | collaborator, writer document, reader, writer, maintainer as a role name | `dg collab` keeps its name and its `--role` values; its help says "members" and the role words. |
| **owner**: the identity that created the repo | | |
| **Dash Platform** at first mention, then **Platform** | the chain, on chain, on-chain | "Stored on Platform", "public on Platform" |
| **verified** (Verification card states); **checked** for one check | proved, proof-checked, hash-checked | Proof detail belongs on the Verification card and in the verification guide. |
| **encrypted** | sealed | |
| **audiences**: Public, All members (short: Members), Maintainers, Writers and maintainers, Specific people; **members-only** for anything not public | named, restricted, lane | "Private" only for a private repository. |
| **Publish** (code), **Make public** (a post), **Make this repo public** (a whole private repo) | reveal, disclose, unseal | |
| **access**: what a bot or runner is given | grant (as a noun), key letter | |
| **Turn on members-only content** (a repo); **Set up your encryption key** (an identity) | | |
| **storage**, "your storage", "the owner's storage" | packs, manifests, chunks (outside storage settings and the merge steps) | |
| **branches and tags** | refs (in the UI) | `dg` output and the docs keep "ref" for git users. |
| **devnet sakura** in prose (`networkName()`); badge "Devnet · sakura" | devnet-sakura (the network key) | |
| **Dash Forge** in titles and at first mention, then **Forge** | | |
| **Enforced by Dash Platform** / **Forge apps enforce this** | consensus, client rule, Forge clients | The `EnforcedBy` chip |
| **archived** | read-only mark | |
| **hidden** (moderation) | | |

These terms stay out of the UI and belong to the contract docs: contract, document, document type, fold, consensus, gate, epoch, key letter, lane, wrap, stamp, quorum (except on the Platform-failure screens), DAPI node, transition, RC1, RC2, forge-v2, PV14.

Every PR that changes UI or CLI copy is checked against this section.

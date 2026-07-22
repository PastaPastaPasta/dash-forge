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
  verify: '#16a34a',   // proof/hash verified
  caution:'#d97706',   // degraded availability
  danger: '#dc2626',   // force-push, delete, failed verification
  dash:   '#008de4'    // Dash brand blue — reserved for identity/credits/network UI only
}
```
- **Dark mode is the primary theme** (class-based, `next-themes`); light mode fully supported. Backgrounds: `anvil-950/900/850` layered surfaces (dark), `anvil-50/white` (light).
- Semantic colors are *meaningful*, never decorative: green = cryptographically verified, amber = availability risk, red = destructive/unverified, dash-blue = platform identity & credits. Don't repurpose.

### Typography
- UI: system stack (`-apple-system, Segoe UI, Roboto, …`) — fast, no font payload.
- Code/OIDs/hashes/CIDs: `ui-monospace, SFMono-Regular, JetBrains Mono, Menlo` — monospace is a first-class citizen; OIDs always mono, 7-char abbreviated, click-to-copy full.
- Scale: 13px base for dense surfaces (file lists, commit log), 15px prose (README, issues); headings 1.25 ratio, semibold not bold.

### Layout & components
- Max content width 1280px; repo pages: left = content, right 296px rail (metadata, verification panel, storage health).
- Radix primitives wrapped in `components/ui/` (yappr/shadcn conventions: `clsx` + `tailwind-merge` + CVA variants).
- Density: tables/lists at 36px rows; generous only around prose.
- Iconography: Lucide, 16px inline / 20px nav; git-specific glyphs (branch, tag, commit) used consistently.
- Motion: 150ms ease-out enter/fade only (yappr keyframes); no scroll-jacking, no skeleton shimmer > 1 s (show cached data + refresh instead).

### Signature elements
1. **Verification chip** — every repo view carries a compact chip row: `refs ✓ proof · packs ✓ sha256 · src: ipfs`. Colors per semantic palette. Clicking opens the trust panel explaining the verification chain.
2. **Cost preview** — any write button shows `~0.0003 DASH` inline before signing; destructive deletes show refund estimate in green.
3. **Identity pill** — DPNS name + dicebear avatar (yappr generator) + abbreviated identity id; consistent everywhere an owner/author appears.
4. **Tier badge** — `⛓ platform` / `🌐 external` / `⛓+🌐 hybrid` on repo headers and clone box.

### Accessibility
- WCAG 2.1 AA contrast (validate ember-on-dark combos); all interactive elements keyboard-reachable with visible `:focus-visible` ring (`forge-400`); diff colors pass for color-blind users (blue/orange diff option); `prefers-reduced-motion` kills all animation.

## B. Engineering conventions

Inherited from yappr `CLAUDE.md`, tightened:

### TypeScript
- `strict: true`; **no `any`, no `@ts-ignore`, no `eslint-disable`** (CI-enforced). Prefer discriminated unions + exhaustive switches for document kinds/events.
- ESM only, Node ≥ 18.18. Zod (or valibot) schemas at every trust boundary: document reads from Platform are *parsed, not cast*.

### Architecture rules
- **Zero backend**: no `/api` routes, no SSR, no dynamic route segments in forge-web; anything needing a secret at runtime is CLI-only.
- forge-core is the only package that touches evo-sdk; apps consume services, never the SDK directly.
- All Platform writes go through WriteEngine (idempotent ST pattern) — no ad-hoc `documents.create` calls.
- Every list read: index-backed orderBy + cursor pagination; never assume < 100 results.
- Authorization decisions only via `authz` module (`AUTHZ_RULES_V1`); UI and CLI must not reimplement.
- Constants (contract IDs, limits, fees) live in `forge-core/src/constants.ts` — single source, generated partly from `forge-contracts/deployments/*.json`.

### Repo layout (monorepo)
```
packages/
  forge-contracts/   # contract JSON, deploy scripts, deployments/*.json
  forge-core/        # lib: platform/, git/, storage/, authz/, keystore/, constants.ts
  git-remote-dash/   # helper bin
  forge-cli/         # dforge bin (commander)
  forge-web/         # Next.js app
```
- pnpm workspaces; changesets for versioning; `forge-core` published as the public SDK for third-party tools.

### Quality gates
- CI: typecheck + lint + unit (vitest) + build (all packages) on every PR; testnet integration suite nightly + pre-release (see e2e plan).
- Conventional commits; PRs small and single-purpose.
- Error handling: forge-core error taxonomy (ported from yappr `error-utils.ts`) — every user-facing failure maps to an actionable message (insufficient credits → bridge link; unauthorized → show collaborator rules; timeout → auto-retry state).
- Logging: `debug`-style namespaced (`forge:write`, `forge:pack`, `forge:authz`); helper honors git's `GIT_TRACE` conventions.
- Never log or serialize private keys/WIFs/mnemonics; keystore APIs return opaque signer handles.

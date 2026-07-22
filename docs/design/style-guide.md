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
1. **Verification chip** — every repo view carries a compact chip row: `refs ✓ proof · packs ✓ sha256 · src: platform/ipfs/s3`. Colors per semantic palette. Clicking opens the trust panel explaining the verification chain.
2. **Cost preview** — any write button shows cost inline before signing, **DASH primary, USD secondary** (`~0.0003 DASH ≈ $0.01`); destructive deletes show refund estimate in green. Running spend surfaced in settings.
3. **Identity pill** — DPNS name + dicebear avatar (yappr generator) + abbreviated identity id; consistent everywhere an owner/author appears. Collaborators shown with token-role badge (WRITE/MAINTAIN).
4. **Backend badge** — `⛓ platform` / `🌐 ipfs|s3|https` / `⛓+🌐 mixed` on repo headers and clone box.

### Accessibility
- WCAG 2.1 AA contrast (validate ember-on-dark combos); all interactive elements keyboard-reachable with visible `:focus-visible` ring (`forge-400`); diff colors pass for color-blind users (blue/orange diff option); `prefers-reduced-motion` kills all animation.

## B. Engineering conventions

### Rust (forge-core, git-remote-dash, dgit, forge-relay, forge-import)
- One cargo workspace; edition 2021+; `clippy -D warnings`, `rustfmt` CI-enforced; `#![forbid(unsafe_code)]` outside vetted FFI.
- Depend on rs-sdk/rs-dpp workspace-pinned to a Platform release tag; SDK touched only inside `forge-core::platform` (PlatformClient) — binaries consume forge-core services.
- Errors: `thiserror` taxonomy mirroring the product error classes (insufficient credits → bridge link, frozen token, timeout-retryable…); every user-facing failure maps to an actionable message.
- All Platform writes via WriteEngine (idempotent ST lifecycle + journal); no ad-hoc document creation.
- Secrets: OS keychain/agent only; no WIF/mnemonic in logs, journals, or `Debug` impls (newtype with redacted Debug).

### TypeScript (forge-web)
- Inherited from yappr `CLAUDE.md`: `strict: true`; **no `any`, no `@ts-ignore`, no `eslint-disable`** (CI-enforced); ESM only.
- **Zero backend**: no `/api` routes, no SSR, no dynamic route segments; query-param routing.
- Zod schemas at every trust boundary: documents read from Platform are *parsed, not cast*.
- Heavy work (materialization, search indexing, pack assembly) in web workers; main thread renders.

### Cross-language parity
- Ref-resolution / event-fold / cost rules exist twice (Rust + TS) by necessity → both implement `FORGE_RULES_V1` against **shared JSON conformance vectors** (`forge-contracts/vectors/`); CI runs both suites on every vector change.
- Every list read: index-backed orderBy + cursor pagination; never assume < 100 results.
- Constants (contract IDs, template versions, fee schedule) generated from `forge-contracts/deployments/*.json` into both languages.

### Repo layout (monorepo)
```
crates/
  forge-core/        # platform/, pack/, backends/, rules/, cost/, keystore/
  git-remote-dash/   # helper bin
  dgit/              # CLI bin (clap; gh-style aliases)
  forge-relay/       # webhook daemon
  forge-import/      # importer (Forgejo-semantics mapping)
forge-contracts/     # registry + repo template JSON, deploy scripts, deployments/, vectors/
forge-web/           # Next.js static app (pnpm)
spikes/              # Phase 0 throwaway prototypes
```

### Quality gates
- CI: cargo test/clippy/fmt + TS typecheck/lint/vitest + builds on every PR; testnet integration suite nightly + pre-release (see e2e plan).
- Conventional commits; PRs small and single-purpose.
- Logging: `tracing` (Rust) / `debug` namespaces (TS); helper honors git's `GIT_TRACE` conventions.
- Cost discipline: any code path that broadcasts a state transition must route through CostEngine so estimates/audits never drift from reality.

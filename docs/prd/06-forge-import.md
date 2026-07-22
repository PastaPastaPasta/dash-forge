# PRD 06 — Forge Import

## Goal
`dg import github.com/org/repo` migrates code + issues + PRs + releases + labels + milestones in one command. Launch adoption depends on this.

## Design

- **Mapping layer**: vendor **Forgejo's migration-layer semantics** (the most battle-hardened GitHub importer) — either bind its Go code as a sidecar process or port its mapping tables to Rust. Source APIs: GitHub REST + GraphQL (rate-limit-aware, resumable state file).
- **Git data**: pushed through the normal remote helper (no special path) — pack pipeline, cost journal, resume all apply.
- **Issues/PRs/labels/milestones/releases**: mapped to repo-contract docs. **Closed PRs import as archived patch docs (metadata + diff, not full packs)** to control cost. Milestones → labels + due-date convention (no milestone doc type in template v1).
- **Author mapping**: non-migrated authors become **placeholder author records** (login + avatar snapshot embedded in doc body metadata) with a **signed-claim flow**: prove control of the GitHub account via gist challenge, signed with a Dash identity → clients thereafter render that identity for the placeholder (claim docs in the repo contract; fold rule in `FORGE_RULES_V1`).
- **Cost gate**: importer prints a full cost estimate (per artifact class) and **requires confirmation**; `--max-spend` hard cap; progress + running spend during import.
- **v1.1**: bidirectional mirror mode — keep GitHub as read-only mirror during transition (mirror pushes via gitmirror backend; issue sync one-way GitHub→Forge).

## UX
```
dg import github.com/org/repo [--repo-name X] [--backend mixed] [--skip issues|prs|releases]
                                [--max-spend 2.5dash] [--resume <state-file>] [--dry-run]
```
`--dry-run` = full enumeration + cost estimate, zero writes.

## Acceptance
- Import **dashpay/platform** (large, real repo) with issue/PR fidelity spot-checked (sampled cross-check script comparing GitHub API vs Platform docs: counts, titles, states, comment threads, label sets).
- Total cost matches pre-estimate **within 10%**.
- Interrupt + `--resume` completes without duplicate documents or double fees.
- Gist-claim flow: a claimed placeholder renders as the claiming identity in forge-web and dg.

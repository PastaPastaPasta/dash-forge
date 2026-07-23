//! Migration enumeration + per-class cost estimate (PRD 06 cost gate).
//!
//! The importer enumerates every artifact class up front and routes each through
//! [`forge_core::cost`] so the printed quote and the confirmation gate never drift from the
//! fee schedule the writes actually pay. Git data is sized exactly (the real self-contained
//! pack is built locally and chunked); collaboration docs are sized from their field bytes
//! plus a fixed system-field overhead; comment volume is projected from GitHub's per-issue
//! `comments` counter (bodies are not fetched during enumeration — that would be N extra API
//! calls for a number that only feeds the estimate).

use forge_core::cost::{estimate_document_storage, CostEstimate, CREDITS_PER_DASH};
use forge_core::pack::split;

use crate::github::{GhIssue, GhLabel, GhMilestone, GhPull, GhRelease, RepoMeta};

/// Measured repo-v1 instantiation cost, in credits (~1.18 DASH, EXECUTION.md economics).
/// Only charged when the migration creates a fresh destination repo.
pub const REPO_V1_CREATE_CREDITS: u64 = 118_000_000_000;

/// Serialized system-field + CBOR-map overhead added to each document's property bytes
/// (`$id`, `$ownerId`, `$revision`, `$createdAt`, `$updatedAt`, type tag, map framing).
const DOC_SYSTEM_OVERHEAD: u64 = 180;

/// Per-collab-document index + count-tree storage overhead, in credits — the cost of the
/// secondary-index entries and (for `documentsCountable` types like `issue`/`patch`/
/// `comment`) the O(1) count-tree update, which `forge_core::cost`'s pure per-byte model
/// does not price. **Empirically calibrated** against the M3 live import (15 collab docs
/// measured at 0.004879 DASH vs a 0.001540 DASH per-byte-only estimate → ~22M credits/doc of
/// unmodelled index/count-tree storage). Refundable (it is storage), so it is added to the
/// deposit side. Git `chunk`/`packManifest` writes carry only a light unique index and are
/// priced by bytes alone (they never touch a count tree).
const COLLAB_INDEX_OVERHEAD_CREDITS: u64 = 22_000_000;

/// Projected average serialized size of one imported comment (body + anchors + provenance).
const AVG_COMMENT_BYTES: u64 = 280;

/// A single migration artifact class and its aggregate cost.
#[derive(Debug, Clone)]
pub struct ClassCost {
    /// Human label (e.g. `issues`).
    pub label: &'static str,
    /// Number of documents/writes in the class.
    pub count: u64,
    /// Refundable storage deposit, credits.
    pub deposit: u64,
    /// Non-refundable processing burn, credits.
    pub burn: u64,
}

impl ClassCost {
    /// Total credits for the class.
    pub fn total(&self) -> u64 {
        self.deposit + self.burn
    }

    /// Total DASH for the class.
    #[allow(clippy::cast_precision_loss)]
    pub fn total_dash(&self) -> f64 {
        self.total() as f64 / CREDITS_PER_DASH as f64
    }
}

/// Sum `n` identical `per`-doc estimates into a labelled [`ClassCost`], adding
/// `fixed_deposit` refundable credits per doc (0 for git classes; the index/count-tree
/// overhead for collab docs).
fn class(label: &'static str, count: u64, per_doc_bytes: u64, fixed_deposit: u64) -> ClassCost {
    let per = estimate_document_storage(per_doc_bytes);
    ClassCost {
        label,
        count,
        deposit: (per.deposit + fixed_deposit) * count,
        burn: per.burn * count,
    }
}

/// Estimated serialized size of a document whose variable field bytes total `field_bytes`.
fn doc_bytes(field_bytes: u64) -> u64 {
    field_bytes + DOC_SYSTEM_OVERHEAD
}

/// Sum an iterator of per-document byte sizes into a labelled [`ClassCost`], adding
/// `fixed_deposit` refundable credits per doc (index/count-tree overhead for collab docs).
fn sum_class(
    label: &'static str,
    fixed_deposit: u64,
    doc_sizes: impl Iterator<Item = u64>,
) -> ClassCost {
    let mut count = 0u64;
    let (mut deposit, mut burn) = (0u64, 0u64);
    for bytes in doc_sizes {
        let e = estimate_document_storage(bytes);
        deposit += e.deposit + fixed_deposit;
        burn += e.burn;
        count += 1;
    }
    ClassCost {
        label,
        count,
        deposit,
        burn,
    }
}

/// The enumerated migration: the source artifacts plus the exactly-sized git pack.
#[derive(Debug, Default)]
pub struct Plan {
    /// Source repo metadata.
    pub meta: RepoMeta,
    /// Real issues (PR records already filtered out).
    pub issues: Vec<GhIssue>,
    /// Pull requests.
    pub pulls: Vec<GhPull>,
    /// Labels.
    pub labels: Vec<GhLabel>,
    /// Milestones (mapped to labels + convention).
    pub milestones: Vec<GhMilestone>,
    /// Releases (non-draft).
    pub releases: Vec<GhRelease>,
    /// Self-contained pack size in bytes (0 if git data skipped/empty).
    pub pack_bytes: usize,
    /// Chunk-document count the pack splits into.
    pub pack_chunks: usize,
    /// Object count in the pack.
    pub pack_objects: u64,
    /// Distinct git refs pushed (one `refUpdate` each).
    pub ref_count: usize,
    /// Whether a fresh repo contract must be created (adds the instantiation cost).
    pub creates_repo: bool,
}

impl Plan {
    /// Record the built pack's geometry (bytes → chunk count via the real chunker).
    pub fn set_pack(&mut self, bytes: &[u8], objects: u64, ref_count: usize) {
        self.pack_bytes = bytes.len();
        self.pack_chunks = split(bytes).len();
        self.pack_objects = objects;
        self.ref_count = ref_count;
    }

    /// Total projected comment volume across issues + PRs (from GitHub's per-item counter).
    pub fn projected_comments(&self) -> u64 {
        self.issues.iter().map(|i| i.comments).sum::<u64>()
            + self.pulls.iter().map(|p| p.comments).sum::<u64>()
    }

    /// The full per-class cost breakdown honouring the skip flags.
    pub fn cost(&self, skip: SkipFlags) -> Vec<ClassCost> {
        let mut out = Vec::new();
        if self.creates_repo {
            // The instantiation cost is measured, not per-byte — a single deposit-heavy line
            // (dominated by count-tree + token storage).
            out.push(ClassCost {
                label: "repo-create",
                count: 1,
                deposit: REPO_V1_CREATE_CREDITS,
                burn: 0,
            });
        }
        self.git_costs(&mut out);
        self.collab_costs(skip, &mut out);
        out
    }

    /// Append the git-data classes (packs, manifest, refs).
    fn git_costs(&self, out: &mut Vec<ClassCost>) {
        if self.pack_chunks > 0 {
            // Each chunk carries up to the field payload max; sum the real per-chunk sizes.
            let per = split_sizes(self.pack_bytes)
                .into_iter()
                .map(estimate_document_storage)
                .fold((0u64, 0u64), |(d, b), e| (d + e.deposit, b + e.burn));
            out.push(ClassCost {
                label: "git-packs",
                count: self.pack_chunks as u64,
                deposit: per.0,
                burn: per.1,
            });
            out.push(class("git-manifest", 1, doc_bytes(240), 0));
        }
        if self.ref_count > 0 {
            out.push(class("git-refs", self.ref_count as u64, doc_bytes(300), 0));
        }
    }

    /// Append the collaboration classes (issues, PRs, state/label events, comments, labels,
    /// releases). Each carries the calibrated index/count-tree overhead.
    fn collab_costs(&self, skip: SkipFlags, out: &mut Vec<ClassCost>) {
        let idx = COLLAB_INDEX_OVERHEAD_CREDITS;
        if !skip.issues {
            out.push(sum_class(
                "issues",
                idx,
                self.issues.iter().map(|i| doc_bytes(issue_field_bytes(i))),
            ));
        }
        if !skip.prs {
            out.push(sum_class(
                "prs",
                idx,
                self.pulls.iter().map(|p| doc_bytes(pr_field_bytes(p))),
            ));
        }
        // State/label `event` docs the importer posts alongside each issue/PR: one label+
        // per attached label, one close (issues) / close-or-merge (PRs) for non-open items.
        let mut events = 0u64;
        if !skip.issues {
            for i in &self.issues {
                events += i.labels.len() as u64;
                if i.state.eq_ignore_ascii_case("closed") {
                    events += 1;
                }
            }
        }
        if !skip.prs {
            for p in &self.pulls {
                if p.is_merged() || p.state.eq_ignore_ascii_case("closed") {
                    events += 1;
                }
            }
        }
        if events > 0 {
            out.push(class("events", events, doc_bytes(90), idx));
        }
        if !skip.comments && (!skip.issues || !skip.prs) {
            let mut comments = 0u64;
            if !skip.issues {
                comments += self.issues.iter().map(|i| i.comments).sum::<u64>();
            }
            if !skip.prs {
                comments += self.pulls.iter().map(|p| p.comments).sum::<u64>();
            }
            if comments > 0 {
                out.push(class(
                    "comments",
                    comments,
                    doc_bytes(AVG_COMMENT_BYTES),
                    idx,
                ));
            }
        }
        let label_docs = self.labels.len() as u64 + self.milestones.len() as u64;
        if label_docs > 0 {
            out.push(sum_class(
                "labels",
                idx,
                self.labels
                    .iter()
                    .map(|l| doc_bytes(label_field_bytes(l)))
                    .chain(
                        self.milestones
                            .iter()
                            .map(|m| doc_bytes(milestone_label_bytes(m))),
                    ),
            ));
        }
        if !skip.releases && !self.releases.is_empty() {
            out.push(sum_class(
                "releases",
                idx,
                self.releases
                    .iter()
                    .map(|r| doc_bytes(release_field_bytes(r))),
            ));
        }
    }

    /// Grand-total credits over every class in `costs`.
    pub fn grand_total(costs: &[ClassCost]) -> CostEstimate {
        CostEstimate {
            deposit: costs.iter().map(|c| c.deposit).sum(),
            burn: costs.iter().map(|c| c.burn).sum(),
        }
    }
}

/// Which artifact classes to skip (`--skip issues|prs|releases|comments`).
#[derive(Debug, Clone, Copy, Default)]
#[allow(clippy::struct_excessive_bools)] // one bool per CLI skip flag — not a state machine
pub struct SkipFlags {
    /// Skip issues.
    pub issues: bool,
    /// Skip pull requests.
    pub prs: bool,
    /// Skip releases.
    pub releases: bool,
    /// Skip issue/PR comment threads (avoids the per-item comment API calls + writes).
    pub comments: bool,
}

/// The per-chunk payload sizes a `bytes`-byte pack splits into (mirrors the real chunker's
/// geometry so the estimate equals the write cost).
fn split_sizes(total_bytes: usize) -> Vec<u64> {
    // Reconstruct only sizes: `split` needs the actual bytes, but the estimate is built from
    // the already-split count and the fixed field-payload max. Rebuild sizes from geometry.
    let max = forge_core::pack::DOC_PAYLOAD_MAX;
    let mut sizes = Vec::new();
    let mut left = total_bytes;
    while left > max {
        sizes.push(max as u64);
        left -= max;
    }
    if left > 0 {
        sizes.push(left as u64);
    }
    sizes
}

fn issue_field_bytes(i: &GhIssue) -> u64 {
    let body = i.body.as_deref().unwrap_or("").len() as u64;
    9 + i.title.len() as u64 + body + imported_bytes(&i.user.login, i.html_url.len())
}

fn pr_field_bytes(p: &GhPull) -> u64 {
    let body = p.body.as_deref().unwrap_or("").len() as u64;
    // number + title + body + baseRefName + headOid(20) + sourceContractId(32) + provenance.
    9 + p.title.len() as u64
        + body
        + p.base.ref_name.len() as u64
        + 20
        + 32
        + imported_bytes(&p.user.login, p.html_url.len())
}

fn label_field_bytes(l: &GhLabel) -> u64 {
    l.name.len() as u64 + l.color.len() as u64 + l.description.as_deref().unwrap_or("").len() as u64
}

fn milestone_label_bytes(m: &GhMilestone) -> u64 {
    // "milestone:<title>" name + description.
    10 + m.title.len() as u64 + m.description.as_deref().unwrap_or("").len() as u64
}

fn release_field_bytes(r: &GhRelease) -> u64 {
    r.tag_name.len() as u64
        + r.name.as_deref().unwrap_or("").len() as u64
        + r.body.as_deref().unwrap_or("").len() as u64
}

/// Serialized bytes of the `imported` provenance object (author + createdAt + url).
fn imported_bytes(author: &str, url_len: usize) -> u64 {
    author.len() as u64 + 9 + url_len as u64 + 24
}

#[cfg(test)]
mod tests {
    use super::{split_sizes, Plan, SkipFlags};
    use crate::github::{GhIssue, GhUser};
    use forge_core::pack::DOC_PAYLOAD_MAX;

    #[test]
    fn split_sizes_matches_geometry() {
        assert_eq!(split_sizes(0), Vec::<u64>::new());
        assert_eq!(split_sizes(100), vec![100]);
        let two = split_sizes(DOC_PAYLOAD_MAX + 5);
        assert_eq!(two, vec![DOC_PAYLOAD_MAX as u64, 5]);
        // Total is preserved.
        assert_eq!(
            split_sizes(DOC_PAYLOAD_MAX * 3 + 7).iter().sum::<u64>(),
            (DOC_PAYLOAD_MAX * 3 + 7) as u64
        );
    }

    #[test]
    fn issue_cost_scales_with_count_and_respects_skip() {
        let mut plan = Plan::default();
        for n in 0..5 {
            plan.issues.push(GhIssue {
                number: n,
                title: "a title".into(),
                body: Some("some body text".into()),
                user: GhUser {
                    login: "octocat".into(),
                },
                html_url: "https://github.com/o/r/issues/1".into(),
                comments: 2,
                ..Default::default()
            });
        }
        let costs = plan.cost(SkipFlags::default());
        let issues = costs.iter().find(|c| c.label == "issues").unwrap();
        assert_eq!(issues.count, 5);
        assert!(issues.total() > 0);

        // Comments projected from the per-issue counter (5 * 2 = 10).
        let comments = costs.iter().find(|c| c.label == "comments").unwrap();
        assert_eq!(comments.count, 10);

        // Skipping issues drops the issues class (comments follow the kept classes).
        let skipped = plan.cost(SkipFlags {
            issues: true,
            ..Default::default()
        });
        assert!(skipped.iter().all(|c| c.label != "issues"));
    }

    #[test]
    fn repo_create_line_appears_only_when_creating() {
        let mut plan = Plan::default();
        assert!(plan
            .cost(SkipFlags::default())
            .iter()
            .all(|c| c.label != "repo-create"));
        plan.creates_repo = true;
        let costs = plan.cost(SkipFlags::default());
        let rc = costs.iter().find(|c| c.label == "repo-create").unwrap();
        assert_eq!(rc.count, 1);
        assert_eq!(rc.deposit, super::REPO_V1_CREATE_CREDITS);
    }
}

//! Branches for fewer people than all members (phase 3F; mixed-visibility DESIGN §4.3, D34) in
//! `dg`: the re-lettering a role change plans ([`prepare`], used by `dg collab add` and `dg collab
//! remove`), and what `dg branch audience` shows and changes.
//!
//! A narrower branch's key reaches its audience in letters. When a role change changes who a
//! group is, the person making it sends the key to anyone who joins, or a new key to everyone
//! left when someone leaves, for every such branch they hold the key of, in the same flow as the
//! environments, after the role change lands. Branches they do not hold are updated by the next
//! person to push them.

use std::collections::BTreeSet;
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use forge_core::env::Audience;
use forge_core::members::Member;
use forge_core::narrow::{self, Reletter};
use forge_core::private::branch_key::{Branch, BranchRing};
use forge_core::repo::RepoService;
use forge_core::rules::v2::Visibility;

use crate::common::Session;
use crate::fmt::{cost_line, plural_with, safe};

/// The cost a letter is quoted at: one Platform chunk of a 64-recipient letter and its manifest.
fn letter_credits(people: usize) -> u64 {
    let header = forge_core::private::named::artifact_header_len(people.clamp(1, 64));
    forge_core::env::service::snapshot_credits((header + 2 * 512 + 16) as u64)
}

/// One branch a role change touches.
#[derive(Debug, Clone)]
pub struct Item {
    /// The full ref name.
    pub name: String,
    /// Who it is for.
    pub audience: Audience,
    /// What its letters need.
    pub action: Reletter,
    /// The people it is for after the change, with an encryption key.
    pub now: BTreeSet<String>,
    /// People it is for who have no encryption key.
    pub no_key: Vec<String>,
}

/// The narrower branches a role change re-letters.
#[derive(Default)]
pub struct Plan {
    ring: Option<Arc<BranchRing>>,
    /// The branches whose letters change.
    pub items: Vec<Item>,
    /// Narrower branches the signer cannot open (it does not hold their keys): their next pusher
    /// updates them.
    pub not_held: usize,
}

/// Plan the letters a role change needs, with the members as they will be (`after`): for every
/// narrower branch the signer holds the key of, whose audience resolves to other people than
/// hold its key now. Empty in a private repository or one without members-only content.
pub async fn prepare(s: &Session, after: &[Member]) -> Result<Plan> {
    if s.repo.visibility != Visibility::Public
        || !forge_core::keyring::has_members_key(&s.client, &s.repo).await?
    {
        return Ok(Plan::default());
    }
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    let ring = Arc::new(narrow::read_ring(&svc, &s.repo, after).await?);
    // the member fold opens the branches held, and counts the others
    svc.keyring(&s.repo).await?.set_branch_ring(Arc::clone(&ring));
    let not_held = match svc.read_members_refs(&s.repo).await {
        Ok(Some(m)) => m.updates.unreadable_narrower.len(),
        _ => 0,
    };
    let owner = s.repo.owner_id();
    let mut items = Vec::new();
    for b in ring.branches().values() {
        let people = narrow::resolve_now(&b.audience, owner, after);
        let (now, no_key) = narrow::with_keys(&svc, &s.repo, &people).await?;
        let action = narrow::plan(b, &now);
        if action != Reletter::Nothing {
            items.push(Item {
                name: b.name.clone(),
                audience: b.audience.clone(),
                action,
                now,
                no_key,
            });
        }
    }
    Ok(Plan {
        ring: Some(ring),
        items,
        not_held,
    })
}

impl Plan {
    /// The credits the planned letters cost.
    #[must_use]
    pub fn credits(&self) -> u64 {
        self.items
            .iter()
            .map(|i| letter_credits(i.now.len()))
            .sum()
    }

    /// Print one line per branch (stderr) and return the sentence the confirmation adds.
    pub fn explain(&self, price: Option<f64>) -> String {
        for i in &self.items {
            let name = safe(forge_core::keyring::short_branch(&i.name));
            let label = narrow::label(&i.audience);
            match &i.action {
                Reletter::Joiners(j) => eprintln!(
                    "  {name} ({label} only): send its key to {}",
                    comma_list(j)
                ),
                Reletter::NewGeneration(_) => eprintln!(
                    "  {name} ({label} only): a new key for the {} people it is for now",
                    i.now.len()
                ),
                Reletter::Nothing => {}
            }
            for p in &i.no_key {
                eprintln!("    {p} has no encryption key, so can't read {name} until they add one");
            }
        }
        if self.not_held > 0 {
            eprintln!(
                "  {} you don't have access to: whoever pushes {} next updates who can read {}",
                plural_with(self.not_held, "branch", "branches"),
                if self.not_held == 1 { "it" } else { "each" },
                if self.not_held == 1 { "it" } else { "them" }
            );
        }
        if self.items.is_empty() {
            return String::new();
        }
        format!(
            " Then {} for fewer people {} its key again ({}).",
            plural_with(self.items.len(), "members-only branch", "members-only branches"),
            if self.items.len() == 1 { "gets" } else { "get" },
            cost_line(self.credits(), price)
        )
    }

    /// Send the planned letters, after the role change landed. Never fails the change: a letter
    /// that cannot be sent is reported, and the branch's next pusher sends it.
    pub async fn save(&self, s: &Session) -> (Value, String) {
        let Some(ring) = &self.ring else {
            return (Value::Null, String::new());
        };
        if self.items.is_empty() {
            return (json!([]), String::new());
        }
        let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
        let mut out = Vec::new();
        let mut text = String::new();
        for i in &self.items {
            let Some(b) = ring.get(&i.name) else { continue };
            let name = forge_core::keyring::short_branch(&i.name).to_owned();
            match narrow::reletter(&svc, &s.repo, b, &i.audience, &i.now).await {
                Ok(Some(w)) => {
                    text.push_str(&format!(
                        "\n  {} ({} only): its key went to {}",
                        safe(&name),
                        narrow::label(&i.audience),
                        people_count(w.to.len())
                    ));
                    out.push(json!({ "branch": name, "status": "sent", "to": w.to }));
                }
                Ok(None) => out.push(json!({ "branch": name, "status": "unchanged" })),
                Err(e) => {
                    text.push_str(&format!(
                        "\n  {}: its key couldn't be sent ({e}); the next push of it sends it",
                        safe(&name)
                    ));
                    out.push(json!({ "branch": name, "status": "failed", "error": e.to_string() }));
                }
            }
        }
        (Value::Array(out), text)
    }
}

/// The branch `name` among the signer's narrower branches, with the ring it came from.
pub async fn held(s: &Session, name: &str) -> Result<Option<(Arc<BranchRing>, Branch)>> {
    if s.repo.visibility != Visibility::Public {
        return Ok(None);
    }
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    let members = forge_core::members::MemberReader::new(&s.client)
        .list(&s.repo)
        .await?;
    let ring = Arc::new(narrow::read_ring(&svc, &s.repo, &members).await?);
    let b = ring.get(name).cloned();
    Ok(b.map(|b| (ring, b)))
}

/// What `dg branch audience` reports about a branch: its audience, who it resolves to and who
/// holds its key now.
#[must_use]
pub fn describe(b: &Branch, people: &BTreeSet<String>) -> Value {
    json!({
        "audience": narrow::spec(&b.audience),
        "label": narrow::label(&b.audience),
        "people": people,
        "holders": b.holders,
    })
}

/// "1 person" / "3 people".
#[must_use]
pub fn people_count(n: usize) -> String {
    plural_with(n, "person", "people")
}

/// `a, b, c`.
#[must_use]
pub fn comma_list(xs: &BTreeSet<String>) -> String {
    xs.iter().cloned().collect::<Vec<_>>().join(", ")
}

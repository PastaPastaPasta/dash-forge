//! `dg repo activity <repo> <ref>` (epic E5): one branch's or tag's activity, newest first, from
//! the chain ([`forge_core::rules::ref_history`]): every push, force-push, tag move and deletion,
//! and every config change that protected the ref or lifted its protection. Whether a branch push
//! kept the old tip is asked of local git when run inside a clone that has both commits
//! (`git merge-base --is-ancestor`); otherwise the push reads "updated".

use anyhow::Result;
use serde_json::json;

use forge_core::rules::ref_history::{ref_history, RefEvent, RefEventKind};

use crate::common::Reader;
use crate::context::Ctx;
use crate::fmt::{safe, short};

/// The full ref name `name` means: a `refs/…` name as given, else a tag or a branch.
pub fn full_ref_name(name: &str, tag: bool) -> String {
    if name.starts_with("refs/") {
        name.to_string()
    } else if tag {
        format!("refs/tags/{name}")
    } else {
        format!("refs/heads/{name}")
    }
}

/// How many of the newest ancestry questions are asked of local git (one `git` run or two each).
const CONTAINS_CHECKED: usize = 20;

/// Whether this directory's git is a shallow clone: its history stops early, so an ancestor
/// it cannot find may still be one.
fn shallow() -> bool {
    std::process::Command::new("git")
        .args(["rev-parse", "--is-shallow-repository"])
        .stderr(std::process::Stdio::null())
        .output()
        .is_ok_and(|o| o.status.success() && o.stdout.trim_ascii() == b"true")
}

/// Whether commit `new` contains commit `old`, as this directory's git sees it; `None` when it
/// cannot tell (not a clone, a commit it does not have, or a shallow clone that did not find it).
fn local_contains(old: &str, new: &str, shallow: bool) -> Option<bool> {
    let has = |oid: &str| {
        std::process::Command::new("git")
            .args(["cat-file", "-e", &format!("{oid}^{{commit}}")])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    if !has(old) || !has(new) {
        return None;
    }
    let status = std::process::Command::new("git")
        .args(["merge-base", "--is-ancestor", old, new])
        .stderr(std::process::Stdio::null())
        .status()
        .ok()?;
    match status.code() {
        Some(0) => Some(true),
        Some(1) if !shallow => Some(false),
        _ => None,
    }
}

/// The words of one entry.
fn describe(e: &RefEvent) -> String {
    let tip = |o: &Option<String>| {
        o.as_deref()
            .map_or_else(String::new, |o| short(o).to_string())
    };
    let moved = || format!("{} → {}", tip(&e.from), tip(&e.to));
    match e.kind {
        RefEventKind::Created => format!("created at {}", tip(&e.to)),
        RefEventKind::Pushed => format!("pushed {}", moved()),
        RefEventKind::ForcePushed => format!("force-pushed {}", moved()),
        RefEventKind::Updated => format!("updated {}", moved()),
        RefEventKind::Moved => format!("moved {}", moved()),
        RefEventKind::Deleted => format!("deleted (was {})", tip(&e.from)),
        RefEventKind::Diverged => format!("diverged {}", moved()),
        RefEventKind::ProtectionAdded => "protected".into(),
        RefEventKind::ProtectionLifted => "protection lifted".into(),
        RefEventKind::ProtectionRestored => "protection restored".into(),
    }
}

/// `dg repo activity`.
pub async fn activity(ctx: &Ctx, repo: &str, name: &str, tag: bool) -> Result<()> {
    let s = Reader::open(ctx, repo).await?;
    let ref_name = full_ref_name(name, tag);
    let (hash, updates, configs) = s.service().ref_history(&s.repo, &ref_name).await?;
    // The questions the walk asks, then the newest of them answered by local git.
    let asked = std::cell::RefCell::new(Vec::<(String, String)>::new());
    let _ = ref_history(&ref_name, &hash, &updates, &configs, |old, new| {
        let mut a = asked.borrow_mut();
        if !a.iter().any(|(o, n)| o == old && n == new) {
            a.push((old.to_string(), new.to_string()));
        }
        None
    });
    let asked = asked.into_inner();
    let shallow = shallow();
    let answers: Vec<((String, String), Option<bool>)> = asked
        .iter()
        .rev()
        .take(CONTAINS_CHECKED)
        .map(|(o, n)| ((o.clone(), n.clone()), local_contains(o, n, shallow)))
        .collect();
    let contains = |old: &str, new: &str| {
        answers
            .iter()
            .find(|((o, n), _)| o == old && n == new)
            .and_then(|(_, a)| *a)
    };
    let mut events = ref_history(&ref_name, &hash, &updates, &configs, contains);
    events.reverse();
    let display = s.repo.display();
    ctx.emit(
        json!({ "repo": display, "ref": ref_name, "events": events }),
        || {
            if events.is_empty() {
                println!("nothing was ever pushed to {}", safe(&ref_name));
                return;
            }
            println!("{} of {}, newest first", safe(&ref_name), safe(&display));
            for e in &events {
                let when = crate::cost::format_utc(e.at);
                let who = e.by.as_deref().unwrap_or("a maintainer (config)");
                let mark = match e.kind {
                    RefEventKind::ForcePushed | RefEventKind::Moved => "!",
                    RefEventKind::ProtectionLifted | RefEventKind::Diverged => "~",
                    _ => " ",
                };
                println!("{mark} {when} UTC  {:<22} {who}", describe(e));
            }
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_name_is_a_branch_unless_tagged() {
        assert_eq!(full_ref_name("main", false), "refs/heads/main");
        assert_eq!(full_ref_name("v1.0", true), "refs/tags/v1.0");
        assert_eq!(full_ref_name("refs/tags/v1.0", false), "refs/tags/v1.0");
    }

    #[test]
    fn entries_say_what_moved() {
        let e = RefEvent {
            kind: RefEventKind::ForcePushed,
            id: "u".into(),
            at: 1,
            by: Some("a".into()),
            from: Some("a".repeat(40)),
            to: Some("b".repeat(40)),
        };
        assert!(describe(&e).starts_with("force-pushed aaaaaaa"));
        let lifted = RefEvent {
            kind: RefEventKind::ProtectionLifted,
            by: None,
            from: None,
            to: None,
            ..e
        };
        assert_eq!(describe(&lifted), "protection lifted");
    }
}

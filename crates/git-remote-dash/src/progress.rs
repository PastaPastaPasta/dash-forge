//! Push progress on stderr (UX spec §7.4): a plan line saying what goes where, one line per
//! storage target as it finishes, a Platform line with the estimate, and a summary with the
//! actual charge.
//!
//! ```text
//! dash: alice/project ← main (8f3e2a1, 312 objects, 1.2 MiB)
//! dash: r2-main      ████████████████ 1.2 MiB  verified   0.4 s
//! dash: platform     manifest 1 · refUpdate 1     est 0.00031 DASH
//! dash: done · Platform charged ≈0.00029 DASH · remaining 0.4809 DASH · https://forge.dashhq.org/repo?owner=…&name=project
//! ```
//!
//! Printed at git's default verbosity; `git push -q` silences everything except errors. A
//! `--dry-run` prints the first lines (plan + targets + estimate) and stops. With
//! `GIT_DASH_JSON=1` every line is a JSON event instead (`{"event":"plan",…}`).
//!
//! The bars are not animated: a target's line is printed once, when its upload has been
//! stored AND verified, so a full bar always means "confirmed", never "in flight".

use std::time::Duration;

use serde_json::{json, Value};

use forge_core::backends::sigv4::uri_encode;
use forge_core::storage::{human_bytes, ResolvedPolicy, StoreOutcome, PLATFORM_PROFILE};
use forge_core::user_error::{dash, one_line, redact, WEB_ORIGIN};

/// Width of the name column (the spec's `r2-main      ` / `platform     `).
const NAME_COL: usize = 12;
/// Characters in a bar.
const BAR: usize = 16;

/// Where progress lines go and in what form.
#[derive(Debug, Clone, Copy)]
pub struct Progress {
    /// Print anything at all (git's verbosity ≥ 1; `-q` sends 0).
    pub enabled: bool,
    /// One JSON object per line instead of text (`GIT_DASH_JSON=1`).
    pub json: bool,
}

impl Progress {
    /// From git's `option verbosity` and the environment.
    pub fn new(verbosity: i32) -> Self {
        Self {
            enabled: verbosity >= 1,
            json: matches!(std::env::var("GIT_DASH_JSON").as_deref(), Ok("1" | "true")),
        }
    }

    /// Emit one event: `text` in human mode, `event` in JSON mode.
    pub fn emit(self, text: &str, event: &Value) {
        if !self.enabled {
            return;
        }
        if self.json {
            eprintln!("{event}");
        } else {
            eprintln!("{}", redact(text));
        }
    }

    /// A free-form status line (`dash: note: …`).
    pub fn note(self, text: &str) {
        self.emit(
            &format!("dash: {text}"),
            &json!({ "event": "note", "message": redact(text) }),
        );
    }
}

/// What is being pushed, for the plan line.
pub struct PlanFacts<'a> {
    /// `owner/name` as the user addressed it.
    pub repo: &'a str,
    /// Branch/tag names being updated (short form).
    pub refs: &'a [String],
    /// The pushed tip (the first accepted ref's new oid).
    pub tip: &'a str,
    /// Objects in the pack.
    pub objects: u64,
    /// Pack bytes.
    pub bytes: u64,
}

/// `dash: alice/project ← main (8f3e2a1, 312 objects, 1.2 MiB)`.
pub fn plan_line(f: &PlanFacts<'_>) -> (String, Value) {
    let refs = if f.refs.is_empty() {
        "(no refs)".to_string()
    } else {
        f.refs.join(", ")
    };
    let short = &f.tip[..f.tip.len().min(7)];
    (
        format!(
            "dash: {} ← {refs} ({short}, {} objects, {})",
            f.repo,
            f.objects,
            human_bytes(f.bytes)
        ),
        json!({
            "event": "plan",
            "repo": f.repo,
            "refs": f.refs,
            "tip": f.tip,
            "objects": f.objects,
            "bytes": f.bytes,
        }),
    )
}

/// `dash: storage      → r2-main, kubo (need 2 of 2) · Platform stores manifest + refs only,
/// est 0.00037 DASH` — which targets, how many must confirm, what Platform stores and what
/// that is estimated to cost. Printed before any upload, so the price is on screen before
/// anything is paid for and a push that fails its policy says where it was headed.
pub fn targets_line(policy: &ResolvedPolicy, est_credits: u64) -> (String, Value) {
    let names = policy.target_names();
    let need = if policy.total() > 1 {
        format!(" (need {} of {})", policy.replicas, policy.total())
    } else {
        String::new()
    };
    let chain = if policy.platform {
        "Platform stores pack + manifest + refs"
    } else if policy.platform_fallback {
        "Platform stores manifest + refs only (Platform fallback armed)"
    } else {
        "Platform stores manifest + refs only"
    };
    let where_ = if policy.external.is_empty() {
        "Platform chunks".to_string()
    } else {
        names.join(", ")
    };
    (
        format!(
            "dash: {:<NAME_COL$} → {where_}{need} · {chain}, est {} DASH",
            "storage",
            dash(est_credits)
        ),
        json!({
            "event": "targets",
            "estCredits": est_credits,
            "targets": names,
            "replicas": policy.replicas,
            "total": policy.total(),
            "platformStoresPack": policy.platform,
            "platformFallback": policy.platform_fallback,
        }),
    )
}

/// One target finished: `dash: r2-main      ████████████████ 1.2 MiB  verified   0.4 s`, or
/// `dash: r2-main      ✗ S3 PUT … 403 …`.
pub fn target_line(o: &StoreOutcome<'_>, bytes: u64) -> (String, Value) {
    let secs = secs(o.elapsed);
    match o.result {
        Ok(uris) => (
            format!(
                "dash: {:<NAME_COL$} {} {}  verified {secs:>5.1} s",
                o.target,
                "█".repeat(BAR),
                human_bytes(bytes)
            ),
            json!({
                "event": "target",
                "target": o.target,
                "ok": true,
                "platform": o.platform,
                "bytes": bytes,
                "seconds": secs,
                "uris": uris.iter().map(|u| redact(&u.0)).collect::<Vec<_>>(),
            }),
        ),
        Err(e) => {
            let why = one_line(&e.to_string());
            (
                format!("dash: {:<NAME_COL$} ✗ {why}", o.target),
                json!({
                    "event": "target",
                    "target": o.target,
                    "ok": false,
                    "platform": o.platform,
                    "seconds": secs,
                    "error": redact(&why),
                }),
            )
        }
    }
}

/// What Platform is asked to write for this push.
#[derive(Debug, Clone, Copy)]
pub struct PlatformWrites {
    /// Chunk documents (0 unless Platform stores the pack).
    pub chunks: u32,
    /// Manifests: the pack's plus its browse-index fragment's.
    pub manifests: u32,
    /// Ref updates.
    pub ref_updates: usize,
    /// Estimated credits for all of it.
    pub est_credits: u64,
}

/// `dash: platform     manifest 1 · refUpdate 1     est 0.00031 DASH`.
pub fn platform_line(w: &PlatformWrites) -> (String, Value) {
    let mut parts = Vec::new();
    if w.chunks > 0 {
        parts.push(format!("chunk {}", w.chunks));
    }
    parts.push(format!("manifest {}", w.manifests));
    parts.push(format!("refUpdate {}", w.ref_updates));
    (
        format!(
            "dash: {:<NAME_COL$} {:<28} est {} DASH",
            PLATFORM_PROFILE,
            parts.join(" · "),
            dash(w.est_credits)
        ),
        json!({
            "event": "platform",
            "chunks": w.chunks,
            "manifests": w.manifests,
            "refUpdates": w.ref_updates,
            "estCredits": w.est_credits,
        }),
    )
}

/// What the push cost on Platform, as far as the helper can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Charge {
    /// The identity's balance went down by this much (≈: a concurrent spend by the same
    /// identity would be counted too).
    Measured(u64),
    /// The balance has not moved yet (read-after-write lag, or it could not be re-read):
    /// the estimate for what was written.
    Estimated(u64),
}

/// `dash: done · Platform charged ≈0.00029 DASH · remaining 0.4809 DASH · <web url>`.
/// `remaining` is `None` when the balance could not be re-read.
pub fn done_line(
    charge: Charge,
    remaining: Option<u64>,
    owner_id: &str,
    name: &str,
) -> (String, Value) {
    let url = web_url(owner_id, name);
    let (charged, kind, text) = match charge {
        Charge::Measured(c) => (c, "measured", format!("Platform charged ≈{} DASH", dash(c))),
        Charge::Estimated(c) => (
            c,
            "estimated",
            format!("Platform charge est {} DASH", dash(c)),
        ),
    };
    let mut parts = vec!["dash: done".to_string(), text];
    if let Some(b) = remaining {
        parts.push(format!("remaining {} DASH", dash(b)));
    }
    parts.push(url.clone());
    (
        parts.join(" · "),
        json!({
            "event": "done",
            "chargedCredits": charged,
            "charge": kind,
            "remainingCredits": remaining,
            "url": url,
        }),
    )
}

/// The repo's page in the web app.
pub fn web_url(owner_id: &str, name: &str) -> String {
    format!(
        "{WEB_ORIGIN}/repo?owner={}&name={}",
        uri_encode(owner_id, false),
        uri_encode(name, false)
    )
}

/// `refs/heads/main` → `main`, `refs/tags/v1` → `v1`.
pub fn short_ref(r: &str) -> String {
    r.strip_prefix("refs/heads/")
        .or_else(|| r.strip_prefix("refs/tags/"))
        .unwrap_or(r)
        .to_string()
}

#[allow(clippy::cast_precision_loss)]
fn secs(d: Duration) -> f64 {
    (d.as_millis() as f64 / 100.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::backends::Uri;
    use forge_core::storage::{StoragePolicy, StorageProfiles};

    const PROFILES: &str = "[profiles.r2-main]\nkind = \"s3\"\nendpoint = \"https://a.r2.cloudflarestorage.com\"\nbucket = \"b\"\n[profiles.kubo]\nkind = \"ipfs-kubo\"\napi = \"http://127.0.0.1:5001\"\n";

    fn policy(storage: Option<&str>) -> ResolvedPolicy {
        StoragePolicy::from_git_values(storage, None, None)
            .unwrap()
            .resolve(&StorageProfiles::parse(PROFILES).unwrap())
            .unwrap()
    }

    /// The spec §7.4 sample, line for line.
    #[test]
    fn matches_the_spec_sample() {
        let (plan, ev) = plan_line(&PlanFacts {
            repo: "alice/project",
            refs: &["main".into()],
            tip: "8f3e2a1c0ffee",
            objects: 312,
            bytes: 1_258_291,
        });
        assert_eq!(
            plan,
            "dash: alice/project ← main (8f3e2a1, 312 objects, 1.2 MiB)"
        );
        assert_eq!(ev["event"], "plan");

        let uris = [Uri("https://pub-9a1.r2.dev/p".into())];
        let (t, ev) = target_line(
            &StoreOutcome {
                target: "r2-main",
                platform: false,
                elapsed: Duration::from_millis(412),
                result: Ok(&uris),
            },
            1_258_291,
        );
        assert_eq!(
            t,
            "dash: r2-main      ████████████████ 1.2 MiB  verified   0.4 s"
        );
        assert_eq!(ev["ok"], true);

        let (p, _) = platform_line(&PlatformWrites {
            chunks: 0,
            manifests: 1,
            ref_updates: 1,
            est_credits: 31_000_000,
        });
        assert_eq!(
            p,
            "dash: platform     manifest 1 · refUpdate 1     est 0.00031 DASH"
        );

        let (d, ev) = done_line(
            Charge::Measured(29_000_000),
            Some(48_090_000_000),
            "alice",
            "project",
        );
        assert_eq!(
            d,
            "dash: done · Platform charged ≈0.00029 DASH · remaining 0.4809 DASH · https://forge.dashhq.org/repo?owner=alice&name=project"
        );
        assert_eq!(ev["chargedCredits"], 29_000_000);
    }

    #[test]
    fn targets_line_says_what_goes_where() {
        let (l, _) = targets_line(&policy(Some("r2-main,kubo")), 37_300_000);
        // e2e/cli/storage-byo.sh greps for these two fragments.
        assert!(l.contains("→ r2-main, kubo (need 2 of 2)"), "{l}");
        assert!(l.contains("manifest + refs only, est 0.000373 DASH"), "{l}");
        let (l, _) = targets_line(&policy(None), 35_000_000_000);
        assert!(
            l.contains(
                "→ Platform chunks · Platform stores pack + manifest + refs, est 0.3500 DASH"
            ),
            "{l}"
        );
    }

    #[test]
    fn failed_target_line_is_one_redacted_line() {
        let err = forge_core::Error::Io("S3 PUT https://k:s@h/b failed\nwith status 403".into());
        let (l, ev) = target_line(
            &StoreOutcome {
                target: "r2-main",
                platform: false,
                elapsed: Duration::from_secs(1),
                result: Err(&err),
            },
            10,
        );
        assert!(
            l.starts_with("dash: r2-main      ✗ io error: S3 PUT"),
            "{l}"
        );
        assert!(!l.contains('\n'));
        // Human text is redacted by `emit`; the JSON field here.
        assert!(!ev["error"].as_str().unwrap().contains("k:s@"));
    }

    #[test]
    fn chunks_show_when_platform_stores_the_pack_and_urls_are_encoded() {
        let (p, _) = platform_line(&PlatformWrites {
            chunks: 3,
            manifests: 2,
            ref_updates: 2,
            est_credits: 100_000_000,
        });
        assert!(p.contains("chunk 3 · manifest 2 · refUpdate 2"), "{p}");
        assert_eq!(
            web_url("o", "a b&c"),
            "https://forge.dashhq.org/repo?owner=o&name=a%20b%26c"
        );
        let (d, ev) = done_line(Charge::Estimated(31_000_000), None, "o", "r");
        assert_eq!(ev["charge"], "estimated");
        // The e2e scenarios grep a failed push's stderr for "balance"; a summary line must
        // not look like a funding problem.
        assert!(!d.contains("balance"), "{d}");
        assert!(
            d.starts_with("dash: done · Platform charge est 0.00031 DASH · https://"),
            "{d}"
        );
        assert_eq!(short_ref("refs/heads/feature/x"), "feature/x");
        assert_eq!(short_ref("refs/tags/v1"), "v1");
    }
}

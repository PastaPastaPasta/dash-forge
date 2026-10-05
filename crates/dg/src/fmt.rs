//! Cost/DASH formatting and JSON-output helpers.
//!
//! These are the pure, side-effect-free building blocks the command handlers use to
//! render both human output (DASH primary, USD secondary on mainnet — style guide §A.2) and the
//! `--json` structs. Keeping them pure keeps them unit-testable without a network.

use forge_core::cost::CREDITS_PER_DASH;
use forge_core::platform::Network;
use forge_core::rules::v2::Visibility;
use serde_json::{json, Value};

/// The fallback DASH/USD price used for the *secondary* USD display when no live price
/// feed is configured. The price feed is optional and offline-safe (style guide §C.6):
/// USD is a convenience only — the integer credit / DASH values are the source of truth.
/// Override with the `DASH_USD` environment variable.
pub const FALLBACK_DASH_USD: f64 = 30.0;

/// The pre-write estimate shown before `dg repo create` signs, in credits: a forge-v2
/// repo is three small documents (`repo`, the owner's `maintainer`, the first `config`).
/// An upper bound; the measured cost is reported after the create lands.
pub const REPO_CREATE_ESTIMATE_CREDITS: u64 = 200_000_000;

/// `text` with control characters (C0 except newline and tab, DEL, and C1) removed, for
/// printing document text anyone could have written (titles, bodies, comments, ref names)
/// to a terminal, where an escape sequence could rewrite what the user sees. `--json` output
/// is left exact.
pub fn safe(text: &str) -> std::borrow::Cow<'_, str> {
    let bad =
        |c: char| (c.is_control() && c != '\n' && c != '\t') || ('\u{80}'..='\u{9f}').contains(&c);
    if text.chars().any(bad) {
        text.chars().filter(|c| !bad(*c)).collect::<String>().into()
    } else {
        text.into()
    }
}

/// An identity for display: its DPNS name with a shortened id when `names` has one
/// (`alice.dash (Fi8bQ2xk…)`), as [`forge_core::platform::PlatformClient::dpns_first_names`]
/// reads them, and the full id otherwise. `--json` output keeps full ids.
pub fn with_name(id: &str, names: &std::collections::BTreeMap<String, String>) -> String {
    match names.get(id) {
        Some(name) => format!("{} ({})", safe(name), short_identity(id)),
        None => id.to_string(),
    }
}

/// An identity id shortened for display next to its name: its first 7 and last 5 characters
/// (`Fi8bQ2x…9XwYz`), as the web shows it. Never the prefix alone: an id is a hash of the asset
/// lock that funded it, so an attacker can grind funding transactions until the first characters
/// match someone else's; matching both ends too costs far more. Short values come back unchanged.
pub fn short_identity(id: &str) -> String {
    // By character: the value may be untrusted document text, not base58.
    let chars: Vec<char> = id.chars().collect();
    if chars.len() <= 13 {
        return id.to_string();
    }
    let head: String = chars[..7].iter().collect();
    let tail: String = chars[chars.len() - 5..].iter().collect();
    format!("{head}\u{2026}{tail}")
}

/// A commit id shortened for display (12 hex digits).
pub fn short(oid: &str) -> &str {
    // By character: the value may be untrusted document text, not hex.
    oid.char_indices().nth(12).map_or(oid, |(i, _)| &oid[..i])
}

/// How an event was written, for human output.
pub fn route_text(route: forge_core::collab::v2::StateRoute) -> &'static str {
    match route {
        forge_core::collab::v2::StateRoute::Member => "as a member (event)",
        forge_core::collab::v2::StateRoute::Author => "as the author (authorEvent)",
    }
}

/// How a state change (a `transition`) was written, for human output.
pub fn transition_route_text(route: forge_core::collab::v2::StateRoute) -> &'static str {
    match route {
        forge_core::collab::v2::StateRoute::Member => "as a member (transition)",
        forge_core::collab::v2::StateRoute::Author => "as the author (transition)",
    }
}

/// What a `transition` did, in the web timeline's words.
pub fn transition_phrase(kind: u8) -> &'static str {
    use forge_core::rules::transition as t;
    match kind {
        t::ISSUE_CLOSE | t::PR_CLOSE | t::PR_DRAFT_CLOSE => "closed this",
        t::ISSUE_REOPEN | t::PR_REOPEN | t::PR_DRAFT_REOPEN => "reopened this",
        t::PR_MERGE => "merged this",
        t::PR_DRAFT => "marked this as draft",
        t::PR_READY => "marked this ready for review",
        t::ISSUE_LOCK | t::PR_LOCK => "locked the conversation",
        t::ISSUE_UNLOCK | t::PR_UNLOCK => "unlocked the conversation",
        _ => "changed the state",
    }
}

/// The DASH/USD price for the secondary USD display on `network`: `None` off mainnet, where
/// DASH is test money with no cash value (QW2-075; the web says the same since QW-046), else
/// the `DASH_USD` override, else the offline fallback.
pub fn usd_price(network: &Network) -> Option<f64> {
    matches!(network, Network::Mainnet).then(mainnet_usd_price)
}

/// The mainnet DASH/USD price: `DASH_USD` env override, else the offline fallback.
fn mainnet_usd_price() -> f64 {
    std::env::var("DASH_USD")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|p| *p > 0.0)
        .unwrap_or(FALLBACK_DASH_USD)
}

/// What a DASH amount is worth off mainnet, for a line that shows a balance or a price list.
pub const NO_CASH_VALUE: &str = "test DASH, no cash value";

/// Convert credits to DASH (1 DASH = 1e11 credits).
#[allow(clippy::cast_precision_loss)]
pub fn credits_to_dash(credits: u64) -> f64 {
    credits as f64 / CREDITS_PER_DASH as f64
}

/// Format a DASH amount with trailing zeros trimmed (but always a leading `0`), e.g.
/// `1.18`, `0.0003`, `0`.
pub fn dash_amount(dash: f64) -> String {
    let s = format!("{dash:.8}");
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

/// A price for copy: three significant figures, never rounding a fee to 0 (`0.0102`,
/// `0.000976`, `32.5`). `dg cost` ([`dash_exact`]) and `--json` keep exact amounts.
pub fn dash_rounded(credits: u64) -> String {
    if credits == 0 {
        return "0".into();
    }
    let d = credits_to_dash(credits);
    // Decimals so that three significant digits show: 0.00517 needs 5, 32.5 needs 1.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let decimals = (2.0 - d.log10().floor()).max(0.0) as usize;
    let s = format!("{d:.decimals$}");
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

/// A DASH amount to the credit (11 decimals, trailing zeros trimmed), so rows add up to
/// their total: `0.00000000003` for 3 credits, `1.5` for 150_000_000_000.
pub fn dash_exact(credits: u64) -> String {
    let whole = credits / CREDITS_PER_DASH;
    let frac = credits % CREDITS_PER_DASH;
    if frac == 0 {
        return whole.to_string();
    }
    let frac = format!("{frac:011}");
    format!("{whole}.{}", frac.trim_end_matches('0'))
}

/// "1 asset" / "3 assets": a count and its noun, never "asset(s)". Nouns whose plural is not
/// a bare `s` go through [`plural_with`].
pub fn plural<N: Copy + std::fmt::Display + PartialEq + From<u8>>(n: N, one: &str) -> String {
    plural_with(n, one, &format!("{one}s"))
}

/// [`plural`] with an explicit plural form ("1 identity" / "2 identities").
pub fn plural_with<N: Copy + std::fmt::Display + PartialEq + From<u8>>(
    n: N,
    one: &str,
    many: &str,
) -> String {
    if n == N::from(1) {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// Set once this process has shown a price ([`cost_line`]): a confirmation that cannot be
/// asked then says to check that estimate, and otherwise to check what the command does
/// (QW2-079: "check the estimate" where none was shown).
pub static ESTIMATE_SHOWN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// A one-line cost display: DASH primary, USD secondary on mainnet, e.g.
/// `~0.0003 DASH ≈ $0.01` (`~0.0003 DASH` where [`usd_price`] is `None`).
pub fn cost_line(credits: u64, price_usd: Option<f64>) -> String {
    priced(credits, price_usd, &dash_rounded(credits))
}

/// [`cost_line`] to the credit ([`dash_exact`]), for `dg cost`, whose rows must add up.
pub fn cost_line_exact(credits: u64, price_usd: Option<f64>) -> String {
    priced(credits, price_usd, &dash_exact(credits))
}

fn priced(credits: u64, price_usd: Option<f64>, amount: &str) -> String {
    ESTIMATE_SHOWN.store(true, std::sync::atomic::Ordering::Relaxed);
    match price_usd {
        Some(price) => format!("~{amount} DASH ≈ ${:.2}", credits_to_dash(credits) * price),
        None => format!("~{amount} DASH"),
    }
}

/// Platform's pack-storage rate for copy, e.g. `~0.39 DASH/MiB`: the calibrated `chunk`
/// fees `git push` quotes (`forge_core::cost::push_fees`), an upper bound.
pub fn platform_rate() -> String {
    format!(
        "~{:.2} DASH/MiB",
        credits_to_dash(forge_core::cost::push_fees::chunks(1024 * 1024))
    )
}

/// The `--json` block for a cost quote (shared by `cost estimate` and the write previews).
/// `usd` and `usdPrice` are `null` off mainnet ([`usd_price`]).
pub fn cost_json(credits: u64, price_usd: Option<f64>) -> Value {
    let dash = credits_to_dash(credits);
    json!({
        "credits": credits,
        "dash": dash,
        "usd": price_usd.map(|p| usd_json(dash * p)),
        "usdPrice": price_usd,
    })
}

/// A USD amount for `--json`: to a millionth of a dollar, so float noise (`0.001663926`)
/// reads `0.001664` while the smallest write still shows a cost (QW-081). `credits` is exact.
fn usd_json(usd: f64) -> f64 {
    (usd * 1_000_000.0).round() / 1_000_000.0
}

/// The `labels:`, `assignees:` and `milestone:` lines of an issue or PR view, each only when
/// set, as `gh issue view` shows them (QW2-085: assignees were missing). `assignees` are as
/// they should print (an id, or an id with its DPNS name).
pub fn triage_lines(labels: &[&str], assignees: &[String], milestone: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    if !labels.is_empty() {
        out.push(format!("labels: {}", safe(&labels.join(", "))));
    }
    // An assignee is an event's value: printed through `safe`, and a hidden (empty) one skipped.
    let assignees: Vec<String> = assignees
        .iter()
        .filter(|a| !a.is_empty())
        .map(|a| safe(a).into_owned())
        .collect();
    if !assignees.is_empty() {
        out.push(format!("assignees: {}", assignees.join(", ")));
    }
    if let Some(m) = milestone {
        out.push(format!("milestone: {}", safe(m)));
    }
    out
}

/// `rows` (records serialized as JSON objects) with `id` beside each `documentId`, as every
/// other `--json` output has it (QW-081): scripts read `id` everywhere.
pub fn with_ids<T: serde::Serialize>(rows: &[T]) -> Value {
    let mut v = serde_json::to_value(rows).unwrap_or(Value::Null);
    if let Value::Array(items) = &mut v {
        for item in items {
            if let Value::Object(o) = item {
                if let Some(id) = o.get("documentId").cloned() {
                    o.entry("id").or_insert(id);
                }
            }
        }
    }
    v
}

/// The `--json` block for `auth balance`.
pub fn balance_json(identity_id: &str, credits: u64, network: &str) -> Value {
    let dash = credits_to_dash(credits);
    json!({
        "identityId": identity_id,
        "network": network,
        "balanceCredits": credits,
        "balanceDash": dash,
    })
}

/// The line a list or view prints for documents it hid: malformed ones, and in a private
/// repository also those this reader cannot open (another epoch, written late, not sealed for
/// the repo; docs/security/private-repos.md §9 "Reading").
pub fn hidden_note(repo: &forge_core::scope::RepoRef, hidden: usize) -> String {
    if repo.visibility == Visibility::Private {
        format!(
            "({} hidden: malformed, written after a key rotation, or not readable with your keys; `dg repo keys status` explains)",
            plural(hidden, "item")
        )
    } else {
        format!("({} hidden)", plural(hidden, "malformed item"))
    }
}

/// What a private repo's event values were read as (`TargetLog::hidden_values`,
/// `plaintext_values`): a note when any label, assignee or milestone could not be shown, or is
/// not encrypted. `None` when there is nothing to say.
#[must_use]
pub fn event_values_note(hidden: usize, plaintext: usize) -> Option<String> {
    let mut parts = Vec::new();
    if hidden > 0 {
        parts.push(format!(
            "{} (labels, assignees, milestones) not readable with your keys",
            plural(hidden, "event value")
        ));
    }
    if plaintext > 0 {
        parts.push(format!(
            "{} written by an older client, not encrypted",
            plural(plaintext, "event value")
        ));
    }
    (!parts.is_empty()).then(|| format!("({})", parts.join("; ")))
}

/// What a maintainer hid (RC2 MOD), in one line: `what` ("comment", "review", "this issue")
/// "hidden by alice as spam". `shown`: the content follows (`--show-hidden`); otherwise the
/// line stands in for it and says how to read it. Nothing is deleted, so it can always be read.
#[must_use]
pub fn hidden_line(
    what: &str,
    h: &forge_core::rules::v2::Hidden,
    who: &dyn Fn(&str) -> String,
    shown: bool,
) -> String {
    let by = hidden_by(h, who);
    if shown {
        format!("[{what} {by}; shown because of --show-hidden]")
    } else {
        format!("[{what} {by}; --show-hidden to read it]")
    }
}

/// "hidden by alice as spam" (with " with its review" for an inline comment of a hidden review):
/// the words [`hidden_line`] and a listed hidden issue or PR share.
#[must_use]
pub fn hidden_by(h: &forge_core::rules::v2::Hidden, who: &dyn Fn(&str) -> String) -> String {
    let reason = h
        .reason
        .as_deref()
        .map(|r| format!(" as {r}"))
        .unwrap_or_default();
    let via = if h.via == forge_core::rules::v2::HiddenVia::Review {
        " with its review"
    } else {
        ""
    };
    format!("hidden by {}{reason}{via}", who(&h.by))
}

/// A list row a maintainer hid (`dg issue list` / `dg pr list --include-hidden`): its mark after
/// the title, "[hidden by alice as spam]".
#[must_use]
pub fn hidden_row_mark(h: &forge_core::rules::v2::Hidden, who: &dyn Fn(&str) -> String) -> String {
    format!("  [{}]", hidden_by(h, who))
}

/// `dg issue list` / `dg pr list --json`: `row` with its `hiddenBy`, the row's whole-thread hide
/// (`{by, reason, at, eventId}`, or null when it has none). Not `hidden`: the list's top-level
/// `hidden` counts malformed documents.
#[must_use]
pub fn with_hidden_by(mut row: Value, h: Option<&forge_core::rules::v2::Hidden>) -> Value {
    row["hiddenBy"] = h.map_or(
        Value::Null,
        |h| json!({ "by": h.by, "reason": h.reason, "at": h.at, "eventId": h.event_id }),
    );
    row
}

/// A list page's rows with each one's whole-thread hide (`hides`, by `$id` as `id` gives it),
/// and how many were left out: a hidden row is kept, marked, only with `include`
/// (`--include-hidden`), as the web's toggle shows it.
pub fn split_hidden<T>(
    page: impl IntoIterator<Item = T>,
    hides: &std::collections::BTreeMap<String, forge_core::rules::v2::Hidden>,
    id: impl Fn(&T) -> &str,
    include: bool,
) -> (Vec<(T, Option<&forge_core::rules::v2::Hidden>)>, usize) {
    let mut omitted = 0;
    let mut kept = Vec::new();
    for row in page {
        let hidden = hides.get(id(&row));
        if hidden.is_some() && !include {
            omitted += 1;
        } else {
            kept.push((row, hidden));
        }
    }
    (kept, omitted)
}

/// What a list page says when it left out rows maintainers hid (`omitted`, on this page only;
/// nothing when none): how many, and the flag that shows them.
#[must_use]
pub fn hidden_rows_note(omitted: usize) -> Option<String> {
    (omitted > 0).then(|| {
        format!("({omitted} hidden by maintainers on this page; --include-hidden shows them)")
    })
}

/// A hide or unhide event's timeline phrase (RC2 MOD): "hid <id> as spam", "unhid this".
#[must_use]
pub fn moderation_phrase(e: &forge_core::rules::Event) -> String {
    let hide = e.kind == forge_core::rules::EventKind::Hide;
    let verb = if hide { "hid" } else { "unhid" };
    let reason = e
        .value
        .as_deref()
        .filter(|v| hide && forge_core::rules::v2::is_hide_reason(v))
        .map(|r| format!(" as {r}"))
        .unwrap_or_default();
    match &e.ref_id {
        Some(id) => format!("{verb} {id}{reason}"),
        None => format!("{verb} this{reason}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// QW-081: every record gets `id` beside its `documentId`; one that has `id` keeps it.
    #[test]
    fn records_get_an_id_beside_their_document_id() {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Row {
            document_id: &'static str,
            name: &'static str,
        }
        let v = with_ids(&[Row {
            document_id: "D1",
            name: "build",
        }]);
        assert_eq!(
            v,
            json!([{ "documentId": "D1", "id": "D1", "name": "build" }])
        );
        let kept = with_ids(&[
            json!({ "documentId": "D1", "id": "X" }),
            json!({ "name": "n" }),
        ]);
        assert_eq!(
            kept,
            json!([{ "documentId": "D1", "id": "X" }, { "name": "n" }])
        );
    }

    /// QW2-085: labels, assignees and milestone, each only when set.
    #[test]
    fn triage_lines_show_what_is_set() {
        let lines = triage_lines(
            &["bug", "docs"],
            &["alice.dash (A1b2c3d…Xw9Yz)".into(), "B".into()],
            Some("v1.0"),
        );
        assert_eq!(
            lines,
            vec![
                "labels: bug, docs",
                "assignees: alice.dash (A1b2c3d…Xw9Yz), B",
                "milestone: v1.0"
            ]
        );
        assert!(triage_lines(&[], &[], None).is_empty());
        // A hidden (empty) assignee is skipped; a control character never reaches the terminal.
        assert_eq!(
            triage_lines(&[], &[String::new(), "B".into()], None),
            vec!["assignees: B"]
        );
        assert!(!triage_lines(&[], &["B\u{1b}[2J".into()], None)[0].contains('\u{1b}'));
    }

    /// QW-081: the `usd` of a cost carries no float noise.
    #[test]
    fn a_cost_in_usd_has_no_float_noise() {
        let v = cost_json(95_093_000, Some(30.0));
        assert_eq!(v["usd"].as_f64(), Some(0.028_528));
        // the smallest writes still read as a cost, not as free
        assert_eq!(
            cost_json(100_000, Some(30.0))["usd"].as_f64(),
            Some(0.00003)
        );
        assert_eq!(v["credits"].as_u64(), Some(95_093_000));
        assert_eq!(cost_json(0, Some(30.0))["usd"].as_f64(), Some(0.0));
    }

    /// QW-083: an id with a DPNS name shows it; one without (or whose read failed) is bare.
    #[test]
    fn an_identity_shows_its_dpns_name_when_it_has_one() {
        let id = "Fi8bQ2xkPqR7sT9uVwXyZ1a2b3c4d5e6f7g8h9i0jKL";
        let names = [
            ("A1".to_string(), "alice.dash\u{1b}[2J".to_string()),
            (id.to_string(), "bob.dash".to_string()),
        ]
        .into();
        assert_eq!(with_name("A1", &names), "alice.dash[2J (A1)");
        assert_eq!(with_name(id, &names), "bob.dash (Fi8bQ2x\u{2026}i0jKL)");
        assert_eq!(with_name("B2", &names), "B2");
        // Both ends, by character: a short or non-ASCII value never splits inside a character.
        assert_eq!(short_identity("abcdefghijklm"), "abcdefghijklm");
        assert_eq!(short_identity("ééééééé-x-ééééé"), "ééééééé\u{2026}ééééé");
    }

    /// The timeline's words for each transition kind (the web's), and how a state change was
    /// written.
    #[test]
    fn transitions_read_as_the_web_timeline() {
        for (kind, words) in [
            (1, "closed this"),
            (2, "reopened this"),
            (11, "closed this"),
            (12, "reopened this"),
            (13, "merged this"),
            (14, "marked this as draft"),
            (15, "marked this ready for review"),
            (16, "closed this"),
            (17, "reopened this"),
            (99, "changed the state"),
        ] {
            assert_eq!(transition_phrase(kind), words, "kind {kind}");
        }
        assert_eq!(
            transition_route_text(forge_core::collab::v2::StateRoute::Author),
            "as the author (transition)"
        );
        assert_eq!(
            transition_route_text(forge_core::collab::v2::StateRoute::Member),
            "as a member (transition)"
        );
    }

    /// A list page's issues or PRs as `dg issue list` / `dg pr list` fold them: the rows'
    /// thread hides by the shared fold, then left out or marked.
    fn listed_hides(
        include: bool,
    ) -> (
        Vec<(&'static str, Option<forge_core::rules::v2::Hidden>)>,
        usize,
    ) {
        use forge_core::collab::moderation::{hidden_threads_of, Hiders};
        use forge_core::collab::v2::{Target, TargetKind};
        use forge_core::rules::{Event, EventKind};
        let ev = |id: &str, on: &str, kind, actor: &str, at| Event {
            id: id.into(),
            target_id: on.into(),
            kind,
            actor: actor.into(),
            value: Some("spam".into()),
            oid: None,
            ref_id: None,
            created_at: at,
        };
        let target = |id: &str, number| Target {
            kind: TargetKind::Issue,
            id: id.into(),
            number,
            author: "bob".into(),
        };
        // A: hidden by a maintainer; B: hidden, then unhidden; C: a writer's hide (no proof);
        // D: no events; E: hidden by the owner.
        let a = [ev("e1", "A", EventKind::Hide, "alice", 1)];
        let b = [
            ev("e2", "B", EventKind::Hide, "alice", 1),
            ev("e3", "B", EventKind::Unhide, "alice", 2),
        ];
        let c = [ev("e4", "C", EventKind::Hide, "wendy", 1)];
        let e = [ev("e5", "E", EventKind::Hide, "own", 1)];
        let rows: Vec<(Target, &[Event])> = vec![
            (target("A", 1), &a),
            (target("B", 2), &b),
            (target("C", 3), &c),
            (target("D", 4), &[]),
            (target("E", 5), &e),
        ];
        let counted = Hiders {
            owner: "own".into(),
            maintainers: ["alice".to_string()].into(),
            proved: false,
        };
        let hides = hidden_threads_of(&rows, &counted);
        let (kept, omitted) = split_hidden(["A", "B", "C", "D", "E"], &hides, |r| r, include);
        let kept = kept.into_iter().map(|(r, h)| (r, h.cloned())).collect();
        (kept, omitted)
    }

    #[test]
    fn a_list_leaves_out_what_maintainers_hid() {
        let (kept, omitted) = listed_hides(false);
        // an unhide after a hide shows B; a writer's hide without the proof does not hide C
        assert_eq!(
            kept.iter().map(|(r, _)| *r).collect::<Vec<_>>(),
            ["B", "C", "D"]
        );
        assert!(kept.iter().all(|(_, h)| h.is_none()));
        assert_eq!(omitted, 2);
        assert_eq!(
            hidden_rows_note(omitted).as_deref(),
            Some("(2 hidden by maintainers on this page; --include-hidden shows them)")
        );
        assert_eq!(hidden_rows_note(0), None);
    }

    #[test]
    fn include_hidden_marks_the_rows_it_shows() {
        let (kept, omitted) = listed_hides(true);
        assert_eq!(omitted, 0);
        assert_eq!(kept.len(), 5);
        let marked: Vec<_> = kept
            .iter()
            .filter_map(|(r, h)| h.as_ref().map(|h| (*r, h.by.as_str())))
            .collect();
        assert_eq!(marked, [("A", "alice"), ("E", "own")]);
        let names: std::collections::BTreeMap<String, String> =
            [("alice".to_string(), "alice.dash".to_string())].into();
        let who = |id: &str| with_name(id, &names);
        let a = kept[0].1.as_ref().expect("A is hidden");
        assert_eq!(
            hidden_row_mark(a, &who),
            format!("  [hidden by {} as spam]", with_name("alice", &names))
        );
        assert_eq!(
            with_hidden_by(json!({ "number": 1 }), Some(a)),
            json!({
                "number": 1,
                "hiddenBy": { "by": "alice", "reason": "spam", "at": 1, "eventId": "e1" }
            })
        );
        assert_eq!(
            with_hidden_by(json!({ "number": 4 }), None),
            json!({ "number": 4, "hiddenBy": null })
        );
    }

    #[test]
    fn event_values_note_says_what_it_counts() {
        assert_eq!(event_values_note(0, 0), None);
        let n = event_values_note(2, 1).unwrap();
        assert!(
            n.contains("2 event values") && n.contains("1 event value "),
            "{n}"
        );
        assert!(n.contains("not encrypted"), "{n}");
    }

    #[test]
    fn short_never_splits_a_character() {
        assert_eq!(short(&"a".repeat(40)), "a".repeat(12));
        assert_eq!(short("abc"), "abc");
        assert_eq!(short(&"é".repeat(20)), "é".repeat(12));
    }

    #[test]
    fn terminal_text_loses_escape_sequences() {
        assert_eq!(safe("plain\ntext\t!"), "plain\ntext\t!");
        assert_eq!(safe("red\u{1b}[31mX\u{7}\u{9b}2J"), "red[31mX2J");
    }

    #[test]
    fn dash_amount_trims_trailing_zeros() {
        assert_eq!(dash_amount(1.18), "1.18");
        assert_eq!(dash_amount(0.000_3), "0.0003");
        assert_eq!(dash_amount(0.0), "0");
        assert_eq!(dash_amount(2.0), "2");
    }

    #[test]
    fn credits_convert_to_dash() {
        assert!((credits_to_dash(CREDITS_PER_DASH) - 1.0).abs() < 1e-12);
        assert!((credits_to_dash(118_000_000_000) - 1.18).abs() < 1e-9);
    }

    #[test]
    fn cost_line_shows_dash_primary_usd_secondary() {
        // 1 MiB storage deposit ≈ 0.283 DASH.
        let line = cost_line(118_000_000_000, Some(30.0));
        assert!(line.starts_with("~1.18 DASH"), "line was {line}");
        assert!(line.contains("$35.40"), "line was {line}");
        // A forge-v2 repo create is quoted well under a cent of a DASH.
        const { assert!(REPO_CREATE_ESTIMATE_CREDITS < forge_core::cost::CREDITS_PER_DASH / 100) };
    }

    #[test]
    fn cost_json_shape_has_credits_dash_usd() {
        let v = cost_json(118_000_000_000, Some(30.0));
        assert_eq!(v["credits"], 118_000_000_000_u64);
        assert!((v["dash"].as_f64().unwrap() - 1.18).abs() < 1e-9);
        assert!((v["usd"].as_f64().unwrap() - 35.4).abs() < 1e-6);
    }

    #[test]
    fn balance_json_shape() {
        let v = balance_json("abc123", 250_000_000_000, "testnet");
        assert_eq!(v["identityId"], "abc123");
        assert_eq!(v["network"], "testnet");
        assert_eq!(v["balanceCredits"], 250_000_000_000_u64);
        assert!((v["balanceDash"].as_f64().unwrap() - 2.5).abs() < 1e-9);
    }

    #[test]
    fn price_env_override_is_respected() {
        std::env::set_var("DASH_USD", "42.5");
        assert_eq!(usd_price(&Network::Mainnet), Some(42.5));
        std::env::remove_var("DASH_USD");
        assert_eq!(usd_price(&Network::Mainnet), Some(FALLBACK_DASH_USD));
    }

    /// Prices are shown to three significant figures, plurals are spelled out.
    #[test]
    fn prices_round_and_plurals_spell_out() {
        assert_eq!(cost_line(1_017_812_000, None), "~0.0102 DASH");
        assert_eq!(cost_line(97_600_000, None), "~0.000976 DASH");
        // A fee too small for eight decimals still shows, never as ~0.
        assert_eq!(cost_line(400, None), "~0.000000004 DASH");
        assert_eq!(cost_line(0, None), "~0 DASH");
        assert_eq!(cost_line(50_000_000_000, None), "~0.5 DASH");
        assert_eq!(cost_line(517_499_000, None), "~0.00517 DASH");
        assert_eq!(cost_line(104_000_000, None), "~0.00104 DASH");
        assert_eq!(cost_line(3_254_000_000_000, None), "~32.5 DASH");
        assert_eq!(cost_line(12_345_000_000_000, None), "~123 DASH");
        // `dg cost` keeps every credit, so its rows add up to the total.
        assert_eq!(dash_exact(1_500), "0.000000015");
        assert_eq!(dash_exact(3), "0.00000000003");
        assert_eq!(dash_exact(150_000_000_000), "1.5");
        assert_eq!(dash_exact(200_000_000_000), "2");
        assert_eq!(dash_exact(0), "0");
        assert_eq!(cost_line_exact(1_017_812_000, None), "~0.01017812 DASH");
        assert_eq!(plural(1u64, "asset"), "1 asset");
        assert_eq!(plural(0u64, "asset"), "0 assets");
        assert_eq!(plural(3usize, "asset"), "3 assets");
        assert_eq!(plural_with(2u64, "identity", "identities"), "2 identities");
    }

    /// QW2-075: devnet and testnet DASH has no cash value, so no dollar figure is shown for it,
    /// whatever `DASH_USD` says.
    #[test]
    fn test_dash_has_no_usd_value() {
        let devnet = Network::Devnet {
            name: "sakura".into(),
            dapi_addresses: Vec::new(),
            quorum_base_url: None,
        };
        for network in [Network::Testnet, devnet] {
            assert_eq!(usd_price(&network), None, "{network:?}");
        }
        let line = cost_line(1_017_812_000, None);
        assert_eq!(line, "~0.0102 DASH");
        let v = cost_json(1_017_812_000, None);
        assert!(v["usd"].is_null() && v["usdPrice"].is_null(), "{v}");
        assert_eq!(v["credits"].as_u64(), Some(1_017_812_000));
    }
}

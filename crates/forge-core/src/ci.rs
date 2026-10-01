//! CI on forge-v2 (`docs/design/platform-parity-spec.md` §2): runner memberships and check runs.
//!
//! * **Runner** = a forge-community `runner` document (RC1 O-02 moved it out of forge-core) `{repoId, memberId}`. Only the repo owner can
//!   create it (`propertyAgreement {"$ownerId": "$ownerId"}` against `repo`, like `maintainer`),
//!   the `(repoId, memberId)` index is unique, and deleting it revokes the runner: the checkRun
//!   gate (`ownerRefersTo anyOf [runner, maintainer, writer]`) refuses its next create or
//!   replace at consensus (40120).
//! * **Check run** = a forge-community `checkRun` `{repoId, headOid, name, status, conclusion?, …}`,
//!   mutable, with `[repoId, headOid, name, vis]` immutable. The newest per `(headOid, name)` by
//!   `($createdAt, $id)` is what readers show ([`crate::collab::v2::newest_check_runs`]), so a
//!   run's progress (`queued → in_progress → completed`) is a **replace** of the reporter's own
//!   document, and a re-run of the same check on the same commit is a new document. The
//!   contract's monotonic rules (D-5) pin `startedAt` / `completedAt` / `conclusion` /
//!   `externalId` once set and tie them to the status; [`check_run_write`] decides each write
//!   so they hold: `startedAt` on the first report that is not `queued`, `completedAt` on the
//!   first `completed` one, a stored time never changed, and a report that would move a run
//!   backwards or change its conclusion is a new run. RC2 (S1, Platform v5's conditional
//!   `immutable`) also freezes a completed run's evidence (`summary`, `detailsUrl`, `logUrl`,
//!   `logSha256`, `artifacts`; [`EVIDENCE_FIELDS`]): a report that continues a completed run
//!   leaves them as stored ([`ReportPlan::evidence_frozen`]).
//! * **The runner's key** is AUTHENTICATION / HIGH bound to `(forge-community, checkRun)`
//!   ([`ContractBounds::SingleContractDocumentType`], admitted on AUTHENTICATION keys from protocol
//!   14), with a budget and an expiry: consensus refuses anything else it signs with 20014
//!   (`ContractBoundedKeyOutOfBoundsError`), and a non-batch transition with
//!   `ContractBoundedKeyNonBatchError`.
//!
//! * **RC1** (`forge-contracts/contracts/forge-community.json`): every write carries `outcome`
//!   ([`outcome_of`]: 0 pending, 1 passed, 2 failed; `outcomeOf` binds it to the status and
//!   conclusion, so a replace sets it again) and a create carries the `vis` stamp (immutable;
//!   `repoId`'s `where` proves it equals the repository's visibility). Times are ms (`msEpoch`),
//!   a completion never precedes its start (`doneAfterStart`) and no time is from the future
//!   (`notFuture`: at most `$updatedAt` + 1 h), so a time the CI gives is capped at the
//!   reporter's clock. `detailsUrl` is https and `logUrl` https or `ipfs://`
//!   ([`is_details_url`], [`is_log_url`]). A **private** repository's run carries no summary,
//!   details link, log, artifacts or external id (`privateNoText`):
//!   [`CheckReport::for_visibility`] drops them and names what it dropped, so a caller warns
//!   instead of failing the report; such a run is matched by name, as it has no external id.
//!
//! Contract lookups go through [`RepoRef::forge`] (`community` for `checkRun` and `runner`), so
//! moving either type to another contract is a deployment-file change here.
//!
//! [`ContractBounds::SingleContractDocumentType`]: dash_sdk::dpp::identity::contract_bounds::ContractBounds

use std::collections::BTreeMap;

use serde::Serialize;

use crate::collab::doc_engine;
use crate::collab::v2::{check_run_docs, DOC_CHECK_RUN};
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::layout;
use crate::members;
use crate::platform::{
    self, FetchedDocument, FieldValue, LoadedContract, LoadedIdentity, PlatformClient, QueryOrder,
};
use crate::rules::v2::{
    check_run_write, Role, RunReport, RunWrite, RunWriteAction, StoredRun, Visibility,
    PASSING_CONCLUSIONS,
};
use crate::scope::RepoRef;

/// forge-community: a CI runner's membership of a repo.
pub const DOC_RUNNER: &str = "runner";

/// `status` values (the schema's enum).
pub const STATUSES: [&str; 3] = ["queued", "in_progress", "completed"];

/// `conclusion` values (the schema's enum: GitHub's set).
pub const CONCLUSIONS: [&str; 8] = [
    "success",
    "failure",
    "neutral",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "stale",
];

/// Field caps from the `checkRun` schema (`maxLength` in characters, `maxBytes` in UTF-8 bytes).
const NAME_MAX: (usize, usize) = (100, 200);
const URL_MAX: (usize, usize) = (300, 300);
const SUMMARY_MAX: (usize, usize) = (1000, 2000);
const EXTERNAL_ID_MAX: (usize, usize) = (120, 120);
const ARTIFACTS_MAX: (usize, usize) = (4096, 4096);

/// The smallest `startedAt` the contract accepts (`msEpoch`): times are milliseconds, and a
/// time in seconds is far below this.
pub const MS_EPOCH: u64 = 1_000_000_000_000;

/// The fields a private repository's run cannot carry (`privateNoText`), by property name.
pub const PRIVATE_TEXT_FIELDS: [&str; 5] =
    ["summary", "detailsUrl", "logUrl", "artifacts", "externalId"];

/// A run's set-once fields, by property name: forge-community freezes each once it is set
/// (`immutableAllowSetting` on RC1, `"when": {"present": "$old.<field>"}` on RC2), and
/// [`check_run_write`] only ever sets them on a run that does not hold them yet.
pub const SET_ONCE_FIELDS: [&str; 4] = ["startedAt", "completedAt", "conclusion", "externalId"];

/// A completed run's evidence, by property name. RC2 forge-community (S1) freezes these once the
/// stored run is `completed` (`immutable` entries with `"when": {"equal": ["$old.status",
/// {"const": "completed"}]}`), and consensus refuses a replace that changes one with 40128
/// (`DocumentImmutablePropertyChangedError`). So a report that continues a completed run (the
/// same completion again, such as a runner's retry after an ambiguous failure) leaves them as
/// stored: [`CheckReport::replace_changes`].
pub const EVIDENCE_FIELDS: [&str; 5] =
    ["summary", "detailsUrl", "logUrl", "logSha256", "artifacts"];

/// Whether `stored`'s [`EVIDENCE_FIELDS`] are final: it is a completed run, and `community`
/// freezes them (S1 is a build flag: a contract without it leaves them editable).
#[must_use]
pub fn evidence_frozen(community: &LoadedContract, stored: &FetchedDocument) -> bool {
    stored.field_str("status").as_deref() == Some("completed")
        && EVIDENCE_FIELDS
            .iter()
            .any(|f| community.freezes_when(DOC_CHECK_RUN, f))
}

/// A `checkRun`'s `outcome` (`outcomeOf`): 0 while the run is not completed, 1 for a completed
/// run that passed (`success`, `neutral`, `skipped`), 2 for any other conclusion.
#[must_use]
pub fn outcome_of(status: &str, conclusion: Option<&str>) -> u64 {
    if status != "completed" {
        0
    } else if conclusion.is_some_and(|c| PASSING_CONCLUSIONS.contains(&c)) {
        1
    } else {
        2
    }
}

/// POSIX `[[:space:]]` (ASCII): what the contract's URL patterns refuse anywhere.
fn is_posix_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r')
}

/// `rest` is empty, or starts with `/`, `?` or `#` and holds no whitespace: the patterns'
/// `([/?#][^[:space:]]*)?$` tail.
pub(crate) fn is_url_tail(rest: &str) -> bool {
    rest.is_empty() || (rest.starts_with(['/', '?', '#']) && !rest.contains(is_posix_space))
}

/// An `https://` URL split into its authority (up to the first `/`, `?` or `#`) and the rest.
pub(crate) fn split_https(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("https://")?;
    Some(rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len())))
}

/// Whether the contract's `checkRun.detailsUrl` pattern admits `url`:
/// `^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$` (https only, no userinfo, no whitespace;
/// an IP host is allowed, for a self-hosted CI).
#[must_use]
pub fn is_details_url(url: &str) -> bool {
    split_https(url).is_some_and(|(host, tail)| {
        !host.is_empty() && !host.contains(|c| c == '@' || is_posix_space(c)) && is_url_tail(tail)
    })
}

/// Whether the contract's `checkRun.logUrl` pattern admits `url`: an https URL as
/// [`is_details_url`], or `ipfs://<alphanumeric CID>` with the same optional tail:
/// `^(https://[^[:space:]/?#@]+|ipfs://[A-Za-z0-9]+)([/?#][^[:space:]]*)?$`.
#[must_use]
pub fn is_log_url(url: &str) -> bool {
    if let Some(rest) = url.strip_prefix("ipfs://") {
        let end = rest
            .find(|c: char| !c.is_ascii_alphanumeric())
            .unwrap_or(rest.len());
        let (cid, tail) = rest.split_at(end);
        return !cid.is_empty() && is_url_tail(tail);
    }
    is_details_url(url)
}

/// One runner membership of a repo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runner {
    /// The runner identity (base58).
    pub identity_id: String,
    /// The membership document's id (what a revoke deletes).
    pub document_id: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

impl Runner {
    fn from_doc(doc: &FetchedDocument) -> Option<Self> {
        Some(Self {
            identity_id: platform::encode_identifier(doc.field_bytes32("memberId")?),
            document_id: doc.id.clone(),
            created_at: doc.created_at.unwrap_or(0),
        })
    }
}

/// Reads of a repo's runner memberships (no key needed).
pub struct RunnerReader<'a> {
    client: &'a PlatformClient,
}

impl<'a> RunnerReader<'a> {
    /// A reader over `client`.
    pub fn new(client: &'a PlatformClient) -> Self {
        Self { client }
    }

    /// Every current runner of `repo`, complete.
    pub async fn list(&self, repo: &RepoRef) -> Result<Vec<Runner>> {
        let docs = members::membership_docs(
            self.client,
            repo,
            DOC_RUNNER,
            &[QueryOrder::asc("repoId"), QueryOrder::asc("memberId")],
        )
        .await?;
        Ok(docs.iter().filter_map(Runner::from_doc).collect())
    }

    /// `identity`'s runner membership of `repo`, if any (the index is unique).
    pub async fn get(&self, repo: &RepoRef, identity: &str) -> Result<Option<Runner>> {
        Ok(
            members::membership_doc(self.client, repo, DOC_RUNNER, identity)
                .await?
                .as_ref()
                .and_then(Runner::from_doc),
        )
    }
}

/// Runner membership writes, signed by the repo owner.
pub struct RunnerService<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
}

impl<'a> RunnerService<'a> {
    /// Bind to the owner identity and its keys.
    pub fn new(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
    ) -> Self {
        Self {
            client,
            identity,
            bridge,
        }
    }

    fn require_owner(&self, repo: &RepoRef) -> Result<()> {
        if repo.owner_id() != self.identity.id() {
            return Err(Error::NotPermitted {
                action: format!("change the runners of {}", repo.display()),
                reason: format!(
                    "only its owner ({}) can enrol or revoke a runner",
                    repo.owner_id()
                ),
                needs: "owner".into(),
            });
        }
        Ok(())
    }

    /// Enrol `member` as a runner of `repo`. Idempotent: an existing membership is returned and
    /// nothing is written.
    pub async fn enrol(&self, repo: &RepoRef, member: &str) -> Result<Runner> {
        self.require_owner(repo)?;
        let reader = RunnerReader::new(self.client);
        if let Some(existing) = reader.get(repo, member).await? {
            return Ok(existing);
        }
        let community = self.client.fetch_contract(&repo.forge().community).await?;
        let props = repo.scope()?.props([(
            "memberId",
            FieldValue::identifier(platform::decode_identifier(member)?),
        )]);
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        match engine.create_document(&community, DOC_RUNNER, props).await {
            Ok(document_id) => Ok(Runner {
                identity_id: member.to_string(),
                document_id,
                created_at: 0,
            }),
            // A concurrent enrol won the unique index: read it back.
            Err(Error::DuplicateUniqueIndex(_)) => {
                reader.get(repo, member).await?.ok_or(Error::NotFound)
            }
            Err(e) => Err(e),
        }
    }

    /// Revoke `member`'s runner membership. Returns whether one existed.
    pub async fn revoke(&self, repo: &RepoRef, member: &str) -> Result<bool> {
        self.require_owner(repo)?;
        let Some(existing) = RunnerReader::new(self.client).get(repo, member).await? else {
            return Ok(false);
        };
        let community = self.client.fetch_contract(&repo.forge().community).await?;
        doc_engine(self.client, self.identity, self.bridge)?
            .delete_document(&community, DOC_RUNNER, &existing.document_id)
            .await?;
        Ok(true)
    }
}

/// What a report says about one check on one commit.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CheckReport {
    /// The commit (hex, 40 or 64 digits).
    pub head_oid: String,
    /// The check's name (`build`, `test`).
    pub name: String,
    /// `queued`, `in_progress` or `completed`.
    pub status: String,
    /// Required exactly when `status` is `completed` (the contract's `conclusionIfDone` /
    /// `doneIfConclusion` rules).
    pub conclusion: Option<String>,
    /// A link to the run's details (https).
    pub details_url: Option<String>,
    /// A short summary (≤ 1000 characters).
    pub summary: Option<String>,
    /// The CI's own run id: a report with the same `externalId` updates that run in place
    /// instead of starting a new one.
    pub external_id: Option<String>,
    /// When the run started (ms), when the CI says; else the report's time is used, on the
    /// first report that is not `queued` ([`check_run_write`]).
    pub started_at: Option<u64>,
    /// When the run completed (ms), when the CI says; else the report's time, on the first
    /// `completed` report.
    pub completed_at: Option<u64>,
    /// The log's URL and SHA-256 (both or neither: `dependentRequired`).
    pub log: Option<(String, [u8; 32])>,
    /// `[{name, url, sha256, size}]` JSON (≤ 4096 bytes).
    pub artifacts: Option<String>,
}

fn check_text(field: &str, value: &str, (chars, bytes): (usize, usize)) -> Result<()> {
    if value.is_empty() {
        return Err(Error::Config(format!("{field} is empty")));
    }
    let n = value.chars().count();
    if n > chars || value.len() > bytes {
        return Err(Error::Config(format!(
            "{field} is too long ({n} characters, {} bytes; the most is {chars} characters, {bytes} bytes)",
            value.len()
        )));
    }
    Ok(())
}

impl CheckReport {
    /// Refuse, before anything is signed, what consensus would refuse: an unknown status or
    /// conclusion, a conclusion without `completed` (or the reverse), an oversized field, a
    /// bad oid. Returns the oid's bytes.
    pub fn validate(&self) -> Result<Vec<u8>> {
        let oid = hex::decode(&self.head_oid)
            .ok()
            .filter(|b| b.len() == 20 || b.len() == 32)
            .ok_or_else(|| {
                Error::Config(format!(
                    "{:?} is not a commit id (40 or 64 hex digits)",
                    self.head_oid
                ))
            })?;
        check_text("the check name", &self.name, NAME_MAX)?;
        if !STATUSES.contains(&self.status.as_str()) {
            return Err(Error::Config(format!(
                "status {:?} is not one of {}",
                self.status,
                STATUSES.join(", ")
            )));
        }
        match (&self.conclusion, self.status == "completed") {
            (Some(c), true) if CONCLUSIONS.contains(&c.as_str()) => {}
            (Some(c), true) => {
                return Err(Error::Config(format!(
                    "conclusion {c:?} is not one of {}",
                    CONCLUSIONS.join(", ")
                )))
            }
            (None, true) => {
                return Err(Error::Config(
                    "a completed run needs a conclusion (--conclusion success|failure|…)".into(),
                ))
            }
            (Some(_), false) => {
                return Err(Error::Config(format!(
                    "a conclusion is only for a completed run (status is {})",
                    self.status
                )))
            }
            (None, false) => {}
        }
        if let Some(u) = &self.details_url {
            check_text("the details URL", u, URL_MAX)?;
            if !is_details_url(u) {
                return Err(Error::Config(format!(
                    "the details URL {u:?} must be an https:// link with a host, no \
                     user:password@ and no spaces"
                )));
            }
        }
        if let Some(s) = &self.summary {
            check_text("the summary", s, SUMMARY_MAX)?;
        }
        if let Some(x) = &self.external_id {
            check_text("the external id", x, EXTERNAL_ID_MAX)?;
        }
        if let Some((u, _)) = &self.log {
            check_text("the log URL", u, URL_MAX)?;
            if !is_log_url(u) {
                return Err(Error::Config(format!(
                    "the log URL {u:?} must be https:// (with a host, no user:password@) or \
                     ipfs://"
                )));
            }
        }
        if let Some(a) = &self.artifacts {
            check_text("the artifacts list", a, ARTIFACTS_MAX)?;
        }
        for (what, t) in [
            ("start", self.started_at),
            ("completion", self.completed_at),
        ] {
            if let Some(t) = t.filter(|t| *t < MS_EPOCH) {
                return Err(Error::Config(format!(
                    "the {what} time {t} is not in milliseconds since 1970 (a time in seconds?)"
                )));
            }
        }
        Ok(oid)
    }

    /// This report as a repository of `visibility` can take it, and the fields it left out. A
    /// private repository's run carries no summary, details link, log, artifacts or external
    /// id (the contract's `privateNoText`): they are dropped (named as in
    /// [`PRIVATE_TEXT_FIELDS`]) rather than refused, so a CI that reports the same way
    /// everywhere still records its status and conclusion, and the caller warns. A public
    /// repository's report is unchanged.
    #[must_use]
    pub fn for_visibility(&self, visibility: Visibility) -> (CheckReport, Vec<&'static str>) {
        let mut r = self.clone();
        let mut dropped = Vec::new();
        if visibility == Visibility::Private {
            for (name, present) in [
                ("summary", r.summary.take().is_some()),
                ("detailsUrl", r.details_url.take().is_some()),
                ("logUrl", r.log.take().is_some()),
                ("artifacts", r.artifacts.take().is_some()),
                ("externalId", r.external_id.take().is_some()),
            ] {
                if present {
                    dropped.push(name);
                }
            }
        }
        (r, dropped)
    }

    /// What the monotonic rules read of this report at `now_ms`. A time the CI gives is capped
    /// at the reporter's clock: the contract refuses a time more than an hour past the block's
    /// (`notFuture`), and a CI host's clock may run ahead of this one.
    fn run_report(&self, now_ms: u64) -> RunReport {
        RunReport {
            status: self.status.clone(),
            conclusion: self.conclusion.clone(),
            started_at: self.started_at.map(|t| t.min(now_ms)),
            completed_at: self.completed_at.map(|t| t.min(now_ms)),
            external_id: self.external_id.clone(),
        }
    }

    /// This report's `outcome` ([`outcome_of`]).
    #[must_use]
    pub fn outcome(&self) -> u64 {
        outcome_of(&self.status, self.conclusion.as_deref())
    }

    /// The write this report makes against `stored` (the run [`run_to_update`] picked, or
    /// none) at `now_ms`: create or replace, and the set-once fields it sets
    /// ([`check_run_write`]). `None` for a report the contract refuses (an unknown status, a
    /// conclusion without `completed` or the reverse): [`Self::validate`] refuses it first.
    #[must_use]
    pub fn write(&self, stored: Option<&FetchedDocument>, now_ms: u64) -> Option<RunWrite> {
        let stored = stored.map(stored_run);
        check_run_write(stored.as_ref(), &self.run_report(now_ms), now_ms)
    }

    /// The full property set a create carries (the scope adds `repoId`): the `vis` stamp of a
    /// repository of `visibility`, the status and outcome, the set-once fields `w` sets, and
    /// everything else this report gives.
    pub(crate) fn create_props(
        &self,
        oid: Vec<u8>,
        w: &RunWrite,
        visibility: Visibility,
    ) -> BTreeMap<String, FieldValue> {
        let mut p = BTreeMap::from([
            ("headOid".to_string(), FieldValue::bytes(oid)),
            ("name".to_string(), FieldValue::text(&self.name)),
        ]);
        layout::stamp_vis(&mut p, visibility);
        p.extend(
            self.changes(w)
                .into_iter()
                .filter_map(|(k, v)| v.map(|v| (k, v))),
        );
        p
    }

    /// What a write of this report sets (never removes: the monotonic fields are set once,
    /// and a report that would clear one is a new run, [`check_run_write`]):
    ///
    /// * `status` and `outcome` always (`outcomeOf` ties the outcome to the status).
    /// * `startedAt`, `completedAt`, `conclusion`, `externalId` as `w` says: only those the
    ///   stored run does not hold yet.
    /// * Everything else this report gives replaces what is stored; what it does not give stays.
    ///
    /// `vis` is immutable: a create sets it ([`Self::create_props`]) and a replace keeps it.
    pub(crate) fn changes(&self, w: &RunWrite) -> BTreeMap<String, Option<FieldValue>> {
        let text = |v: &Option<String>| v.as_deref().map(FieldValue::text);
        let mut c = BTreeMap::from([
            ("status".to_string(), Some(FieldValue::text(&self.status))),
            (
                "outcome".to_string(),
                Some(FieldValue::integer(self.outcome())),
            ),
        ]);
        let set = [
            ("startedAt", w.started_at.map(FieldValue::integer)),
            ("completedAt", w.completed_at.map(FieldValue::integer)),
            ("conclusion", text(&w.conclusion)),
            ("externalId", text(&w.external_id)),
            ("detailsUrl", text(&self.details_url)),
            ("summary", text(&self.summary)),
            ("artifacts", text(&self.artifacts)),
        ];
        c.extend(
            set.into_iter()
                .filter_map(|(k, v)| v.map(|v| (k.to_string(), Some(v)))),
        );
        if let Some((u, h)) = &self.log {
            c.insert("logUrl".into(), Some(FieldValue::text(u)));
            c.insert("logSha256".into(), Some(FieldValue::bytes(h.to_vec())));
        }
        c
    }

    /// What a replace sets: [`Self::changes`], less the [`EVIDENCE_FIELDS`] when `frozen` (the
    /// stored run already completed, and the contract freezes them: [`evidence_frozen`]). Those
    /// stay as stored, so the same completion reported again writes nothing new rather than
    /// being refused at consensus.
    pub(crate) fn replace_changes(
        &self,
        w: &RunWrite,
        frozen: bool,
    ) -> BTreeMap<String, Option<FieldValue>> {
        let mut c = self.changes(w);
        if frozen {
            for f in EVIDENCE_FIELDS {
                c.remove(f);
            }
        }
        c
    }
}

/// A stored `checkRun` as the monotonic rules read it.
fn stored_run(d: &FetchedDocument) -> StoredRun {
    StoredRun {
        status: d.field_str("status").unwrap_or_default(),
        started_at: d.field_u64("startedAt"),
        completed_at: d.field_u64("completedAt"),
        conclusion: d.field_str("conclusion"),
        external_id: d.field_str("externalId"),
    }
}

/// The run a report updates in place, among `docs` (the head's `checkRun` documents): the
/// reporter's own newest run of that name ([`newest_run`]), when the report continues it
/// ([`check_run_write`] answers a replace). A report that would move it backwards (a re-run
/// queued after it started or completed) or change its conclusion is a new run: `None`.
pub fn run_to_update<'d>(
    docs: &'d [FetchedDocument],
    reporter: &str,
    report: &CheckReport,
) -> Option<&'d FetchedDocument> {
    let newest = newest_run(docs, reporter, report)?;
    // Only the action is read: no time is capped (the report's times never decide it).
    report
        .write(Some(newest), u64::MAX)
        .is_some_and(|w| w.action == RunWriteAction::Replace)
        .then_some(newest)
}

/// The reporter's newest run that `report` names (by name, and by `externalId` when it gives
/// one), whether or not the report may update it.
fn newest_run<'d>(
    docs: &'d [FetchedDocument],
    reporter: &str,
    report: &CheckReport,
) -> Option<&'d FetchedDocument> {
    docs.iter()
        .filter(|d| d.owner_id == reporter && d.field_str("name").as_deref() == Some(&report.name))
        .filter(|d| report.external_id.is_none() || d.field_str("externalId") == report.external_id)
        .max_by(|a, b| (a.created_at.unwrap_or(0), &a.id).cmp(&(b.created_at.unwrap_or(0), &b.id)))
}

/// What [`CheckRuns::report`] did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reported {
    /// The `checkRun` document's id.
    pub document_id: String,
    /// `created`, `updated`, or `unchanged` (the stored run already said this).
    pub action: &'static str,
}

/// Check-run reports, signed by a runner (or a maintainer / writer).
pub struct CheckRuns<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
}

impl<'a> CheckRuns<'a> {
    /// Sign as `identity`.
    pub fn new(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
    ) -> Self {
        Self {
            client,
            identity,
            bridge,
        }
    }

    /// Decide what `report` will do on `repo`, before anything is signed: replace the run it
    /// updates ([`run_to_update`]), else create one. Reads the `checkRun` index
    /// `head (repoId, headOid, $createdAt)`. A report with an `externalId` that matches no run
    /// at all reads once more after a short pause: a run created a moment ago may not be on the
    /// node this read reached yet, and a second create would split the run in two. A match that
    /// may not be updated (completed, or a re-queue of a started run) is a new run at once.
    ///
    /// On a private repository the report's text is dropped first
    /// ([`CheckReport::for_visibility`]; [`ReportPlan::dropped`] names it), so its run is
    /// matched by name: it has no external id.
    pub async fn plan(&self, repo: &RepoRef, report: &CheckReport) -> Result<ReportPlan> {
        // A report that names its run (by external id, even one a private repository drops)
        // continues one that may have been created a moment ago.
        let names_its_run = report.external_id.is_some();
        let (report, dropped) = report.for_visibility(repo.visibility);
        let report = &report;
        let oid = report.validate()?;
        let community = self.client.fetch_contract(&repo.forge().community).await?;
        let me = self.identity.id();
        self.require_check_role(repo, &me, &report.name).await?;
        let mut docs = check_run_docs(self.client, &community, repo, oid.clone()).await?;
        if names_its_run && newest_run(&docs, &me, report).is_none() {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            docs = check_run_docs(self.client, &community, repo, oid.clone()).await?;
        }
        let target = run_to_update(&docs, &me, report).cloned();
        let write = report
            .write(target.as_ref(), crate::cache::now_ms())
            .ok_or_else(|| Error::Config("the report breaks the check run rules".into()))?;
        Ok(ReportPlan {
            community,
            oid,
            target,
            write,
            dropped,
        })
    }

    /// RC2 member roles: refuse, before signing, a check run from a triage member or reader
    /// who is not also a runner (a check run claims `r` 1, which only a maintainer's, a
    /// role-1 writer's or a runner's operand admits). Off with the pre-check.
    async fn require_check_role(&self, repo: &RepoRef, me: &str, name: &str) -> Result<()> {
        if !crate::collab::v2::precheck_enabled() {
            return Ok(());
        }
        // A runner first: most reports are a runner's, and its operand admits it whatever
        // membership it also holds.
        if RunnerReader::new(self.client)
            .get(repo, me)
            .await?
            .is_some()
        {
            return Ok(());
        }
        let role = members::MemberReader::new(self.client)
            .roles_of(repo, me)
            .await?
            .iter()
            .map(|m| m.role)
            .min();
        if role.is_none_or(Role::is_approver) {
            return Ok(());
        }
        Err(crate::collab::v2::role_refusal(
            role,
            Role::Writer,
            repo,
            &format!("report check run {name}"),
        )
        .unwrap_or(Error::Config("internal: no refusal".into())))
    }

    /// Write what [`Self::plan`] decided. `report` is the one planned, perhaps with a log added
    /// since; on a private repository its text is dropped again, so none is ever written.
    pub async fn execute(
        &self,
        repo: &RepoRef,
        report: &CheckReport,
        plan: ReportPlan,
    ) -> Result<Reported> {
        let (report, _) = report.for_visibility(repo.visibility);
        report.validate()?;
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        if let Some(run) = &plan.target {
            let written = engine
                .replace_document(
                    &plan.community,
                    DOC_CHECK_RUN,
                    &run.id,
                    &report.replace_changes(&plan.write, plan.evidence_frozen()),
                )
                .await?;
            return Ok(Reported {
                document_id: run.id.clone(),
                action: if written { "updated" } else { "unchanged" },
            });
        }
        let mut props =
            repo.scope()?
                .scoped(report.create_props(plan.oid, &plan.write, repo.visibility));
        // RC2 member roles: a check run claims `r` 1 (runners and maintainers send 1; a
        // writer's leaf proves its role is 1).
        crate::members::stamp_claimed_role(&plan.community, DOC_CHECK_RUN, &mut props, 1);
        let document_id = engine
            .create_document(&plan.community, DOC_CHECK_RUN, props)
            .await?;
        Ok(Reported {
            document_id,
            action: "created",
        })
    }

    /// [`Self::plan`] then [`Self::execute`].
    pub async fn report(&self, repo: &RepoRef, report: &CheckReport) -> Result<Reported> {
        let plan = self.plan(repo, report).await?;
        self.execute(repo, report, plan).await
    }
}

/// What a report will do ([`CheckRuns::plan`]).
pub struct ReportPlan {
    community: LoadedContract,
    oid: Vec<u8>,
    /// The run it replaces; `None`: it creates one.
    target: Option<FetchedDocument>,
    /// What it writes ([`check_run_write`]).
    write: RunWrite,
    /// The fields a private repository's run cannot carry that the report gave
    /// ([`CheckReport::for_visibility`]).
    dropped: Vec<&'static str>,
}

impl ReportPlan {
    /// Whether the report replaces an existing run (else it creates one).
    pub fn replaces(&self) -> bool {
        self.target.is_some()
    }

    /// Whether the report continues a run that already completed, whose evidence (summary,
    /// details link, log, artifacts) stays as stored ([`EVIDENCE_FIELDS`]): a caller need not
    /// upload a log or artifacts the write will not record.
    pub fn evidence_frozen(&self) -> bool {
        self.target
            .as_ref()
            .is_some_and(|t| evidence_frozen(&self.community, t))
    }

    /// The report's fields left out because the repository is private (`privateNoText`), as
    /// named in [`PRIVATE_TEXT_FIELDS`]; empty on a public repository.
    pub fn dropped(&self) -> &[&'static str] {
        &self.dropped
    }
}

/// The web page that shows a commit's check runs: the commit page of the repo.
pub fn commit_web_url(repo: &RepoRef, oid: &str) -> String {
    format!(
        "{}&oid={oid}",
        crate::user_error::web_page_url("repo/commit/", repo.owner_id(), repo.name())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, owner: &str, at: u64, fields: &[(&str, &str)]) -> FetchedDocument {
        FetchedDocument {
            id: id.into(),
            owner_id: owner.into(),
            created_at: Some(at),
            created_at_block_height: None,
            updated_at_block_height: None,
            fields: fields
                .iter()
                .map(|(k, v)| ((*k).to_string(), FieldValue::text(*v)))
                .collect(),
            revision: Some(1),
        }
    }

    fn report(status: &str, conclusion: Option<&str>) -> CheckReport {
        CheckReport {
            head_oid: "ab".repeat(20),
            name: "build".into(),
            status: status.into(),
            conclusion: conclusion.map(Into::into),
            ..CheckReport::default()
        }
    }

    #[test]
    fn a_report_is_checked_against_the_schema_rules_before_signing() {
        assert_eq!(
            report("completed", Some("success"))
                .validate()
                .unwrap()
                .len(),
            20
        );
        assert!(report("queued", None).validate().is_ok());
        let sha256_head = CheckReport {
            head_oid: "cd".repeat(32),
            ..report("in_progress", None)
        };
        assert_eq!(sha256_head.validate().unwrap().len(), 32);
        for bad in [
            report("completed", None),         // conclusionIfDone
            report("queued", Some("success")), // doneIfConclusion
            report("done", None),
            report("completed", Some("passed")),
            CheckReport {
                head_oid: "xyz".into(),
                ..report("queued", None)
            },
            CheckReport {
                name: "n".repeat(101),
                ..report("queued", None)
            },
            CheckReport {
                summary: Some("é".repeat(1001)),
                ..report("queued", None)
            },
            CheckReport {
                details_url: Some(String::new()),
                ..report("queued", None)
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn progress_replaces_the_reporters_open_run_and_a_rerun_after_completion_is_new() {
        let me = "runner";
        let docs = [
            doc("a", me, 1, &[("name", "build"), ("status", "completed")]),
            doc("b", me, 2, &[("name", "build"), ("status", "in_progress")]),
            doc(
                "c",
                "someone-else",
                3,
                &[("name", "build"), ("status", "queued")],
            ),
            doc("d", me, 4, &[("name", "test"), ("status", "queued")]),
        ];
        let r = report("completed", Some("success"));
        assert_eq!(
            run_to_update(&docs, me, &r).map(|d| d.id.as_str()),
            Some("b")
        );
        // Another identity's run is never replaced (consensus would refuse it anyway).
        assert_eq!(run_to_update(&docs, "nobody", &r), None);
        // A re-run queued after the run started is a new document (never backwards).
        assert_eq!(run_to_update(&docs, me, &report("queued", None)), None);
        // Completed: the same completion again is the same run; another conclusion, or a
        // re-run starting over, is new.
        let done = [doc(
            "a",
            me,
            1,
            &[
                ("name", "build"),
                ("status", "completed"),
                ("conclusion", "success"),
            ],
        )];
        assert_eq!(
            run_to_update(&done, me, &r).map(|d| d.id.as_str()),
            Some("a")
        );
        assert_eq!(
            run_to_update(&done, me, &report("completed", Some("failure"))),
            None
        );
        assert_eq!(run_to_update(&done, me, &report("in_progress", None)), None);
    }

    #[test]
    fn an_external_id_updates_exactly_that_run_while_it_continues() {
        let me = "runner";
        let docs = [
            doc(
                "a",
                me,
                1,
                &[
                    ("name", "build"),
                    ("status", "completed"),
                    ("conclusion", "failure"),
                    ("externalId", "gh-1"),
                ],
            ),
            doc(
                "b",
                me,
                2,
                &[
                    ("name", "build"),
                    ("status", "queued"),
                    ("externalId", "gh-2"),
                ],
            ),
        ];
        let mut r = report("completed", Some("failure"));
        r.external_id = Some("gh-2".into());
        assert_eq!(
            run_to_update(&docs, me, &r).map(|d| d.id.as_str()),
            Some("b")
        );
        // The same completion of a completed run again: that run (nothing new to set). A
        // different conclusion is a re-run: a new document.
        r.external_id = Some("gh-1".into());
        assert_eq!(
            run_to_update(&docs, me, &r).map(|d| d.id.as_str()),
            Some("a")
        );
        r.conclusion = Some("success".into());
        assert_eq!(run_to_update(&docs, me, &r), None);
        r.external_id = Some("gh-3".into());
        assert_eq!(run_to_update(&docs, me, &r), None);
    }

    fn stored(fields: &[(&str, FieldValue)]) -> FetchedDocument {
        FetchedDocument {
            id: "run".into(),
            owner_id: "runner".into(),
            created_at: Some(1),
            created_at_block_height: None,
            updated_at_block_height: None,
            fields: fields
                .iter()
                .map(|(k, v)| ((*k).to_string(), v.clone()))
                .collect(),
            revision: Some(2),
        }
    }

    /// The fields a replace or create sets, as `dg ci report` writes them at `now`.
    fn written(
        r: &CheckReport,
        stored: Option<&FetchedDocument>,
        now: u64,
    ) -> (RunWriteAction, BTreeMap<String, Option<FieldValue>>) {
        let w = r.write(stored, now).expect("a valid report");
        // As on RC2 with S1: a completed run's evidence is frozen.
        let frozen = stored.is_some_and(|s| s.field_str("status").as_deref() == Some("completed"));
        let c = match w.action {
            RunWriteAction::Replace => r.replace_changes(&w, frozen),
            RunWriteAction::Create => r.changes(&w),
        };
        (w.action, c)
    }

    #[test]
    fn a_run_that_jumps_to_completed_gets_both_times() {
        // The old stamping dropped `startedAt` here (only `in_progress` set it), which the
        // contract's `startedIfRunning` refuses.
        let (action, c) = written(&report("completed", Some("success")), None, 50);
        assert_eq!(action, RunWriteAction::Create);
        assert_eq!(c.get("startedAt"), Some(&Some(FieldValue::integer(50))));
        assert_eq!(c.get("completedAt"), Some(&Some(FieldValue::integer(50))));
        assert_eq!(
            c.get("conclusion"),
            Some(&Some(FieldValue::text("success")))
        );
        let create = report("completed", Some("success")).create_props(
            vec![0; 20],
            &report("completed", Some("success"))
                .write(None, 50)
                .unwrap(),
            Visibility::Public,
        );
        assert!(create.contains_key("startedAt") && create.contains_key("completedAt"));
    }

    #[test]
    fn a_queued_run_has_no_times_and_its_start_is_set_once() {
        let (action, c) = written(&report("queued", None), None, 10);
        assert_eq!(action, RunWriteAction::Create);
        assert!(!c.contains_key("startedAt") && !c.contains_key("completedAt"));
        assert!(!c.contains_key("conclusion"));
        // The first in_progress sets the start; a repeated one does not move it.
        let queued = stored(&[("status", FieldValue::text("queued"))]);
        let (action, c) = written(&report("in_progress", None), Some(&queued), 20);
        assert_eq!(action, RunWriteAction::Replace);
        assert_eq!(c.get("startedAt"), Some(&Some(FieldValue::integer(20))));
        let running = stored(&[
            ("status", FieldValue::text("in_progress")),
            ("startedAt", FieldValue::integer(20)),
        ]);
        let mut again = report("in_progress", None);
        again.started_at = Some(99);
        let (action, c) = written(&again, Some(&running), 30);
        assert_eq!(action, RunWriteAction::Replace);
        assert!(!c.contains_key("startedAt"), "the start never moves: {c:?}");
        assert!(c.values().all(Option::is_some), "nothing is ever removed");
    }

    #[test]
    fn a_final_match_is_told_apart_from_no_match() {
        let me = "runner";
        let docs = [doc(
            "a",
            me,
            1,
            &[
                ("name", "build"),
                ("status", "completed"),
                ("externalId", "gh-1"),
            ],
        )];
        let mut r = report("completed", Some("success"));
        r.external_id = Some("gh-1".into());
        // matched: no retry read
        assert!(newest_run(&docs, me, &r).is_some());
        // no match at all: the plan reads again before creating
        r.external_id = Some("gh-2".into());
        assert!(newest_run(&docs, me, &r).is_none());
    }

    #[test]
    fn a_requeue_of_a_started_run_is_a_new_run() {
        let me = "runner";
        let started = [doc(
            "a",
            me,
            1,
            &[("name", "build"), ("status", "in_progress")],
        )];
        let mut started = started;
        started[0]
            .fields
            .insert("startedAt".into(), FieldValue::integer(10));
        // forge-community refuses queued with startedAt (`runningIfStarted`) and removing a
        // set-once startedAt: the re-queue starts a new document
        assert_eq!(run_to_update(&started, me, &report("queued", None)), None);
        // Moving it forward replaces it
        assert_eq!(
            run_to_update(&started, me, &report("completed", Some("success")))
                .map(|d| d.id.as_str()),
            Some("a")
        );
        // A queued run may be re-queued in place (nothing set yet)
        let queued = [doc("q", me, 1, &[("name", "build"), ("status", "queued")])];
        assert_eq!(
            run_to_update(&queued, me, &report("queued", None)).map(|d| d.id.as_str()),
            Some("q")
        );
    }

    #[test]
    fn completing_sets_completion_and_log_and_keeps_the_start() {
        let running = stored(&[
            ("status", FieldValue::text("in_progress")),
            ("startedAt", FieldValue::integer(10)),
        ]);
        let mut done = report("completed", Some("success"));
        done.completed_at = Some(30);
        done.log = Some(("https://x/log".into(), [7; 32]));
        let (action, c) = written(&done, Some(&running), 99);
        assert_eq!(action, RunWriteAction::Replace);
        assert_eq!(c.get("completedAt"), Some(&Some(FieldValue::integer(30))));
        assert_eq!(
            c.get("logSha256"),
            Some(&Some(FieldValue::bytes(vec![7; 32])))
        );
        assert!(!c.contains_key("startedAt"));
        // A completion time the CI gives never precedes the start it pairs with.
        done.completed_at = Some(5);
        let (_, c) = written(&done, Some(&running), 99);
        assert_eq!(c.get("completedAt"), Some(&Some(FieldValue::integer(10))));
        // The same completion again sets nothing new.
        let finished = stored(&[
            ("status", FieldValue::text("completed")),
            ("startedAt", FieldValue::integer(10)),
            ("completedAt", FieldValue::integer(30)),
            ("conclusion", FieldValue::text("success")),
        ]);
        let (action, c) = written(&report("completed", Some("success")), Some(&finished), 99);
        assert_eq!(action, RunWriteAction::Replace);
        assert_eq!(c.keys().collect::<Vec<_>>(), ["outcome", "status"]);
        // Nor does a repeat that carries other evidence (a runner's retry without its
        // artifacts): a completed run's summary, links, log and artifacts are frozen (RC2 S1),
        // so they stay as stored instead of drawing 40128.
        let mut again = report("completed", Some("success"));
        again.summary = Some("ok; artifacts not recorded: their upload failed".into());
        again.details_url = Some("https://ci.example.com/run/2".into());
        again.log = Some(("https://x/log2".into(), [9; 32]));
        again.artifacts = Some("[]".into());
        let (action, c) = written(&again, Some(&finished), 99);
        assert_eq!(action, RunWriteAction::Replace);
        assert_eq!(c.keys().collect::<Vec<_>>(), ["outcome", "status"]);
        // A run that completes now still records its evidence.
        let (_, c) = written(&again, Some(&running), 99);
        for f in EVIDENCE_FIELDS {
            assert!(c.contains_key(f), "{f}");
        }
        // A backwards report or a changed conclusion is a new run with its own times.
        let (action, c) = written(&report("queued", None), Some(&finished), 99);
        assert_eq!(action, RunWriteAction::Create);
        assert!(!c.contains_key("startedAt"));
        let (action, c) = written(&report("completed", Some("failure")), Some(&finished), 99);
        assert_eq!(action, RunWriteAction::Create);
        assert_eq!(c.get("startedAt"), Some(&Some(FieldValue::integer(99))));
    }

    #[test]
    fn the_generated_community_freezes_what_a_report_leaves_as_stored() {
        let community = crate::test_support::rc1::loaded(crate::layout::ForgeContract::Community);
        // M1: each set-once field is a conditional `immutable` entry (`check_run_write` never
        // changes one).
        for f in SET_ONCE_FIELDS {
            assert!(community.freezes_when(DOC_CHECK_RUN, f), "{f}");
        }
        // S1 is a build flag: all of the evidence freezes, or none of it.
        let frozen: Vec<bool> = EVIDENCE_FIELDS
            .iter()
            .map(|f| community.freezes_when(DOC_CHECK_RUN, f))
            .collect();
        assert!(frozen.iter().all(|f| *f == frozen[0]), "{frozen:?}");
        let done = stored(&[("status", FieldValue::text("completed"))]);
        assert_eq!(evidence_frozen(&community, &done), frozen[0]);
        let running = stored(&[("status", FieldValue::text("in_progress"))]);
        assert!(!evidence_frozen(&community, &running));
        // Only a conditional entry counts: `name` is always immutable, `status` mutable.
        assert!(!community.freezes_when(DOC_CHECK_RUN, "name"));
        assert!(!community.freezes_when(DOC_CHECK_RUN, "status"));
        assert!(!community.freezes_when("noSuchType", "summary"));
    }

    /// The RC1 accept/refuse vectors of one document type (`forge-contracts/vectors/rc1`).
    pub(crate) fn rc1_vectors(doc_type: &str) -> Vec<serde_json::Value> {
        let all: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../forge-contracts/vectors/rc1/forge-community.json"
        ))
        .expect("the RC1 vectors parse");
        let cases: Vec<_> = all.into_iter().filter(|c| c["type"] == doc_type).collect();
        assert!(!cases.is_empty(), "no {doc_type} vectors");
        cases
    }

    /// A vector's `{"$b": [fill, len]}` bytes.
    fn vector_bytes(v: &serde_json::Value) -> Vec<u8> {
        let fill = u8::try_from(v["$b"][0].as_u64().unwrap()).unwrap();
        vec![fill; usize::try_from(v["$b"][1].as_u64().unwrap()).unwrap()]
    }

    /// What a CI reported to make the vector's `checkRun`.
    fn report_of(doc: &serde_json::Value) -> CheckReport {
        let text = |k: &str| doc[k].as_str().map(str::to_string);
        CheckReport {
            head_oid: hex::encode(vector_bytes(&doc["headOid"])),
            name: text("name").unwrap(),
            status: text("status").unwrap(),
            conclusion: text("conclusion"),
            details_url: text("detailsUrl"),
            summary: text("summary"),
            external_id: text("externalId"),
            started_at: doc["startedAt"].as_u64(),
            completed_at: doc["completedAt"].as_u64(),
            log: text("logUrl").map(|u| {
                let h = doc.get("logSha256").map_or(vec![0; 32], vector_bytes);
                (u, h.try_into().unwrap())
            }),
            artifacts: text("artifacts"),
        }
    }

    fn visibility_of(doc: &serde_json::Value) -> Visibility {
        if doc["vis"] == "private" {
            Visibility::Private
        } else {
            Visibility::Public
        }
    }

    /// The vector document as the property map a create writes (without `repoId`, which the
    /// scope adds).
    fn vector_props(doc: &serde_json::Value) -> BTreeMap<String, FieldValue> {
        doc.as_object()
            .unwrap()
            .iter()
            .filter(|(k, _)| *k != "repoId")
            .map(|(k, v)| {
                let f = match v {
                    serde_json::Value::String(s) => FieldValue::text(s.as_str()),
                    serde_json::Value::Number(n) => FieldValue::integer(n.as_u64().unwrap()),
                    other => FieldValue::bytes(vector_bytes(other)),
                };
                (k.clone(), f)
            })
            .collect()
    }

    /// After every time in the vectors, and no more than an hour after them (`notFuture`).
    const VECTOR_NOW: u64 = 1_760_000_100_000;

    #[test]
    fn the_builder_writes_every_accepted_rc1_check_run_exactly() {
        for case in rc1_vectors("checkRun")
            .iter()
            .filter(|c| c["expect"] == "ok")
        {
            let doc = &case["doc"];
            let r = report_of(doc);
            let oid = r
                .validate()
                .unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
            let (kept, dropped) = r.for_visibility(visibility_of(doc));
            assert!(dropped.is_empty(), "{}", case["name"]);
            let w = kept.write(None, VECTOR_NOW).unwrap();
            // `r` (RC2 member roles) is stamped at the write ([`CheckRuns::execute`]): 1.
            let mut props = kept.create_props(oid, &w, visibility_of(doc));
            props.insert(members::CLAIMED_ROLE.to_string(), FieldValue::integer(1));
            assert_eq!(props, vector_props(doc), "{}", case["name"]);
        }
    }

    #[test]
    fn the_rc1_refusals_a_report_can_cause_are_refused_before_signing() {
        for case in rc1_vectors("checkRun")
            .iter()
            .filter(|c| c["expect"] != "ok")
        {
            let (doc, why) = (&case["doc"], case["why"].as_str().unwrap());
            let r = report_of(doc);
            match why {
                // A bad URL, a time in seconds, a bad head: refused.
                "pattern" | "msEpoch" | "oidWidth" | "conclusionIfDone" => {
                    assert!(r.validate().is_err(), "{} should be refused", case["name"]);
                }
                // Private text is dropped, and the write then carries none.
                "privateNoText" => {
                    let (kept, dropped) = r.for_visibility(Visibility::Private);
                    assert!(!dropped.is_empty(), "{}", case["name"]);
                    let oid = kept.validate().unwrap();
                    let props = kept.create_props(
                        oid,
                        &kept.write(None, VECTOR_NOW).unwrap(),
                        Visibility::Private,
                    );
                    for f in PRIVATE_TEXT_FIELDS {
                        assert!(!props.contains_key(f), "{}: {f}", case["name"]);
                    }
                }
                // A completion before the start is clamped to it.
                "doneAfterStart" => {
                    let w = r.write(None, VECTOR_NOW).unwrap();
                    assert!(w.completed_at >= w.started_at, "{}", case["name"]);
                }
                // The builder sets the outcome, times and vis itself: a report cannot say
                // them wrong.
                "outcomeOf" => {
                    assert_ne!(
                        r.outcome(),
                        doc["outcome"].as_u64().unwrap(),
                        "{}",
                        case["name"]
                    );
                }
                _ => {}
            }
        }
    }

    #[test]
    fn a_replace_never_touches_an_immutable_field() {
        let full = CheckReport {
            details_url: Some("https://ci.example.com/1".into()),
            summary: Some("ok".into()),
            external_id: Some("gh-1".into()),
            started_at: Some(MS_EPOCH),
            completed_at: Some(MS_EPOCH + 1),
            ..report("completed", Some("success"))
        };
        let running = stored(&[
            ("status", FieldValue::text("in_progress")),
            ("startedAt", FieldValue::integer(MS_EPOCH)),
            ("externalId", FieldValue::text("gh-1")),
        ]);
        let (action, c) = written(&full, Some(&running), MS_EPOCH + 5);
        assert_eq!(action, RunWriteAction::Replace);
        for immutable in [
            "vis",
            "repoId",
            "headOid",
            "name",
            "startedAt",
            "externalId",
        ] {
            assert!(!c.contains_key(immutable), "{immutable} in {c:?}");
        }
        assert_eq!(
            c.get("completedAt"),
            Some(&Some(FieldValue::integer(MS_EPOCH + 1)))
        );
    }

    #[test]
    fn url_patterns_match_the_contract() {
        for ok in [
            "https://ci.example.com/run/1",
            "https://10.0.0.5:8443/job/1",
            "https://ci.example.com",
            "https://ci.example.com?x=1#y",
            "https://ci.example.com/a@b",
        ] {
            assert!(is_details_url(ok) && is_log_url(ok), "{ok}");
        }
        for bad in [
            "javascript:alert(1)",
            "http://ci.example.com/1",
            "https://github.com@evil.example/x",
            "https://a b",
            "https://a\n",
            "https://a/\u{0b}",
            "HTTPS://a.b",
            "https:///x",
            "https://",
            "",
        ] {
            assert!(!is_details_url(bad) && !is_log_url(bad), "{bad:?}");
        }
        assert!(is_log_url("ipfs://bafy123") && is_log_url("ipfs://bafy123/log.txt"));
        for bad in ["ipfs://", "ipfs://bafy-1", "s3://bucket/1", "ipfs://b x"] {
            assert!(!is_log_url(bad), "{bad:?}");
        }
        assert!(!is_details_url("ipfs://bafy123"));
    }

    #[test]
    fn a_private_report_drops_its_text_and_is_matched_by_name() {
        let r = CheckReport {
            details_url: Some("https://ci.example.com/1".into()),
            summary: Some("ok".into()),
            external_id: Some("gh-1".into()),
            log: Some(("https://logs.example.com/1".into(), [1; 32])),
            artifacts: Some("[]".into()),
            ..report("completed", Some("success"))
        };
        let (public, none) = r.for_visibility(Visibility::Public);
        assert_eq!((public, none), (r.clone(), vec![]));
        let (private, dropped) = r.for_visibility(Visibility::Private);
        assert_eq!(dropped, PRIVATE_TEXT_FIELDS);
        assert_eq!(private, report("completed", Some("success")));
        // Without the external id, the reporter's open run of that name is the one updated.
        let me = "runner";
        let docs = [doc(
            "a",
            me,
            1,
            &[("name", "build"), ("status", "in_progress")],
        )];
        assert_eq!(
            run_to_update(&docs, me, &private).map(|d| d.id.as_str()),
            Some("a")
        );
    }

    #[test]
    fn every_write_carries_the_outcome_and_times_are_capped_at_the_reporters_clock() {
        assert_eq!(outcome_of("queued", None), 0);
        assert_eq!(outcome_of("in_progress", None), 0);
        for (c, o) in [
            ("success", 1),
            ("neutral", 1),
            ("skipped", 1),
            ("failure", 2),
            ("cancelled", 2),
            ("timed_out", 2),
            ("action_required", 2),
            ("stale", 2),
        ] {
            assert_eq!(outcome_of("completed", Some(c)), o, "{c}");
        }
        // A replace sets the outcome again, whatever else it leaves.
        let running = stored(&[
            ("status", FieldValue::text("in_progress")),
            ("startedAt", FieldValue::integer(MS_EPOCH)),
            ("outcome", FieldValue::integer(0)),
        ]);
        let (_, c) = written(
            &report("completed", Some("failure")),
            Some(&running),
            MS_EPOCH + 10,
        );
        assert_eq!(c.get("outcome"), Some(&Some(FieldValue::integer(2))));
        // A CI clock ahead of the reporter's: its times are capped at the reporter's.
        let mut ahead = report("completed", Some("success"));
        ahead.started_at = Some(MS_EPOCH + 5_000);
        ahead.completed_at = Some(MS_EPOCH + 9_000);
        let w = ahead.write(None, MS_EPOCH + 1_000).unwrap();
        assert_eq!(
            (w.started_at, w.completed_at),
            (Some(MS_EPOCH + 1_000), Some(MS_EPOCH + 1_000))
        );
        // A time in seconds is refused before signing.
        let mut seconds = report("in_progress", None);
        seconds.started_at = Some(1_760_000_000);
        assert!(seconds.validate().is_err());
    }

    #[test]
    fn the_policy_writer_passes_the_rc1_policy_vectors_and_reads_back() {
        use crate::collab::v2::{policy_from_doc, policy_props};
        use crate::rules::review::Policy;
        let id = |v: &serde_json::Value| [u8::try_from(v["$id"].as_u64().unwrap()).unwrap(); 32];
        for case in rc1_vectors("policy") {
            let (doc, name) = (&case["doc"], &case["name"]);
            let list = |k: &str| doc[k].as_array().cloned().unwrap_or_default();
            let policy = Policy {
                required_approvals: u32::try_from(doc["requiredApprovals"].as_u64().unwrap())
                    .unwrap(),
                approver_role: 0,
                require_checks: doc["requireChecks"].as_bool().unwrap_or(false),
                merge_methods: u8::try_from(doc["mergeMethods"].as_u64().unwrap_or(0)).unwrap(),
                required_checks: list("requiredChecks")
                    .iter()
                    .map(|n| n.as_str().unwrap().to_string())
                    .collect(),
                required_check_sources: list("requiredCheckSources")
                    .iter()
                    .map(|s| platform::encode_identifier(id(s)))
                    .collect(),
            };
            let props = policy_props(&policy);
            assert_eq!(props.is_ok(), case["expect"] == "ok", "{name}");
            let Ok(props) = props else { continue };
            if let Some(names) = doc["requiredChecks"].as_array() {
                let want: Vec<_> = names.iter().map(|n| n.as_str().unwrap()).collect();
                assert_eq!(
                    props.get("requiredChecks"),
                    Some(&FieldValue::text_list(want)),
                    "{name}"
                );
            }
            let sources = list("requiredCheckSources");
            assert_eq!(
                props.get("requiredCheckSources"),
                (!sources.is_empty())
                    .then(|| FieldValue::List(
                        sources
                            .iter()
                            .map(|s| FieldValue::identifier(id(s)))
                            .collect()
                    ))
                    .as_ref(),
                "{name}"
            );
            let fetched = FetchedDocument {
                id: "p".into(),
                owner_id: "o".into(),
                created_at: Some(1),
                created_at_block_height: None,
                updated_at_block_height: None,
                fields: props,
                revision: Some(1),
            };
            assert_eq!(policy_from_doc(&fetched), policy, "{name}");
        }
    }

    #[test]
    fn the_commit_link_is_the_web_commit_page() {
        use crate::network::ForgeIds;
        let repo = RepoRef {
            forge: ForgeIds::test_forge(),
            repo_id: "R".into(),
            owner_id: "alice".into(),
            name: "proj".into(),
            visibility: crate::rules::v2::Visibility::Public,
        };
        assert_eq!(
            commit_web_url(&repo, "abc"),
            "https://forge.dashhq.org/repo/commit/?owner=alice&name=proj&oid=abc"
        );
    }
}

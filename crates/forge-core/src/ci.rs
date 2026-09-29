//! CI on forge-v2 (`docs/design/platform-parity-spec.md` §2): runner memberships and check runs.
//!
//! * **Runner** = a forge-core `runner` document `{repoId, memberId}`. Only the repo owner can
//!   create it (`propertyAgreement {"$ownerId": "$ownerId"}` against `repo`, like `maintainer`),
//!   the `(repoId, memberId)` index is unique, and deleting it revokes the runner: the checkRun
//!   gate (`ownerRefersTo anyOf [runner, maintainer, writer]`) refuses its next create or
//!   replace at consensus (40120).
//! * **Check run** = a forge-community `checkRun` `{repoId, headOid, name, status, conclusion?, …}`,
//!   mutable, with `[repoId, headOid, name]` immutable. The newest per `(headOid, name)` by
//!   `($createdAt, $id)` is what readers show ([`crate::collab::v2::newest_check_runs`]), so a
//!   run's progress (`queued → in_progress → completed`) is a **replace** of the reporter's own
//!   document, and a re-run of the same check on the same commit is a new document.
//! * **The runner's key** is AUTHENTICATION / HIGH bound to `(forge-community, checkRun)`
//!   ([`ContractBounds::SingleContractDocumentType`], admitted on AUTHENTICATION keys from protocol
//!   14), with a budget and an expiry: consensus refuses anything else it signs with 20014
//!   (`ContractBoundedKeyOutOfBoundsError`), and a non-batch transition with
//!   `ContractBoundedKeyNonBatchError`.
//!
//! Contract lookups go through [`RepoRef::forge`] (`community` for `checkRun`, `core` for `runner`),
//! so moving either type to another contract is a deployment-file change here.
//!
//! [`ContractBounds::SingleContractDocumentType`]: dash_sdk::dpp::identity::contract_bounds::ContractBounds

use std::collections::BTreeMap;

use serde::Serialize;

use crate::collab::doc_engine;
use crate::collab::v2::{check_run_docs, DOC_CHECK_RUN};
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::members;
use crate::platform::{
    self, FetchedDocument, FieldValue, LoadedContract, LoadedIdentity, PlatformClient, QueryOrder,
};
use crate::scope::RepoRef;

/// forge-core: a CI runner's membership of a repo.
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
        let core = self.client.fetch_contract(&repo.forge().core).await?;
        let props = repo.scope()?.props([(
            "memberId",
            FieldValue::identifier(platform::decode_identifier(member)?),
        )]);
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        match engine.create_document(&core, DOC_RUNNER, props).await {
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
        let core = self.client.fetch_contract(&repo.forge().core).await?;
        doc_engine(self.client, self.identity, self.bridge)?
            .delete_document(&core, DOC_RUNNER, &existing.document_id)
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
    /// When the run started / completed (ms).
    pub started_at: Option<u64>,
    /// When the run completed (ms).
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
        }
        if let Some(s) = &self.summary {
            check_text("the summary", s, SUMMARY_MAX)?;
        }
        if let Some(x) = &self.external_id {
            check_text("the external id", x, EXTERNAL_ID_MAX)?;
        }
        if let Some((u, _)) = &self.log {
            check_text("the log URL", u, URL_MAX)?;
        }
        if let Some(a) = &self.artifacts {
            check_text("the artifacts list", a, ARTIFACTS_MAX)?;
        }
        Ok(oid)
    }

    /// The full property set a create carries (the scope adds `repoId`).
    fn create_props(&self, oid: Vec<u8>) -> BTreeMap<String, FieldValue> {
        let mut p = BTreeMap::from([
            ("headOid".to_string(), FieldValue::bytes(oid)),
            ("name".to_string(), FieldValue::text(&self.name)),
        ]);
        p.extend(
            self.changes(None)
                .into_iter()
                .filter_map(|(k, v)| v.map(|v| (k, v))),
        );
        p
    }

    /// What a replace of `stored` changes (`None` removes a property). forge-community's
    /// `checkRun` is monotonic: `startedAt`, `completedAt`, `conclusion` and `externalId` are
    /// set once (`immutableAllowSetting`: a replace may add them, never change or remove them),
    /// `startedAt` is present exactly when the run is not queued and `completedAt` exactly when
    /// it is completed. So:
    ///
    /// * `status` always; `conclusion` when this report gives one (it is set once, with
    ///   `completed`).
    /// * The first non-queued report sets `startedAt` (the report's, else `now_ms`); a later one
    ///   keeps it. Completing sets `completedAt` (the report's, else `now_ms`).
    /// * Nothing is ever cleared. A report that would move a stored run backwards (a re-queue
    ///   of a started run, anything after completion) is a new run: [`run_to_update`] never
    ///   picks such a run to replace.
    /// * Everything else this report gives replaces what is stored; what it does not give stays.
    fn changes(&self, stored: Option<&FetchedDocument>) -> BTreeMap<String, Option<FieldValue>> {
        self.changes_at(stored, crate::cache::now_ms())
    }

    /// [`Self::changes`] with the clock given (tests).
    fn changes_at(
        &self,
        stored: Option<&FetchedDocument>,
        now: u64,
    ) -> BTreeMap<String, Option<FieldValue>> {
        let text = |v: &Option<String>| v.as_deref().map(FieldValue::text);
        let queued = self.status == "queued";
        let completed = self.status == "completed";
        let has = |k: &str| stored.is_some_and(|d| d.fields.contains_key(k));
        let mut c = BTreeMap::from([("status".to_string(), Some(FieldValue::text(&self.status)))]);
        if let Some(conclusion) = text(&self.conclusion) {
            c.insert("conclusion".into(), Some(conclusion));
        }
        if !queued && !has("startedAt") {
            let t = self.started_at.or(self.completed_at).unwrap_or(now);
            c.insert("startedAt".into(), Some(FieldValue::integer(t)));
        }
        if completed && !has("completedAt") {
            let t = self.completed_at.unwrap_or(now);
            c.insert("completedAt".into(), Some(FieldValue::integer(t)));
        }
        if let Some((u, h)) = &self.log {
            c.insert("logUrl".into(), Some(FieldValue::text(u)));
            c.insert("logSha256".into(), Some(FieldValue::bytes(h.to_vec())));
        }
        // `externalId` is set once; a run matched by it already holds the same value, which a
        // replace may repeat
        let given = [
            ("detailsUrl", text(&self.details_url)),
            ("summary", text(&self.summary)),
            ("externalId", text(&self.external_id)),
            ("artifacts", text(&self.artifacts)),
        ];
        c.extend(
            given
                .into_iter()
                .filter_map(|(k, v)| v.map(|v| (k.to_string(), Some(v)))),
        );
        c
    }
}

/// The run a report updates in place, among `docs` (the head's `checkRun` documents): the
/// reporter's own newest run of that name (of that `externalId`, when the report gives one),
/// and only when the report moves it forward. forge-community's `checkRun` is monotonic
/// (`docs/contracts/forge-v2.md` §2): a completed run is final, and a started run cannot go
/// back to queued, so a report of either (a re-run) is a new document.
pub fn run_to_update<'d>(
    docs: &'d [FetchedDocument],
    reporter: &str,
    report: &CheckReport,
) -> Option<&'d FetchedDocument> {
    let newest = newest_run(docs, reporter, report)?;
    let completed = newest.field_str("status").as_deref() == Some("completed");
    let started = newest.fields.contains_key("startedAt");
    let requeue = report.status == "queued" && started;
    (!completed && !requeue).then_some(newest)
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
    pub async fn plan(&self, repo: &RepoRef, report: &CheckReport) -> Result<ReportPlan> {
        let oid = report.validate()?;
        let community = self.client.fetch_contract(&repo.forge().community).await?;
        let me = self.identity.id();
        let mut docs = check_run_docs(self.client, &community, repo, oid.clone()).await?;
        if report.external_id.is_some() && newest_run(&docs, &me, report).is_none() {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            docs = check_run_docs(self.client, &community, repo, oid.clone()).await?;
        }
        let target = run_to_update(&docs, &me, report).cloned();
        Ok(ReportPlan {
            community,
            oid,
            target,
        })
    }

    /// Write what [`Self::plan`] decided.
    pub async fn execute(
        &self,
        repo: &RepoRef,
        report: &CheckReport,
        plan: ReportPlan,
    ) -> Result<Reported> {
        let engine = doc_engine(self.client, self.identity, self.bridge)?;
        if let Some(run) = &plan.target {
            let written = engine
                .replace_document(
                    &plan.community,
                    DOC_CHECK_RUN,
                    &run.id,
                    &report.changes(Some(run)),
                )
                .await?;
            return Ok(Reported {
                document_id: run.id.clone(),
                action: if written { "updated" } else { "unchanged" },
            });
        }
        let props = repo.scope()?.scoped(report.create_props(plan.oid));
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
}

impl ReportPlan {
    /// Whether the report replaces an existing run (else it creates one).
    pub fn replaces(&self) -> bool {
        self.target.is_some()
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
        // Completed newest: a re-run starts a new document.
        let done = [doc(
            "a",
            me,
            1,
            &[("name", "build"), ("status", "completed")],
        )];
        assert_eq!(run_to_update(&done, me, &r), None);
    }

    #[test]
    fn an_external_id_updates_that_run_until_it_is_completed() {
        let me = "runner";
        let docs = [
            doc(
                "a",
                me,
                1,
                &[
                    ("name", "build"),
                    ("status", "completed"),
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
        // A completed run is final (forge-community: `doneIfCompletedAt`, set-once fields): a
        // report naming it is a re-run, a new document
        r.external_id = Some("gh-1".into());
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
        // matched but final: no retry read, a new run
        assert!(newest_run(&docs, me, &r).is_some());
        assert_eq!(run_to_update(&docs, me, &r), None);
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
            &[
                ("name", "build"),
                ("status", "in_progress"),
                ("startedAt", "10"),
            ],
        )];
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
    fn a_report_never_clears_a_set_once_field() {
        let running = stored(&[
            ("status", FieldValue::text("in_progress")),
            ("startedAt", FieldValue::integer(10)),
            ("externalId", FieldValue::text("gh-1")),
            ("logUrl", FieldValue::text("https://x/log")),
            ("logSha256", FieldValue::bytes(vec![1; 32])),
        ]);
        let mut again = report("in_progress", None);
        again.started_at = Some(99);
        again.external_id = Some("gh-1".into());
        let c = again.changes_at(Some(&running), 500);
        assert!(
            !c.values().any(Option::is_none),
            "nothing is removed: {c:?}"
        );
        assert!(
            !c.contains_key("startedAt"),
            "the start does not move: {c:?}"
        );
        assert!(!c.contains_key("completedAt"), "not completed: {c:?}");
        assert!(
            !c.contains_key("conclusion"),
            "no conclusion before completion: {c:?}"
        );
        assert!(
            !c.contains_key("logUrl"),
            "an in-progress update keeps the log"
        );
    }

    #[test]
    fn a_first_non_queued_report_sets_the_start_even_without_one() {
        let queued = stored(&[("status", FieldValue::text("queued"))]);
        // The report's own start wins
        let mut r = report("in_progress", None);
        r.started_at = Some(99);
        assert_eq!(
            r.changes_at(Some(&queued), 500).get("startedAt"),
            Some(&Some(FieldValue::integer(99)))
        );
        // Without one, now: `startedIfRunning` needs it
        let c = report("in_progress", None).changes_at(Some(&queued), 500);
        assert_eq!(c.get("startedAt"), Some(&Some(FieldValue::integer(500))));
        // Straight to completed: both times, the start no later than the completion
        let mut done = report("completed", Some("success"));
        done.completed_at = Some(300);
        let c = done.changes_at(Some(&queued), 500);
        assert_eq!(c.get("startedAt"), Some(&Some(FieldValue::integer(300))));
        assert_eq!(c.get("completedAt"), Some(&Some(FieldValue::integer(300))));
        // A create straight to completed carries both too
        let create = report("completed", Some("success")).create_props(vec![0; 20]);
        assert!(create.contains_key("startedAt") && create.contains_key("completedAt"));
        // A queued create carries neither
        let create = report("queued", None).create_props(vec![0; 20]);
        assert!(!create.contains_key("startedAt") && !create.contains_key("completedAt"));
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
        let c = done.changes(Some(&running));
        assert_eq!(c.get("completedAt"), Some(&Some(FieldValue::integer(30))));
        assert_eq!(
            c.get("logSha256"),
            Some(&Some(FieldValue::bytes(vec![7; 32])))
        );
        assert!(!c.contains_key("startedAt"));
        let create = report("queued", None).create_props(vec![0; 20]);
        assert!(!create.contains_key("conclusion") && !create.contains_key("logUrl"));
        assert_eq!(create.get("status"), Some(&FieldValue::text("queued")));
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

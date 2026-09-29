//! CI on forge-v2 (`docs/design/platform-parity-spec.md` §2): runner memberships and check runs.
//!
//! * **Runner** = a forge-core `runner` document `{repoId, memberId}`. Only the repo owner can
//!   create it (`propertyAgreement {"$ownerId": "$ownerId"}` against `repo`, like `maintainer`),
//!   the `(repoId, memberId)` index is unique, and deleting it revokes the runner: the checkRun
//!   gate (`ownerRefersTo anyOf [runner, maintainer, writer]`) refuses its next create or
//!   replace at consensus (40120).
//! * **Check run** = a forge-collab `checkRun` `{repoId, headOid, name, status, conclusion?, …}`,
//!   mutable, with `[repoId, headOid, name]` immutable. The newest per `(headOid, name)` by
//!   `($createdAt, $id)` is what readers show ([`crate::collab::v2::newest_check_runs`]), so a
//!   run's progress (`queued → in_progress → completed`) is a **replace** of the reporter's own
//!   document, and a re-run of the same check on the same commit is a new document.
//! * **The runner's key** is AUTHENTICATION / HIGH bound to `(forge-collab, checkRun)`
//!   ([`ContractBounds::SingleContractDocumentType`], admitted on AUTHENTICATION keys from protocol
//!   14), with a budget and an expiry: consensus refuses anything else it signs with 20014
//!   (`ContractBoundedKeyOutOfBoundsError`), and a non-batch transition with
//!   `ContractBoundedKeyNonBatchError`.
//!
//! Contract lookups go through [`RepoRef::forge`] (`collab` for `checkRun`, `core` for `runner`),
//! so moving either type to another contract is a deployment-file change here.
//!
//! [`ContractBounds::SingleContractDocumentType`]: dash_sdk::dpp::identity::contract_bounds::ContractBounds

use std::collections::BTreeMap;

use serde::Serialize;

use crate::collab::v2::DOC_CHECK_RUN;
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::platform::{
    self, FetchedDocument, FieldValue, LoadedIdentity, PlatformClient, QueryFilter, QueryOrder,
    WriteEngine,
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
        let core = self.client.fetch_contract(&repo.forge().core).await?;
        let docs = self
            .client
            .query_all_documents(
                &core,
                DOC_RUNNER,
                &repo.scope()?.filters([]),
                &[QueryOrder::asc("repoId"), QueryOrder::asc("memberId")],
            )
            .await?;
        Ok(docs.iter().filter_map(Runner::from_doc).collect())
    }

    /// `identity`'s runner membership of `repo`, if any (the index is unique).
    pub async fn get(&self, repo: &RepoRef, identity: &str) -> Result<Option<Runner>> {
        let core = self.client.fetch_contract(&repo.forge().core).await?;
        let member = FieldValue::identifier(platform::decode_identifier(identity)?);
        let docs = self
            .client
            .query_documents(
                &core,
                DOC_RUNNER,
                &repo.scope()?.filters([QueryFilter::eq("memberId", member)]),
                &[],
                1,
                None,
            )
            .await?;
        Ok(docs.iter().find_map(Runner::from_doc))
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
        let engine = WriteEngine::new(self.client, self.identity, self.bridge.doc_op_key()?)?;
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
        WriteEngine::new(self.client, self.identity, self.bridge.doc_op_key()?)?
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
    if value.chars().count() > chars || value.len() > bytes {
        return Err(Error::Config(format!(
            "{field} is too long ({} characters, {} bytes; the most is {chars} characters, {bytes} bytes)",
            value.chars().count(),
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
            self.changes()
                .into_iter()
                .filter_map(|(k, v)| v.map(|v| (k, v))),
        );
        p
    }

    /// What a replace changes: `status` and `conclusion` always (`None` removes a conclusion
    /// left from an earlier report, which the contract's `doneIfConclusion` rule would refuse on
    /// a re-queued run), and every other property this report gives. What it does not give
    /// stays as stored (a `startedAt` set when the run started, a summary).
    fn changes(&self) -> BTreeMap<String, Option<FieldValue>> {
        let mut c = BTreeMap::from([
            ("status".to_string(), Some(FieldValue::text(&self.status))),
            (
                "conclusion".to_string(),
                self.conclusion.as_deref().map(FieldValue::text),
            ),
        ]);
        let text = |v: &Option<String>| v.as_deref().map(FieldValue::text);
        let given = [
            ("detailsUrl", text(&self.details_url)),
            ("summary", text(&self.summary)),
            ("externalId", text(&self.external_id)),
            ("startedAt", self.started_at.map(FieldValue::integer)),
            ("completedAt", self.completed_at.map(FieldValue::integer)),
            ("logUrl", self.log.as_ref().map(|(u, _)| FieldValue::text(u))),
            (
                "logSha256",
                self.log.as_ref().map(|(_, h)| FieldValue::bytes(h.to_vec())),
            ),
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
/// reporter's own newest run of that name, and only while it is not completed or when it
/// carries the same `externalId`. A completed run is history; a new report of it (a re-run)
/// is a new document.
pub fn run_to_update<'d>(
    docs: &'d [FetchedDocument],
    reporter: &str,
    report: &CheckReport,
) -> Option<&'d FetchedDocument> {
    let mine = docs
        .iter()
        .filter(|d| d.owner_id == reporter && d.field_str("name").as_deref() == Some(&report.name));
    if let Some(ext) = &report.external_id {
        return mine
            .filter(|d| d.field_str("externalId").as_deref() == Some(ext.as_str()))
            .max_by_key(|d| (d.created_at.unwrap_or(0), d.id.clone()));
    }
    mine.max_by_key(|d| (d.created_at.unwrap_or(0), d.id.clone()))
        .filter(|d| d.field_str("status").as_deref() != Some("completed"))
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

    /// Report `report` on `repo`: replace the run it updates ([`run_to_update`]), else create a
    /// new one. The `checkRun` index `head (repoId, headOid, $createdAt)` is read once.
    pub async fn report(&self, repo: &RepoRef, report: &CheckReport) -> Result<Reported> {
        let oid = report.validate()?;
        let collab = self.client.fetch_contract(&repo.forge().collab).await?;
        let docs = self
            .client
            .query_all_documents(
                &collab,
                DOC_CHECK_RUN,
                &[
                    QueryFilter::eq(
                        "repoId",
                        FieldValue::identifier(platform::decode_identifier(repo.id())?),
                    ),
                    QueryFilter::eq("headOid", FieldValue::bytes(oid.clone())),
                ],
                &[
                    QueryOrder::asc("repoId"),
                    QueryOrder::asc("headOid"),
                    QueryOrder::asc("$createdAt"),
                ],
            )
            .await?;
        let engine = WriteEngine::new(self.client, self.identity, self.bridge.doc_op_key()?)?;
        if let Some(run) = run_to_update(&docs, &self.identity.id(), report) {
            let written = engine
                .replace_document(&collab, DOC_CHECK_RUN, &run.id, &report.changes())
                .await?;
            return Ok(Reported {
                document_id: run.id.clone(),
                action: if written { "updated" } else { "unchanged" },
            });
        }
        let props = repo.scope()?.scoped(report.create_props(oid));
        let document_id = engine
            .create_document(&collab, DOC_CHECK_RUN, props)
            .await?;
        Ok(Reported {
            document_id,
            action: "created",
        })
    }
}

/// The web page that shows a commit's check runs: the commit page of the repo.
pub fn commit_web_url(repo: &RepoRef, oid: &str) -> String {
    format!(
        "{}&oid={}",
        crate::user_error::web_url(repo.owner_id(), repo.name()).replacen(
            "/repo?",
            "/repo/commit/?",
            1
        ),
        oid
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
            report("completed", Some("success")).validate().unwrap().len(),
            20
        );
        assert!(report("queued", None).validate().is_ok());
        let sha256_head = CheckReport {
            head_oid: "cd".repeat(32),
            ..report("in_progress", None)
        };
        assert_eq!(sha256_head.validate().unwrap().len(), 32);
        for bad in [
            report("completed", None),       // conclusionIfDone
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
            doc("c", "someone-else", 3, &[("name", "build"), ("status", "queued")]),
            doc("d", me, 4, &[("name", "test"), ("status", "queued")]),
        ];
        let r = report("completed", Some("success"));
        assert_eq!(run_to_update(&docs, me, &r).map(|d| d.id.as_str()), Some("b"));
        // Another identity's run is never replaced (consensus would refuse it anyway).
        assert_eq!(run_to_update(&docs, "nobody", &r), None);
        // Completed newest: a re-run starts a new document.
        let done = [doc("a", me, 1, &[("name", "build"), ("status", "completed")])];
        assert_eq!(run_to_update(&done, me, &r), None);
    }

    #[test]
    fn an_external_id_updates_exactly_that_run_even_once_completed() {
        let me = "runner";
        let docs = [
            doc(
                "a",
                me,
                1,
                &[("name", "build"), ("status", "completed"), ("externalId", "gh-1")],
            ),
            doc(
                "b",
                me,
                2,
                &[("name", "build"), ("status", "queued"), ("externalId", "gh-2")],
            ),
        ];
        let mut r = report("completed", Some("failure"));
        r.external_id = Some("gh-1".into());
        assert_eq!(run_to_update(&docs, me, &r).map(|d| d.id.as_str()), Some("a"));
        r.external_id = Some("gh-3".into());
        assert_eq!(run_to_update(&docs, me, &r), None);
    }

    #[test]
    fn a_replace_clears_a_stale_conclusion_and_keeps_what_it_does_not_give() {
        let changes = report("queued", None).changes();
        assert_eq!(
            changes.get("conclusion"),
            Some(&None),
            "a re-queued run drops its old conclusion"
        );
        assert!(
            !changes.contains_key("startedAt") && !changes.contains_key("summary"),
            "absent fields stay as stored: {changes:?}"
        );
        let mut done = report("completed", Some("success"));
        done.log = Some(("https://x/log".into(), [7; 32]));
        let changes = done.changes();
        assert_eq!(
            changes.get("logSha256"),
            Some(&Some(FieldValue::bytes(vec![7; 32])))
        );
        let create = report("queued", None).create_props(vec![0; 20]);
        assert!(!create.contains_key("conclusion"));
        assert!(!create.contains_key("logUrl"));
        assert_eq!(create.get("status"), Some(&FieldValue::text("queued")));
    }

    #[test]
    fn the_commit_link_is_the_web_commit_page() {
        use crate::network::ForgeIds;
        let repo = RepoRef {
            forge: ForgeIds {
                core: "C".into(),
                collab: "L".into(),
                group: "G".into(),
                superseded_in_group: vec![],
                group_owner: None,
            },
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

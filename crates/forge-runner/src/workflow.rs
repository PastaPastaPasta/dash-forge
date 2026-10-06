//! Reading a commit's workflows before act sees them: which files run on this push, which jobs
//! they define, and whether any job asks for something the runner refuses.
//!
//! act would honour a job's `container.options` (any `docker run` flag: `--privileged`,
//! `-v /var/run/docker.sock:…`, `--pid host`), `container.volumes`, the same keys on
//! `services.*`, and a reusable workflow (`jobs.*.uses`, which runs another workflow the runner
//! did not read). Each is a way out of the job container, so a job carrying one is refused
//! unless the repository's owner turned `allow_container_options` on for it, and the reason is
//! reported as the job's check run.
//!
//! `on.push` is evaluated here too (branches / branches-ignore / tags / tags-ignore / paths /
//! paths-ignore), and act is given one workflow file at a time (`-W <file>`), so a workflow that
//! does not run on this push never reaches act.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// A job id the runner will pass to act and use in paths: GitHub's own rule for job ids.
pub fn valid_job_id(id: &str) -> bool {
    let mut c = id.chars();
    c.next()
        .is_some_and(|f| f.is_ascii_alphabetic() || f == '_')
        && c.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        && id.len() <= 100
}

/// One job of one workflow file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    /// The job id (valid by [`valid_job_id`]).
    pub id: String,
    /// `<workflow name> / <job name>` (≤ 100 characters): the check-run name.
    pub check_name: String,
    /// Why the runner will not run it, if it will not.
    pub refused: Option<String>,
}

/// A workflow file that runs on this push, and its jobs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workflow {
    /// The file, relative to the checkout (`.forge/workflows/ci.yml`).
    pub file: PathBuf,
    /// The workflow's `name` (the file name when it has none).
    pub name: String,
    /// Its jobs, in file order.
    pub jobs: Vec<Job>,
    /// The parsed file (for [`Workflow::for_act`]).
    pub doc: Value,
    /// Some jobs were left out ([`Workflow::only_jobs`]): act gets [`Self::doc`], not the file.
    pub trimmed: bool,
}

impl Workflow {
    /// The workflow's `on`. A key named `on` parses as the string "on" in YAML 1.2; YAML 1.1
    /// readers may make it true.
    pub fn on(&self) -> Value {
        self.doc
            .get("on")
            .or_else(|| self.doc.get("true"))
            .cloned()
            .unwrap_or(Value::Null)
    }

    /// Only the jobs `keep` (by id) and every job they `needs`, directly or not: the jobs of a
    /// push workflow the branch policy requires, run although its path filter left the push
    /// out. The file's other jobs are not run.
    #[must_use]
    pub fn only_jobs(&self, keep: &BTreeSet<String>) -> Workflow {
        let needs_of = |id: &str| -> Vec<String> {
            match self
                .doc
                .get("jobs")
                .and_then(|j| j.get(id))
                .and_then(|j| j.get("needs"))
            {
                Some(Value::String(n)) => vec![n.clone()],
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(|n| n.as_str().map(str::to_string))
                    .collect(),
                _ => Vec::new(),
            }
        };
        let mut kept: BTreeSet<String> = BTreeSet::new();
        let mut todo: Vec<String> = keep.iter().cloned().collect();
        while let Some(id) = todo.pop() {
            if kept.insert(id.clone()) {
                todo.extend(needs_of(&id));
            }
        }
        let mut doc = self.doc.clone();
        if let Some(jobs) = doc.get_mut("jobs").and_then(Value::as_object_mut) {
            jobs.retain(|id, _| kept.contains(id));
        }
        Workflow {
            file: self.file.clone(),
            name: self.name.clone(),
            jobs: self
                .jobs
                .iter()
                .filter(|j| kept.contains(&j.id))
                .cloned()
                .collect(),
            trimmed: self.trimmed || kept.len() < self.jobs.len(),
            doc,
        }
    }

    /// The workflow as act should see it: the refused jobs removed, and every remaining job's
    /// `needs` cut to the jobs that remain. `None` when nothing was refused or left out (act
    /// reads the file itself).
    pub fn for_act(&self) -> Option<Value> {
        let refused: Vec<&str> = self
            .jobs
            .iter()
            .filter(|j| j.refused.is_some())
            .map(|j| j.id.as_str())
            .collect();
        if refused.is_empty() {
            return self.trimmed.then(|| self.doc.clone());
        }
        let mut doc = self.doc.clone();
        let jobs = doc.get_mut("jobs")?.as_object_mut()?;
        for r in &refused {
            jobs.remove(*r);
        }
        for job in jobs.values_mut() {
            match job.get_mut("needs") {
                Some(Value::String(n)) if refused.contains(&n.as_str()) => {
                    job.as_object_mut()?.remove("needs");
                }
                Some(Value::Array(a)) => {
                    a.retain(|n| n.as_str().is_none_or(|n| !refused.contains(&n)));
                }
                _ => {}
            }
        }
        Some(doc)
    }
}

/// A workflow file that could not be used: bad YAML, no `jobs`, an invalid job id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Broken {
    /// The file, relative to the checkout.
    pub file: PathBuf,
    /// Why.
    pub reason: String,
}

/// What a commit's workflow files amount to for one trigger.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Plan {
    /// The files that run on this push.
    pub run: Vec<Workflow>,
    /// The files that could not be read (each reported as one failed check).
    pub broken: Vec<Broken>,
    /// The files that would run on this pull request or push but for their `paths` /
    /// `paths-ignore` filter ([`Facts::runs_without_paths`]). On a pull request, a required check
    /// among their jobs is reported `skipped`; on a push, a required check's job runs anyway.
    /// Either way it does not wait forever for a run that will never come.
    pub path_filtered: Vec<Workflow>,
}

/// The push a workflow's `on.push` filter is judged against.
#[derive(Clone, Copy)]
pub struct PushFacts<'a> {
    /// `refs/heads/main` / `refs/tags/v1`.
    pub refname: &'a str,
    /// Paths changed by the push (relative to the repo root); `None` when unknown (a new ref),
    /// in which case path filters run the workflow, as GitHub does for a new branch.
    pub changed: Option<&'a [String]>,
}

/// The pull-request activity a workflow's `on.pull_request` filter is judged against.
#[derive(Clone, Copy)]
pub struct PullFacts<'a> {
    /// The base branch, short (`main`): what `branches` / `branches-ignore` match.
    pub base: &'a str,
    /// `opened`, `synchronize`, `reopened` or `ready_for_review`: what `types` match.
    pub action: &'a str,
    /// Paths the PR changes (`base...head`); `None` when unknown, which runs path filters.
    pub changed: Option<&'a [String]>,
    /// A re-run: the workflow runs if any activity the runner runs PRs on
    /// ([`RUNNER_PULL_ACTIONS`]) matches its `types` (it may have run on another one before),
    /// then the base branch and the paths are judged as usual. A workflow whose `types` name
    /// none of them (`closed`, `labeled`) never ran here, and never re-runs.
    pub any_type: bool,
}

/// What a workflow's `on:` is judged against.
pub enum Facts<'a> {
    /// A push to a ref of the repository.
    Push(PushFacts<'a>),
    /// A pull request was opened, its head moved, it was reopened or marked ready.
    PullRequest(PullFacts<'a>),
    /// A `schedule` entry's time came: the workflows that list this cron expression run, except
    /// those that list one of `earlier` (due in the same poll and run with that one already), so
    /// a workflow runs once a poll however many of its expressions are due.
    Schedule(&'a str, &'a [String]),
}

impl Facts<'_> {
    /// Whether a workflow whose `on` is `on` would run on this pull request or push whatever
    /// paths it changes: for a workflow that does not run ([`Self::runs`]), that its `paths` /
    /// `paths-ignore` filter alone left it out. A pull request's changes are the whole PR
    /// (`base...head`); a push's are only that push's own commits, so a push's required checks
    /// are run rather than skipped.
    pub fn runs_without_paths(&self, on: &Value) -> bool {
        match self {
            Facts::PullRequest(p) if p.changed.is_some() => runs_on_pull_request(
                on,
                &PullFacts {
                    changed: None,
                    ..*p
                },
            ),
            Facts::Push(p) if p.changed.is_some() => runs_on_push(
                on,
                &PushFacts {
                    changed: None,
                    ..*p
                },
            ),
            _ => false,
        }
    }

    /// Whether a workflow whose `on` is `on` runs.
    pub fn runs(&self, on: &Value) -> bool {
        match self {
            Facts::Push(p) => runs_on_push(on, p),
            Facts::PullRequest(p) => runs_on_pull_request(on, p),
            Facts::Schedule(cron, earlier) => {
                let listed: Vec<String> =
                    schedule_crons(on).iter().map(|c| normal_cron(c)).collect();
                listed.contains(&normal_cron(cron)) && !earlier.iter().any(|e| listed.contains(e))
            }
        }
    }
}

/// The cron expressions of a workflow's `on.schedule` (`- cron: '…'` entries), as written.
/// `schedule` needs its entries, so the bare `on: schedule` forms list none.
pub fn schedule_crons(on: &Value) -> Vec<String> {
    on.get("schedule")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|e| e.get("cron").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// A cron expression with its fields separated by single spaces (how two are compared).
pub fn normal_cron(cron: &str) -> String {
    cron.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The largest workflow file read (a bigger one is refused, not parsed).
pub const MAX_WORKFLOW_BYTES: u64 = 512 * 1024;

/// Read every `*.yml` / `*.yaml` directly in `dir` (sorted), and decide what runs.
pub fn plan(
    checkout: &Path,
    dir: &Path,
    facts: &Facts<'_>,
    allow_container: bool,
    labels: &[&str],
) -> Plan {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "yml" || x == "yaml"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let mut plan = Plan::default();
    for path in files {
        let rel = path.strip_prefix(checkout).unwrap_or(&path).to_path_buf();
        // A symlink could point the runner at a file outside the checkout.
        let meta = std::fs::symlink_metadata(&path);
        let text = match meta {
            Ok(m) if !m.file_type().is_file() => Err("not a regular file".to_string()),
            Ok(m) if m.len() > MAX_WORKFLOW_BYTES => Err("larger than 512 KiB".to_string()),
            Ok(_) => std::fs::read_to_string(&path).map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        match text.and_then(|t| read_workflow(&rel, &t, allow_container, labels)) {
            Ok((wf, on)) => {
                if facts.runs(&on) {
                    plan.run.push(wf);
                } else if facts.runs_without_paths(&on) {
                    plan.path_filtered.push(wf);
                }
            }
            Err(reason) => plan.broken.push(Broken { file: rel, reason }),
        }
    }
    plan
}

/// Parse one workflow file: its jobs (with refusals) and its `on` value.
pub fn read_workflow(
    rel: &Path,
    text: &str,
    allow_container: bool,
    labels: &[&str],
) -> Result<(Workflow, Value), String> {
    let v: Value = yaml_serde::from_str(text).map_err(|e| format!("not valid YAML: {e}"))?;
    // YAML merge keys (`<<: *anchor`): this parser keeps `<<` as a plain key, act's expands it,
    // so the two would read different jobs. A workflow that uses one is not run.
    if has_merge_key(&v) {
        return Err(
            "uses a YAML merge key (`<<:`), which the runner does not expand the way act does"
                .into(),
        );
    }
    let file_name = rel
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let name = v["name"].as_str().map_or(file_name, str::to_string);
    let jobs = v["jobs"].as_object().ok_or("no `jobs:` mapping")?;
    if jobs.is_empty() {
        return Err("`jobs:` is empty".into());
    }
    let mut out = Vec::new();
    for (id, job) in jobs {
        if !valid_job_id(id) {
            return Err(format!(
                "job id {id:?} is not a valid id (a letter or `_`, then letters, digits, `_`, `-`)"
            ));
        }
        let job_name = job["name"].as_str().unwrap_or(id);
        let check_name: String = format!("{name} / {job_name}").chars().take(100).collect();
        out.push(Job {
            id: id.clone(),
            check_name,
            refused: (!allow_container)
                .then(|| refusal(job))
                .flatten()
                .or_else(|| unknown_label(job, labels)),
        });
    }
    let wf = Workflow {
        file: rel.to_path_buf(),
        name,
        jobs: out,
        doc: v,
        trimmed: false,
    };
    let on = wf.on();
    Ok((wf, on))
}

/// The keys a job's `container`, or one of its `services`, may have. Anything else (`options`,
/// `volumes`, keys a newer act might add) is refused: fail closed.
const CONTAINER_KEYS: [&str; 4] = ["image", "env", "ports", "credentials"];

/// Why a job's `runs-on` is refused: it must name labels the runner maps to an image
/// (`[platforms]`). act would otherwise pick its own default images, unpinned and old.
fn unknown_label(job: &Value, labels: &[&str]) -> Option<String> {
    let runs_on = job.get("runs-on")?;
    let names: Vec<&str> = match runs_on {
        Value::String(s) => vec![s.as_str()],
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
        _ => return Some("`runs-on` is not a label or a list of labels".into()),
    };
    if names.iter().any(|n| n.contains("${{")) {
        return Some("`runs-on` uses an expression".into());
    }
    names
        .iter()
        .find(|n| !labels.contains(n))
        .map(|n| format!("`runs-on: {n}` is not a label this runner has an image for ([platforms] in runner.toml)"))
}

/// Whether any mapping in `v` has a `<<` key (a YAML merge key, left unexpanded here).
fn has_merge_key(v: &Value) -> bool {
    match v {
        Value::Array(a) => a.iter().any(has_merge_key),
        Value::Object(o) => o.contains_key("<<") || o.values().any(has_merge_key),
        _ => false,
    }
}

/// Whether a value contains an expression anywhere (`${{`): a `container` or `services` built
/// at run time could carry what the runner cannot see now.
fn has_expression(v: &Value) -> bool {
    match v {
        Value::String(s) => s.contains("${{"),
        Value::Array(a) => a.iter().any(has_expression),
        Value::Object(o) => o.keys().any(|k| k.contains("${{")) || o.values().any(has_expression),
        _ => false,
    }
}

/// Why a `container` / service definition is refused, if it is.
fn container_refusal(v: &Value, what: &str) -> Option<String> {
    if has_expression(v) {
        return Some(format!(
            "`{what}` uses an expression (`${{{{ … }}}}`), which could set docker options at run time"
        ));
    }
    match v {
        Value::Null => None,
        Value::String(image) if !image.trim().is_empty() => None,
        Value::Object(o) => o
            .keys()
            .find(|k| !CONTAINER_KEYS.contains(&k.as_str()))
            .map(|k| {
                format!("sets `{what}.{k}` (only image, env, ports and credentials are run; docker options or mounts reach past the job container)")
            }),
        _ => Some(format!("`{what}` is neither an image name nor a mapping")),
    }
}

/// Why the runner refuses `job`, if it does: anything that reaches past the job container, or
/// that the runner cannot judge before act runs.
pub fn refusal(job: &Value) -> Option<String> {
    let Some(obj) = job.as_object() else {
        return Some("the job is not a mapping".into());
    };
    if obj.contains_key("uses") {
        return Some(
            "calls a reusable workflow (`uses:`), which the runner does not read before it runs"
                .into(),
        );
    }
    if let Some(r) = obj
        .get("container")
        .and_then(|c| container_refusal(c, "container"))
    {
        return Some(r);
    }
    match obj.get("services") {
        None | Some(Value::Null) => None,
        Some(Value::Object(services)) => services.iter().find_map(|(name, svc)| {
            container_refusal(svc, &format!("services.{name}")).or_else(|| {
                (svc.is_null() || svc.as_str().is_some())
                    .then(|| format!("`services.{name}` must be a mapping with an image"))
            })
        }),
        Some(_) => Some("`services` is not a mapping".into()),
    }
}

fn strings(v: &Value) -> Option<Vec<String>> {
    match v {
        Value::String(s) => Some(vec![s.clone()]),
        Value::Array(a) => Some(
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect(),
        ),
        _ => None,
    }
}

/// GitHub's filter glob for branch, tag and path filters: `*` within a path segment, `**`
/// across segments, `?` one character (not `/`). A leading `!` negates, handled in
/// [`list_matches`].
fn filter_glob(pattern: &str, name: &str) -> bool {
    fn go(p: &[u8], n: &[u8]) -> bool {
        match p {
            [] => n.is_empty(),
            [b'*', b'*', rest @ ..] => (0..=n.len()).any(|i| go(rest, &n[i..])),
            [b'*', rest @ ..] => (0..=n.len())
                .take_while(|&i| i == 0 || n[i - 1] != b'/')
                .any(|i| go(rest, &n[i..])),
            [b'?', rest @ ..] => n.first().is_some_and(|c| *c != b'/') && go(rest, &n[1..]),
            [c, rest @ ..] => n.first() == Some(c) && go(rest, &n[1..]),
        }
    }
    go(pattern.as_bytes(), name.as_bytes())
}

fn list_matches(patterns: &[String], name: &str) -> bool {
    let mut hit = false;
    for p in patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if filter_glob(neg, name) {
                hit = false;
            }
        } else if filter_glob(p, name) {
            hit = true;
        }
    }
    hit
}

/// Whether a workflow whose `on` is `on` runs on `push` (GitHub's rules for the push event).
pub fn runs_on_push(on: &Value, push: &PushFacts<'_>) -> bool {
    let filters: &Value = match on {
        Value::String(s) => return s == "push",
        Value::Array(a) => return a.iter().any(|e| e.as_str() == Some("push")),
        Value::Object(o) => match o.get("push") {
            None => return false,
            Some(Value::Null) => return true,
            Some(f) => f,
        },
        _ => return false,
    };
    let (kind, short) = if let Some(b) = push.refname.strip_prefix("refs/heads/") {
        ("branches", b)
    } else if let Some(t) = push.refname.strip_prefix("refs/tags/") {
        ("tags", t)
    } else {
        return false;
    };
    let other = if kind == "branches" {
        "tags"
    } else {
        "branches"
    };
    let inc = strings(&filters[kind]);
    let exc = strings(&filters[format!("{kind}-ignore")]);
    let has_any_ref_filter = inc.is_some()
        || exc.is_some()
        || filters.get(other).is_some()
        || filters.get(format!("{other}-ignore")).is_some();
    let ref_ok = match (&inc, &exc) {
        (Some(i), _) => list_matches(i, short),
        (None, Some(e)) => !list_matches(e, short),
        // Only the other kind is filtered: this kind does not run (GitHub: a workflow with only
        // `tags:` does not run on branch pushes).
        (None, None) => !has_any_ref_filter,
    };
    ref_ok && paths_ok(filters, push.changed)
}

/// `paths` / `paths-ignore` against the changed files (unknown changes run the workflow).
fn paths_ok(filters: &Value, changed: Option<&[String]>) -> bool {
    let paths = strings(&filters["paths"]);
    let paths_ignore = strings(&filters["paths-ignore"]);
    match (changed, paths, paths_ignore) {
        (None, _, _) | (_, None, None) => true,
        (Some(ch), Some(p), _) => ch.iter().any(|f| list_matches(&p, f)),
        (Some(ch), None, Some(ig)) => ch.iter().any(|f| !list_matches(&ig, f)),
    }
}

/// The `pull_request` activity types a workflow runs on when it names none (GitHub's default).
const DEFAULT_PULL_TYPES: [&str; 3] = ["opened", "synchronize", "reopened"];

/// The `pull_request` activities the runner runs PRs on (`watch::pull_events`).
pub const RUNNER_PULL_ACTIONS: [&str; 4] =
    ["opened", "synchronize", "reopened", "ready_for_review"];

/// Whether a workflow whose `on` is `on` runs on this pull-request activity (GitHub's rules for
/// `pull_request`: `types`, then `branches` / `branches-ignore` on the base branch, then
/// `paths` / `paths-ignore` on the PR's changes). `pull_request_target` never runs here.
pub fn runs_on_pull_request(on: &Value, pr: &PullFacts<'_>) -> bool {
    // A re-run's types are the default ones and every activity the runner fires.
    let default_type = pr.any_type || DEFAULT_PULL_TYPES.contains(&pr.action);
    let filters: &Value = match on {
        Value::String(s) => return s == "pull_request" && default_type,
        Value::Array(a) => {
            return default_type && a.iter().any(|e| e.as_str() == Some("pull_request"))
        }
        Value::Object(o) => match o.get("pull_request") {
            None => return false,
            Some(Value::Null) => return default_type,
            Some(f) => f,
        },
        _ => return false,
    };
    let type_ok = strings(&filters["types"]).map_or(default_type, |t| {
        t.iter()
            .any(|t| t == pr.action || (pr.any_type && RUNNER_PULL_ACTIONS.contains(&t.as_str())))
    });
    let branch_ok = match (
        strings(&filters["branches"]),
        strings(&filters["branches-ignore"]),
    ) {
        (Some(i), _) => list_matches(&i, pr.base),
        (None, Some(e)) => !list_matches(&e, pr.base),
        (None, None) => true,
    };
    type_ok && branch_ok && paths_ok(filters, pr.changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn facts<'a>(r: &'a str, changed: Option<&'a [String]>) -> PushFacts<'a> {
        PushFacts {
            refname: r,
            changed,
        }
    }

    fn wf(text: &str) -> Result<(Workflow, Value), String> {
        read_workflow(
            Path::new(".forge/workflows/ci.yml"),
            text,
            false,
            &["x", "ubuntu-latest"],
        )
    }

    #[test]
    fn only_jobs_keeps_the_required_ones_and_what_they_need() {
        let doc: Value = yaml_serde::from_str(
            "on: push\njobs:\n  setup: {runs-on: x, steps: []}\n  req: {runs-on: x, needs: setup, steps: []}\n  other: {runs-on: x, steps: []}\n",
        )
        .unwrap();
        let job = |id: &str| Job {
            id: id.into(),
            check_name: format!("w / {id}"),
            refused: None,
        };
        let wf = Workflow {
            file: "w.yml".into(),
            name: "w".into(),
            jobs: vec![job("setup"), job("req"), job("other")],
            doc,
            trimmed: false,
        };
        assert!(
            wf.for_act().is_none(),
            "the whole file: act reads it itself"
        );
        let kept = wf.only_jobs(&BTreeSet::from(["req".to_string()]));
        let ids: Vec<&str> = kept.jobs.iter().map(|j| j.id.as_str()).collect();
        assert_eq!(ids, ["setup", "req"]);
        let doc = kept
            .for_act()
            .expect("a trimmed file goes to act as a copy");
        assert!(doc["jobs"].get("other").is_none());
        assert!(doc["jobs"].get("setup").is_some());
    }

    #[test]
    fn container_options_volumes_services_and_reusable_workflows_are_refused() {
        let (w, _) = wf(r#"
name: ci
on: push
jobs:
  ok:
    runs-on: ubuntu-latest
    container: { image: node:20 }
    steps: [{ run: echo }]
  priv:
    runs-on: ubuntu-latest
    container: { image: node:20, options: --privileged }
  mount:
    runs-on: ubuntu-latest
    container: { image: node:20, volumes: ["/var/run/docker.sock:/var/run/docker.sock"] }
  svc:
    runs-on: ubuntu-latest
    services:
      db: { image: postgres, options: "--pid host" }
  svcvol:
    runs-on: ubuntu-latest
    services:
      db: { image: postgres, volumes: ["/:/host"] }
  call:
    uses: ./.forge/workflows/other.yml
"#)
        .unwrap();
        let refused: BTreeMap<_, _> = w
            .jobs
            .iter()
            .map(|j| (j.id.as_str(), j.refused.is_some()))
            .collect();
        assert_eq!(
            refused,
            BTreeMap::from([
                ("ok", false),
                ("priv", true),
                ("mount", true),
                ("svc", true),
                ("svcvol", true),
                ("call", true)
            ])
        );
        let (w, _) = read_workflow(
            Path::new("x.yml"),
            "on: push\njobs:\n  p:\n    runs-on: x\n    container: { image: x, options: --privileged }\n",
            true,
            &["x"],
        )
        .unwrap();
        assert!(w.jobs[0].refused.is_none(), "allowed per repo");
    }

    #[test]
    fn act_gets_a_copy_without_the_refused_jobs() {
        let (w, _) = wf("on: push\njobs:\n  a:\n    runs-on: x\n  bad:\n    container: { image: x, options: --privileged }\n  b:\n    needs: [a, bad]\n  c:\n    needs: bad\n").unwrap();
        let doc = w.for_act().unwrap();
        let jobs = doc["jobs"].as_object().unwrap();
        // Key order depends on serde_json's `preserve_order` (another workspace crate turns it
        // on); act does not care about job order.
        let mut keys: Vec<_> = jobs.keys().collect();
        keys.sort();
        assert_eq!(keys, ["a", "b", "c"]);
        assert_eq!(jobs["b"]["needs"], serde_json::json!(["a"]));
        assert!(jobs["c"].get("needs").is_none());
        let (ok, _) = wf("on: push\njobs:\n  a:\n    runs-on: x\n").unwrap();
        assert!(ok.for_act().is_none());
    }

    #[test]
    fn runs_on_must_be_a_configured_label() {
        let r = |ro: &str| {
            wf(&format!("on: push\njobs:\n  j:\n    runs-on: {ro}\n"))
                .unwrap()
                .0
                .jobs[0]
                .refused
                .clone()
        };
        assert!(r("ubuntu-latest").is_none());
        assert!(r("[x, ubuntu-latest]").is_none());
        assert!(r("ubuntu-22.04").is_some_and(|w| w.contains("[platforms]")));
        assert!(r("${{ matrix.os }}").is_some());
    }

    #[test]
    fn a_yaml_merge_key_makes_the_workflow_broken() {
        let hidden = "x: &c\n  container: { image: n, options: --privileged }\non: push\njobs:\n  j:\n    <<: *c\n    runs-on: x\n";
        assert!(wf(hidden).unwrap_err().contains("merge key"));
        let alias =
            "x: &o --privileged\non: push\njobs:\n  j:\n    container: { image: n, options: *o }\n";
        assert!(
            wf(alias).unwrap().0.jobs[0].refused.is_some(),
            "plain aliases are expanded and still refused"
        );
    }

    #[test]
    fn job_ids_are_validated_and_bad_yaml_is_a_reason() {
        assert!(valid_job_id("build_1-a") && valid_job_id("_x"));
        for bad in ["", "1abc", "a b", "../x", "a/b", "x;rm", "-j"] {
            assert!(!valid_job_id(bad), "{bad}");
        }
        assert!(wf("on: push\njobs:\n  \"../evil\":\n    runs-on: x\n")
            .unwrap_err()
            .contains("not a valid id"));
        assert!(wf("on: push\njobs: [1")
            .unwrap_err()
            .contains("not valid YAML"));
        assert!(wf("on: push\n").unwrap_err().contains("no `jobs:`"));
    }

    #[test]
    fn check_names_come_from_the_workflow_and_job_names() {
        let (w, _) = wf("name: CI\non: push\njobs:\n  build:\n    name: Build  it\n    runs-on: x\n  test:\n    runs-on: x\n").unwrap();
        assert_eq!(
            w.jobs
                .iter()
                .map(|j| j.check_name.as_str())
                .collect::<Vec<_>>(),
            ["CI / Build  it", "CI / test"]
        );
        let (w, _) = wf("on: push\njobs:\n  a:\n    runs-on: x\n").unwrap();
        assert_eq!(w.jobs[0].check_name, "ci.yml / a");
    }

    #[test]
    fn on_pull_request_filters() {
        let on = |t: &str| {
            wf(&format!("{t}\njobs:\n  a:\n    runs-on: x\n"))
                .unwrap()
                .1
        };
        let pr = |base, action, changed| PullFacts {
            base,
            action,
            changed,
            any_type: false,
        };
        let opened = pr("main", "opened", None);
        let sync = pr("main", "synchronize", None);
        let ready = pr("main", "ready_for_review", None);
        assert!(runs_on_pull_request(&on("on: pull_request"), &opened));
        assert!(runs_on_pull_request(&on("on: [push, pull_request]"), &sync));
        assert!(!runs_on_pull_request(&on("on: push"), &opened));
        assert!(
            !runs_on_pull_request(&on("on: pull_request_target"), &opened),
            "pull_request_target never runs here"
        );
        assert!(
            !runs_on_pull_request(&on("on: pull_request"), &ready),
            "ready_for_review is not a default type"
        );
        let typed = on("on:\n  pull_request:\n    types: [ready_for_review]");
        assert!(runs_on_pull_request(&typed, &ready) && !runs_on_pull_request(&typed, &opened));
        let empty = on("on:\n  pull_request:");
        assert!(runs_on_pull_request(&empty, &sync));
        let rerun = PullFacts {
            any_type: true,
            ..pr("main", "opened", None)
        };
        assert!(
            runs_on_pull_request(&typed, &rerun)
                && runs_on_pull_request(&on("on: pull_request"), &rerun),
            "a re-run runs a workflow of any activity the runner fires"
        );
        assert!(!runs_on_pull_request(&on("on: push"), &rerun));
        let closed = on("on:\n  pull_request:\n    types: [closed, labeled]");
        assert!(
            !runs_on_pull_request(&closed, &rerun),
            "a workflow that never ran here never re-runs"
        );
        let b = on("on:\n  pull_request:\n    branches: [main]");
        assert!(runs_on_pull_request(&b, &opened), "branches match the base");
        assert!(!runs_on_pull_request(&b, &pr("dev", "opened", None)));
        let ig = on("on:\n  pull_request:\n    branches-ignore: ['release/**']");
        assert!(!runs_on_pull_request(&ig, &pr("release/1", "opened", None)));
        let changed = ["docs/a.md".to_string()];
        let p = on("on:\n  pull_request:\n    paths: ['src/**']");
        assert!(!runs_on_pull_request(
            &p,
            &pr("main", "opened", Some(&changed))
        ));
        assert!(runs_on_pull_request(&p, &opened), "unknown changes run");
        let facts = Facts::PullRequest(opened);
        assert!(facts.runs(&on("on: pull_request")) && !facts.runs(&on("on: push")));
    }

    #[test]
    fn on_push_filters() {
        let on = |t: &str| {
            wf(&format!("{t}\njobs:\n  a:\n    runs-on: x\n"))
                .unwrap()
                .1
        };
        let main = facts("refs/heads/main", None);
        let feat = facts("refs/heads/feat/x", None);
        let tag = facts("refs/tags/v1.2", None);
        assert!(runs_on_push(&on("on: push"), &main));
        assert!(!runs_on_push(&on("on: pull_request"), &main));
        assert!(runs_on_push(&on("on: [push, pull_request]"), &tag));
        let b = on("on:\n  push:\n    branches: [main, 'release/**']");
        assert!(runs_on_push(&b, &main));
        assert!(!runs_on_push(&b, &feat));
        assert!(!runs_on_push(&b, &tag), "branches only: tags do not run");
        let t = on("on:\n  push:\n    tags: ['v*']");
        assert!(runs_on_push(&t, &tag) && !runs_on_push(&t, &main));
        let ig = on("on:\n  push:\n    branches-ignore: ['feat/**']");
        assert!(runs_on_push(&ig, &main) && !runs_on_push(&ig, &feat));
        let neg = on("on:\n  push:\n    branches: ['**', '!feat/**']");
        assert!(runs_on_push(&neg, &main) && !runs_on_push(&neg, &feat));
        assert!(
            filter_glob("v?.*", "v1.2") && !filter_glob("v?", "v12") && !filter_glob("a?b", "a/b")
        );
        let changed = ["docs/a.md".to_string()];
        let p = on("on:\n  push:\n    paths: ['src/**']");
        assert!(!runs_on_push(&p, &facts("refs/heads/main", Some(&changed))));
        assert!(
            runs_on_push(&p, &facts("refs/heads/main", None)),
            "a new ref runs"
        );
        let pi = on("on:\n  push:\n    paths-ignore: ['docs/**']");
        assert!(!runs_on_push(
            &pi,
            &facts("refs/heads/main", Some(&changed))
        ));
        assert!(runs_on_push(
            &on("on:\n  push:\n  workflow_dispatch:"),
            &main
        ));
    }

    #[test]
    fn plan_reads_only_regular_workflow_files_and_reports_broken_ones() {
        let d = tempfile::tempdir().unwrap();
        let w = d.path().join(".forge/workflows");
        std::fs::create_dir_all(&w).unwrap();
        std::fs::write(w.join("a.yml"), "on: push\njobs:\n  a:\n    runs-on: x\n").unwrap();
        std::fs::write(
            w.join("b.yaml"),
            "on: pull_request\njobs:\n  b:\n    runs-on: x\n",
        )
        .unwrap();
        std::fs::write(w.join("c.yml"), "jobs: [").unwrap();
        std::fs::write(w.join("notes.txt"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", w.join("d.yml")).unwrap();
        let p = plan(
            d.path(),
            &w,
            &Facts::Push(facts("refs/heads/main", None)),
            false,
            &["x"],
        );
        assert_eq!(p.run.len(), 1);
        assert_eq!(p.run[0].file, Path::new(".forge/workflows/a.yml"));
        let broken: Vec<_> = p
            .broken
            .iter()
            .map(|b| b.file.to_string_lossy().into_owned())
            .collect();
        #[cfg(unix)]
        assert_eq!(broken, [".forge/workflows/c.yml", ".forge/workflows/d.yml"]);
    }
    #[test]
    fn a_pull_request_that_changes_no_watched_path_is_path_filtered() {
        let on = |t: &str| {
            wf(&format!("{t}\njobs:\n  a:\n    runs-on: x\n"))
                .unwrap()
                .1
        };
        let docs = ["docs/a.md".to_string()];
        let src = ["src/a.rs".to_string()];
        let pr = |changed| {
            Facts::PullRequest(PullFacts {
                base: "main",
                action: "opened",
                changed,
                any_type: false,
            })
        };
        // What `plan` reports as path-filtered.
        let filtered = |f: &Facts<'_>, on: &Value| !f.runs(on) && f.runs_without_paths(on);
        let paths = on("on:\n  pull_request:\n    paths: ['src/**']");
        let ignore = on("on:\n  pull_request:\n    paths-ignore: ['docs/**']");
        assert!(filtered(&pr(Some(&docs)), &paths));
        assert!(filtered(&pr(Some(&docs)), &ignore));
        assert!(
            !filtered(&pr(Some(&src)), &paths),
            "a workflow that runs is not filtered"
        );
        assert!(
            !filtered(&pr(None), &paths),
            "unknown changes run the workflow"
        );
        let other_base = on("on:\n  pull_request:\n    branches: [dev]\n    paths: ['src/**']");
        assert!(
            !filtered(&pr(Some(&docs)), &other_base),
            "a workflow for another base would not run whatever the paths"
        );
        assert!(!filtered(&pr(Some(&docs)), &on("on: push")));
        let push_paths = on("on:\n  push:\n    paths: ['src/**']");
        assert!(
            filtered(
                &Facts::Push(facts("refs/heads/main", Some(&docs))),
                &push_paths
            ),
            "a push that changes no watched path is path-filtered…"
        );
        assert!(
            !filtered(&Facts::Push(facts("refs/heads/main", None)), &push_paths),
            "…but not a new branch, whose changes are unknown"
        );

        let d = tempfile::tempdir().unwrap();
        let w = d.path().join(".forge/workflows");
        std::fs::create_dir_all(&w).unwrap();
        std::fs::write(
            w.join("a.yml"),
            "on:\n  pull_request:\n    paths: ['src/**']\njobs:\n  a:\n    runs-on: x\n",
        )
        .unwrap();
        std::fs::write(
            w.join("b.yml"),
            "on: pull_request\njobs:\n  b:\n    runs-on: x\n",
        )
        .unwrap();
        let p = plan(d.path(), &w, &pr(Some(&docs)), false, &["x"]);
        assert_eq!(p.run.len(), 1);
        assert_eq!(p.run[0].file, Path::new(".forge/workflows/b.yml"));
        assert_eq!(p.path_filtered.len(), 1);
        assert_eq!(p.path_filtered[0].jobs[0].check_name, "a.yml / a");
    }

    #[test]
    fn a_schedule_runs_the_workflows_that_list_its_cron() {
        let on = |t: &str| -> Value { yaml_serde::from_str::<Value>(t).unwrap()["on"].clone() };
        let nightly =
            on("on:\n  schedule:\n    - cron: '0  3 * * *'\n    - cron: '*/5 * * * *'\n  push:");
        assert_eq!(schedule_crons(&nightly), ["0  3 * * *", "*/5 * * * *"]);
        assert!(
            Facts::Schedule("0 3 * * *", &[]).runs(&nightly),
            "spacing does not matter"
        );
        assert!(Facts::Schedule("*/5 * * * *", &[]).runs(&nightly));
        assert!(
            !Facts::Schedule("*/5 * * * *", &["0 3 * * *".into()]).runs(&nightly),
            "it ran for an earlier expression due in the same poll"
        );
        assert!(!Facts::Schedule("0 4 * * *", &[]).runs(&nightly));
        assert!(!Facts::Schedule("0 3 * * *", &[]).runs(&on("on: push")));
        assert!(
            schedule_crons(&on("on: [push, schedule]")).is_empty(),
            "a bare schedule lists no time"
        );
    }
}

//! Environments in workflows (DESIGN §4.5 "CI", phase 4D): a job's `environment:` gets that
//! Forge environment's entries as `${{ secrets.NAME }}`, on a trusted run only, and only when
//! the environment's audience names this runner's identity (`dg ci env` checks that and refuses
//! otherwise; a group never counts).
//!
//! act gives every job of a workflow file one secrets map, so the runner keeps environments apart
//! itself. Each entry in use gets a name drawn at random for this run (`FORGE_ENV_<random>_<n>`),
//! and in a job that names an environment, `secrets.NAME` and `secrets['NAME']` for one of its
//! entries become that name in the copy of the workflow act reads. Another job cannot name those
//! values: the names are drawn after its commit was written. A job that reads `secrets` other
//! than by a literal name (`toJSON(secrets)`, `secrets[matrix.name]`) would see them all, so in a
//! workflow run that carries environment values it is refused, and so is a call to a reusable
//! workflow, which the runner does not read, and an environment job's `outputs` read from
//! `secrets`. Actions can't reach the map: act (0.2.89) refuses `secrets` in an action's
//! `action.yml`, as GitHub does. Repository secrets (`secrets_file`) keep their names, so an
//! environment's entry wins over a repository secret of the same name, as on GitHub.
//!
//! The values reach act through its environment (`-s NAME`, [`crate::act::command`]), never a
//! file or its command line: act's `--secret-file` reader cannot hold every value (one ending in
//! `"` or `\`, or holding a CR LF), and nothing is written to disk. Every value is masked in the
//! job logs ([`Given::masks`]).

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use anyhow::{bail, Result};
use serde_json::Value;

use crate::workflow::Workflow;

/// What `dg ci env` said about one environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    /// Its entries, `(name, value)`.
    Values(Vec<(String, String)>),
    /// It can't be given to this runner.
    Unavailable {
        /// Why, for the job's check run, which anyone may read: never the environment's
        /// audience, people or count, which dg's own message may hold.
        public: &'static str,
        /// Sharing it with the runner would settle it.
        share: bool,
        /// dg's message, for the runner's log only.
        detail: String,
    },
}

/// The `dg` error codes that settle a lookup, each with the reason a check run gives (anything
/// else, a network failure, is tried again on the next poll). Not found, not openable and not
/// shared read the same: which one it is would tell the public about an environment it can't
/// see.
const SETTLED: [(&str, &str); 6] = [
    ("E102", NOT_SHARED),
    ("E307", NOT_SHARED),
    ("E612", NOT_SHARED),
    (
        "E608",
        "two maintainers saved it at once, and one version must be kept first",
    ),
    ("E306", "the runner's key holds no encryption key"),
    ("E201", "the runner's dg has no `dg ci env`; update dg"),
];

/// The public reason for an environment the runner can't read.
const NOT_SHARED: &str = "it isn't shared with this runner by name, or doesn't exist";

/// Read `dg --json ci env`'s answer: its entries, a settled refusal, or an error to retry.
pub fn parse_lookup(ok: bool, stdout: &str, stderr: &str) -> Result<Lookup> {
    let v: Value = serde_json::from_str(stdout).unwrap_or(Value::Null);
    if ok {
        let Some(entries) = v["entries"].as_array() else {
            bail!("dg ci env: no entries in its answer");
        };
        let mut out = Vec::new();
        for e in entries {
            match (e["name"].as_str(), e["value"].as_str()) {
                (Some(n), Some(val)) => out.push((n.to_string(), val.to_string())),
                _ => bail!("dg ci env: an entry without a name or value"),
            }
        }
        return Ok(Lookup::Values(out));
    }
    let err = &v["error"];
    let code = err["code"].as_str().unwrap_or_default();
    if let Some((_, public)) = SETTLED.iter().find(|(c, _)| *c == code) {
        let msg = err["message"].as_str().unwrap_or("not available");
        let detail = err["cause"]
            .as_str()
            .map_or_else(|| msg.to_string(), |c| format!("{msg}: {c}"));
        return Ok(Lookup::Unavailable {
            public,
            share: *public == NOT_SHARED,
            detail: format!("{detail} [{code}]"),
        });
    }
    let said = if stderr.trim().is_empty() {
        stdout.chars().take(600).collect::<String>()
    } else {
        stderr.trim().to_string()
    };
    bail!("dg ci env failed: {}", said.trim())
}

/// An environment name as `dg env` takes it: 1 to 64 letters, digits, `.`, `_` or `-`, starting
/// with a letter or digit.
fn valid_env_name(name: &str) -> bool {
    let b = name.as_bytes();
    (1..=64).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// The environment a job names (`environment: production`, or `environment: {name: production,
/// url: …}`), or why the runner refuses the job: a name it can only know at run time, or one
/// that is not an environment name.
pub fn job_environment(job: &Value) -> Result<Option<String>, String> {
    let name = match job.get("environment") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(s)) => s.as_str(),
        Some(Value::Object(o)) => match o.get("name") {
            Some(Value::String(s)) => s.as_str(),
            _ => return Err("`environment` has no `name`".into()),
        },
        Some(_) => return Err("`environment` is neither a name nor a mapping with one".into()),
    };
    if name.contains("${{") {
        return Err(
            "`environment` uses an expression; the runner gives an environment's values only to a job that names it as written"
                .into(),
        );
    }
    let name = name.trim();
    if !valid_env_name(name) {
        return Err(format!(
            "`environment: {name}` is not an environment name (1-64 letters, digits, `.`, `_` or `-`)"
        ));
    }
    Ok(Some(name.to_string()))
}

/// How a piece of workflow text reads the `secrets` context: each literal read (`secrets.NAME`,
/// `secrets['NAME']`) with the byte range it spans, and whether it reads it any other way.
#[derive(Debug, Default, PartialEq, Eq)]
struct Reads {
    names: Vec<(Range<usize>, String)>,
    whole: bool,
}

/// The literal name read right after `secrets` at `at` in `expr`, and where the read ends:
/// `.NAME` or `['NAME']`. `None` for anything else.
fn literal_name(expr: &str, at: usize) -> Option<(usize, String)> {
    let rest = &expr[at..];
    if let Some(after) = rest.strip_prefix('.') {
        let len = after
            .bytes()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
            .count();
        let first = after.bytes().next()?;
        if len == 0 || !(first.is_ascii_alphabetic() || first == b'_') {
            return None;
        }
        return Some((at + 1 + len, after[..len].to_string()));
    }
    let inner = rest.strip_prefix("['")?;
    let close = inner.find('\'')?;
    let name = &inner[..close];
    // `''` (a quote inside the name) or anything but `]` after the closing quote: not literal.
    if inner[close + 1..].starts_with(']') && !name.is_empty() {
        return Some((at + 2 + close + 2, name.to_string()));
    }
    None
}

/// Scan one expression (the text inside `${{ }}`, or a bare `if:`), found at `base` in its
/// string. Context names are case-insensitive; a `secrets` that follows a `.` is a property.
fn scan_expr(expr: &str, base: usize, out: &mut Reads) {
    let b = expr.as_bytes();
    let mut i = 0;
    let mut prev = 0u8;
    while i < b.len() {
        let c = b[i];
        if c == b'\'' {
            i += 1;
            while i < b.len() {
                if b[i] == b'\'' {
                    if b.get(i + 1) == Some(&b'\'') {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i += 1;
            prev = b'\'';
            continue;
        }
        if c.is_ascii_alphabetic() || c == b'_' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || matches!(b[i], b'_' | b'-')) {
                i += 1;
            }
            if prev != b'.' && expr[start..i].eq_ignore_ascii_case("secrets") {
                match literal_name(expr, i) {
                    Some((end, name)) => {
                        out.names.push((base + start..base + end, name));
                        i = end;
                    }
                    None => out.whole = true,
                }
            }
            prev = b'a';
            continue;
        }
        if !c.is_ascii_whitespace() {
            prev = c;
        }
        i += 1;
    }
}

/// The expressions of a string value: each `${{ … }}`, or the whole string for a bare `if:`.
/// act reads an `if:` as one expression unless it holds both `${{` and `}}`; such an `if:` is
/// also scanned whole for a whole read, so text that fools one reading is caught by the other.
fn scan_text(text: &str, bare: bool, out: &mut Reads) {
    if bare {
        if !(text.contains("${{") && text.contains("}}")) {
            scan_expr(text, 0, out);
            return;
        }
        let mut whole = Reads::default();
        scan_expr(text, 0, &mut whole);
        out.whole |= whole.whole;
    }
    let mut from = 0;
    while let Some(open) = text[from..].find("${{") {
        let start = from + open + 3;
        // The first `}}` outside a string literal closes it.
        let b = text.as_bytes();
        let mut i = start;
        let mut quoted = false;
        while i < b.len() {
            match b[i] {
                b'\'' => quoted = !quoted,
                b'}' if !quoted && b.get(i + 1) == Some(&b'}') => break,
                _ => {}
            }
            i += 1;
        }
        scan_expr(&text[start..i], start, out);
        from = (i + 2).min(text.len());
    }
}

/// Every read of `secrets` anywhere in `v` (keys included, for the whole-context check).
fn scan_value(v: &Value, bare: bool, out: &mut Reads) {
    match v {
        Value::String(s) => {
            let mut r = Reads::default();
            scan_text(s, bare, &mut r);
            out.whole |= r.whole;
            out.names.extend(r.names);
        }
        Value::Array(a) => a.iter().for_each(|x| scan_value(x, false, out)),
        Value::Object(o) => {
            for (k, x) in o {
                let mut r = Reads::default();
                scan_text(k, false, &mut r);
                out.whole |= r.whole || !r.names.is_empty();
                scan_value(x, k == "if", out);
            }
        }
        _ => {}
    }
}

/// Whether `v` reads `secrets` other than by a literal name.
fn reads_whole(v: &Value) -> bool {
    let mut r = Reads::default();
    scan_value(v, false, &mut r);
    r.whole
}

/// Whether `v` reads `secrets` at all.
fn reads_any(v: &Value) -> bool {
    let mut r = Reads::default();
    scan_value(v, false, &mut r);
    r.whole || !r.names.is_empty()
}

/// Rewrite every literal read of a name `renamed` holds (by its upper-case form) to the new name.
fn rewrite(v: &mut Value, bare: bool, renamed: &BTreeMap<String, String>) {
    match v {
        Value::String(s) => {
            let mut r = Reads::default();
            scan_text(s, bare, &mut r);
            for (range, name) in r.names.iter().rev() {
                if let Some(new) = renamed.get(&name.to_ascii_uppercase()) {
                    s.replace_range(range.clone(), &format!("secrets.{new}"));
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| rewrite(x, false, renamed)),
        Value::Object(o) => {
            for (k, x) in o.iter_mut() {
                rewrite(x, k == "if", renamed);
            }
        }
        _ => {}
    }
}

/// What one workflow run gives act from environments.
#[derive(Debug, Default)]
pub struct Given {
    /// `(name, value)` for act's environment and `-s NAME`: the run's random names. Empty values
    /// are left out (act would ask for one), and read as empty, as an unset secret does.
    pub secrets: Vec<(String, String)>,
    /// A note for a job's summary, by job id.
    pub notes: BTreeMap<String, &'static str>,
}

impl Given {
    /// The values to mask in logs.
    pub fn masks(&self) -> impl Iterator<Item = &str> {
        self.secrets.iter().map(|(_, v)| v.as_str())
    }
}

/// The environments a run's workflows name (literal names only, from jobs not already refused):
/// what to look up before anything is reported.
pub fn named(workflows: &[&Workflow]) -> BTreeSet<String> {
    workflows
        .iter()
        .flat_map(|wf| {
            wf.jobs
                .iter()
                .filter(|j| j.refused.is_none())
                .filter_map(|j| job_environment(&wf.doc["jobs"][&j.id]).ok().flatten())
        })
        .collect()
}

/// Settle `wf`'s environments: refuse what must not run, rename the entries of each job's
/// environment in the copy act reads, and say what goes to act. `trusted`: the run may have
/// environment values (a trusted ref, or a trusted pull request); otherwise jobs that name one
/// run without its values, as a fork's pull request runs without secrets. `looked` holds each
/// named environment's [`Lookup`] (every name [`named`] lists), and `nonce` is the run's random
/// part of the names (upper-case hex).
pub fn apply(
    wf: &mut Workflow,
    trusted: bool,
    looked: &BTreeMap<String, Lookup>,
    nonce: &str,
) -> Given {
    let mut given = Given::default();
    let mut env_of: BTreeMap<String, String> = BTreeMap::new();
    for j in wf.jobs.iter_mut().filter(|j| j.refused.is_none()) {
        match job_environment(&wf.doc["jobs"][&j.id]) {
            Ok(Some(e)) => {
                env_of.insert(j.id.clone(), e);
            }
            Ok(None) => {}
            Err(why) => j.refused = Some(why),
        }
    }
    if env_of.is_empty() {
        return given;
    }
    if !trusted {
        for id in env_of.keys() {
            given.notes.insert(
                id.clone(),
                ", without its environment's values (only trusted refs get them)",
            );
        }
        return given;
    }
    // Parts of the workflow outside its jobs (`env`, `run-name`, `defaults`) apply to every job.
    let mut outside = wf.doc.clone();
    if let Some(o) = outside.as_object_mut() {
        o.remove("jobs");
    }
    let outside_whole = reads_whole(&outside);
    let mut values: BTreeMap<&str, &[(String, String)]> = BTreeMap::new();
    for j in wf.jobs.iter_mut().filter(|j| j.refused.is_none()) {
        let Some(env) = env_of.get(&j.id) else {
            continue;
        };
        let job = &wf.doc["jobs"][&j.id];
        match env_values(job, env, outside_whole, looked.get(env)) {
            Ok(v) => {
                values.insert(env, v);
            }
            Err(why) => j.refused = Some(why),
        }
    }
    if values.is_empty() {
        return given;
    }
    // Values are in this run's map: no other job may read the whole map, or call a workflow the
    // runner does not read.
    for j in wf.jobs.iter_mut().filter(|j| j.refused.is_none()) {
        if env_of.contains_key(&j.id) {
            continue;
        }
        let job = &wf.doc["jobs"][&j.id];
        if job.get("uses").is_some() {
            j.refused = Some("calls a reusable workflow, which the runner does not read, in a workflow whose other jobs get an environment's values".into());
        } else if reads_whole(job) {
            j.refused = Some("reads `secrets` as a whole, not by name (`secrets.NAME`), in a workflow whose other jobs get an environment's values".into());
        }
    }
    let renamed = rename(&values, nonce, &mut given.secrets);
    let jobs = wf.doc.get_mut("jobs").and_then(Value::as_object_mut);
    for (id, job) in jobs.into_iter().flatten() {
        let Some(map) = env_of.get(id).and_then(|e| renamed.get(e.as_str())) else {
            continue;
        };
        if wf.jobs.iter().any(|j| &j.id == id && j.refused.is_none()) {
            rewrite(job, false, map);
            given
                .notes
                .insert(id.clone(), ", with its environment's values");
        }
    }
    wf.trimmed = true;
    given
}

/// The values a job naming `env` gets, or why it is refused: a whole read of `secrets` outside
/// the jobs (`outside_whole`) or in the job, a reusable workflow, `outputs` that read `secrets`
/// (they would carry a value to jobs without the environment), or an environment the runner
/// can't give it.
fn env_values<'l>(
    job: &Value,
    env: &str,
    outside_whole: bool,
    looked: Option<&'l Lookup>,
) -> Result<&'l [(String, String)], String> {
    if outside_whole {
        return Err(format!("names environment {env}, but the workflow reads `secrets` as a whole outside its jobs, which would hand every job its values"));
    }
    if job.get("uses").is_some() {
        return Err(format!(
            "names environment {env} and calls a reusable workflow, which the runner does not read"
        ));
    }
    if reads_whole(job) {
        return Err(format!("names environment {env} but reads `secrets` as a whole, not by name (`secrets.NAME`), which would hand it other environments' values too"));
    }
    if job.get("outputs").is_some_and(reads_any) {
        return Err(format!("names environment {env} and sets `outputs` from `secrets`, which would hand its values to other jobs"));
    }
    match looked {
        Some(Lookup::Values(v)) => unusable(v).map_or(Ok(v), |why| Err(format!("environment {env} {why}"))),
        Some(Lookup::Unavailable { public, share: true, .. }) => Err(format!("environment {env} can't be read by this runner: {public}. A maintainer shares it with the runner's identity: `dg env share --env {env} <runner>`")),
        Some(Lookup::Unavailable { public, .. }) => {
            Err(format!("environment {env} can't be read by this runner: {public}"))
        }
        None => Err(format!("environment {env} was not looked up")),
    }
}

/// This run's name for each entry of each environment in `values` (by its upper-case name), and
/// the non-empty values under those names in `secrets`. Names with GitHub's reserved `GITHUB_`
/// prefix are left out (the runner sets `GITHUB_TOKEN` itself).
fn rename<'v>(
    values: &BTreeMap<&'v str, &[(String, String)]>,
    nonce: &str,
    secrets: &mut Vec<(String, String)>,
) -> BTreeMap<&'v str, BTreeMap<String, String>> {
    let mut n = 0usize;
    let mut out = BTreeMap::new();
    for (env, entries) in values {
        let mut names = BTreeMap::new();
        for (name, value) in *entries {
            if name.to_ascii_uppercase().starts_with("GITHUB_") {
                continue;
            }
            let new = format!("FORGE_ENV_{nonce}_{n}");
            n += 1;
            if !value.is_empty() {
                secrets.push((new.clone(), value.clone()));
            }
            names.insert(name.to_ascii_uppercase(), new);
        }
        out.insert(*env, names);
    }
    out
}

/// Why entries can't be given to act: two names that differ only in letter case (act's and
/// GitHub's secret names don't), or a value holding a NUL character (no process environment
/// can).
fn unusable(entries: &[(String, String)]) -> Option<String> {
    let mut seen: BTreeMap<String, &str> = BTreeMap::new();
    for (n, v) in entries {
        if let Some(other) = seen.insert(n.to_ascii_uppercase(), n) {
            return Some(format!("has entries whose names differ only in letter case ({other}, {n}), which workflows can't tell apart"));
        }
        if v.contains('\0') {
            return Some(format!(
                "has an entry, {n}, holding a NUL character, which act can't take"
            ));
        }
    }
    None
}

/// The run's random part of the names (128 bits from the system's random source, upper-case
/// hex: act upper-cases secret names).
pub fn nonce() -> Result<String> {
    use anyhow::Context as _;
    use std::io::Read as _;
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .context("reading /dev/urandom")?;
    Ok(hex::encode_upper(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::read_workflow;
    use std::path::Path;

    fn reads(text: &str, bare: bool) -> Reads {
        let mut r = Reads::default();
        scan_text(text, bare, &mut r);
        r
    }

    fn names(text: &str) -> Vec<String> {
        reads(text, false)
            .names
            .into_iter()
            .map(|(_, n)| n)
            .collect()
    }

    #[test]
    fn literal_reads_are_found_and_anything_else_is_a_whole_read() {
        assert_eq!(names("${{ secrets.DB_URL }}"), ["DB_URL"]);
        assert_eq!(
            names("a ${{ secrets['db'] }} b ${{SECRETS.x}}"),
            ["db", "x"]
        );
        assert_eq!(
            names("${{ format('{0}', secrets.A) }} and ${{ secrets.B || 'x' }}"),
            ["A", "B"]
        );
        assert!(names("echo secrets.A and ${{ github.secrets }}").is_empty());
        assert!(names("${{ 'secrets.A' }}").is_empty(), "inside a string");
        assert!(!reads("${{ 'it''s secrets.A }}' }}", false).whole);
        for whole in [
            "${{ toJSON(secrets) }}",
            "${{ secrets[matrix.name] }}",
            "${{ secrets [ 'A' ] }}",
            "${{ secrets }}",
            "${{ secrets.  A }}",
            "${{ secrets['it''s'] }}",
        ] {
            assert!(reads(whole, false).whole, "{whole}");
        }
        assert!(
            reads("secrets.A != ''", true).names.len() == 1,
            "a bare if:"
        );
        assert!(reads("contains(toJSON(secrets), 'x')", true).whole);
        // act reads this `if:` whole (no `}}`), so the string after `${{` is no hiding place.
        assert!(reads("contains(toJSON(secrets), 'a') || '${{' == ''", true).whole);
        assert!(reads("${{ true }} && contains(toJSON(secrets), 'a')", true).whole);
        assert!(
            reads("toJSON(secrets)", false).names.is_empty()
                && !reads("toJSON(secrets)", false).whole,
            "plain text outside ${{{{ }}}} is not an expression"
        );
    }

    #[test]
    fn environment_names_are_literal() {
        let env = |y: &str| job_environment(&yaml_serde::from_str::<Value>(y).unwrap());
        assert_eq!(
            env("environment: production").unwrap().as_deref(),
            Some("production")
        );
        assert_eq!(
            env("environment: {name: staging, url: 'https://x'}")
                .unwrap()
                .as_deref(),
            Some("staging")
        );
        assert_eq!(env("runs-on: x").unwrap(), None);
        assert!(env("environment: ${{ matrix.env }}").is_err());
        assert!(env("environment: {url: x}").is_err());
        assert!(env("environment: 'prod/eu'").is_err());
        assert!(env("environment: [a]").is_err());
    }

    const WF: &str = r"
name: deploy
env:
  LEVEL: info
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ${{ secrets.DB_URL }} ${{ secrets.REPO_ONLY }}
  staging:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: echo ${{ secrets.DB_URL }}
        if: secrets.db_url != ''
  production:
    runs-on: ubuntu-latest
    environment: {name: production}
    needs: [build]
    steps:
      - run: echo ${{ secrets['DB_URL'] }} ${{ secrets.REPO_ONLY }} ${{ secrets.GITHUB_TOKEN }}
        env:
          K: ${{ secrets.API_KEY }}
";

    fn wf(text: &str) -> Workflow {
        read_workflow(Path::new("deploy.yml"), text, false, &["ubuntu-latest"])
            .unwrap()
            .0
    }

    fn looked(pairs: &[(&str, Lookup)]) -> BTreeMap<String, Lookup> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    fn vals(pairs: &[(&str, &str)]) -> Lookup {
        Lookup::Values(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
        )
    }

    fn step_run(w: &Workflow, job: &str) -> String {
        w.doc["jobs"][job]["steps"][0]["run"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// Each job reads its own environment's value under the same name; a job without one, and
    /// repository secrets, keep the names they had.
    #[test]
    fn each_job_reads_only_its_own_environment() {
        let mut w = wf(WF);
        assert_eq!(
            named(&[&w]),
            BTreeSet::from(["production".to_string(), "staging".to_string()])
        );
        let l = looked(&[
            (
                "staging",
                vals(&[("DB_URL", "stage-db"), ("GITHUB_TOKEN", "no")]),
            ),
            (
                "production",
                vals(&[("DB_URL", "prod-db"), ("API_KEY", ""), ("X", "x")]),
            ),
        ]);
        let g = apply(&mut w, true, &l, "N");
        assert!(w.jobs.iter().all(|j| j.refused.is_none()), "{:?}", w.jobs);
        assert!(
            w.trimmed && w.for_act().is_some(),
            "act reads the rewritten copy"
        );
        assert_eq!(
            step_run(&w, "build"),
            "echo ${{ secrets.DB_URL }} ${{ secrets.REPO_ONLY }}"
        );
        let given: BTreeMap<&str, &str> = g
            .secrets
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let stage = step_run(&w, "staging");
        let prod = step_run(&w, "production");
        let name_in = |s: &str| {
            s.split("secrets.")
                .nth(1)
                .unwrap()
                .split(' ')
                .next()
                .unwrap()
                .to_string()
        };
        assert_eq!(given[name_in(&stage).as_str()], "stage-db");
        assert_eq!(given[name_in(&prod).as_str()], "prod-db");
        assert!(
            prod.ends_with("${{ secrets.REPO_ONLY }} ${{ secrets.GITHUB_TOKEN }}"),
            "{prod}"
        );
        assert!(
            w.doc["jobs"]["staging"]["steps"][0]["if"]
                .as_str()
                .unwrap()
                .starts_with("secrets.FORGE_ENV_N_"),
            "a bare if: is rewritten too"
        );
        let k = w.doc["jobs"]["production"]["steps"][0]["env"]["K"]
            .as_str()
            .unwrap();
        assert!(k.starts_with("${{ secrets.FORGE_ENV_N_"), "{k}");
        assert!(
            !given.values().any(|v| v.is_empty()),
            "an empty value is not given"
        );
        assert!(
            !given.values().any(|v| *v == "no"),
            "GITHUB_ names are not taken"
        );
        assert_eq!(g.secrets.len(), 3);
        assert_eq!(g.notes["production"], ", with its environment's values");
        assert!(!g.notes.contains_key("build"));
    }

    #[test]
    fn an_untrusted_run_gets_no_values() {
        let mut w = wf(WF);
        let g = apply(&mut w, false, &BTreeMap::new(), "N");
        assert!(g.secrets.is_empty());
        assert!(w.jobs.iter().all(|j| j.refused.is_none()));
        assert!(!w.trimmed, "act reads the file as it is");
        assert!(g.notes["staging"].contains("only trusted refs"));
    }

    #[test]
    fn an_environment_not_shared_with_the_runner_refuses_its_jobs_only() {
        let mut w = wf(WF);
        let l = looked(&[
            ("staging", vals(&[("DB_URL", "s")])),
            (
                "production",
                parse_lookup(
                    false,
                    r#"{"error":{"code":"E612","message":"m","cause":"Writers and maintainers"}}"#,
                    "",
                )
                .unwrap(),
            ),
        ]);
        let g = apply(&mut w, true, &l, "N");
        let refused = |id: &str| w.jobs.iter().find(|j| j.id == id).unwrap().refused.clone();
        assert!(refused("production")
            .unwrap()
            .contains("dg env share --env production"));
        assert_eq!(refused("staging"), None);
        assert_eq!(refused("build"), None);
        assert_eq!(g.secrets.len(), 1);
        assert!(w.for_act().unwrap()["jobs"].get("production").is_none());
    }

    #[test]
    fn whole_reads_are_refused_when_values_are_in_the_run() {
        let text = WF.replace(
            "echo ${{ secrets.DB_URL }} ${{ secrets.REPO_ONLY }}",
            "echo ${{ toJSON(secrets) }}",
        );
        let l = looked(&[
            ("staging", vals(&[("DB_URL", "s")])),
            ("production", vals(&[("DB_URL", "p")])),
        ]);
        let mut w = wf(&text);
        apply(&mut w, true, &l, "N");
        let refused =
            |w: &Workflow, id: &str| w.jobs.iter().find(|j| j.id == id).unwrap().refused.clone();
        assert!(refused(&w, "build").unwrap().contains("as a whole"));
        assert_eq!(refused(&w, "production"), None);
        // No environment values in the run: the same job runs.
        let mut w = wf(&text);
        apply(&mut w, false, &l, "N");
        assert_eq!(refused(&w, "build"), None);
        // Outside the jobs: every job naming an environment is refused, the rest run.
        let mut w = wf(&WF.replace("LEVEL: info", "ALL: ${{ toJSON(secrets) }}"));
        let g = apply(&mut w, true, &l, "N");
        assert!(refused(&w, "staging").unwrap().contains("outside its jobs"));
        assert!(refused(&w, "production").is_some());
        assert_eq!(refused(&w, "build"), None);
        assert!(g.secrets.is_empty());
    }

    #[test]
    fn a_name_clash_and_an_expression_name_are_refused() {
        let l = looked(&[
            ("staging", vals(&[("db_url", "a"), ("DB_URL", "b")])),
            ("production", vals(&[("DB_URL", "p")])),
        ]);
        let mut w = wf(WF);
        apply(&mut w, true, &l, "N");
        let r = w
            .jobs
            .iter()
            .find(|j| j.id == "staging")
            .unwrap()
            .refused
            .clone();
        assert!(r.unwrap().contains("letter case"));
        let mut w = wf(&WF.replace("environment: staging", "environment: ${{ matrix.e }}"));
        apply(&mut w, false, &l, "N");
        let r = w
            .jobs
            .iter()
            .find(|j| j.id == "staging")
            .unwrap()
            .refused
            .clone();
        assert!(
            r.unwrap().contains("expression"),
            "refused whether or not trusted"
        );
    }

    /// An environment job's `outputs` would carry a value on to jobs without the environment.
    #[test]
    fn outputs_read_from_secrets_are_refused() {
        let text = WF.replace(
            "    environment: staging\n",
            "    environment: staging\n    outputs:\n      leak: ${{ secrets.DB_URL }}\n",
        );
        let l = looked(&[
            ("staging", vals(&[("DB_URL", "s")])),
            ("production", vals(&[("DB_URL", "p")])),
        ]);
        let mut w = wf(&text);
        apply(&mut w, true, &l, "N");
        let r = w
            .jobs
            .iter()
            .find(|j| j.id == "staging")
            .unwrap()
            .refused
            .clone();
        assert!(r.unwrap().contains("`outputs`"));
    }

    #[test]
    fn dg_answers_are_read() {
        let ok = r#"{"env":"p","entries":[{"name":"A","type":"secret","value":"1"}]}"#;
        assert_eq!(
            parse_lookup(true, ok, "").unwrap(),
            Lookup::Values(vec![("A".into(), "1".into())])
        );
        let refused = r#"{"error":{"code":"E612","message":"x has no environment p shared with this runner","cause":"p reaches it only through its group"}}"#;
        match parse_lookup(false, refused, "").unwrap() {
            Lookup::Unavailable {
                public,
                share,
                detail,
            } => {
                assert!(detail.contains("only through its group") && detail.ends_with("[E612]"));
                assert!(
                    share && !public.contains("group"),
                    "the public reason says nothing of the audience"
                );
            }
            other @ Lookup::Values(_) => panic!("{other:?}"),
        }
        let conflict =
            r#"{"error":{"code":"E608","message":"2 people changed p at the same time"}}"#;
        assert!(matches!(
            parse_lookup(false, conflict, "").unwrap(),
            Lookup::Unavailable { share: false, .. }
        ));
        let net = r#"{"error":{"code":"E701","message":"no node answered"}}"#;
        assert!(
            parse_lookup(false, net, "").is_err(),
            "a network error is tried again"
        );
        assert!(parse_lookup(false, "", "boom").is_err());
        assert!(parse_lookup(true, "{}", "").is_err());
    }

    #[test]
    fn nonces_differ() {
        let (a, b) = (nonce().unwrap(), nonce().unwrap());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert_eq!(a, a.to_ascii_uppercase());
    }
}

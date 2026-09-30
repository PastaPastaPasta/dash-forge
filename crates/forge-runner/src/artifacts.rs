//! Job artifacts (`actions/upload-artifact`) from act's artifact server, turned into files `dg ci
//! report --artifact` uploads to the owner's storage and records on the job's check run.
//!
//! act's server (`--artifact-server-path <dir>`) keeps what jobs upload as
//! `<dir>/<run id>/<artifact name>/…`:
//!
//! * **upload-artifact v4** sends one zip: `<name>/<name>.zip`, passed on as it is.
//! * **v3** sends each file (gzipped ones end in `.gz__`): they are put in one zip, `<name>.zip`,
//!   the gzipped ones inflated, as GitHub serves a v3 artifact.
//!
//! The server does not say which job uploaded what, so each job's log is read for
//! upload-artifact's `Artifact <name> has been successfully uploaded!`. An artifact no log names
//! (a log cut at its cap) goes on every job of that workflow file, so none is lost. Nothing in
//! the server's directory is followed through a symlink, and a gzip is inflated only up to
//! [`MAX_ARTIFACT_BYTES`].

use std::collections::BTreeMap;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context as _, Result};

/// The largest artifact uploaded; a larger one is left out (and said so in the job's summary).
pub const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;

/// The most artifacts one job's report carries (`dg ci report` takes 10).
pub const MAX_PER_JOB: usize = 10;

/// An artifact ready to report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact {
    /// The name the job gave it.
    pub name: String,
    /// `<name>.zip`, to upload.
    pub zip: PathBuf,
}

/// What [`collect`] found: the artifacts, and why others were left out.
#[derive(Debug, Default)]
pub struct Collected {
    pub artifacts: Vec<Artifact>,
    pub skipped: Vec<String>,
}

/// A file name for `name`: letters, digits, `.`, `_` and `-` kept, anything else `_`, at most
/// 100 characters, never empty or a dot name.
pub fn file_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .take(100)
        .collect();
    if s.is_empty() || s.chars().all(|c| c == '.') {
        "artifact".into()
    } else {
        s
    }
}

/// The regular files under `dir` (not through symlinks), with their paths relative to it,
/// sorted.
fn files_under(dir: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d)? {
            let e = e?;
            let t = e.file_type()?;
            if t.is_dir() {
                stack.push(e.path());
            } else if t.is_file() {
                let rel = e
                    .path()
                    .strip_prefix(dir)?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, e.path()));
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Collect every artifact under act's server directory `dir` into `out`.
pub fn collect(dir: &Path, out: &Path) -> Result<Collected> {
    let mut found = Collected::default();
    if !dir.is_dir() {
        return Ok(found);
    }
    std::fs::create_dir_all(out)?;
    let mut runs: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    runs.sort();
    for run in runs {
        let mut named: Vec<PathBuf> = std::fs::read_dir(&run)?
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.path())
            .collect();
        named.sort();
        for adir in named {
            let name = adir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let zip = out.join(format!("{}.zip", file_name(&name)));
            match pack(&adir, &name, &zip) {
                Ok(()) => found.artifacts.push(Artifact { name, zip }),
                Err(e) => found.skipped.push(format!("{name}: {e:#}")),
            }
        }
    }
    Ok(found)
}

/// Make `zip` from one artifact directory: v4's single `<name>.zip` as it is, else v3's files.
fn pack(adir: &Path, name: &str, zip: &Path) -> Result<()> {
    let files = files_under(adir)?;
    if let [(rel, path)] = files.as_slice() {
        if *rel == format!("{name}.zip") {
            if std::fs::metadata(path)?.len() > MAX_ARTIFACT_BYTES {
                bail!("larger than {} MiB", MAX_ARTIFACT_BYTES >> 20);
            }
            std::fs::copy(path, zip)?;
            return Ok(());
        }
    }
    if files.is_empty() {
        bail!("no files");
    }
    let f = std::fs::File::create(zip).with_context(|| format!("creating {}", zip.display()))?;
    let mut w = zip::ZipWriter::new(f);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);
    let mut total = 0u64;
    let mut buf = Vec::new();
    for (rel, path) in files {
        buf.clear();
        let file = std::fs::File::open(&path)?;
        let (entry, n) = match rel.strip_suffix(".gz__") {
            Some(plain) => {
                let mut z = flate2::read::GzDecoder::new(file).take(MAX_ARTIFACT_BYTES + 1);
                (plain.to_string(), z.read_to_end(&mut buf)?)
            }
            None => (
                rel.clone(),
                file.take(MAX_ARTIFACT_BYTES + 1).read_to_end(&mut buf)?,
            ),
        };
        total += n as u64;
        if total > MAX_ARTIFACT_BYTES {
            drop(w);
            let _ = std::fs::remove_file(zip);
            bail!("larger than {} MiB", MAX_ARTIFACT_BYTES >> 20);
        }
        w.start_file(entry, opts)?;
        w.write_all(&buf)?;
    }
    w.finish()?;
    Ok(())
}

/// The artifact names a job's log says it uploaded.
pub fn uploaded_by(log: &str) -> Vec<String> {
    const HEAD: &str = "Artifact ";
    const TAIL: &str = " has been successfully uploaded!";
    let mut names: Vec<String> = log
        .lines()
        .filter_map(|l| {
            let at = l.find(HEAD)?;
            let rest = &l[at + HEAD.len()..];
            rest.find(TAIL).map(|end| rest[..end].to_string())
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Which artifacts go on which job's report: those its log names, and those no job's log names
/// on every job (`logs` is job id → log).
pub fn assign<'a>(
    artifacts: &'a [Artifact],
    logs: &BTreeMap<String, String>,
    jobs: &[&str],
) -> BTreeMap<String, Vec<&'a Artifact>> {
    let claimed: BTreeMap<&str, Vec<String>> = jobs
        .iter()
        .map(|j| (*j, uploaded_by(logs.get(*j).map_or("", String::as_str))))
        .collect();
    let orphan = |a: &Artifact| !claimed.values().any(|names| names.contains(&a.name));
    jobs.iter()
        .map(|j| {
            let mine = artifacts
                .iter()
                .filter(|a| claimed[j].contains(&a.name) || orphan(a))
                .collect();
            ((*j).to_string(), mine)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gz(bytes: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(bytes).unwrap();
        e.finish().unwrap()
    }

    fn unzip(p: &Path) -> BTreeMap<String, String> {
        let mut z = zip::ZipArchive::new(std::fs::File::open(p).unwrap()).unwrap();
        (0..z.len())
            .map(|i| {
                let mut f = z.by_index(i).unwrap();
                let mut s = String::new();
                f.read_to_string(&mut s).unwrap();
                (f.name().to_string(), s)
            })
            .collect()
    }

    #[test]
    fn v4_zips_pass_through_and_v3_files_are_zipped_inflated() {
        let d = tempfile::tempdir().unwrap();
        let srv = d.path().join("srv");
        std::fs::create_dir_all(srv.join("1/dist4")).unwrap();
        std::fs::write(srv.join("1/dist4/dist4.zip"), b"PK-v4").unwrap();
        std::fs::create_dir_all(srv.join("1/dist3/sub")).unwrap();
        std::fs::write(srv.join("1/dist3/a.txt"), b"plain").unwrap();
        std::fs::write(srv.join("1/dist3/sub/b.txt.gz__"), gz(b"inflated")).unwrap();
        let got = collect(&srv, &d.path().join("out")).unwrap();
        let names: Vec<_> = got.artifacts.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["dist3", "dist4"]);
        assert_eq!(std::fs::read(&got.artifacts[1].zip).unwrap(), b"PK-v4");
        assert_eq!(
            unzip(&got.artifacts[0].zip),
            BTreeMap::from([
                ("a.txt".to_string(), "plain".to_string()),
                ("sub/b.txt".to_string(), "inflated".to_string()),
            ])
        );
        assert!(got.skipped.is_empty());
        assert!(collect(&d.path().join("none"), &d.path().join("o2"))
            .unwrap()
            .artifacts
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed() {
        let d = tempfile::tempdir().unwrap();
        let srv = d.path().join("srv");
        std::fs::create_dir_all(srv.join("1/a")).unwrap();
        std::fs::write(srv.join("1/a/ok.txt"), b"ok").unwrap();
        std::os::unix::fs::symlink("/etc/hosts", srv.join("1/a/hosts")).unwrap();
        let got = collect(&srv, &d.path().join("out")).unwrap();
        let entries = unzip(&got.artifacts[0].zip);
        assert_eq!(entries.keys().collect::<Vec<_>>(), ["ok.txt"]);
    }

    #[test]
    fn names_become_safe_file_names() {
        assert_eq!(file_name("dist-1.0_x"), "dist-1.0_x");
        assert_eq!(file_name("a/b c"), "a_b_c");
        assert_eq!(file_name(".."), "artifact");
        assert_eq!(file_name(""), "artifact");
        assert_eq!(file_name(&"x".repeat(300)).len(), 100);
    }

    #[test]
    fn artifacts_go_to_the_jobs_whose_logs_name_them() {
        let log = "[a/up] | Artifact dist has been successfully uploaded! Final size is 3 bytes.\n";
        assert_eq!(uploaded_by(log), ["dist"]);
        let arts = [
            Artifact {
                name: "dist".into(),
                zip: "d.zip".into(),
            },
            Artifact {
                name: "lost".into(),
                zip: "l.zip".into(),
            },
        ];
        let logs = BTreeMap::from([
            ("up".to_string(), log.to_string()),
            ("other".to_string(), "no uploads".to_string()),
        ]);
        let got = assign(&arts, &logs, &["up", "other"]);
        let names = |j: &str| got[j].iter().map(|a| a.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names("up"), ["dist", "lost"]);
        assert_eq!(
            names("other"),
            ["lost"],
            "an artifact no log names goes on every job"
        );
    }
}

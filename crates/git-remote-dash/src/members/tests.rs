//! The helper side of members-only branches: the publication guard over real git
//! (`publish_guard__*`, S4's scenarios and the git-only ones), a new branch's audience (D12), and
//! the grafts over an unreadable members-only parent.

use super::*;
use serde_json::Value;

/// `git` in `dir`, with no user or system config (and none a caller's environment injects), a
/// fixed author and committer, and `stdin`; its stdout.
fn git_bytes(dir: &Path, args: &[&str], stdin: &[u8]) -> Vec<u8> {
    use std::io::Write as _;
    let mut child = std::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_COUNT", "0")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@e.x")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@e.x")
        .env("GIT_AUTHOR_DATE", "@1700000000 +0000")
        .env("GIT_COMMITTER_DATE", "@1700000000 +0000")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let data = stdin.to_vec();
    let writer = std::thread::spawn(move || input.write_all(&data));
    let out = child.wait_with_output().unwrap();
    writer.join().unwrap().unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

fn git_in(dir: &Path, args: &[&str], stdin: Option<&str>) -> String {
    let out = git_bytes(dir, args, stdin.unwrap_or_default().as_bytes());
    String::from_utf8(out).unwrap().trim().to_owned()
}

fn init(dir: &Path) {
    git_in(dir, &["init", "-q", "-b", "main"], None);
}

// --- the vectors over real git ------------------------------------------------------------------

/// A vector's abstract object graph made real in a fresh repository: every abstract id mapped to
/// the object git stores for it. Blobs hold their abstract id, trees name their entries by
/// abstract id, commits carry it as their message, and a notes commit's tree names the objects it
/// annotates by their real ids, as `git notes` writes it.
struct Realized {
    _dir: tempfile::TempDir,
    path: PathBuf,
    real: BTreeMap<String, String>,
    abstract_of: BTreeMap<String, String>,
}

fn realize(objects: &serde_json::Map<String, Value>, notes: &serde_json::Map<String, Value>) -> Realized {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().to_path_buf();
    init(&path);
    let mut real: BTreeMap<String, String> = BTreeMap::new();
    let deps = |id: &str| -> Vec<String> {
        let o = &objects[id];
        let mut d: Vec<String> = Vec::new();
        match o["type"].as_str().unwrap() {
            "tree" => d.extend(o["entries"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_owned())),
            "commit" => {
                d.extend(o["parents"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_owned()));
                if let Some(t) = o["tree"].as_str() {
                    d.push(t.to_owned());
                }
                if let Some(n) = notes.get(id) {
                    d.extend(n.as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_owned()));
                }
            }
            "tag" => d.push(o["target"].as_str().unwrap().to_owned()),
            _ => {}
        }
        d
    };
    let empty_tree = git_in(&path, &["mktree"], Some(""));
    while real.len() < objects.len() {
        let before = real.len();
        for (id, o) in objects {
            if real.contains_key(id) || !deps(id).iter().all(|d| real.contains_key(d)) {
                continue;
            }
            let oid = match o["type"].as_str().unwrap() {
                "blob" => git_in(&path, &["hash-object", "-w", "--stdin"], Some(id)),
                "tree" => {
                    let mut entries: Vec<String> = o["entries"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|e| {
                            let e = e.as_str().unwrap();
                            let (mode, kind) = if objects[e]["type"] == "tree" {
                                ("040000", "tree")
                            } else {
                                ("100644", "blob")
                            };
                            format!("{mode} {kind} {}\t{e}", real[e])
                        })
                        .collect();
                    entries.sort_by(|a, b| a.split('\t').nth(1).cmp(&b.split('\t').nth(1)));
                    git_in(&path, &["mktree"], Some(&(entries.join("\n") + "\n")))
                }
                "commit" => {
                    let tree = match notes.get(id) {
                        Some(targets) => {
                            let note = git_in(&path, &["hash-object", "-w", "--stdin"], Some("a note"));
                            let mut entries: Vec<String> = targets
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|t| format!("100644 blob {note}\t{}", real[t.as_str().unwrap()]))
                                .collect();
                            entries.sort();
                            git_in(&path, &["mktree"], Some(&(entries.join("\n") + "\n")))
                        }
                        None => o["tree"]
                            .as_str()
                            .map_or(empty_tree.clone(), |t| real[t].clone()),
                    };
                    let mut args = vec!["commit-tree".to_owned(), tree, "-m".into(), id.clone()];
                    for p in o["parents"].as_array().unwrap() {
                        args.push("-p".into());
                        args.push(real[p.as_str().unwrap()].clone());
                    }
                    let args: Vec<&str> = args.iter().map(String::as_str).collect();
                    git_in(&path, &args, None)
                }
                "tag" => {
                    let target = o["target"].as_str().unwrap();
                    let kind = objects[target]["type"].as_str().unwrap();
                    let body = format!(
                        "object {}\ntype {kind}\ntag t{}\ntagger t <t@e.x> 1700000000 +0000\n\n{id}\n",
                        real[target],
                        &id[..8]
                    );
                    git_in(&path, &["mktag"], Some(&body))
                }
                other => panic!("object type {other}"),
            };
            real.insert(id.clone(), oid);
        }
        assert!(real.len() > before, "the vector's graph has a cycle or a missing object");
    }
    let abstract_of = real.iter().map(|(a, r)| (r.clone(), a.clone())).collect();
    Realized {
        _dir: dir,
        path,
        real,
        abstract_of,
    }
}

impl Realized {
    fn oid(&self, a: &str) -> String {
        self.real.get(a).cloned().unwrap_or_else(|| a.to_owned())
    }

    /// A ref name with an abstract id in it (`refs/replace/<id>`) made real.
    fn dst(&self, d: &str) -> String {
        match d.strip_prefix("refs/replace/") {
            Some(x) => format!("refs/replace/{}", self.oid(x)),
            None => d.to_owned(),
        }
    }

    fn back(&self, v: &mut Value) {
        match v {
            Value::String(s) => {
                if let Some(a) = self.abstract_of.get(s.as_str()) {
                    *s = a.clone();
                } else if let Some(x) = s.strip_prefix("refs/replace/") {
                    if let Some(a) = self.abstract_of.get(x) {
                        *s = format!("refs/replace/{a}");
                    }
                }
            }
            Value::Array(a) => {
                for x in a.iter_mut() {
                    self.back(x);
                }
                if a.iter().all(Value::is_string) {
                    a.sort_by(|x, y| x.as_str().cmp(&y.as_str()));
                }
            }
            Value::Object(o) => o.values_mut().for_each(|x| self.back(x)),
            _ => {}
        }
    }
}

fn audience(v: &Value) -> Audience {
    match v.as_str() {
        Some("members") => Audience::Members,
        _ => Audience::Public,
    }
}

/// The ledger a vector describes, through the real parser (`null` absent, `"unknown"` another
/// version, else its entries).
fn ledger_of(v: &Value, r: &Realized) -> ledger::State {
    match v {
        Value::Null => ledger::State::Absent,
        Value::String(s) if s == "unknown" => ledger::State::Unknown,
        Value::Array(entries) => {
            let mut text = format!("{}\n", ledger::HEADER);
            for e in entries {
                text.push_str(&format!("commit {}", r.oid(e["oid"].as_str().unwrap())));
                if let Some(a) = e.get("audience").and_then(Value::as_str) {
                    text.push(' ');
                    text.push_str(a);
                }
                text.push('\n');
            }
            ledger::State::Present(ledger::parse(&text).expect("a vector's ledger parses"))
        }
        other => panic!("ledger {other}"),
    }
}

fn vectors(case: &str) -> Vec<(String, Value)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../forge-contracts/vectors");
    let mut out: Vec<(String, Value)> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| {
            let p = e.unwrap().path();
            let name = p.file_name()?.to_str()?.to_owned();
            (name.starts_with(&format!("{case}__")) && name.ends_with(".json")).then(|| {
                let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
                (name, v)
            })
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn every_publish_guard_vector_holds_over_real_git() {
    let all = vectors("publish_guard");
    assert!(all.len() >= 30, "{} vectors", all.len());
    let mut repos: BTreeMap<String, Realized> = BTreeMap::new();
    for (name, v) in &all {
        let inp = &v["input"];
        let key = serde_json::to_string(&(&inp["objects"], &inp["notes"])).unwrap();
        let r = repos.entry(key).or_insert_with(|| {
            realize(
                inp["objects"].as_object().unwrap(),
                inp.get("notes")
                    .and_then(Value::as_object)
                    .unwrap_or(&serde_json::Map::new()),
            )
        });
        let ids = |v: &Value| -> Vec<String> {
            v.as_array()
                .unwrap()
                .iter()
                .map(|x| r.oid(x.as_str().unwrap()))
                .collect()
        };
        let public_tips = ids(&inp["publicTips"]);
        let decryptable = (!inp["decryptable"].is_null()).then(|| ids(&inp["decryptable"]));
        let batch: Vec<BatchRef> = inp["batch"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| BatchRef {
                dst: r.dst(b["dst"].as_str().unwrap()),
                new: b["new"].as_str().map(|n| r.oid(n)),
                audience: audience(&b["audience"]),
            })
            .collect();
        let state = ledger_of(&inp["ledger"], r);
        let publish = inp.get("publishPrivate").and_then(Value::as_str).map(|p| r.oid(p));
        let outcome = guard::guard(
            &GitGraph::at(&r.path),
            &GuardInput {
                members_key: inp["membersKey"].as_bool().unwrap(),
                ledger: &state,
                decryptable: decryptable.as_deref(),
                public_tips: &public_tips,
                batch: &batch,
                publish_private: publish.as_deref(),
            },
        )
        .unwrap_or_else(|e| panic!("{name}: {e}"));
        let mut got = serde_json::to_value(&outcome).unwrap();
        r.back(&mut got);
        let mut want = v["expected"].clone();
        r.back(&mut want);
        assert_eq!(got, want, "{name}: {}", v["description"]);
    }
}

// --- the guard's inputs, which only real git has --------------------------------------------------

/// `main` A–B, a members-only branch `sec` B–S1–S2, and `merge` = main merging sec.
struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    b: String,
    s2: String,
    merge: String,
}

fn fixture() -> Fixture {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().to_path_buf();
    init(&path);
    let commit = |msg: &str, file: &str, parents: &[&str]| {
        std::fs::write(path.join(file), msg).unwrap();
        git_in(&path, &["add", file], None);
        let tree = git_in(&path, &["write-tree"], None);
        let mut args = vec!["commit-tree", tree.as_str(), "-m", msg];
        for p in parents {
            args.push("-p");
            args.push(p);
        }
        git_in(&path, &args, None)
    };
    let a = commit("A", "pub.txt", &[]);
    let b = commit("B", "pub.txt", &[&a]);
    let s1 = commit("S1 secret fix", "secret.txt", &[&b]);
    let s2 = commit("S2 more secret", "secret.txt", &[&s1]);
    let merge = commit("Merge sec", "pub.txt", &[&b, &s2]);
    Fixture {
        _dir: dir,
        path,
        b,
        s2,
        merge,
    }
}

fn check(f: &Fixture, ledger: &ledger::State, decryptable: Option<&[String]>, members_key: bool) -> Outcome {
    guard::guard(
        &GitGraph::at(&f.path),
        &GuardInput {
            members_key,
            ledger,
            decryptable,
            public_tips: std::slice::from_ref(&f.b),
            batch: &[BatchRef {
                dst: "refs/heads/main".into(),
                new: Some(f.merge.clone()),
                audience: Audience::Public,
            }],
            publish_private: None,
        },
    )
    .unwrap()
}

#[test]
fn a_local_graft_or_replace_ref_cannot_hide_a_members_only_parent() {
    let f = fixture();
    let s = [f.s2.clone()];
    let empty = ledger::State::Present(ledger::Ledger::default());
    assert_eq!(check(&f, &empty, Some(&s), true).verdict, Verdict::Refuse);
    // `git replace --graft <merge> <B>`: a plain rev-list would follow it and see no sealed parent
    git_in(&f.path, &["replace", "--graft", &f.merge, &f.b], None);
    let o = check(&f, &empty, Some(&s), true);
    assert_eq!(o.verdict, Verdict::Refuse, "replace refs are off");
    assert_eq!(o.findings[0].oids.len(), 2, "S1 and S2");
    git_in(&f.path, &["replace", "-d", &f.merge], None);
    // the legacy graft file
    std::fs::create_dir_all(f.path.join(".git/info")).unwrap();
    std::fs::write(f.path.join(".git/info/grafts"), format!("{} {}\n", f.merge, f.b)).unwrap();
    assert_eq!(check(&f, &empty, Some(&s), true).verdict, Verdict::Refuse, "GIT_GRAFT_FILE is off");
}

#[test]
fn members_only_commits_this_clone_never_fetched_are_skipped_not_errors() {
    let f = fixture();
    let s = [f.s2.clone(), "ab".repeat(20)];
    let empty = ledger::State::Present(ledger::Ledger::default());
    let o = check(&f, &empty, Some(&s), true);
    assert_eq!(o.verdict, Verdict::Refuse);
    assert_eq!(GitGraph::at(&f.path).present(&s).unwrap().len(), 1);
}

#[test]
fn a_locked_key_falls_back_on_the_ledger_and_a_fork_is_refused_too() {
    let f = fixture();
    let text = format!("{}\ncommit {}\n", ledger::HEADER, f.s2);
    let held = ledger::State::Present(ledger::parse(&text).unwrap());
    // the key is locked: the ledger alone refuses the merge
    assert_eq!(check(&f, &held, None, true).verdict, Verdict::Refuse);
    // a fork without members-only content: the ledger is the clone's, so still refused
    assert_eq!(check(&f, &held, None, false).verdict, Verdict::Refuse);
    // locked, no ledger, members-only content on: the guard cannot run (E806)
    assert_eq!(check(&f, &ledger::State::Absent, None, true).verdict, Verdict::Unavailable);
    // locked, an empty ledger: through, with the note
    let o = check(&f, &ledger::State::Present(ledger::Ledger::default()), None, true);
    assert_eq!(o.verdict, Verdict::Pass);
    assert_eq!(o.notes, vec![guard::Note::NoKeyEmptyLedger]);
}

#[test]
fn a_refusal_names_the_first_commits_and_the_branch_they_come_from() {
    let f = fixture();
    let s = [f.s2.clone()];
    let empty = ledger::State::Present(ledger::Ledger::default());
    let o = check(&f, &empty, Some(&s), true);
    let tips: BTreeMap<String, String> = [("refs/heads/sec/fix".to_owned(), f.s2.clone())].into();
    let (e, lines) = publish_refusal(&GitGraph::at(&f.path), &o, &tips, 0);
    assert_eq!(e.code, codes::PUBLISHES_MEMBERS_ONLY);
    assert_eq!(
        e.message,
        "pushing refs/heads/main would publish 2 commits from members-only branch sec/fix"
    );
    assert!(e.fix[0].starts_with("dg publish sec/fix --onto main"), "{:?}", e.fix);
    let shown = lines.join("\n");
    assert!(shown.contains("S2 more secret") && shown.contains("S1 secret fix"), "{shown}");
}

// --- a new branch's audience (D12) ----------------------------------------------------------------

fn facts() -> RepoFacts {
    RepoFacts {
        members_key: true,
        has_members_branch: true,
        owner_only: false,
        empty: false,
        default_ref: "refs/heads/main".into(),
    }
}

fn decided(dst: &str, s: &Signals, f: &RepoFacts, inherits: bool) -> std::result::Result<Audience, Refusal> {
    decide(dst, s, f, || Ok(inherits)).unwrap()
}

#[test]
fn a_new_branch_takes_the_first_signal_then_asks_once() {
    use Audience::{Members, Public};
    let f = facts();
    let none = Signals::default();
    let with = |g: fn(&mut Signals)| {
        let mut s = Signals::default();
        g(&mut s);
        s
    };
    // nothing says: asked (E811), once
    assert_eq!(decided("refs/heads/x", &none, &f, false), Err(Refusal::Ask));
    let asked = with(|s| s.asked_before = true);
    assert_eq!(decided("refs/heads/x", &asked, &f, false), Ok(Public));
    // local intent beats the push option, which beats inheritance, which beats the clone default
    let intent = with(|s| {
        s.intent = Some(Public);
        s.option = Some(Members);
        s.clone_default = Some(Members);
    });
    assert_eq!(decided("refs/heads/x", &intent, &f, true), Ok(Public));
    let option = with(|s| {
        s.option = Some(Public);
        s.clone_default = Some(Members);
    });
    assert_eq!(decided("refs/heads/x", &option, &f, true), Ok(Public));
    let default = with(|s| s.clone_default = Some(Public));
    assert_eq!(decided("refs/heads/x", &default, &f, true), Ok(Members), "inheritance first");
    assert_eq!(decided("refs/heads/x", &default, &f, false), Ok(Public));
    // no question while no members-only branch exists (rev 4.1), the owner is alone (rev 4), or
    // the repository is empty
    for g in [
        (|f: &mut RepoFacts| f.has_members_branch = false) as fn(&mut RepoFacts),
        |f| f.owner_only = true,
        |f| f.empty = true,
    ] {
        let mut quiet = facts();
        g(&mut quiet);
        assert_eq!(decided("refs/heads/x", &none, &quiet, false), Ok(Public));
    }
    // a tag follows inheritance only, and never asks
    assert_eq!(decided("refs/tags/v1", &none, &f, false), Ok(Public));
    assert_eq!(decided("refs/tags/v1", &none, &f, true), Ok(Members));
}

#[test]
fn audiences_that_cannot_be_are_refused() {
    use Audience::{Members, Public};
    let f = facts();
    let members = Signals {
        option: Some(Members),
        ..Signals::default()
    };
    // the default branch is always public
    assert_eq!(decided("refs/heads/main", &members, &f, false), Err(Refusal::DefaultBranch));
    assert_eq!(decided("refs/heads/main", &Signals::default(), &f, true), Ok(Public));
    // an existing public branch stays public: E809
    let public_now = Signals {
        existing: Some(Public),
        option: Some(Members),
        ..Signals::default()
    };
    assert_eq!(decided("refs/heads/x", &public_now, &f, false), Err(Refusal::AlreadyPublic));
    // an existing members-only branch stays members-only; `-o public` would publish it
    let members_now = Signals {
        existing: Some(Members),
        ..Signals::default()
    };
    assert_eq!(decided("refs/heads/x", &members_now, &f, false), Ok(Members));
    let publish = Signals {
        option: Some(Public),
        ..members_now
    };
    assert_eq!(decided("refs/heads/x", &publish, &f, false), Err(Refusal::MembersBranchPublic));
    // members-only asked for with members-only content off: refused, never public
    let off = RepoFacts {
        members_key: false,
        ..facts()
    };
    assert_eq!(decided("refs/heads/x", &members, &off, false), Err(Refusal::MembersOff));
    let default_members = Signals {
        clone_default: Some(Members),
        ..Signals::default()
    };
    assert_eq!(decided("refs/heads/x", &default_members, &off, false), Err(Refusal::MembersOff));
    assert_eq!(decided("refs/heads/x", &Signals::default(), &off, false), Ok(Public));
}

#[test]
fn every_refusal_has_its_code_and_plain_copy() {
    for (r, code) in [
        (Refusal::AlreadyPublic, codes::BRANCH_ALREADY_PUBLIC),
        (Refusal::DefaultBranch, codes::BRANCH_ALREADY_PUBLIC),
        (Refusal::MembersOff, codes::MEMBERS_ONLY_OFF),
        (Refusal::Ask, codes::NEW_BRANCH_AUDIENCE),
        (Refusal::MembersBranchPublic, codes::PUBLISHES_MEMBERS_ONLY),
    ] {
        let (e, wire) = refusal_error(&r, "refs/heads/fix-auth", "o/r");
        assert_eq!(e.code, code, "{r:?}");
        let text = format!("{e:?} {wire}").to_lowercase();
        for word in ["sealed", "lane", "epoch", "key letter", "disclosure", "reveal"] {
            assert!(!text.contains(word), "{r:?}: {word} in {text}");
        }
    }
    let (e, _) = refusal_error(&Refusal::Ask, "refs/heads/fix-auth", "o/r");
    assert_eq!(e.message, "new branch fix-auth: choose who can see it");
}

// --- grafts over an unreadable members-only parent ----------------------------------------------------

#[test]
fn a_merge_whose_members_only_parent_is_missing_is_grafted_and_fsck_stays_clean() {
    let f = fixture();
    // a public clone of `merge`, as S4's graft fixture: every object of the merge's history but
    // the members-only commits and what only they reach
    let public = tempfile::TempDir::new().unwrap();
    init(public.path());
    let objects = |args: &[&str]| -> BTreeSet<String> {
        git_in(&f.path, args, None)
            .lines()
            .filter_map(|l| l.split(' ').next())
            .map(str::to_owned)
            .collect()
    };
    let in_merge_tree: BTreeSet<String> = objects(&["ls-tree", "-r", "-t", "--object-only", &f.merge])
        .into_iter()
        .chain([git_in(&f.path, &["rev-parse", &format!("{}^{{tree}}", f.merge)], None)])
        .collect();
    let members_only: BTreeSet<String> = objects(&["rev-list", "--objects", &f.s2, &format!("^{}", f.b)])
        .difference(&in_merge_tree)
        .cloned()
        .collect();
    let keep: Vec<String> = objects(&["rev-list", "--objects", &f.merge])
        .difference(&members_only)
        .cloned()
        .collect();
    let pack = git_bytes(&f.path, &["pack-objects", "--stdout", "-q"], (keep.join("\n") + "\n").as_bytes());
    git_bytes(public.path(), &["index-pack", "--stdin"], &pack);
    let wants = [f.merge.clone()];
    let cut = commits_missing_parents(Some(public.path()), &wants).unwrap();
    assert_eq!(cut, vec![(f.merge.clone(), vec![f.b.clone()])]);
    let packs: Vec<String> = std::fs::read_dir(public.path().join(".git/objects/pack"))
        .unwrap()
        .filter_map(|e| {
            let n = e.unwrap().file_name().into_string().ok()?;
            n.strip_prefix("pack-")?.strip_suffix(".pack").map(str::to_owned)
        })
        .collect();
    git_in(public.path(), &["remote", "add", "origin", "dash://o/r"], None);
    let grafted = graft_missing_parents(Some(public.path()), &wants, &packs, Some("origin")).unwrap();
    assert_eq!(grafted, vec![f.merge.clone()]);
    git_in(public.path(), &["update-ref", "refs/heads/main", &f.merge], None);
    // log works, and fsck is clean
    let log = git_in(public.path(), &["log", "--format=%s", "main"], None);
    assert_eq!(log.lines().collect::<Vec<_>>(), ["Merge sec", "B", "A"]);
    git_in(public.path(), &["fsck", "--no-progress"], None);
}

#[test]
fn the_hook_input_is_parsed_and_null_ids_are_deletes() {
    let lines = parse_hook_input(&format!(
        "refs/heads/a {} refs/heads/a {}\n\n(delete) {} refs/heads/b {}\n",
        "1".repeat(40),
        "0".repeat(40),
        "0".repeat(40),
        "2".repeat(40)
    ));
    assert_eq!(lines.len(), 2);
    assert!(is_null_oid(&lines[0].remote_oid));
    assert!(is_null_oid(&lines[1].local_oid));
    assert_eq!(lines[1].remote_ref, "refs/heads/b");
}

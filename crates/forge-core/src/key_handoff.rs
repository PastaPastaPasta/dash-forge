//! Handing an unlocked identity key from `dg` to the `git-remote-dash` that `git` starts.
//!
//! `dg init` asks for a sealed key's passphrase, then runs `git push`, and git runs the helper.
//! The helper must not ask a second time, and the key must never travel through the
//! environment (readable by other processes of the same user, inherited by every descendant,
//! kept by crash reporters) or argv (visible to every user through `ps`). So `dg` writes the
//! key into a pipe, and the `git` it starts inherits the pipe's read end; git passes open
//! descriptors on to the helpers it runs, and the helper reads the key before it answers git.
//!
//! - **Parent** ([`attach`]): the pipe is created close-on-exec, and its read end is made
//!   inheritable only in the forked child that becomes `git` (a `pre_exec` hook, through
//!   `command-fds`). No other process `dg` starts, before or at the same time, inherits it. The
//!   key is written and the write end closed before `git` starts, so a reader sees the key and
//!   then end-of-file. [`KEY_FD_ENV`] names the descriptor and the pipe: `<fd>:<dev>:<ino>`
//!   (none of it secret).
//! - **Child** ([`take`]): the helper's first act. It removes [`KEY_FD_ENV`] from its own
//!   environment and checks that the descriptor is that very pipe (device and inode). A
//!   stale or reused variable (a hook running its own `git push`, a number that now names
//!   another pipe) is ignored without reading anything, and the key is loaded from its
//!   source. Then it closes the descriptor (so nothing the helper starts inherits it) and
//!   reads at most [`MAX_KEY_BYTES`] into a buffer that is wiped on drop. Git waits for the
//!   helper's first reply, so the pipe is empty before git runs anything else; a hook or a
//!   second helper that inherits the descriptor reads end-of-file.
//!
//! On Windows there is no handoff: [`attach`] does nothing and the helper asks for the
//! passphrase on the console itself.

#[cfg(unix)]
use crate::error::Error;
use crate::error::Result;
use crate::keystore::Secret;

/// The variable naming the inherited pipe: `<fd>:<dev>:<ino>`. None of it is secret.
pub const KEY_FD_ENV: &str = "DASH_FORGE_KEY_FD";

/// What the pipe starts with, so a descriptor that holds something else is never taken for
/// a key.
#[cfg(unix)]
const MAGIC: &[u8] = b"dash-forge-key/1\n";

/// The largest key accepted. A limited key is about 100 bytes and a full identity file about
/// 3 KiB. The write end is non-blocking, so a key that does not fit the pipe's buffer (Linux
/// shrinks it to one page, 4 KiB, once a user passes `pipe-user-pages-soft`) fails here
/// with an error rather than hanging before `git` has started.
pub const MAX_KEY_BYTES: usize = 16 * 1024;

/// The most the helper reads: the header, the largest key, and one byte to detect more.
#[cfg(unix)]
const READ_LIMIT: usize = MAGIC.len() + MAX_KEY_BYTES + 1;

#[cfg(unix)]
fn handoff_error(why: &str) -> Error {
    Error::Config(format!(
        "the key dg handed to git-remote-dash is unusable: {why}"
    ))
}

/// Arrange for `cmd` (a `git` that runs `git-remote-dash`) to receive `key`. Call it once per
/// command, on a command built for the purpose: each call makes a pipe that stays inheritable
/// for as long as `cmd` lives. A no-op where the platform has no handoff (Windows).
#[cfg(unix)]
pub fn attach(cmd: &mut std::process::Command, key: &Secret) -> Result<()> {
    use command_fds::CommandFdExt as _;
    use nix::fcntl::{fcntl, FcntlArg, OFlag};
    use std::io::Write as _;
    use std::os::fd::{AsRawFd as _, OwnedFd};
    use std::os::unix::fs::MetadataExt as _;

    let io = |e: std::io::Error| Error::Io(format!("handing the key to git-remote-dash: {e}"));
    let key = key.expose().as_bytes();
    if key.len() > MAX_KEY_BYTES {
        return Err(handoff_error("the key is larger than the handoff allows"));
    }
    // Both ends are close-on-exec.
    let (reader, mut writer) = std::io::pipe().map_err(io)?;
    // Never block: a full pipe is an error, not a hang before `git` has even started.
    fcntl(&writer, FcntlArg::F_SETFL(OFlag::O_NONBLOCK)).map_err(|e| io(e.into()))?;
    let mut payload = zeroize::Zeroizing::new(Vec::with_capacity(MAGIC.len() + key.len()));
    payload.extend_from_slice(MAGIC);
    payload.extend_from_slice(key);
    writer.write_all(&payload).map_err(io)?;
    drop(writer);
    // A duplicate numbered 3 or higher (std's dup does that), so the child's stdio setup,
    // which runs before the hook, cannot overwrite it.
    let fd = std::fs::File::from(OwnedFd::from(reader).try_clone().map_err(io)?);
    let m = fd.metadata().map_err(io)?;
    cmd.env(
        KEY_FD_ENV,
        format!("{}:{}:{}", fd.as_raw_fd(), m.dev(), m.ino()),
    );
    let fd = OwnedFd::from(fd);
    // Inheritable in the forked child only; the parent's copy stays close-on-exec and is
    // closed when `cmd` is dropped.
    cmd.preserved_fds(vec![fd]);
    Ok(())
}

/// Windows: no handoff.
#[cfg(not(unix))]
pub fn attach(_cmd: &mut std::process::Command, _key: &Secret) -> Result<()> {
    Ok(())
}

/// The key `dg` handed over, if any: call it first thing in `main`. `Ok(None)` when there is
/// no handoff, or its pipe was already read (a second helper in the same git command).
pub fn take() -> Result<Option<Secret>> {
    let Some(raw) = std::env::var_os(KEY_FD_ENV) else {
        return Ok(None);
    };
    // Nothing this process starts should look for it.
    std::env::remove_var(KEY_FD_ENV);
    let parsed = raw.to_str().and_then(|s| {
        let mut it = s.split(':').map(str::parse::<u64>);
        match (it.next(), it.next(), it.next(), it.next()) {
            (Some(Ok(fd)), Some(Ok(dev)), Some(Ok(ino)), None) => {
                Some((i32::try_from(fd).ok().filter(|n| *n > 2)?, dev, ino))
            }
            _ => None,
        }
    });
    let Some((fd, dev, ino)) = parsed else {
        // Not what dg writes (an older dg, or set by hand): never read from it.
        tracing::debug!("{KEY_FD_ENV} is malformed; no key was handed over");
        return Ok(None);
    };
    take_fd(fd, dev, ino)
}

/// [`take`] for descriptor `fd`, which must be the pipe `dev`/`ino`: read the key and close
/// the descriptor.
#[cfg(unix)]
fn take_fd(fd: i32, dev: u64, ino: u64) -> Result<Option<Secret>> {
    use std::io::Read as _;
    use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, OpenOptionsExt as _};

    let path = format!("/dev/fd/{fd}");
    // Only a pipe: never open a terminal, file or device the number might name.
    if !std::fs::metadata(&path).is_ok_and(|m| m.file_type().is_fifo()) {
        tracing::debug!("{KEY_FD_ENV} names no inherited pipe; no key was handed over");
        return Ok(None);
    }
    // A new close-on-exec descriptor for the same pipe (macOS duplicates the descriptor;
    // Linux reopens the pipe, and O_NONBLOCK keeps that open from waiting for a writer), so
    // the inherited one can be closed without `unsafe`. Nothing is read yet.
    let Ok(file) = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::fcntl::OFlag::O_NONBLOCK.bits())
        .open(&path)
    else {
        return Ok(None);
    };
    // Is it the pipe dg made? A git hook that runs its own `git push` inherits the variable,
    // and by then the number may name another pipe (a jobserver, the hook's own): leave it
    // alone, read nothing, and load the key from its source. (`File::metadata` is an fstat
    // of the descriptor; a stat of the `/dev/fd/N` path describes devfs's node on macOS.)
    if !file
        .metadata()
        .is_ok_and(|m| m.dev() == dev && m.ino() == ino)
    {
        tracing::debug!("{KEY_FD_ENV} names a pipe dg did not make; no key was handed over");
        return Ok(None);
    }
    // What this process starts must not inherit even an empty pipe.
    let _ = nix::unistd::close(fd);
    // Sized once: a growing buffer would leave copies of the key in freed memory.
    let mut buf = zeroize::Zeroizing::new(Vec::with_capacity(READ_LIMIT));
    file.take(READ_LIMIT as u64)
        .read_to_end(&mut buf)
        .map_err(|e| handoff_error(&format!("reading it failed ({e})")))?;
    if buf.is_empty() {
        tracing::debug!("the key handoff was already read; loading the key from its source");
        return Ok(None);
    }
    let key = buf
        .strip_prefix(MAGIC)
        .ok_or_else(|| handoff_error("it does not start with the handoff header"))?;
    if key.len() > MAX_KEY_BYTES {
        return Err(handoff_error("it is larger than the handoff allows"));
    }
    let text = std::str::from_utf8(key).map_err(|_| handoff_error("it is not text"))?;
    Ok(Some(Secret::new(text)))
}

/// Windows: no handoff.
#[cfg(not(unix))]
fn take_fd(_fd: i32, _dev: u64, _ino: u64) -> Result<Option<Secret>> {
    Ok(None)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::os::fd::{AsRawFd as _, IntoRawFd as _};
    use std::process::Command;

    const KEY: &str =
        "dfk1:devnet-moutai:8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB:5:cSecretWif";

    fn sh(script: &str) -> Command {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", script]);
        c
    }

    /// The pipe `fd` is: `(dev, ino)`.
    fn id(fd: i32) -> (u64, u64) {
        use std::os::unix::fs::MetadataExt as _;
        // An fstat (a new descriptor for the same pipe), as `attach` records it.
        let m = std::fs::File::open(format!("/dev/fd/{fd}"))
            .unwrap()
            .metadata()
            .unwrap();
        (m.dev(), m.ino())
    }

    /// [`take_fd`] for an fd whose identity is recorded now, as [`attach`] does.
    fn take_own(fd: i32) -> Result<Option<Secret>> {
        let (dev, ino) = id(fd);
        take_fd(fd, dev, ino)
    }

    #[test]
    fn only_the_attached_child_inherits_the_key() {
        let mut cmd = sh(r#"cat "/dev/fd/${DASH_FORGE_KEY_FD%%:*}""#);
        attach(&mut cmd, &Secret::new(KEY)).unwrap();
        let var = cmd
            .get_envs()
            .find(|(k, _)| *k == KEY_FD_ENV)
            .and_then(|(_, v)| Some(v?.to_str()?.to_string()))
            .unwrap();
        let fields: Vec<u64> = var.split(':').map(|f| f.parse().unwrap()).collect();
        assert_eq!(fields.len(), 3, "<fd>:<dev>:<ino>: {var}");
        let fd = i32::try_from(fields[0]).unwrap();
        assert!(fd > 2, "never a stdio number: {fd}");
        // The environment carries the number only; argv nothing.
        assert!(cmd
            .get_envs()
            .all(|(_, v)| !v.is_some_and(|v| v.to_string_lossy().contains("cSecretWif"))));
        assert!(cmd
            .get_args()
            .all(|a| !a.to_string_lossy().contains("cSecretWif")));
        // Another process started while `cmd` holds the pipe does not inherit it.
        let other = sh(&format!(
            "test -e /dev/fd/{fd} && echo LEAKED || echo closed"
        ))
        .output()
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&other.stdout).trim(), "closed");
        let out = cmd.output().unwrap();
        assert!(out.status.success());
        assert_eq!(out.stdout, [MAGIC, KEY.as_bytes()].concat());
    }

    #[test]
    fn take_reads_the_key_once_and_closes_the_descriptor() {
        let (reader, mut writer) = std::io::pipe().unwrap();
        writer.write_all(&[MAGIC, KEY.as_bytes()].concat()).unwrap();
        drop(writer);
        let ino = |fd: i32| {
            std::fs::metadata(format!("/dev/fd/{fd}"))
                .ok()
                .map(|m| std::os::unix::fs::MetadataExt::ino(&m))
        };
        let fd = reader.into_raw_fd();
        let pipe = ino(fd);
        assert!(pipe.is_some());
        assert_eq!(take_own(fd).unwrap().unwrap().expose(), KEY);
        // Closed: the number names nothing now, or (other tests run in parallel) something
        // else, never this pipe.
        assert_ne!(ino(fd), pipe, "the inherited descriptor is closed");
    }

    #[test]
    fn a_drained_pipe_is_no_handoff_and_garbage_is_refused() {
        let (reader, writer) = std::io::pipe().unwrap();
        drop(writer);
        assert!(take_own(reader.into_raw_fd()).unwrap().is_none());

        let (reader, mut writer) = std::io::pipe().unwrap();
        writer.write_all(b"not a key").unwrap();
        drop(writer);
        let err = take_own(reader.into_raw_fd()).unwrap_err().to_string();
        assert!(err.contains("handoff header"), "{err}");
        assert!(
            !err.contains("not a key"),
            "the bytes are never echoed: {err}"
        );

        // A descriptor that is not a pipe is no handoff, and is left open.
        let file = tempfile::tempfile().unwrap();
        assert!(take_fd(file.as_raw_fd(), 0, 0).unwrap().is_none());
        assert!(file.metadata().is_ok());
    }

    /// A stale variable whose number now names another pipe, with its writer still open
    /// (a jobserver, a hook's own pipe): nothing is read (no hang, no token consumed), the
    /// descriptor is left alone, and the caller falls back to the key source.
    #[test]
    fn a_foreign_live_pipe_is_never_read() {
        let (ours, _ours_w) = std::io::pipe().unwrap();
        let (dev, ino) = id(ours.as_raw_fd());
        let (foreign, mut foreign_w) = std::io::pipe().unwrap();
        foreign_w.write_all(b"+").unwrap(); // a jobserver token
        let fd = foreign.as_raw_fd();
        let start = std::time::Instant::now();
        assert!(take_fd(fd, dev, ino).unwrap().is_none());
        assert!(
            start.elapsed() < std::time::Duration::from_secs(2),
            "no hang"
        );
        // Still open, token unread.
        drop(foreign_w);
        let mut left = Vec::new();
        std::io::Read::read_to_end(&mut &foreign, &mut left).unwrap();
        assert_eq!(left, b"+");
    }

    /// A malformed variable (an older dg's bare number, or garbage) is no handoff.
    #[test]
    fn a_malformed_variable_is_no_handoff() {
        for bad in ["7", "x:1:2", "7:1", "7:1:2:3", "1:1:1"] {
            std::env::set_var(KEY_FD_ENV, bad);
            assert!(take().unwrap().is_none(), "{bad}");
            assert!(std::env::var_os(KEY_FD_ENV).is_none(), "removed: {bad}");
        }
    }

    #[test]
    fn an_oversized_key_is_refused_before_anything_is_written() {
        let mut cmd = sh("true");
        let big = Secret::new("x".repeat(MAX_KEY_BYTES + 1));
        assert!(attach(&mut cmd, &big).is_err());
        assert!(cmd.get_envs().all(|(k, _)| k != KEY_FD_ENV));
    }
}

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
//!   then end-of-file. The number of the descriptor (not a secret) is in [`KEY_FD_ENV`].
//! - **Child** ([`take`]): the helper's first act. It removes [`KEY_FD_ENV`] from its own
//!   environment, checks the descriptor is a pipe, closes it (so nothing the helper starts
//!   inherits it) and reads at most [`MAX_KEY_BYTES`] into a buffer that is wiped on drop.
//!   Git waits for the helper's first reply, so the pipe is empty before git runs anything
//!   else. A hook or a second helper that inherits the descriptor reads end-of-file, and one
//!   where the number names something other than a pipe loads the key from its source.
//!
//! On Windows there is no handoff: [`attach`] does nothing and the helper asks for the
//! passphrase on the console itself.

use crate::error::{Error, Result};
use crate::keystore::Secret;

/// The variable naming the inherited descriptor's number. The number is not a secret.
pub const KEY_FD_ENV: &str = "DASH_FORGE_KEY_FD";

/// What the pipe starts with, so a descriptor that holds something else is never taken for
/// a key.
const MAGIC: &[u8] = b"dash-forge-key/1\n";

/// The largest key accepted (a full identity file is about 3 KiB). It stays well under the
/// smallest pipe buffer, so writing the key before `git` starts can never block.
pub const MAX_KEY_BYTES: usize = 16 * 1024;

/// The most the helper reads: the header, the largest key, and one byte to detect more.
const READ_LIMIT: usize = MAGIC.len() + MAX_KEY_BYTES + 1;

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
    let fd: OwnedFd = OwnedFd::from(reader).try_clone().map_err(io)?;
    cmd.env(KEY_FD_ENV, fd.as_raw_fd().to_string());
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
    let fd = raw
        .to_str()
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|n| *n > 2)
        .ok_or_else(|| handoff_error("its descriptor number is not valid"))?;
    take_fd(fd)
}

/// [`take`] for descriptor `fd`: read the key and close the descriptor.
#[cfg(unix)]
fn take_fd(fd: i32) -> Result<Option<Secret>> {
    use std::io::Read as _;
    use std::os::unix::fs::{FileTypeExt as _, OpenOptionsExt as _};

    let path = format!("/dev/fd/{fd}");
    // No descriptor, or not a pipe (a terminal, a file): nothing was handed to this process
    // (a git hook that runs another `git push` inherits the variable, not the pipe). Leave it
    // alone and load the key from its source.
    if !std::fs::metadata(&path).is_ok_and(|m| m.file_type().is_fifo()) {
        tracing::debug!("{KEY_FD_ENV} names no inherited pipe; no key was handed over");
        return Ok(None);
    }
    // A new close-on-exec descriptor for the same pipe, so the inherited one can be closed
    // without `unsafe`. Non-blocking: on Linux this is a FIFO open, which would otherwise wait
    // for a writer that no longer exists.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::fcntl::OFlag::O_NONBLOCK.bits())
        .open(&path)
        .map_err(|e| handoff_error(&format!("opening its descriptor failed ({e})")))?;
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
fn take_fd(_fd: i32) -> Result<Option<Secret>> {
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

    #[test]
    fn only_the_attached_child_inherits_the_key() {
        let mut cmd = sh(r#"cat <&"$DASH_FORGE_KEY_FD""#);
        attach(&mut cmd, &Secret::new(KEY)).unwrap();
        let fd: i32 = cmd
            .get_envs()
            .find(|(k, _)| *k == KEY_FD_ENV)
            .and_then(|(_, v)| v?.to_str()?.parse().ok())
            .unwrap();
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
        assert_eq!(take_fd(fd).unwrap().unwrap().expose(), KEY);
        // Closed: the number names nothing now, or (other tests run in parallel) something
        // else, never this pipe.
        assert_ne!(ino(fd), pipe, "the inherited descriptor is closed");
    }

    #[test]
    fn a_drained_pipe_is_no_handoff_and_garbage_is_refused() {
        let (reader, writer) = std::io::pipe().unwrap();
        drop(writer);
        assert!(take_fd(reader.into_raw_fd()).unwrap().is_none());

        let (reader, mut writer) = std::io::pipe().unwrap();
        writer.write_all(b"not a key").unwrap();
        drop(writer);
        let err = take_fd(reader.into_raw_fd()).unwrap_err().to_string();
        assert!(err.contains("handoff header"), "{err}");
        assert!(
            !err.contains("not a key"),
            "the bytes are never echoed: {err}"
        );

        // A descriptor that is not a pipe is no handoff, and is left open.
        let file = tempfile::tempfile().unwrap();
        assert!(take_fd(file.as_raw_fd()).unwrap().is_none());
        assert!(file.metadata().is_ok());
    }

    #[test]
    fn an_oversized_key_is_refused_before_anything_is_written() {
        let mut cmd = sh("true");
        let big = Secret::new("x".repeat(MAX_KEY_BYTES + 1));
        assert!(attach(&mut cmd, &big).is_err());
        assert!(cmd.get_envs().all(|(k, _)| k != KEY_FD_ENV));
    }
}

# Installing Dash Forge

Every release on [GitHub Releases](https://github.com/PastaPastaPasta/dash-forge/releases)
ships prebuilt binaries, so you do not need Rust, `protoc`, or the Platform SDK source to use
Dash Forge. Each archive contains:

| File | What it is |
|---|---|
| `dg` | the command-line interface |
| `git-remote-dash` | the git remote helper; git runs it for `dash://` URLs, so it must be on `PATH` |
| `forge-relay`, `forge-import` | the relay daemon and the GitHub importer (optional) |
| `completions/` | shell completions for `dg` (bash, zsh, fish, PowerShell) |

## Supported platforms

| Target | Archive | Notes |
|---|---|---|
| `x86_64-unknown-linux-gnu` | `.tar.gz` | glibc 2.35 or newer (Ubuntu 22.04, Debian 12, RHEL 10) |
| `aarch64-unknown-linux-gnu` | `.tar.gz` | glibc 2.35 or newer |
| `x86_64-unknown-linux-musl` | `.tar.gz` | fully static: Alpine, older distributions, containers |
| `x86_64-apple-darwin` | `.tar.gz` | Intel Macs; **not signed by Apple**, see [below](#macos-gatekeeper) |
| `aarch64-apple-darwin` | `.tar.gz` | Apple silicon; **not signed by Apple** |
| `x86_64-pc-windows-msvc` | `.zip` | Windows 10 and later |

Archives are named `dash-forge-<version>-<target>.tar.gz` (`.zip` on Windows). Each
contains one directory with the same name.

There is no static build for aarch64 Linux yet. On an aarch64 system with glibc older than
2.35, [build from source](BUILDING.md).

## Install script (Linux and macOS)

```sh
curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/install.sh | sh
```

The script works as follows. It is short, and you can
[read it](../install.sh) before you run it.

1. It detects your OS, CPU, and C library (glibc or musl).
2. It downloads `SHA256SUMS` and your platform's archive from the latest release.
3. It checks the archive's SHA-256. On a mismatch it stops with an error and installs
   nothing.
4. If the [GitHub CLI](https://cli.github.com) is installed and logged in, it also runs
   `gh attestation verify`. This checks that the archive was built by this repository's
   release workflow from the release tag. A failed check stops the install. **Without
   `gh`, only the checksum is checked.** `SHA256SUMS` comes from the same place as the
   archive, so this catches a corrupt download, not a tampered release. Beyond that, the
   install relies on HTTPS to GitHub. The script says so when it skips the attestation
   check. Set `DASH_FORGE_ATTESTATION=require` to make the check mandatory.
5. It checks that the new `dg` runs on this system. Only then does it copy `dg` and
   `git-remote-dash` into `~/.local/bin`, replacing any older copies in one step. It also
   tells you if that directory is not on your `PATH`. If the new `dg` does not run, a
   working install is left as it was.

On Linux, glibc older than 2.35 gets the static musl build automatically.

The script never runs `sudo`. You can control it with these environment variables:

| Variable | Default | Effect |
|---|---|---|
| `DASH_FORGE_VERSION` | latest | a specific release, e.g. `0.1.0` |
| `DASH_FORGE_INSTALL_DIR` | `~/.local/bin` | where the binaries go |
| `DASH_FORGE_BINARIES` | `dg git-remote-dash` | add `forge-relay` / `forge-import` if you want them |
| `DASH_FORGE_COMPLETIONS` | `0` | `1` installs bash, zsh and fish completions under `~/.local/share` and `~/.config/fish` |
| `DASH_FORGE_ATTESTATION` | `auto` | `require` fails if `gh` cannot verify the attestation; `skip` relies on the checksum alone |
| `DASH_FORGE_TARGET` | detected | force a target, e.g. `x86_64-unknown-linux-musl` on an old glibc |

For a system-wide install, run the script with sudo yourself:

```sh
curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/install.sh \
  | sudo DASH_FORGE_INSTALL_DIR=/usr/local/bin sh
```

Then check the install:

```sh
dg --version      # dg 0.1.0 (<commit> <target>)
dg doctor         # git, git-remote-dash (same version as dg), network, identity
```

## Manual download and verification

1. Download your platform's archive and `SHA256SUMS` from the
   [release page](https://github.com/PastaPastaPasta/dash-forge/releases).
2. Verify the checksum:

   ```sh
   sha256sum --check --ignore-missing SHA256SUMS          # Linux
   shasum -a 256 --check --ignore-missing SHA256SUMS      # macOS
   ```

   ```powershell
   # Windows: compare with the line for your archive in SHA256SUMS
   (Get-FileHash dash-forge-<version>-x86_64-pc-windows-msvc.zip -Algorithm SHA256).Hash.ToLower()
   ```

3. Optionally, verify build provenance. The archives and `SHA256SUMS` carry GitHub
   [artifact attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations):
   Sigstore-signed statements that say which workflow built the file, and from which
   commit and tag. There is no project key to distribute, rotate, or leak.

   ```sh
   gh attestation verify dash-forge-<version>-<target>.tar.gz \
     --repo PastaPastaPasta/dash-forge \
     --signer-workflow PastaPastaPasta/dash-forge/.github/workflows/release.yml
   ```

   The checksum only shows that the download matches `SHA256SUMS`. The attestation also
   shows that both files came from this repository's release workflow, and not from
   whoever controls the download. It does not show that the file is the *newest* release.
   Anyone who can edit this repository's releases could serve an older, genuinely attested
   build. Pin `DASH_FORGE_VERSION` if that matters to you.

4. Unpack the archive and put `dg` and `git-remote-dash` in a directory on your `PATH`:

   ```sh
   tar -xzf dash-forge-<version>-<target>.tar.gz
   install -m 755 dash-forge-<version>-<target>/dg dash-forge-<version>-<target>/git-remote-dash ~/.local/bin/
   ```

   On Windows, extract the zip and add the folder to your user `Path`, or copy `dg.exe` and
   `git-remote-dash.exe` into a folder that is already on it.

## cargo binstall

[cargo-binstall](https://github.com/cargo-bins/cargo-binstall) installs the same release
archives into `~/.cargo/bin`. The crates are not on crates.io (the name `dg` there belongs to
an unrelated project), so point binstall at this repository:

```sh
cargo binstall --git https://github.com/PastaPastaPasta/dash-forge dg git-remote-dash
```

cargo-binstall does not check `SHA256SUMS` or the attestation. It relies on HTTPS alone.
It takes the version to download from `Cargo.toml` on `master`. Between a version-bump merge
and the matching tag's release, that version has no archives yet, and binstall falls back to
compiling from source. That build needs `protoc`; see [BUILDING.md](BUILDING.md).

## macOS: Gatekeeper

The macOS binaries are **not signed or notarized by Apple yet**. The effect depends on how
you download them:

- **install.sh, curl, or `cargo binstall`**: these do not add the quarantine attribute, so
  Gatekeeper does not check the binaries and they run normally.
- **A web browser**: the archive is quarantined, and the first run fails with *"dg" cannot
  be opened because Apple cannot check it for malicious software*. After you have checked
  the checksum (and, if you like, the attestation) as described above, remove the
  quarantine flag from the unpacked binaries:

  ```sh
  xattr -d com.apple.quarantine dg git-remote-dash forge-relay forge-import
  ```

Signing and notarization are planned. Until then, the checksum and attestation are how you
confirm where a binary came from.

## Shell completions

```sh
dg completions bash > ~/.local/share/bash-completion/completions/dg
dg completions zsh  > "${fpath[1]}/_dg"            # or any directory on $fpath
dg completions fish > ~/.config/fish/completions/dg.fish
```

```powershell
dg completions powershell | Out-String | Invoke-Expression   # add to $PROFILE to keep it
```

The same scripts are in each archive's `completions/` directory.
`DASH_FORGE_COMPLETIONS=1 sh install.sh` installs the bash, zsh and fish scripts for you.

## Upgrading and uninstalling

To upgrade, rerun the install script, or `cargo binstall` with `--force`. `dg doctor`
reports a `git-remote-dash` whose version does not match `dg`.

To uninstall, delete the binaries: `rm ~/.local/bin/dg ~/.local/bin/git-remote-dash`.
Your configuration and identities in `~/.config/dash-forge` are left untouched.

## Build from source

See [BUILDING.md](BUILDING.md). You need Rust (the version is pinned by
`rust-toolchain.toml`) and `protoc` 25 or newer.

## For maintainers: cutting a release

1. Set `version` under `[workspace.package]` in `Cargo.toml` to the new version, and merge
   that change to `master`. That PR runs the release pipeline as a dry run, because it
   touches `Cargo.toml`. Make sure all six targets are green.
2. Tag the merge commit `v<version>` and push the tag. `release.yml` then does the rest:
   it builds all six targets from scratch (no build cache), runs `install.sh` against the
   built archives, writes `SHA256SUMS`, attests the files, and publishes the release with
   generated notes. The run fails before anything is published in two cases: the tag does
   not match the `Cargo.toml` version, or the tagged commit is not on `master`.
3. **Approve twice.** Two jobs use the protected `release` environment, and each waits for a
   reviewer: `attest + publish` (the GitHub Release), then, after it succeeds,
   `push forge-relay image` (pushes `ghcr.io/<owner>/forge-relay:<version>`, and `:latest`
   for a non-pre-release, built from the checksummed musl archive). Approving only the first
   publishes the release without the image; the image job can be approved later from the
   same run.

The dry run also runs on every PR that touches `crates/`, `Cargo.*` or the pipeline. It
builds and packages every target and uploads the archives as workflow artifacts. It never
attests anything or creates a release. Once `release.yml` is on `master`, you can also
start one by hand: `gh workflow run release.yml --ref <branch> -f dry_run=true`.

**One-time repository setup (admin).** The workflow only publishes from `master` commits,
but the tag itself and the `release` environment are protected in the repository settings:

- Settings → Environments → `release`: add required reviewers, and a deployment rule that
  allows only tags matching `v*`.
- Settings → Rules → Rulesets: a tag ruleset for `v*` that restricts creating, updating
  and deleting those tags to maintainers.

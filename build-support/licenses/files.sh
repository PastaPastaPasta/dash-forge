# Sourced by stage.sh and verify-archive.sh: which license files a release archive for a target
# must hold, one path per line, relative to the archive's top directory. One list, so what is
# packaged and what is asserted cannot drift apart.
#
#   - everywhere: the project's own licenses and the third-party notices;
#   - Linux: the vendored OpenSSL's license (release.yml builds Linux with forge-core/vendored-openssl);
#   - musl: musl libc's license (statically linked).
license_files() {
  printf '%s\n' LICENSE-MIT LICENSE-APACHE THIRD-PARTY-LICENSES
  case "$1" in *-linux-*) printf '%s\n' licenses/OPENSSL-LICENSE ;; esac
  case "$1" in *-linux-musl) printf '%s\n' licenses/MUSL-COPYRIGHT ;; esac
}

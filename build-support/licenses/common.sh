# Sourced by generate.sh and generate-wasm.sh: the steps they share after cargo-about has made
# its JSON.

# Needs $here (build-support/licenses) set by the caller.

# render_notice CRATES_JSON OURS_JSON: the notice body on stdout, LF line endings. OURS_JSON is
# a JSON array of crate names to leave out (the workspace's own crates; [] for none).
render_notice() {
  # shellcheck disable=SC2154 # $here is set by the sourcing script
  jq --raw-output --argjson ours "$2" --from-file "$here/render.jq" "$1" | tr -d '\r'
}

# check_no_placeholders CRATES_JSON OURS_JSON: fails when a crate that ships a license file was
# given cargo-about's generic SPDX text ("Copyright (c) <year> <copyright holders>") instead of
# its own, i.e. cargo-about could not match the file. Clarify that crate in about.toml (against
# the file, by checksum) so its real copyright lines are reproduced. Crates that ship no file at
# all keep the generic text; there is nothing else to print for them.
check_no_placeholders() {
  bad=$(jq --raw-output --argjson ours "$2" '
    def kept: .crate.name as $n | ($ours | map(. == $n) | any | not);
    .licenses[]
    | select(.text | test("Copyright[^\n]*<(year|copyright holders?|owner)>"; "i"))
    | .used_by[] | select(kept) | .crate | "\(.name) \(.version) \(.manifest_path)"' "$1" | sort -u |
    while read -r name version manifest; do
      file=$(license_file_in "$(dirname "$manifest")")
      [ -z "$file" ] || echo "$name $version ($file)"
    done)
  if [ -n "$bad" ]; then
    echo "generate: these crates ship a license file that cargo-about did not match, so the notice would carry" >&2
    echo "placeholder text for them; add a [crate.clarify] entry for each to build-support/licenses/about.toml:" >&2
    printf '  %s\n' "$bad" >&2
    return 1
  fi
}

# The name of a license file in directory $1 (LICENSE*, COPYING*, UNLICENSE*, any case), or nothing.
license_file_in() {
  for f in "$1"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f" | tr '[:upper:]' '[:lower:]')
    case "$name" in
      license* | licence* | copying* | unlicense*) echo "$(basename "$f")"; return 0 ;;
    esac
  done
  return 0
}

# Render cargo-about's JSON (`cargo-about generate --format json`) as the plain-text body of a
# license notice: an overview, then each license text with the crates that use it. Used by
# generate.sh and generate-wasm.sh (through common.sh) instead of a handlebars template, so the
# workspace's own crates can be left out by name.
#
#   jq --raw-output --argjson ours '["crate", ...]' --from-file render.jq crates.json
#
# Plain jq 1.6 (no string repetition, no newer builtins): Debian bookworm's jq is 1.6.
def rule: "--------------------------------------------------------------------------------";
def kept: .crate.name as $n | ($ours | map(. == $n) | any | not);
(.licenses
  | map(.used_by |= map(select(kept)))
  | map(select((.used_by | length) > 0))) as $lics
| ($lics
  | group_by(.id)
  | map({id: .[0].id, name: .[0].name, count: (map(.used_by | length) | add)})
  | sort_by([(0 - .count), .id])) as $overview
| "Overview of licenses:",
  ($overview[] | "  * \(.name) (\(.id)): \(.count) \(if .count == 1 then "crate" else "crates" end)"),
  ($lics[]
    | "",
      "",
      rule,
      "\(.name) (\(.id))",
      rule,
      "",
      "Used by:",
      (.used_by[] | .crate | "  * \(.name) \(.version)\(if .repository then " (\(.repository))" else "" end)"),
      "",
      .text)

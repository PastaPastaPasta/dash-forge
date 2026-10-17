#!/bin/sh
# Copy the license files a release archive needs into its stage directory.
#
#   stage.sh TARGET NOTICES_DIR STAGE_DIR
#
# NOTICES_DIR is generate.sh's output; STAGE_DIR is the directory that becomes the archive's top
# level. Fails when a needed file is missing or empty. See files.sh for the per-target list.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=build-support/licenses/files.sh
. "$here/files.sh"

target=${1:?usage: stage.sh TARGET NOTICES_DIR STAGE_DIR}
notices=${2:?usage: stage.sh TARGET NOTICES_DIR STAGE_DIR}
stage=${3:?usage: stage.sh TARGET NOTICES_DIR STAGE_DIR}

license_files "$target" | while read -r f; do
  [ -s "$notices/$f" ] || { echo "stage: $notices/$f is missing or empty" >&2; exit 1; }
  mkdir -p "$stage/$(dirname "$f")"
  cp "$notices/$f" "$stage/$f"
done

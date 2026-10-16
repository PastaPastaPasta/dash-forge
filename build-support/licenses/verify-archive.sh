#!/bin/sh
# Fail unless a release archive holds every license file its target needs.
#
#   verify-archive.sh ARCHIVE TARGET
#
# ARCHIVE is a dash-forge-<version>-<target>.tar.gz or .zip; its single top directory carries
# the same name. Needs tar (and unzip for .zip). See files.sh for the per-target list.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=build-support/licenses/files.sh
. "$here/files.sh"

archive=${1:?usage: verify-archive.sh ARCHIVE TARGET}
target=${2:?usage: verify-archive.sh ARCHIVE TARGET}
base=$(basename "$archive")
case "$base" in
  *.tar.gz) top=${base%.tar.gz}; list() { tar -tzf "$archive"; } ;;
  *.zip) top=${base%.zip}; list() { unzip -Z1 "$archive"; } ;;
  *) echo "verify-archive: $base is neither .tar.gz nor .zip" >&2; exit 1 ;;
esac
# The archive must be for the target it is checked as.
case "$top" in *"-$target") ;; *) echo "verify-archive: $base is not a $target archive" >&2; exit 1 ;; esac

entries=$(list)
missing=0
for f in $(license_files "$target"); do
  # tar lists "top/file" (7z-made zips the same).
  if ! printf '%s\n' "$entries" | grep -Fxq "$top/$f"; then
    echo "verify-archive: $base has no $f" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1
echo "verify-archive: $base holds its license files"

#!/usr/bin/env bash
# Downloads Copernicus GLO-30 elevation tiles for Slovenia and the nearby Alps (N45-N47, E013-E016)
# into data/dem/, from the public copernicus-dem-30m bucket. See docs/development.md.
#
#   ./scripts/download-dem.sh                 all 12 tiles
#   ./scripts/download-dem.sh N46_00_E013_00  only the named tiles
#
# Files already there are skipped, so it can be run again after an interruption.
# Set DEM_DIR to download somewhere else.
set -euo pipefail
cd "$(dirname "$0")/.."

base_url="https://copernicus-dem-30m.s3.amazonaws.com"
target="${DEM_DIR:-data/dem}"
mkdir -p "$target"

tiles=("$@")
if [ "${#tiles[@]}" -eq 0 ]; then
  for lat in 45 46 47; do
    for lon in 013 014 015 016; do
      tiles+=("N${lat}_00_E${lon}_00")
    done
  done
fi

for tile in "${tiles[@]}"; do
  if ! [[ "$tile" =~ ^[NS][0-9]{2}_00_[EW][0-9]{3}_00$ ]]; then
    echo "Not a tile name, expected something like N46_00_E013_00: $tile" >&2
    exit 1
  fi
  name="Copernicus_DSM_COG_10_${tile}_DEM"
  file="$target/$name.tif"
  if [ -s "$file" ]; then
    echo "Already there: $name"
    continue
  fi
  echo "Downloading $name"
  # Through a temporary name: an interrupted download must not look like a finished tile.
  curl --fail --location --silent --show-error --retry 3 \
    --output "$file.part" "$base_url/$name/$name.tif"
  mv "$file.part" "$file"
done

echo "Done. Tiles are in $target"

#!/usr/bin/env bash
# Restore the media tree from git history into assets/.
#
#   npm run assets:pull              # newest commit that still had the media
#   npm run assets:pull -- <ref>     # an explicit commit/tag
#
# The media used to live in public/atlas/{img,thumb,audio} and public/{brand,sfx}.
# After the Pages/R2 split it is not tracked any more, but every byte is still in
# history: this script maps the old layout onto the new one.
#
# Expect ~630 MB of downloads on a fresh clone (partial clones fetch on demand).
set -euo pipefail

cd "$(dirname "$0")/../.."

REF="${1:-}"
if [ -z "$REF" ]; then
  # The split commit deleted these paths; its parent still has them.
  DELETED_IN=$(git log --diff-filter=D --format=%H -1 -- 'public/atlas/img' || true)
  if [ -n "$DELETED_IN" ]; then
    REF="${DELETED_IN}^"
  else
    REF="HEAD"
  fi
fi

if ! git cat-file -e "${REF}:public/atlas/img" 2>/dev/null; then
  echo "error: ${REF} does not contain public/atlas/img — pass a ref from before the split." >&2
  echo "hint:  git log --oneline -- public/atlas/img | head" >&2
  exit 1
fi

echo "source: ${REF}"
echo "This reads ~630 MB out of the object store; a partial clone will fetch it now."
echo

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git archive "$REF" \
  public/atlas/img public/atlas/thumb public/atlas/audio \
  public/brand public/sfx 2>/dev/null | tar -x -C "$TMP"

mkdir -p assets/illustrations assets/audio assets

for pair in "img:illustrations/img" "thumb:illustrations/thumb"; do
  src="$TMP/public/atlas/${pair%%:*}"
  dst="assets/${pair#*:}"
  [ -d "$src" ] || continue
  mkdir -p "$dst"
  cp -R "$src/." "$dst/"
done

for accent in uk us ex ex2; do
  src="$TMP/public/atlas/audio/$accent"
  [ -d "$src" ] || continue
  mkdir -p "assets/audio/$accent"
  cp -R "$src/." "assets/audio/$accent/"
done

for kind in brand sfx; do
  src="$TMP/public/$kind"
  [ -d "$src" ] || continue
  mkdir -p "assets/$kind"
  cp -R "$src/." "assets/$kind/"
done

echo
node scripts/assets/manifest.mjs
echo
echo "Next: npm run assets:sync -- --dry-run"

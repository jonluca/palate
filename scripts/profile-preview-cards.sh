#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "${PALATE_PHOTOS_PROFILE_RESULT:-}" ]]; then
  export PALATE_PHOTOS_PROFILE_RESULT="$ROOT_DIR/.build/preview-cards-profile-$(date -u +%Y%m%dT%H%M%SZ).json"
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

exec zsh "$SCRIPT_DIR/profile-photos-library.sh" \
  --mode preview-cards \
  --preview-visible-cards 4 \
  --preview-width 1200 \
  --preview-height 320 \
  --preview-iterations 12 \
  --preview-timeout-ms 30000 \
  --preview-rss-sample-ms 5 \
  "$@"

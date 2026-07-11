#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "${PALATE_PHOTOS_PROFILE_RESULT:-}" ]]; then
  export PALATE_PHOTOS_PROFILE_RESULT="$ROOT_DIR/.build/thumbnail-scroll-profile-$(date -u +%Y%m%dT%H%M%SZ).json"
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

exec zsh "$SCRIPT_DIR/profile-photos-library.sh" \
  --mode thumbnail-scroll \
  --scroll-visible-rows 4 \
  --scroll-ahead-rows 3 \
  --scroll-behind-rows 1 \
  --scroll-fling-windows 4 \
  --scroll-width 480 \
  --scroll-height 480 \
  --scroll-iterations 4 \
  --scroll-timeout-ms 30000 \
  --scroll-rss-sample-ms 5 \
  "$@"

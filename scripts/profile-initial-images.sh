#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "${PALATE_PHOTOS_PROFILE_RESULT:-}" ]]; then
  export PALATE_PHOTOS_PROFILE_RESULT="$ROOT_DIR/.build/initial-images-profile-$(date -u +%Y%m%dT%H%M%SZ).json"
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

exec zsh "$SCRIPT_DIR/profile-photos-library.sh" \
  --mode initial-images \
  "$@"

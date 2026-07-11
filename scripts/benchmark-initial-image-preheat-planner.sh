#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.build/initial-image-preheat-planner"
BINARY="$BUILD_DIR/benchmark"
CORE_DIR="$ROOT_DIR/modules/batch-asset-info/ios/Core"

mkdir -p "$BUILD_DIR"

xcrun swiftc \
  -O \
  -framework Photos \
  "$CORE_DIR/PhotoAssetThumbnailError.swift" \
  "$CORE_DIR/PhotoAssetThumbnailTarget.swift" \
  "$CORE_DIR/PhotoAssetThumbnailContentMode.swift" \
  "$CORE_DIR/PhotoAssetThumbnailRequestKey.swift" \
  "$CORE_DIR/PhotoAssetThumbnailPreheatBudget.swift" \
  "$CORE_DIR/PhotoAssetThumbnailPreheatTransition.swift" \
  "$CORE_DIR/PhotoAssetThumbnailPreheatDelta.swift" \
  "$CORE_DIR/PhotoAssetThumbnailPreheatPlanner.swift" \
  "$SCRIPT_DIR/fixtures/initial-image-preheat-planner/main.swift" \
  -o "$BINARY"

exec "$BINARY" "$@"

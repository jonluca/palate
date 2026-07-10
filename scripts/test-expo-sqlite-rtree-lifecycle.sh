#!/bin/zsh

set -euo pipefail

SCRIPT_DIRECTORY="${0:A:h}"
ROOT_DIRECTORY="${SCRIPT_DIRECTORY:h}"
SQLITE_DIRECTORY="$ROOT_DIRECTORY/node_modules/expo-sqlite/ios"
SQLITE_DATABASE_SOURCE="$ROOT_DIRECTORY/node_modules/expo-sqlite/src/SQLiteDatabase.ts"
PROBE_SOURCE="$SCRIPT_DIRECTORY/fixtures/expo-sqlite-rtree-close-probe.c"
CORE_SOURCE="$ROOT_DIRECTORY/utils/db/core.ts"
APP_CONFIG="$ROOT_DIRECTORY/app.config.ts"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/palate-rtree-close.XXXXXX")"
PROBE_BINARY="$TEMPORARY_DIRECTORY/expo-sqlite-rtree-close-probe"

cleanup() {
  rm -rf "$TEMPORARY_DIRECTORY"
}
trap cleanup EXIT INT TERM HUP

for required_file in "$SQLITE_DIRECTORY/sqlite3.c" "$SQLITE_DIRECTORY/sqlite3.h" "$SQLITE_DATABASE_SOURCE" "$PROBE_SOURCE" "$CORE_SOURCE" "$APP_CONFIG"; do
  if [[ ! -f "$required_file" ]]; then
    print -u2 "Missing required file: $required_file"
    exit 1
  fi
done

clang \
  -std=c11 \
  -O2 \
  -DSQLITE_ENABLE_RTREE=1 \
  -DSQLITE_THREADSAFE=2 \
  -I"$SQLITE_DIRECTORY" \
  "$SQLITE_DIRECTORY/sqlite3.c" \
  "$PROBE_SOURCE" \
  -o "$PROBE_BINARY"

PROBE_OUTPUT="$($PROBE_BINARY)"
if [[ ! "$PROBE_OUTPUT" =~ '"compileOption":"ENABLE_RTREE"' ]] || \
   [[ ! "$PROBE_OUTPUT" =~ '"rtreeOwnedStatementCount":[1-9][0-9]*' ]] || \
   [[ ! "$PROBE_OUTPUT" =~ '"safeClose":true' ]]; then
  print -u2 "Unexpected R-Tree lifecycle probe output: $PROBE_OUTPUT"
  exit 1
fi

if ! rg -U -q 'MAIN_DATABASE_OPTIONS:[^=]+=[[:space:]]*\{[^}]*finalizeUnusedStatementsBeforeClosing:[[:space:]]*false' "$CORE_SOURCE"; then
  print -u2 "Main database must disable Expo SQLite's unsafe unused-statement finalizer."
  exit 1
fi

if ! rg -U -q 'openDatabaseAsync\([[:space:]]*__DEV__[^,]+,[[:space:]]*MAIN_DATABASE_OPTIONS' "$CORE_SOURCE"; then
  print -u2 "Main database open must pass MAIN_DATABASE_OPTIONS."
  exit 1
fi

if ! rg -U -q '(?s)class Transaction extends SQLiteDatabase \{.*?const options = \{ \.\.\.db\.options, useNewConnection: true \}' "$SQLITE_DATABASE_SOURCE"; then
  print -u2 "Expo SQLite exclusive transactions must inherit the main database close options."
  exit 1
fi

if ! rg -q 'customBuildFlags:[[:space:]]*"-DSQLITE_ENABLE_RTREE=1"' "$APP_CONFIG"; then
  print -u2 "Expo SQLite must be compiled with SQLITE_ENABLE_RTREE."
  exit 1
fi

print "Expo SQLite R-Tree lifecycle contract passed."
print "$PROBE_OUTPUT"

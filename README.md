# Photo Foodie 🍽️📸

A mobile app that automatically discovers your restaurant visits by analyzing your camera roll. It groups photos by location and time, detects food using on-device ML, and matches visits to restaurants — including 15,000+ Michelin-rated establishments worldwide.

![iOS](https://img.shields.io/badge/iOS-17+-000000?style=flat&logo=apple)
![Expo](https://img.shields.io/badge/Expo-57-4630EB?style=flat&logo=expo)
![React Native](https://img.shields.io/badge/React%20Native-0.86-61DAFB?style=flat&logo=react)

## Screenshots

<p align="center">
  <img src="assets/images/img1.jpeg" width="250" alt="Restaurant Visits" />
  <img src="assets/images/img2.jpeg" width="250" alt="Visit Details" />
  <img src="assets/images/img3.jpeg" width="250" alt="Photo Gallery" />
</p>

## Features

- **Camera Roll Scanning** — Batch processes your entire photo library with native performance
- **Location Clustering** — Groups photos into visits based on GPS coordinates and time proximity
- **Food Detection** — Uses on-device Vision ML to identify food photos within each cluster
- **Michelin Matching** — Automatically suggests nearby Michelin-starred restaurants (1-3 stars, Bib Gourmand, Selected)
- **Apple Maps + Google Places** — Search any restaurant via MapKit or Google Maps API
- **Calendar Integration** — Matches visits to calendar events and creates visits from reservation entries
- **Review Workflow** — Confirm, reject, or reassign restaurant matches
- **Visit History** — Track all confirmed restaurants with visit counts and photo galleries

## Prerequisites

- Node.js 24+
- pnpm 11.10.0 (set via `packageManager` in package.json)
- Xcode 26.4+ (for iOS)
- Android Studio (for Android)
- A physical device recommended (iOS Simulator lacks photo library with location data)

> **Note:** Expo Go is not supported due to native module dependencies.

## Getting Started

### 1. Install

```bash
pnpm install
```

### 2. Build and Run

```bash
# iOS
pnpm ios

# Android
pnpm android
```

### 3. Grant Permissions

When prompted, grant **full photo library access** — the app needs to read GPS metadata from all photos to discover restaurant visits.

## How It Works

### 1. Scanning

The app reads all photos from your camera roll, extracting photo IDs, timestamps, and GPS coordinates. On iOS, a custom native module (`BatchAssetInfo`) processes photos in batches for maximum speed.

### 2. Clustering

Photos are grouped into "visits" using a spatial-temporal algorithm:

- Photos within **2 hours** of each other AND
- Within **200 meters** of each other

Each cluster represents a potential restaurant visit.

### 3. Food Detection

A sample of photos from each cluster is analyzed using iOS Vision framework to detect food content. Visits with detected food are prioritized in the review queue.

### 4. Restaurant Matching

For each cluster, the app suggests nearby Michelin restaurants (within 100m). The bundled dataset includes 3-star, 2-star, 1-star, Bib Gourmand, and Michelin Selected restaurants.

### 5. Calendar Enrichment

The app fetches and matches calendar events in one native EventKit batch, then can create visits directly from restaurant reservations in your calendar.

### 6. Review & Confirm

Users review pending visits in the **Review** tab — confirm the suggested restaurant, search for a different one, or reject as not a restaurant visit.

## Tech Stack

| Layer              | Technology                                                                              |
| ------------------ | --------------------------------------------------------------------------------------- |
| **Framework**      | [Expo SDK 56](https://expo.dev) + React Native 0.85                                     |
| **Navigation**     | [Expo Router](https://docs.expo.dev/router/introduction/) with typed routes             |
| **Database**       | [Expo SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/) (WAL mode)             |
| **State**          | [Zustand](https://zustand-demo.pmnd.rs/) + [TanStack Query](https://tanstack.com/query) |
| **Styling**        | [Uniwind](https://uniwind.dev) (Tailwind CSS for React Native)                          |
| **Animations**     | [React Native Reanimated](https://docs.swmansion.com/react-native-reanimated/)          |
| **Lists**          | [FlashList](https://shopify.github.io/flash-list/)                                      |
| **Native Modules** | Custom Swift modules for batch asset processing, food detection, and MapKit search      |

## Project Structure

```
├── app/                      # Expo Router pages
│   └── (app)/(tabs)/         # Bottom tab screens
│       ├── index.tsx         # Home (restaurants list)
│       ├── review.tsx        # Pending visits review
│       ├── visits.tsx        # All visits gallery
│       └── settings.tsx      # App settings
├── components/               # Reusable UI components
│   ├── home/                 # Home screen components
│   ├── ui/                   # Design system primitives
│   ├── visit/                # Visit detail components
│   └── AwesomeGallery/       # Photo gallery viewer
├── hooks/                    # React hooks & queries
├── modules/                  # Native Expo modules
│   ├── batch-asset-info/     # iOS Swift module for photo processing & food detection
│   ├── calendar-matching/     # EventKit fetching and native visit matching
│   └── mapkit-search/        # iOS Swift module for Apple Maps search
├── services/                 # Business logic
│   ├── scanner.ts            # Photo scanning
│   ├── visit.ts              # Clustering & visit processing
│   ├── places.ts             # Google Places API
│   ├── michelin.ts           # Michelin data loader
│   └── calendar.ts           # Calendar integration
├── store/                    # Zustand stores
├── utils/                    # Utilities
│   └── db.ts                 # SQLite database layer
└── assets/
    └── michelin.csv          # 15k+ Michelin restaurants
```

## Scripts

```bash
pnpm start        # Start Expo dev server
pnpm ios          # Build and run on iOS
pnpm android      # Build and run on Android
pnpm typecheck    # Run TypeScript checks
pnpm lint         # Run ESLint
pnpm test:calendar # Run the isolated native calendar matcher tests
pnpm profile:calendar # Validate and benchmark native calendar matching
pnpm profile:calendar-query-windows # Compare broad and sparse Calendar query plans structurally
pnpm test:macos-calendar-query-harness # Test macOS validator recovery without the live app or database
pnpm test:michelin-calendar-guide # Verify two-stage Calendar guide projection and snapshot parity
pnpm profile:michelin-calendar-guide # Model Calendar guide transfer on an immutable real database
pnpm test:michelin-provider-spatial # Verify provider full-guide parity and R-Tree lifecycle safety
pnpm test:expo-sqlite-rtree-lifecycle # Verify native R-Tree connection shutdown ownership
pnpm profile:michelin-provider-spatial # Model provider matching on the immutable real guide
pnpm test:calendar-batch-mutation # Verify JS routing and native batch/commit semantics
pnpm profile:calendar-batch-mutation # Profile 4,000 creates plus 4,000 deletes structurally
pnpm test:calendar-eventkit-mutation # Test the bounded EventKit profiler support
pnpm profile:calendar-eventkit-mutation # Run the temporary-calendar A/B with Calendar access
pnpm test:visit-merge # Verify set-based auto-merge parity and rollback behavior
pnpm profile:visit-merge # Benchmark legacy and set-based auto-merge paths
pnpm test:macos-visit-merge-harness # Test fixture install/recovery without the live database
pnpm test:macos-build # Verify configuration-specific macOS build selection
pnpm test:wrapped-stats # Verify batched yearly Stats parity and deterministic ties
pnpm profile:wrapped-stats # Benchmark yearly Stats fanout on synthetic or read-only real data
pnpm test:wrapped-stats-michelin # Verify consolidated Michelin-stat parity and production call accounting
pnpm profile:wrapped-stats-michelin # Benchmark Michelin-stat consolidation on read-only real data
pnpm test:macos-wrapped-stats-harness # Test Stats fixture/launch recovery without the live app
pnpm test:food-keyword-sync # Verify zero-write startup sync, repair rollback, and writer contention
pnpm profile:food-keyword-sync # Compare legacy and read-only steady-state keyword sync
pnpm test:review-query-policy # Verify fresh remount reuse and scoped Review invalidation
pnpm profile:review-query-policy # Model Review remount query-call and payload reductions
pnpm test:vision-result-pages # Verify Vision result paging, boundaries, ordering, and retry safety
pnpm profile:vision-result-pages # Benchmark the isolated result-page planner
pnpm test:vision-pipeline # Run the native Vision pipeline and runtime-configuration tests
pnpm build:macos  # Build the iOS app for My Mac (Designed for iPhone)
pnpm clean        # Remove generated mobile directories, Expo state, and node_modules
```

## Calendar Matching Correctness and Performance

Calendar matching now sorts native candidates by start time, end time, and event ID before ranking. The event-ID tie-break removes the previous dependence on EventKit input order when otherwise equal events compete for a visit. The isolated Calendar suite passes **36/36 tests**, including all input permutations for equal-score/equal-time ties, sparse-window coverage, runtime configuration, and native validation attestation.

Calendar reservation import no longer transfers every guide field for all 28,785 active Michelin rows. It scans only `id` and `name`, applies the existing memoized Unicode/affix normalizer in JavaScript, and hydrates the requested exact-name groups inside the same dedicated deferred SQLite snapshot. An explicit `rowid` order preserves the former table encounter order even when SQLite can use a covering index, so equal-score duplicate names retain the same first match. `test:michelin-calendar-guide` compares against the literal former `SELECT m.*` oracle with and without dataset metadata, forces an adversarial covering-index plan, exercises the production request/ranking seam, proves two-connection snapshot isolation, and launches the benchmark contract against direct, symlink, and hardlink aliases of every SQLite sidecar.

On this Mac's immutable 28,785-row guide, the aggregate model hydrated 101 rows across 77 normalized names. A fresh rerun measured median modeled work from **37.416 ms to 21.008 ms (1.78×)**, while JSON-equivalent native-to-JavaScript payload fell from **9,176,962 to 1,378,875 bytes (84.98%)**. The source main file, WAL, SHM, journal, `total_changes()`, and `sqlite_sequence` remained unchanged; the aggregate-only report SHA-256 is `3981006f9d67d422c42a87bfe2ca7b5119378e84c6572a6e3cbceb092ce11336`. This is a Node SQLite/benchmark-local JavaScript model: it includes both queries, normalization, hydration, and transaction commit, but excludes Expo's dedicated connection lifecycle, the production memoization cache, EventKit, the React Native bridge, and rendering.

Calendar export and delete each use one native call and one authorization/preflight. Valid items are staged with `save` or `remove` using `commit: false`; item-level validation and staging failures remain isolated, later items still run, and an already-absent delete satisfies the requested postcondition. A phase commits once only when at least one mutation was staged.

If the final `EKEventStore.commit()` throws, the backend calls `reset()` to discard pending in-memory changes, removes event IDs from staged successes, and reports those items as `ERR_CALENDAR_BATCH_COMMIT_FAILED`. Independent validation/staging failures and `alreadyAbsent` results retain their original outcomes. This is deterministic result mapping plus pending-state discard, not a claim that EventKit documents a multi-item commit as atomic. An uncertain native failure is never retried through Expo.

`test:calendar-batch-mutation` covers the JavaScript routing/result contract and 17 Swift core/profiler tests. The default synthetic profile validates exact ordered outcomes and final-state parity for 4,000 creates plus 4,000 deletes. Modeled JavaScript/native calls and authorization checks fall from **16,000 to 2**, the EventKit commit upper bound falls from **8,000 to 2**, and observed synthetic commits fall from **7,988 to 2**. Its Swift-only timing excludes EventKit, Calendar I/O, JavaScript, and the React Native bridge and is not an EventKit speedup claim.

The signed native macOS profiler then exercised the actual production executor/backend with this Mac's existing full Calendar access. After one warmup, three counterbalanced samples per strategy produced:

| Events | Create: per-item commits | Create: one commit | Speedup | Delete: per-item commits | Delete: one commit | Speedup |
| ------ | ------------------------ | ------------------ | ------- | ------------------------ | ------------------ | ------- |
| 1      | 1.513 ms                 | 1.414 ms           | 1.07×   | 2.297 ms                 | 2.491 ms           | 0.92×   |
| 25     | 36.949 ms                | 13.937 ms          | 2.65×   | 36.491 ms                | 17.087 ms          | 2.14×   |
| 100    | 138.666 ms               | 52.192 ms          | 2.66×   | 147.248 ms               | 59.957 ms          | 2.46×   |

Every accepted sample preserved exact fields and counts, exposed nonempty identifiers before the production commit, retained the same identifiers after readback, and left zero events after delete. The temporary calendar was removed and a read-only post-run audit found no active-source profiler artifacts. One-item delete is slightly slower because both paths make one commit while the production path also performs batch validation/result mapping; the measured win begins when commits are actually coalesced. These timings exclude launch, TCC, temporary-calendar lifecycle, semantic readback, JavaScript, React Native, persistence, and remote sync latency.

`profile:calendar-query-windows` compares broad and sparse query-window plans over deterministic synthetic visits or a read-only SQLite visit source. It verifies complete buffered-visit coverage, sorted non-overlapping windows, and the three-year EventKit predicate limit. This is structural timestamp analysis only: it neither invokes EventKit nor predicts EventKit latency.

The schema-v3 macOS validator has a separate permission-free contract suite at `test:macos-calendar-query-harness`. The test uses a temporary WAL database and fake process/environment commands to exercise success, retained semantic-failure artifacts, and signal recovery. The live validator additionally requires both native strategy/gap attestation and the launched process environment, supports an explicit parity database opened as immutable read-only, retains a report and result database when parity fails, and atomically restores the original live database and launch environment.

The real fixture contained **68,028 photos, 6,511 visits, 2,000 Calendar links, and 1,161 distinct events**. Warm runs were counterbalanced and used one deterministic broad result database as the immutable parity reference:

| Strategy                  | Warm prefix timings (n=3)          | Median     | Median peak RSS |
| ------------------------- | ---------------------------------- | ---------- | --------------- |
| Broad                     | 7.570505 s, 7.736945 s, 7.738894 s | 7.736945 s | 812,192 KiB     |
| Sparse, 30-day coalescing | 7.797055 s, 7.733106 s, 7.806115 s | 7.797055 s | 812,160 KiB     |

Sparse-30 was **0.78% slower by median wall time**, while median peak RSS was effectively identical (32 KiB lower, less than 0.01%). With no demonstrated win, broad remains the production default. One sparse-14 correctness run also passed in 8.228779 seconds, but a single run is not tuning evidence. These timings cover the manually triggered **Rescan Photos prefix through durable Calendar restoration**: they include PhotoKit metadata scanning and visit grouping before Calendar matching, exclude later food-detection and maintenance phases, and are not isolated EventKit measurements. The 0.2-second database/RSS sampling interval and the manual tap after recording the trigger limit precision.

A fresh signed Release containing the one-commit mutation code also passed a broad production Rescan Photos integration run against this Mac's real library. In **11.255348 seconds**, with **821,952 KiB** sampled peak RSS, it reproduced **6,511 visits, 2,000 Calendar links, 1,161 distinct events, 68,028 photos, 5,147 suggestions, and 2 metadata rows** with exact visit/photo/suggestion/metadata parity, clean integrity, and zero foreign-key violations. The result matched reference SHA-256 `8edb82747cf7b94b2758cb416c73a8af69d15b1df8d2352c7e75f04867354b8a`; the live database was restored to `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`. This manually triggered run is integration evidence, not comparative tuning evidence, and Rescan does not invoke export/delete mutations.

The deterministic tie rule changed 168 legacy, previously arbitrary event IDs. Only 15 selected titles and 14 locations changed; restaurant suggestions and all fixture counts remained unchanged. Validation artifacts were written separately, and the existing live database was restored untouched after every run.

Both tested Release builds were launched through Xcode on **My Mac (Designed for iPhone)**. The earlier broad/sparse A/B used executable SHA-256 `7b0dbfbf9bd4ae617fe39d43959feaab23af18422fe1c90fa4b6ab92940eae7d` and `main.jsbundle` SHA-256 `3277663b1c392be51e4fa3c3f27f190f3e563a651c107b96d1ab8a20ed9eb2eb`. The fresh batched-commit Rescan follow-up used executable SHA-256 `d0081d772b7ccdc58b4254f60f2ad6789d720feeb4df8198b950340572702fe5` and `main.jsbundle` SHA-256 `4d8ce5ba3f4fa7c5fbcad5840369cb540505a8c0b06b563599b50e22ee5c48ad`. After exposing that same backend to the isolated Swift profiler, a final signed integration rebuild also passed with executable SHA-256 `34d4cba79b78360f2d9f612b8fcb4035242211436dc12a7df7d71993cf5f11dc` and the same bundle hash.

## Provider Michelin Matching Performance

Provider reservation review and import no longer transfer and scan the complete Michelin guide. Located reservations are grouped into batches of at most 64 and narrowed through a persistent SQLite R-Tree using conservative 1,000-meter spherical bounds. JavaScript receives only row order, ID, name, and coordinates, retains the existing Unicode-aware exact-first/fuzzy-second rules and Haversine checks, and hydrates only the unique winning guide rows inside the same dedicated deferred read snapshot. Reservations without coordinates continue to try Places first and use the selective exact-name guide projection only as their fallback.

The R-Tree is maintained by insert/update/delete triggers, skips invalid and `0,0` guide coordinates, and avoids shadow-table writes when an upsert leaves coordinates unchanged. Initialization performs a deep missing/orphan/bounds check rather than trusting row counts; the real 28,785-row healthy check measured **24.985 ms median** and produced no writes or WAL. `VACUUM` rebuilds the row-ID-backed index, and a same-session invalidation guard forces deep validation before the next provider read if that rebuild fails.

The Expo SQLite native build explicitly enables `SQLITE_ENABLE_RTREE`. Its default unused-statement cleanup cannot be used on these connections: `sqlite3_next_stmt()` also exposes R-Tree's internally owned prepared statements, so finalizing that list before `sqlite3_close()` makes `rtreeDisconnect()` finalize the same pointers again. Palate disables that fallback on the main connection and all inherited exclusive-transaction connections, while its app-owned prepared statements retain explicit `finally` cleanup. `test:expo-sqlite-rtree-lifecycle` compiles Expo's vendored amalgamation with the production R-Tree flag, confirms that eight R-Tree-owned statements are exposed, closes them safely through SQLite ownership, and checks the app and transaction-option contracts.

`test:michelin-provider-spatial` covers literal full-guide parity, exact and fuzzy distance boundaries, equal-distance row-order ties, invalid coordinates, antimeridian and pole bounds, active/historical datasets, winner-only hydration, no-coordinate fallbacks, equal-count corruption, unchanged-coordinate upserts, transactional rollback, concurrent read snapshots, zero-write healthy startup, and forced `VACUUM` row-ID remapping. The source/output contract also rejects direct, symlink, hardlink, and SQLite-sidecar aliases.

On this Mac's immutable **28,785-row** guide, the production-core Node model matched the full-guide oracle exactly for 256 deterministic located reservations. Median modeled work fell from **181.453 ms to 18.336 ms (9.90×)**. Transferred data fell from **28,785 rows / 9,176,962 bytes** to **5,035 rows / 700,450 bytes**, including 4,843 lightweight candidates and 192 unique hydrated winners—a **92.37% payload reduction**. The spatial path uses five SQLite calls for this four-batch workload instead of one full-guide call; the win comes from transferring and normalizing far less data. Its one-time scratch R-Tree build took 79.325 ms and is reported separately because production persists the index. The aggregate-only report SHA-256 is `ee32c35762fcc14c378ebfc05a6508f9513cf0c098b2dfb6b38d267008cdaeb9`.

Those timings include local SQLite execution/decoding, winner hydration, name normalization, Haversine filtering, and exact/fuzzy selection. They exclude Expo's dedicated-connection lifecycle, React Native scheduling/bridge effects, rendering, and the persistent index migration, so **9.90× is an isolated Node/SQLite model, not a signed-app latency claim**. `validate-macos-provider-spatial.sh` separately attests the signed app, runs the real startup migration against an installed disposable copy of the Mac's Palate database, verifies R-Tree integrity and query plans, permits read-only Calendar Imports inspection, proves every non-spatial table unchanged, and restores the original main/WAL/SHM/journal set exactly.

A signed Release was then validated on **My Mac (Designed for iPhone)** against the live database shape containing **68,028 photo rows, 6,511 visits, and 2,000 Calendar-linked visits**. The forced app migration indexed all **28,785** valid guide rows; `rtreecheck` returned `ok`, the candidate plan used both the R-Tree and row-ID lookup, all 14 non-spatial tables and schemas remained unchanged, and the disposable WAL was empty before checkpoint. Read-only UI inspection loaded **139 real Calendar events matching Michelin restaurants** without importing or dismissing anything. A launch-window crash guard found zero new reports for the attested bundle ID and Mach-O UUID. The app executable SHA-256 was `333045d2afadac7ec46583d08335436b7aad4aa5b8b77648b96f7d9246b9f2c3`, `main.jsbundle` SHA-256 was `7582065dcdfa75ada92e143edfb1d4ccdf40c3f35aea2eb148641c26fca6f03e`, and CDHash was `f5a19abea957f9e9b9e63a55bbbdfc622053cd62`. The original database and exact WAL/SHM/journal presence were restored to SHA-256 `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`; the aggregate-only validation report SHA-256 is `ab66e4d1d26d4645608bbed4707048d4c597a5e1e055b65ff876a2907273a4c3`. Its 5.353-second process-observed-to-integration-ready interval is readiness evidence, not a comparative performance measurement.

```bash
zsh scripts/validate-macos-provider-spatial.sh \
  --app="$HOME/Library/Developer/Xcode/DerivedData/Build/Products/Release-iphoneos/Palate.app" \
  --database="$HOME/Library/Containers/<palate-container>/Data/Documents/SQLite/photo_foodie.db" \
  --output-prefix="$PWD/.build/macos-provider-spatial" \
  --manual-launch
```

## Visit Auto-Merge Correctness and Performance

Duplicate-visit auto-merge now validates the complete disjoint plan before side effects and executes one exclusive transaction with six set-based mutations. Photos and reservation-import mappings move through indexed `UPDATE ... FROM` statements; target aggregates, suggestions, source suggestions, and source visits are updated or removed in bulk. Manual one-pair merge behavior is unchanged. A bounded retry loop covers transient SQLite writer contention for the same five-second horizon as the app connection, while malformed, overlapping, cyclic, or stale plans fail atomically.

`test:visit-merge` runs 26 isolated scenarios against an independent literal 11-call legacy oracle. It compares complete ordered snapshots of visits, photos, suggestions, reservations, restaurants, and metadata; exercises empty and Unicode IDs, stale counts, coordinate fallbacks, food flags, suggestion precedence, malformed plans, and injected late failures; and finishes with SQLite quick and foreign-key checks. A virtual monotonic clock verifies the exact five-second backoff schedule without real waiting, including final-deadline success and exhaustion, timestamp refresh, timer overshoot, native busy-error forms, and non-busy passthrough. A separate two-connection WAL fixture proves real lock release, rollback, unchanged state on exhaustion, and recovery. The current parity digest is `a1b7916b055958175286f7030b3c617952e7c5a1c768ff1dc623162a84bafbab`, with bit-exact centroids in the deterministic suite.

`profile:visit-merge` uses one warmup and seven counterbalanced pairs, checks full-table parity on every sample, records per-phase timings, and captures sanitized query plans. Its synthetic fixture improved from **12.679 ms to 3.681 ms median (3.445×)**. A separate immutable, read-only profile derived from this Mac's Palate database used **185 real visits and 19,103 real photo rows**, forming 37 five-visit groups and 148 merges. It improved from **66.565 ms to 30.124 ms median (2.210×)** and reduced the modeled full path from **1,629 operations to 10**. Every non-centroid field matched exactly; maximum centroid drift was `1.7053e-13`, below the declared `1e-12` tolerance; all 13 reported searches were indexed and no base table was fully scanned. These Node/V8 in-memory SQLite timings isolate database work and are not end-to-end app timings.

The macOS validator creates the same 37-by-5 shape from real photo-backed visits, adds deterministic suggestion conflicts and reservation mappings, computes an independent legacy reference, atomically installs only a prepared copy, and restores the original live database on every exit or signal. `test:macos-visit-merge-harness` verifies success, semantic-failure, and termination recovery with a disposable WAL database and fake process/environment commands. A signed Release was also launched through Xcode on **My Mac (Designed for iPhone)** with the prepared real-photo fixture; it rendered all 37 synthetic restaurants with real thumbnails and reached the final 148-to-37 merge confirmation. The irreversible confirmation has deliberately not been accepted yet, so this is build, fixture, launch-attestation, and UI-readiness evidence—not a completed production-app merge parity result.

For an authorized real-app run, quit Xcode, build a signed Release into Xcode's configured build directory, set the Palate scheme's **Run > Info > Build Configuration** to **Release**, and start the validator. Reopen Xcode only after `READY_TO_LAUNCH`, choose **Run Without Building**, and create the reported trigger immediately before accepting the final **Merge All** alert. The validator resolves the running executable with `lsof` and requires its executable and `main.jsbundle` hashes to match the supplied app before it prints `READY`; a Debug or stale product is rejected and the fixture is restored.

```bash
PALATE_XCODE_CONFIGURATION=Release \
PALATE_CODE_SIGNING_ALLOWED=YES \
PALATE_ALLOW_PROVISIONING_UPDATES=1 \
PALATE_DERIVED_DATA_PATH="$HOME/Library/Developer/Xcode/DerivedData" \
pnpm build:macos

zsh scripts/validate-macos-visit-merge.sh \
  --app="$HOME/Library/Developer/Xcode/DerivedData/Build/Products/Release-iphoneos/Palate.app" \
  --database="$HOME/Library/Containers/<palate-container>/Data/Documents/SQLite/photo_foodie.db" \
  --output-prefix="$PWD/.build/macos-visit-merge" \
  --manual-launch
```

## Review Query Cache Policy

The expensive pending-review query reuses fresh data for 30 seconds across navigation remounts instead of forcing a query on every mount. Relevant mutations invalidate Review data; notes updates use the exact pending-review key, immediately refetch active observers, and leave inactive cached data invalidated for the next stale-aware mount. Pull-to-refresh likewise targets only the active pending-review and unanalyzed-photo-count queries rather than every app query.

The focused QueryCore contract suite verifies fresh remount reuse, stale and invalidated remounts, exact active refresh, cached-data visibility during refresh, notes-mutation invalidation, and isolation from descendant or unrelated keys. The structural profile models six mounts and reduces materializations from **6 to 1**, avoiding **83.33%** of modeled query calls, rows, and bytes. Its timing covers Node/V8 TanStack Query observers and exact-size JSON parsing—not Expo SQLite, the native bridge, Hermes, React rendering, or Photos/Calendar access—so it is not an app-speed claim.

## Wrapped Stats Query Performance

The all-time Wrapped Stats path now computes every yearly total and each year's top restaurant in one CTE/window query instead of issuing one follow-up query per year. The five Michelin-award queries are likewise one materialized-CTE query, with JavaScript retaining the legacy award classification rules. On the current 15-year data shape, the yearly phase falls from **16 SQLite calls to 1**, the Michelin phase from **5 calls to 1**, and the complete all-time request from **39 calls to 20**. A selected-year request falls from **23 calls to 19**. Equal-count yearly winners now use `restaurantId ASC` as a stable final key rather than depending on SQLite's chosen query plan.

`test:wrapped-stats` compares the yearly production query with an independent literal legacy oracle across indexed and unindexed plans, focused null/orphan/status/UTC/Unicode cases, and 48 randomized fixtures. Defined counts, ordering, and null behavior match exactly; any changed legacy name must be one of multiple equal-count winners. `test:wrapped-stats-michelin` independently executes the literal five-query oracle and covers empty, null, Unicode, multi-label, historical-award, orphan, and status cases in two index modes plus 48 randomized fixtures. It also parses the production source to prove that every database call remains in the single `Promise.all` plan and that the complete plan contains exactly 20 all-time or 19 selected-year calls. Both profiles reject source/output main-file and SQLite-sidecar aliases through direct, canonical, symlink, and hardlink paths.

The read-only Mac-derived profile retained all **6,511 real visit timestamps** across **15 UTC years**, replaced identifiers and names in memory, and never wrote to the source database. One warmup plus seven counterbalanced pairs measured **21.712 ms to 11.493 ms median (1.89×)** for the isolated yearly phase, saving 10.219 ms. All defined semantics matched; five displayed winner names changed only where multiple restaurants had the same maximum count. The source SHA-256 remained `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`, integrity remained `ok`, and the anonymized report SHA-256 is `fa5c8d8c1f1abb47923c9ebf0188e2ed78c171d81388bf2b2443082a068629db`. These Node/V8 in-memory SQLite timings include statement preparation, execution, row decoding, and yearly hydration, but exclude Expo scheduling, the React Native bridge, and rendering.

The separate Michelin profile retained all **6,511 real timestamps** and the full **28,785-row guide**, then built an in-memory confirmed workload using direct suggestions, nearest suggestions, and a deterministic guide fallback so all 15 reported metrics were exercised. Across nine counterbalanced samples, all-time Michelin work fell from **23.557 ms to 9.255 ms median (2.55×)** and the representative 2025 query from **9.207 ms to 2.494 ms (3.69×)**, with exact parity to the literal oracle. The source was opened through an immutable read-only URI in one read transaction after rejecting a nonempty WAL, and its main file and sidecars remained unchanged. The aggregate-only report SHA-256 is `0291019f8c48f04e83ca0950e3c920b071ef3e6caaf007b58d71f71da7ceeeed`. These are isolated Node/V8 SQLite timings, not end-to-end screen timings.

The separate macOS fixture selects one real visit for each year from 2012 through 2026 in a disposable database copy. It retains **2,304 attached photo rows and 11 Calendar-linked visits**, produces an independent all-time/2025 oracle, and requires complete schema/table multiset parity after the read-only Stats session. `test:macos-wrapped-stats-harness` covers success, stale visual timestamps, semantic mutation, signal recovery, and rejection of a mismatched Xcode-launched executable or JavaScript bundle before `READY`; every case restores the database and launch environment byte-for-byte. It verifies `sqlite_sequence`, persisted pragmas, and all table multisets, rejects any sampled nonzero WAL, removes raw fixture/oracle intermediates, and retains only aggregate report data.

A final signed Release containing both Stats consolidations, the zero-write keyword sync, and the Calendar guide projection was launched through Xcode on **My Mac (Designed for iPhone)**. The harness attested executable SHA-256 `d0ce57f9c7b0585a66939082cc2f649ce9cc76b4858c561e7b9cdf01b602e207` and `main.jsbundle` SHA-256 `3f0a0b75a9d7279e5fe54e35ac1f8273f3cff8b2320d6c60af0a9c4037e831cc`. The visible all-time screen matched 15 visits, 45 stars, and one restaurant; the selected 2025 screen matched one visit, three stars, and one restaurant. The independent oracle additionally verified 2,304 all-time photos, a 153.6 average, one map point, and 831 photos in 2025. Every 50 ms sample observed a zero-byte WAL, the prepared/result databases were byte-identical, all 13 tables including `sqlite_sequence` matched, and the live database was restored byte-for-byte to SHA-256 `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`. The aggregate-only report SHA-256 is `e8fba14ac442f91daaff00bb91d59797c302eb85f7968f90c6d8da75fa247b95`. Its 32.758-second trigger-to-ready interval includes manual UI work and is integration evidence, not an app timing result.

## Startup Food-Keyword Sync

Database initialization now inspects all 58 bundled food keywords once and returns without opening a transaction when the rows are already healthy. Actual repairs re-read under an exclusive transaction, update only defaults that are no longer marked built-in, and insert only missing defaults; disabled state, creation timestamps, row IDs, and unrelated user keywords are preserved. A failed insert rolls the entire repair back.

`test:food-keyword-sync` covers first install, a byte-stable steady-state rerun, missing and misclassified repair, disabled/user-row preservation, injected rollback and retry, and a real two-worker/two-connection WAL race. In the race, both workers observe the same defect before competing for the writer lock; one performs the repair and the other re-reads to a zero-write result without a uniqueness failure. The same no-write path was also run against an isolated copy of this Mac's database: it performed one read, no transaction or writes, kept `sqlite_sequence` at 232, left the WAL empty, and kept the main file byte-identical at SHA-256 `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`.

Across seven counterbalanced samples of 500 steady-state reruns, the isolated benchmark improved from **31.864 ms to 21.303 ms median (1.50×)**. More importantly, one legacy rerun added **58 total changes, 58 sequence IDs, and 8,272 WAL bytes** despite changing no row values; the optimized rerun added **zero** of each. The report SHA-256 is `4a7dad8f8e9a12f344f70cc7dbba782540dc6f58d733cf0cf629597de70fd558`. The timing is Node/V8 SQLite evidence; the write-elimination invariant is the startup-relevant result.

## Vision Result-Page Performance Validation

Vision classification results cross the native/JavaScript boundary in bounded pages. The production default is **1,000 results per page**, tunable from 1 through 2,000 with `PALATE_VISION_RESULT_PAGE_SIZE`; JavaScript falls back to the legacy 50-result behavior when a binary does not advertise a valid page size. A 1,000-result page aligns with the 1,000-row durable SQLite flush boundary and reduces native calls for the 13,059-photo fixture from 66 at 200 results per page to 14.

The isolated `test:vision-result-pages` suite covers boundary counts, exact ordered reconstruction (including duplicate and missing-asset-like identifiers), the 2,000-result cap, a final partial page, the 1,000-row flush boundary, and an exactly retryable failed write. `profile:vision-result-pages` rotates 200-, 500-, and 1,000-result strategies across the 13,059-row real-fixture shape and a 68,027-row deep-library shape. Its Node/V8 timings cover only page planning, copying, and traversal, so they are structural diagnostics rather than an end-to-end app speedup claim.

App-level correctness and performance were also exercised with a signed Release build running as **My Mac (Designed for iPhone)** against this Mac's real Photos library and Palate database. `scripts/validate-macos-vision-result-page.sh` snapshots the live database, resets the 13,059 previously classified fixture photos, observes the launched process environment, samples durable SQLite progress and RSS every 0.2 seconds, and restores the original database byte-for-byte. The requested page size is attested by the process environment plus native runtime-configuration resolver tests (there is no app-side marker). The harness preserves and restores pre-existing result-page, classification-strategy, concurrency, pipeline-depth, and validation-run launch environment values, including on signals.

The primary schema-v2 timing is the **durable tail** from the first 0.2-second sample that observes durable database progress (after at least one 1,000-row flush) through completion. It deliberately excludes launch, UI-trigger latency, and the first observed persistence flush, so it is useful for comparing the steady classification/persistence tail but is not total user-perceived scan time. Trigger-to-durable-completion remains a diagnostic in each report.

| Real-library A/B/A/B evidence      | 200-result pages                   | 1,000-result pages                 | Result                                                                                                                                  |
| ---------------------------------- | ---------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Earlier trigger-wall runs          | 56.863 s, 56.398 s (mean 56.630 s) | 55.600 s, 55.490 s (mean 55.545 s) | 1.92% lower mean wall time; both 1,000-page runs were faster                                                                            |
| Process-attested durable-tail runs | 62.572 s, 56.779 s (mean 59.675 s) | 56.666 s, 56.290 s (mean 56.478 s) | 5.36% lower raw mean, but the first 62.572 s baseline was cold/noisy; the second paired comparison was a more conservative 0.86% faster |

The process-attested runs averaged 608,312 KiB peak RSS at page size 200 and 599,272 KiB at page size 1,000 (1.49% lower), but two samples per configuration are not enough to characterize memory precisely. Every run reproduced all 2,526 food-positive photos and 1,020 food-probable visits with zero mismatches. The parity queries are deletion-safe: they detect missing and extra photo or visit rows as well as semantic food-label, confidence, and visit-flag differences. Every run also ended with zero pending rows, `PRAGMA integrity_check = ok`, and restoration to the original database SHA-256 `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`.

For a real-library rerun, quit Xcode, build an explicit signed Release into Xcode's configured build directory, set the Palate scheme's **Run > Info > Build Configuration** to **Release**, invoke the harness with the exact app path printed by the build helper, and reopen Xcode only when the harness requests the manual launch. Use **Run Without Building**, then trigger **Deep Scan All Photos** when the harness is ready:

```bash
PALATE_XCODE_CONFIGURATION=Release \
PALATE_CODE_SIGNING_ALLOWED=YES \
PALATE_ALLOW_PROVISIONING_UPDATES=1 \
PALATE_DERIVED_DATA_PATH="$HOME/Library/Developer/Xcode/DerivedData" \
pnpm build:macos

zsh scripts/validate-macos-vision-result-page.sh \
  --app="$HOME/Library/Developer/Xcode/DerivedData/Build/Products/Release-iphoneos/Palate.app" \
  --database="$HOME/Library/Containers/<palate-container>/Data/Documents/SQLite/photo_foodie.db" \
  --page-size=1000 \
  --output-prefix="$PWD/.build/macos-vision-page1000-a" \
  --manual-launch
```

Create the reported `.trigger` file with the current epoch immediately before pressing the scan confirmation button. The harness writes a JSON report, a 0.2-second sample trace, and a post-run database copy while restoring the live database and launch environment automatically.

## Thanks

Special thanks to Jerry for collecting the dataset - [jerrynsh.com](https://jerrynsh.com/building-what-michelin-wouldnt-its-awards-history/)

https://ko-fi.com/s/81041defee

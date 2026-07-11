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
pnpm test:calendar-matching-context # Verify the one-snapshot Calendar matching context
pnpm profile:calendar-matching-context # Benchmark context loading on immutable real rows
pnpm test:calendar-matching-request # Verify native request/fallback selection
pnpm profile:calendar-matching-request # Benchmark request preparation and bridge shape
pnpm test:calendar-import-snapshot # Verify rendered-snapshot planning, atomic persistence, and cache rollback
pnpm profile:calendar-import-snapshot # Model the discovery work removed from Calendar import mutations
pnpm profile:calendar-query-windows # Compare broad and sparse Calendar query plans structurally
pnpm test:macos-calendar-query-harness # Test macOS validator recovery without the live app or database
pnpm test:michelin-calendar-guide # Verify two-stage Calendar guide projection and snapshot parity
pnpm profile:michelin-calendar-guide # Model Calendar guide transfer on an immutable real database
pnpm test:michelin-import-core # Verify strategy resolution, attestation, and shared set-based SQL
pnpm test:michelin-import-production-wiring # Verify production lifecycle and terminal-error contracts
pnpm test:michelin-import-prototype # Verify set-based import semantics against the legacy JS path
pnpm profile:michelin-import-prototype # Profile the production-shared ATTACH/INSERT...SELECT SQL
pnpm test:macos-michelin-import-harness # Exercise signed-validator recovery, corruption, and privacy cases
pnpm test:macos-michelin-import-summary # Verify strict counterbalanced signed A/B aggregation
pnpm test:michelin-provider-spatial # Verify provider full-guide parity and R-Tree lifecycle safety
pnpm test:expo-sqlite-rtree-lifecycle # Verify production R-Tree/URI flags and safe native shutdown
pnpm profile:michelin-provider-spatial # Model provider matching on the immutable real guide
pnpm test:provider-reservation-location # Verify coalesced provider geocoding, review reuse, and bridge replay safety
pnpm profile:provider-reservation-location # Model provider request and critical-path reductions
pnpm test:reservation-review-prefilter # Verify exact provider-review snapshot parity and commit-race handling
pnpm profile:reservation-review-prefilter # Profile selective facts/day rows against full-history scans
pnpm test:michelin-suggestion-index-projection # Verify minimal-index exact suggestion parity
pnpm profile:michelin-suggestion-index-projection # Profile the projection on immutable real rows
pnpm test:michelin-name-search # Verify Unicode name-search parity, cache reset, and dataset-swap safety
pnpm profile:michelin-name-search # Profile Unicode projection, hydration, and rapid typing
pnpm test:map-viewport-query # Verify native Michelin map selection against the former JS oracle
pnpm profile:map-viewport-query # Profile viewport selection on synthetic or immutable real data
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
pnpm test:review-mutation-cache-policy # Verify optimistic Review isolation, overlap, and refresh races
pnpm profile:review-mutation-cache-policy # Model repeated status-action hydration avoidance
pnpm test:pending-review-paging # Verify one-bind deterministic Review pages against the monolith
pnpm profile:pending-review-paging # Profile progressive pages on synthetic or immutable real data
pnpm test:quick-actions-query # Verify the slim Quick Actions projection and shared mutation-cache key
pnpm profile:quick-actions-query # Profile Quick Actions on synthetic or immutable real data
pnpm test:visit-list-paging # Verify slim keyset pages, cache resets, and profiler source/output guards
pnpm profile:visit-list-paging # Profile first-page bootstrap and complete traversal by visit filter
pnpm test:confirmed-restaurant-search # Verify the lazy slim visit-modal search projection
pnpm profile:confirmed-restaurant-search # Profile closed, blank, and typed modal search states
pnpm test:visit-photo-proximity # Verify antimeridian-, pole-, and threshold-safe visit grouping
pnpm profile:visit-photo-proximity # Measure the isolated proximity correctness cost
pnpm test:food-sampling # Verify deterministic visit-photo sampling and sample ranks
pnpm profile:food-sampling # Profile the combined sampling query
pnpm test:visit-food-adaptive-scan # Verify adaptive rank-wave semantics
pnpm profile:visit-food-adaptive-scan # Model avoided Vision attempts on synthetic or retained-control data
pnpm test:visit-food-detection-strategy # Verify native strategy selection and safe fallback
pnpm test:visit-food-detection-orchestration # Verify rank-3 checkpoints, bulk tail, progress, and retry safety
pnpm test:vision-result-pages # Verify Vision result paging, boundaries, ordering, and retry safety
pnpm profile:vision-result-pages # Benchmark the isolated result-page planner
pnpm test:vision-page-orchestration # Verify bounded ordered one-page lookahead
pnpm profile:vision-page-orchestration # Model classification/persistence overlap
pnpm test:vision-pipeline # Run the native Vision pipeline and runtime-configuration tests
pnpm test:vision-result-transport # Cross-check binary V1 in TypeScript and Swift
pnpm profile:vision-result-transport # Model JSON and binary transport on immutable real rows
pnpm test:macos-vision-result-page-harness # Test Vision fixture install/recovery without the live database
pnpm test:macos-vision-visit-food-summary # Test strict signed strategy A/B aggregation
pnpm profile:macos-vision-visit-food-summary # Summarize signed full-plan/adaptive reports
pnpm test:macos-vision-transport-summary # Test strict signed transport A/B aggregation
pnpm profile:macos-vision-transport-summary # Validate and summarize signed legacy/packed reports
pnpm test:incremental-photo-scan # Verify full/incremental selection, paging, and persistence parity
pnpm profile:incremental-photo-scan # Model full, identifier-list, and database-backed scans
pnpm test:macos-photo-scan-summary # Test signed-report validation and aggregation
pnpm profile:macos-photo-scan-summary # Validate and aggregate signed real-library A/B reports
pnpm build:macos  # Build the iOS app for My Mac (Designed for iPhone)
pnpm clean        # Remove generated mobile directories, Expo state, and node_modules
```

## Calendar Matching Correctness and Performance

Calendar matching now sorts native candidates by start time, end time, and event ID before ranking. The event-ID tie-break removes the previous dependence on EventKit input order when otherwise equal events compete for a visit. The isolated Calendar suite passes **36/36 tests**, including all input permutations for equal-score/equal-time ties, sparse-window coverage, runtime configuration, and native validation attestation.

Calendar reservation import no longer transfers every guide field for all 28,785 active Michelin rows. It scans only `id` and `name`, applies the existing memoized Unicode/affix normalizer in JavaScript, and hydrates the requested exact-name groups inside the same dedicated deferred SQLite snapshot. An explicit `rowid` order preserves the former table encounter order even when SQLite can use a covering index, so equal-score duplicate names retain the same first match. `test:michelin-calendar-guide` compares against the literal former `SELECT m.*` oracle with and without dataset metadata, forces an adversarial covering-index plan, exercises the production request/ranking seam, proves two-connection snapshot isolation, and launches the benchmark contract against direct, symlink, and hardlink aliases of every SQLite sidecar.

On this Mac's immutable 28,785-row guide, the aggregate model hydrated 101 rows across 77 normalized names. A fresh rerun measured median modeled work from **37.416 ms to 21.008 ms (1.78×)**, while JSON-equivalent native-to-JavaScript payload fell from **9,176,962 to 1,378,875 bytes (84.98%)**. The source main file, WAL, SHM, journal, `total_changes()`, and `sqlite_sequence` remained unchanged; the aggregate-only report SHA-256 is `3981006f9d67d422c42a87bfe2ca7b5119378e84c6572a6e3cbceb092ce11336`. This is a Node SQLite/benchmark-local JavaScript model: it includes both queries, normalization, hydration, and transaction commit, but excludes Expo's dedicated connection lifecycle, the production memoization cache, EventKit, the React Native bridge, and rendering.

Calendar Imports now persist the exact event snapshots already rendered and reviewed by the user instead of rerunning the 1,000-day EventKit/Michelin discovery pipeline inside the mutation. A pure planner deduplicates IDs, rejects invalid overrides, and excludes future events. One exclusive SQLite transaction then rechecks linked and dismissed IDs, applies the existing inclusive ±1-day confirmed-visit conflict rule across every originally matched restaurant, inserts visits with `INSERT OR IGNORE ... RETURNING`, and creates suggestions only for visits that were actually inserted. The mutation returns exact inserted and skipped ID sets; its Query cache policy serializes overlapping imports, rolls back only unavailable optimistic rows, and invalidates canonical stats after success.

`test:calendar-import-snapshot` covers malformed overrides, partial availability, deterministic ID collisions, alternate-restaurant conflicts, 1,002-item batching, forced rollback, a two-connection WAL dismissal race, and QueryClient cache recovery. The privacy-safe benchmark shape uses 8,167 synthetic eligible events and 139 candidates derived from existing aggregate Mac evidence. Snapshot reuse eliminates one full discovery call and all 8,167 modeled event-row traversals per mutation; the pure JavaScript model measured **56.86×** for a one-item import and **1.735×** for all 139. Those timings exclude EventKit, Michelin/SQLite discovery, persistence, Expo/React Native, and rendering; the decision-relevant production evidence is eliminated repeated discovery. Aggregate report SHA-256: `8136cddce879ce5c56b40e12c12ac73995cb5b4a7a8badd5fab329eea5db90fb`.

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

The schema-v6 macOS validator has a separate permission-free contract suite at `test:macos-calendar-query-harness`. The test uses temporary WAL databases and fake process/environment commands to cover aggregate-only privacy, exact main/WAL/SHM/journal restoration and modes, lock contention, TERM recovery, and a durable SIGKILL guard. The live validator holds a kernel lock for the complete run, captures the original file set before any SQLite checkpoint, mutates only a disposable installed copy, and publishes a report only after byte-exact restoration. Raw database artifacts are deleted by default and require the explicit `--retain-raw-databases` opt-in; a guard left by an uncatchable termination makes later runs fail closed until `--database=PATH --recover-stale-guard` validates the manifest and restores the exact file set, launch environment, and private-artifact policy. An explicit incremental parity reference may contain newly visible photos only when native attestation explains the entire nonnegative delta exactly: library total equals reference photos, excluded-visible equals the live baseline, and unknown-visible equals the difference. For a changed real Photos library without a prebuilt reference, `--capture-reference-database=PATH` accepts only an attested incremental delta, proves every original photo row remains exact plus full visit/Calendar/suggestion/metadata parity and clean SQLite integrity, then writes the validated standalone reference with mode `0600`; it is incompatible with a supplied reference or a legacy scan. If newly visible assets legitimately grow the visit fixture, adding `--capture-expected-calendar-link-count=N` explicitly switches capture A to baseline-preserving bootstrap mode: original photo, visit, and suggestion rows plus metadata remain protected, aggregate counts may only grow, and `N` is the atomic completion target. Replay B supplies that database through `--reference-database=PATH --allow-reference-fixture-growth`; the validator first proves it preserves the protected baseline, then uses its aggregate counts as completion targets and requires full-result parity under the validator's existing nondeterministic `visits.updatedAt` exemption. Bootstrap preservation uses the same exemption and permits Calendar-derived fields to be recomputed; every other existing visit field remains exact. Neither growth path weakens ordinary validation. The aggregate report redacts the private path while recording its hash, counts, deltas, validation, and capture status. The contract suite rejects legacy deltas, negative deltas, balanced-but-wrong attestations, original-row mutations, aggregate shrinkage, and result-count mismatches.

The real fixture contained **68,028 photos, 6,511 visits, 2,000 Calendar links, and 1,161 distinct events**. Warm runs were counterbalanced and used one deterministic broad result database as the immutable parity reference:

| Strategy                  | Warm prefix timings (n=3)          | Median     | Median peak RSS |
| ------------------------- | ---------------------------------- | ---------- | --------------- |
| Broad                     | 7.570505 s, 7.736945 s, 7.738894 s | 7.736945 s | 812,192 KiB     |
| Sparse, 30-day coalescing | 7.797055 s, 7.733106 s, 7.806115 s | 7.797055 s | 812,160 KiB     |

Sparse-30 was **0.78% slower by median wall time**, while median peak RSS was effectively identical (32 KiB lower, less than 0.01%). With no demonstrated win, broad remains the production default. One sparse-14 correctness run also passed in 8.228779 seconds, but a single run is not tuning evidence. These timings cover the manually triggered **Rescan Photos prefix through durable Calendar restoration**: they include PhotoKit metadata scanning and visit grouping before Calendar matching, exclude later food-detection and maintenance phases, and are not isolated EventKit measurements. The 0.2-second database/RSS sampling interval and the manual tap after recording the trigger limit precision.

A fresh signed Release containing the one-commit mutation code also passed a broad production Rescan Photos integration run against this Mac's real library. In **11.255348 seconds**, with **821,952 KiB** sampled peak RSS, it reproduced **6,511 visits, 2,000 Calendar links, 1,161 distinct events, 68,028 photos, 5,147 suggestions, and 2 metadata rows** with exact visit/photo/suggestion/metadata parity, clean integrity, and zero foreign-key violations. The result matched reference SHA-256 `8edb82747cf7b94b2758cb416c73a8af69d15b1df8d2352c7e75f04867354b8a`; the live database was restored to `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`. This manually triggered run is integration evidence, not comparative tuning evidence, and Rescan does not invoke export/delete mutations.

On 2026-07-10, a newer real-library validation found five newly visible Photos assets and deterministic fixture growth of one visit, one Calendar link, and one distinct event. A guarded bootstrap capture completed in **7.995144 seconds** and preserved every baseline photo, suggestion, metadata row, and existing non-Calendar visit field under the established `updatedAt` exemption. Replay B then reproduced the complete **68,033-photo, 6,512-visit, 2,001-link, 1,162-event, 5,147-suggestion, 2-metadata-row** reference in **6.203330 seconds** with zero visit, photo, suggestion, or metadata mismatches, `integrity_check = ok`, and zero foreign-key violations. Native attestation proved the incremental identifier-list path excluded exactly 68,028 known assets and returned exactly five unknown assets. The Xcode-launched signed Release matched executable SHA-256 `d0c0cdb18c52a24c46249c82f237f4c9ac2102c13ac3229558ff735324550bbb` and `main.jsbundle` SHA-256 `b51c28926ed81b2680ec651a93934aad0836b5867e41a6149a70a9450dd4c6c3`; strict code-signature validation passed. Replay report SHA-256 is `3e0f2d32ee9ec42cf4f3cd6a31debbc1bcc7ed1b313dd256ca27756411913730`. The private reference and trigger files were removed after verification, and the live main/WAL/SHM set was restored byte-for-byte to `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, and `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`. These are signed integration timings for one capture/replay pair, not comparative tuning evidence.

The deterministic tie rule changed 168 legacy, previously arbitrary event IDs. Only 15 selected titles and 14 locations changed; restaurant suggestions and all fixture counts remained unchanged. Validation artifacts were written separately, and the existing live database was restored untouched after every run.

Both tested Release builds were launched through Xcode on **My Mac (Designed for iPhone)**. The earlier broad/sparse A/B used executable SHA-256 `7b0dbfbf9bd4ae617fe39d43959feaab23af18422fe1c90fa4b6ab92940eae7d` and `main.jsbundle` SHA-256 `3277663b1c392be51e4fa3c3f27f190f3e563a651c107b96d1ab8a20ed9eb2eb`. The fresh batched-commit Rescan follow-up used executable SHA-256 `d0081d772b7ccdc58b4254f60f2ad6789d720feeb4df8198b950340572702fe5` and `main.jsbundle` SHA-256 `4d8ce5ba3f4fa7c5fbcad5840369cb540505a8c0b06b563599b50e22ee5c48ad`. After exposing that same backend to the isolated Swift profiler, a final signed integration rebuild also passed with executable SHA-256 `34d4cba79b78360f2d9f612b8fcb4035242211436dc12a7df7d71993cf5f11dc` and the same bundle hash.

## Incremental Photo Scan Correctness and Performance

Quick rescans now read persisted PhotoKit identifiers with one SQLite query and perform the full-library membership plan in native Swift. Each visible `PHAsset` is read once; persisted location/skip counters are derived only for known identifiers, and only unknown assets cross back to JavaScript for insertion. The legacy full scan remains available as a runtime fallback, and an older binary without the incremental API keeps its former behavior. The selector tests cover empty, stale, partially known, all-known, Unicode, invalid-metadata, page-boundary, begin-failure, malformed-session cleanup, and post-begin failure cases while comparing the final database against the literal full-scan insertion oracle.

An additional database-backed native implementation reads `id`, `creationTime`, `latitude`, and `longitude` directly through ExpoSQLite's own `exsqlite3_*` runtime. It uses a separate read-only connection, sees committed WAL rows, validates the actual table/schema and dynamic row types, closes SQLite before PhotoKit enumeration, and never links a second SQLite copy into the app process. The native suite covers malformed paths and schemas, duplicate/invalid identifiers, numeric and coordinate boundaries, Unicode, exact identifier-list plan parity, source immutability, and a committed-but-uncheckpointed WAL row.

The aggregate-only isolated profile used all **68,031 persisted rows** plus 512 deterministic unknown assets without opening Photos or writing the source. Incremental scanning reduced native pages from **35 to 1**, insert statements from **18 to 1**, and bound parameters by **476,217**. The identifier-list path reduced the modeled serialized payload from **15,541,664 to 3,225,915 bytes (79.24%)**. The database-backed path additionally eliminated the **3,129,427-byte** identifier bridge and 68,031 retained JavaScript identifiers, but its Node/system-SQLite timing is explicitly only a structural proxy for Swift/ExpoSQLite.

Signed real-library runs used schema-v2 native attestation to prove the selected implementation, exact executable and bundle hashes, an unchanged pre-trigger logical digest, exact visit/photo/suggestion/metadata parity, clean integrity, zero foreign-key violations, and byte-exact restoration after every run. A fresh five-pair, counterbalanced A/B on the stabilized **68,031-photo** fixture measured legacy at **8.256213 s median** and the fused identifier-list path at **6.315584 s median**: a descriptive **23.51% improvement** and **1.940629 s saved**. The identifier-list path was faster in four of five pairs and raised median sampled peak RSS from **805,536 to 874,512 KiB** (+68,976 KiB). The timing covers the manually triggered Rescan Photos prefix through durable Calendar restoration, so it is signed-app integration evidence rather than isolated PhotoKit latency. A separate database-backed A/B did not demonstrate a latency win, so database-backed scanning remains opt-in while production keeps the identifier-list plan.

The five-pair Release (`Palate` SHA-256 `73117f1ec01cb977ecff3acb4f6375a5814b2045da8f58d08b7dcec58f0db162`; `main.jsbundle` SHA-256 `d57db514aab5db72562bea0678a2aabdd5621fa425f24c01ce1f87b2e1f88c9e`) was launched on **My Mac (Designed for iPhone)** and attested `selectedScanImplementation = identifier-list` on every incremental run. The schema-v3 summarizer requires balanced multi-sample groups and rejects mismatched logical database digests, Calendar configurations, fixture/build/library identities, per-strategy known/unknown workloads, restored schema-v6 file sets, duplicate run IDs, and nonuniform implementations before producing descriptive statistics. PhotoKit content identity is still count-based rather than an ordered private identifier digest, and that limitation is recorded in the report. After validation, all raw database copies and trigger files were removed; the original 68,028-photo main database, empty WAL, and SHM were restored to SHA-256 `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, and `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`.

A final combined signed Release containing the Photo, Calendar, Vision-orchestration, and visit-geometry work also passed a fresh real-library run on **My Mac (Designed for iPhone)**. The schema-v6 report attested executable SHA-256 `f760d7b6448ee9a990eedf9adcaff337bc7cbd8c2b6347e57a43d52104e0ced9`, `main.jsbundle` SHA-256 `a6778fe9d298eb50cd21ed053b4873bc00c7d750ba07c377aa8a1d978c363f46`, strict code-signature validity, identifier-list incremental scanning, and the exact current-library delta of 3 unknown plus 68,028 excluded-visible assets. It reproduced **68,031 photos, 6,511 visits, 2,000 Calendar links across 1,161 events, 5,147 suggestions, and 2 metadata rows** with zero parity mismatches, clean integrity, and zero foreign-key violations in **6.612872 seconds** at **855,360 KiB** sampled peak RSS. This is single-run integration evidence, not another comparative speedup measurement. The aggregate-only report SHA-256 is `80b9b80e5eab5a5652feb03c24a12c2a3be3e04ba94cc5559a96b1c5e0b82bd2`; all retained private database copies and triggers were deleted, and the original main/WAL/SHM files were restored exactly to the hashes above.

## Visit Photo Proximity Correctness

Adjacent-photo grouping now uses a stable Haversine decision metric, with a cross/dot `atan2` path near antipodes, and threshold-derived safe coordinate rejection bounds instead of fixed degree cutoffs. Longitude wraps across the antimeridian; corrupt/non-finite coordinates and thresholds fail closed; and pole or large-threshold cases no longer reject valid pairs early.

`test:visit-photo-proximity` covers 14,406 authoritative spherical boundary assertions, 4,900 exact ordinary-decision comparisons with the removed implementation, and 20,000 deterministic property samples. Ordinary centroids remain bit-exact arithmetic results; only antimeridian-crossing longitude uses a circular mean. The isolated one-million-comparison benchmark measured **16.062 ms** versus **15.345 ms** for the literal former path (+4.67%, or 0.717 ms per million). The wrap-aware centroid measured **3.038 ms** versus **2.718 ms** per 200,000 four-photo groups (+11.77%). These are explicitly measured correctness costs, not speedup claims.

## Provider Michelin Matching Performance

Provider reservation review and import no longer transfer and scan the complete Michelin guide. Located reservations are grouped into batches of at most 64 and narrowed through a persistent SQLite R-Tree using conservative 1,000-meter spherical bounds. JavaScript receives only row order, ID, name, and coordinates, retains the existing Unicode-aware exact-first/fuzzy-second rules and Haversine checks, and hydrates only the unique winning guide rows inside the same dedicated deferred read snapshot. Reservations without coordinates continue to try Places first and use the selective exact-name guide projection only as their fallback.

The R-Tree is maintained by insert/update/delete triggers, skips invalid and `0,0` guide coordinates, and avoids shadow-table writes when an upsert leaves coordinates unchanged. Initialization performs a deep missing/orphan/bounds check rather than trusting row counts; the real 28,785-row healthy check measured **24.985 ms median** and produced no writes or WAL. `VACUUM` rebuilds the row-ID-backed index, and a same-session invalidation guard forces deep validation before the next provider read if that rebuild fails.

The Expo SQLite native build explicitly enables `SQLITE_ENABLE_RTREE` and `SQLITE_USE_URI`. Its default unused-statement cleanup cannot be used on these connections: `sqlite3_next_stmt()` also exposes R-Tree's internally owned prepared statements, so finalizing that list before `sqlite3_close()` makes `rtreeDisconnect()` finalize the same pointers again. Palate disables that fallback on the main connection and all inherited exclusive-transaction connections, while its app-owned prepared statements retain explicit `finally` cleanup. `test:expo-sqlite-rtree-lifecycle` compiles Expo's vendored amalgamation with the exact production flags, attests both compile options, binds and reads the production-style immutable URI through `ATTACH`, proves writes are rejected, confirms that eight R-Tree-owned statements are exposed, closes them safely through SQLite ownership, and checks the app and transaction-option contracts.

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

## Set-Based Provider Reservation Persistence

Provider reservation persistence now has an explicit `set-based-json-v1` validation strategy alongside the literal `legacy-row-v1` path. The candidate performs its identity recheck, overlap snapshots, planning, restaurant upsert, visit insert/update, source mapping, and suggestion replacement inside one exclusive transaction. Ordered JSON1 inputs preserve first-source, last-writer, ID-collision, and suggestion-replacement behavior while reducing a nonempty import to at most eight data statements. Because Expo starts its dedicated exclusive connection with deferred `BEGIN`, the candidate first applies the main connection's five-second busy timeout and acquires row-neutral write intent before any recheck read; this prevents a concurrent WAL commit from turning the first real write into `BUSY_SNAPSHOT`. The ordinary app path remains `legacy-row-v1` until an Expo/signed-app A/B establishes a safe promotion threshold.

```sh
pnpm test:reservation-import-persistence
pnpm profile:reservation-import-persistence
```

The independent literal oracle compares all five affected tables and result counters. Its focused suite covers more than 1,000 inputs, equal-start ties, frozen matching snapshots, updates targeting an earlier planned insert, repeated target decisions, source and visit-ID conflicts, ordered suggestion replacement, restaurant optional-field preservation, deterministic 23/25-hour DST days, the exact 30-minute overlap boundary, late-trigger rollback, a real two-connection WAL recheck, and the deferred-transaction writer-lock interleaving.

At the 256-input provider shape, calls fell from **709 to 10 (98.590%)**, but median local Node/SQLite time was effectively neutral at **5.516 ms versus 5.543 ms (0.995×)**. At 1,000 inputs the candidate reduced **34.504 ms to 30.777 ms (1.121×)**; at 5,000 it reduced **1,288.488 ms to 1,097.705 ms (1.174×)**, with exact snapshots and 5/5 paired wins at both larger scales. It was slower below 1,000 inputs, and its JSON parameter payload is larger. These are file-backed Node/V8 SQLite measurements that exclude Expo bridge/scheduling, Hermes, provider fetch and matching, award lookup, merge work, rendering, and signed-app RSS. Aggregate report SHA-256: `f5b26f61e423ad6ef4cf6319a0b2f860950698547fe253a9bb86e0b7def49cb7`.

## Batched Provider Award History

Provider import and review now resolve Michelin award-at-visit values in bounded batches instead of launching one database query per matched reservation. Exact Michelin IDs are deduplicated within the same device-local visit year, encounter order and per-input outputs are preserved, and groups are capped at 1,000 IDs. A provider-only throwing reader distinguishes legitimate all-null history from database failure; only rejected batches fall back to per-ID reads, globally limited to eight concurrent requests, retaining the former failure isolation without creating an all-null retry storm.

```sh
pnpm test:reservation-award-batching
pnpm profile:reservation-award-batching
```

The focused suite covers zero-query unmatched inputs, duplicate and leading-zero IDs, malformed Michelin IDs, cross-year reuse, Los Angeles DST and local/UTC New Year boundaries, `NaN` timestamps, 1,002-ID chunking, empty and null awards, 1,000-ID all-null success without fallback, rejected-batch concurrency and per-ID failure isolation, output order, and both production call sites. In the deterministic 139-visit shape, SQL queries fell from **102 to 15** and median file-backed Node/SQLite work from **1.553 ms to 1.239 ms (1.254×)**. At 256, 1,000, and 5,000 visits, measured speedups were **1.543×**, **1.601×**, and **3.239×**; the batched path won all 7 pairs at every scale. The benchmark recreates the former `Promise.all` fan-out and cached-database-promise yield, but synchronous `node:sqlite` cannot reproduce Expo's asynchronous queue. Its synthetic 15-year fixture also excludes guide initialization, provider fetch and spatial matching, persistence, merge work, and UI. Aggregate report SHA-256: `1f8d2e252eb8fc379d043f85c5cdcc3b126868f5ec93b20a4243a110b88fb9a0`.

## Provider Location Preparation and Replay Control

OpenTable and Tock review now resolve unique nonempty place-query strings with four bounded workers instead of one serial lookup per reservation. A successful result is shared across exact duplicate queries; an empty or rejected first attempt deliberately gives later duplicates independent bounded attempts so a transient failure cannot poison the group. Input order, direct-coordinate bypass, query construction, Google-first/first-result selection, local Michelin fallback, provider-address precedence, and unresolved behavior remain unchanged. Located review records retain their coordinates through approval, eliminating the second geocode pass.

The browser bridge rejects identical pending/completed payload replays and ignores stale async completions. Tock additionally caches only a nonempty complete capture: later polling deliveries repost it without GraphQL. A known-count short page posts retry status without reservation data, keeping the WebView mounted until a complete retry succeeds.

```sh
pnpm test:provider-reservation-location
pnpm profile:provider-reservation-location
```

The isolated suite includes a literal sequential oracle, transient reject/empty recovery, query-collision and address cases, concurrency bounds, review-to-approval reuse, replay generations, and an executed VM harness for the production Tock bridge. At 139 inputs with roughly 50% duplicate queries, place requests fell from **111 to 60** and deterministic latency units from **780 to 114 (6.842×)**. At 256/50%, requests fell from **204 to 108** with **7.186×** modeled critical-path speedup. At 1,000/90%, they fell from **800 to 125** with **23.278×** modeled speedup. Three complete Tock deliveries require **6 to 2 GraphQL requests (-66.667%)**; a short-first recovery needs **6 to 4** and never exposes the partial payload. These are deterministic request/latency models with fake lookups, not real network timing. Aggregate report SHA-256: `4e438efaa936bb582a596654291a52b2d94b471c66ace691a2d48ff76ea13530`.

## Provider Review Snapshot Prefilter

Provider review no longer loads and repeatedly scans the complete confirmed-visit history before showing import candidates. One deferred read transaction uses JSON1 inputs to fetch exact source/dismissal/fingerprint facts and only compact confirmed rows on requested device-local days. The exact legacy normalization, fuzzy-name, local-day, and orphan-source rules then run over that bounded snapshot. Review cards deliberately leave award-at-visit empty, avoiding historical-award queries before approval; the actual import path still resolves awards in batches.

After provider location work, unresolved candidates receive a fresh selective snapshot and located candidates retain the richer overlap recheck. This closes both sides of the concurrent-commit window without returning to a full-history scan.

```sh
pnpm test:reservation-review-prefilter
pnpm profile:reservation-review-prefilter
```

The focused oracle covers DST-local days, source/fingerprint/dismissal precedence, legacy confirmed and orphan mappings, restaurant-ID plus normalized/substring/word-name matches, scale and query plans, and a real two-connection WAL commit that occurs between the initial snapshot and a null location result. At the 139-candidate shape, one snapshot fell from **6 queries / 6,498 rows / 1,173,797 bytes** to **2 queries / 155 rows / 25,051 bytes**, with exact output and median modeled work falling from **108.527 ms to 0.887 ms (122.387×)**. At 5,000 candidates it fell from **23 to 2 queries**, removed **19,646,365 local-date comparisons**, and measured **3,882.978 ms to 11.287 ms (344.037×)**. These are synthetic file-backed Node/V8 SQLite timings; they exclude Expo scheduling, provider APIs, Photos, Calendar, rendering, the conditional fresh unresolved snapshot, and the intentionally preserved post-location overlap query. Aggregate report SHA-256: `1b43d29092b24dd3bb4c5a777497cd7be26cd528f4d3b0a2013559bd339aa9f4`.

## Set-Based Michelin Import

Production now contains both the legacy full-row JavaScript importer and a guarded native-SQLite strategy that opens the content-addressed guide through an immutable, read-only URI and performs one `ATTACH` plus set-based `INSERT ... SELECT` upsert. The strategy is resolved before work begins; after the set-based path is selected, a failure is terminal for that process rather than being replayed through the legacy writer after an ambiguous commit. Dataset version and runtime attestation are committed in the same transaction.

The bundled guide is copied through a `.partial` file, checked against the bundle's MD5 before publication, atomically moved into Documents, and checked again when reused. The dedicated Expo SQLite connection requires the app's explicit `SQLITE_USE_URI` build flag, while the existing spatial triggers retain `SQLITE_ENABLE_RTREE`. Post-commit detach or close failures are surfaced as terminal errors so a restart can reconcile the committed dataset marker.

The isolated production-core tests and profiler are:

```sh
pnpm test:michelin-import-core
pnpm test:michelin-import-production-wiring
pnpm test:michelin-import-prototype
pnpm profile:michelin-import-prototype
pnpm test:macos-michelin-import-harness
pnpm test:macos-michelin-import-summary
```

The final immutable real-guide report preserved exact parity from **28,787 source rows to 28,785 valid imported rows**, including metadata and the production R-Tree; the complete restaurant/metadata/R-Tree digest is `91ddd471a6da4880b712c436ea9bde417d1036be010ed7b0756c0712200c8e43`. Across six counterbalanced pairs, median total time fell from **270.677 ms to 224.702 ms (1.2046×, 16.985%, 45.974 ms saved)**, and every paired sample favored the set-based path. It eliminated **28,787 modeled result rows, 34,031,921 result bytes, 287,848 bound values, and 27 statements** while both paths produced the same **8,858,000-byte destination WAL growth**. Aggregate-only report SHA-256: `f0a7ddd77985cc11d7480d893be5fc3bffa74a2c8823975f19842bc9077deeae`.

That timing is an isolated Node/V8 SQLite measurement even though it imports the SQL shared by production. The signed validator separately guards and restores the real app database, verifies the running Release executable/bundle/guide, checks the materialized guide byte-for-byte, and compares every active restaurant field against an independent legacy-semantics oracle using exact IEEE Float64 coordinate bits. Its reports contain only aggregate counts, hashes, timings, and memory data:

```sh
zsh scripts/validate-macos-michelin-import.sh \
  --app="$HOME/Library/Developer/Xcode/DerivedData/Build/Products/Release-iphoneos/Palate.app" \
  --database="$HOME/Library/Containers/<palate-container>/Data/Documents/SQLite/photo_foodie.db" \
  --output-prefix="$PWD/.build/michelin-import-signed" \
  --strategy=attach-insert-select-v1 \
  --manual-launch
```

## Michelin Suggestion Index Projection Performance

The shared production suggestion-index loader now materializes only the three fields consumed by `MichelinLocationIndex`: `id`, `latitude`, and `longitude`. Production, the parity test, and the immutable profiler all import the same `ACTIVE_MICHELIN_SUGGESTION_LOCATIONS_SQL` and exact policy constants, preventing the measured query or workload from drifting from the app:

```sql
SELECT m.id, m.latitude, m.longitude
FROM michelin_restaurants m
JOIN app_metadata metadata
  ON metadata.key = 'michelin_dataset_version'
 AND m.datasetVersion = metadata.value
```

The measured baseline uses the exact former SQL shape—including the same literal `metadata.key = 'michelin_dataset_version'` predicate—and changes only the projection from `m.id, m.latitude, m.longitude` to `m.*`. The baseline and candidate therefore differ only in the columns materialized and transferred.

The production constants are a **200-meter** nearby-suggestion radius, a **100-meter** primary-match radius, and a maximum of **5 suggestions** per visit. Full Michelin rows remain available to the separate hydration paths that render restaurant details; they are no longer carried into the long-lived spatial suggestion index.

Run the isolated production-seam test and immutable real-database profile with:

```sh
pnpm test:michelin-suggestion-index-projection
pnpm profile:michelin-suggestion-index-projection -- \
  --database="$HOME/Library/Containers/<palate-container>/Data/Documents/SQLite/photo_foodie.db" \
  --samples=11 --warmup=3
```

On this Mac's immutable **28,785-row** active guide, the profile searched all **6,511 valid persisted visit centroids** and reproduced exactly **5,141 suggestions** and **1,180 primary suggestions**, including IDs and distances. The three-column projection reduced the modeled JSON-structural payload by **78.614%**. Median load time fell from **22.062167 ms to 8.190750 ms (2.6935466×)**, while median load/build/search total fell from **69.780333 ms to 51.080167 ms (1.3660945×)**; the projection won all **11/11** counterbalanced pairs. The database main/WAL/SHM/journal set, `total_changes()`, and `sqlite_sequence` remained unchanged. The aggregate-only report SHA-256 is `492726ec6ddca9e3cee9167d5662db5d7b0c5d28bc2948a2fddca65f2da4c78b`.

These are isolated Node/V8 `node:sqlite` timings. They exclude Expo SQLite scheduling and native-to-JavaScript serialization, Hermes and React Native effects, suggestion persistence, and UI work. The workload deliberately searches every valid stored centroid for repeatability; normal production work is limited to pending visits during a version refresh and newly created visits during scanning. This profile therefore proves exact projection parity and an isolated data-loading win, not signed-app or end-to-end latency.

## Unicode Michelin Name Search

ASCII Michelin queries keep the existing SQLite path. Normalized queries that still contain non-ASCII text now load an active-dataset `{id, name}` projection, reuse a versioned in-memory `{id, name, lowerName}` index, apply the exact JavaScript Unicode substring and locale ordering rules, then hydrate at most 50 ordered winners through JSON1. Hydration rechecks the active dataset and confirmed-visit exclusion. A version-before/version-after guard discards a result if the guide changes between indexing and hydration and retries once; abort checks prevent stale requests from publishing. Static initialization is represented by a QueryClient entry, so `queryClient.clear()` correctly forces reinitialization, and inactive versioned indexes are retained until cache reset. A version change selects a new key; an in-flight mismatch also removes the attempted stale key. The UI issues cancellable Michelin lookups without an artificial debounce and keeps the previous result rendered while the next query reconciles.

```sh
pnpm test:michelin-name-search
pnpm profile:michelin-name-search
```

The suite covers composed/decomposed Unicode, normalization back to the ASCII route, exact ordering and limits, active/historical rows, exclusions, pre-aborted and post-hydration cancellation, concurrent initialization, cache clear/reinit, inactive collection beyond five minutes, continuous version churn, and a real same-ID rename during hydration. On the immutable **28,785-row** guide, the input projection is **3,737 rows / 187,259 bytes** rather than **28,785 full rows / 8,917,897 bytes (97.900% fewer projected bytes)**; the retained lowercased index models **303,755 JSON bytes**. Broad `é` search measured **27.595 ms** for the former full transfer, **6.703 ms** cold (**4.117×**), and **1.565 ms** warm (**17.636×**). Selective `épi` measured **27.799 ms**, **5.225 ms** cold (**5.320×**), and **0.265 ms** warm (**104.868×**), with exact ordered-result hashes throughout. A historical three-keystroke debounce model reduced three full searches and **26,673,315 modeled native-to-JavaScript JSON bytes** to one logical search, four SQLite calls, and **195,721 modeled bytes**, but it is no longer the production input policy. These are Node/V8 SQLite and cache models, not signed-app input-latency measurements. Aggregate report SHA-256: `ec02258e9ea675a7e42be15d3b6232d13df972751948b8e2a49a7c84ba86f537`.

## Michelin Map Viewport Performance

The Michelin Map no longer transfers the complete active guide and builds a JavaScript KDBush before it can show the default view. SQLite now applies active-dataset, award-year, visited, award, and exact viewport predicates over the persistent Michelin R-Tree, ranks a bounded prefix, and hydrates only rows that can be rendered. The default Visited path starts from confirmed restaurant IDs, so an empty confirmed set returns without walking the guide. JavaScript retains the existing Mercator, award, visited, locale-aware name, source-order, antimeridian, and top-500 oracle. A 32-row native cushion protects that final ordering from small SQLite/Hermes math differences; a score group crossing the 500-row boundary is expanded on one native WAL snapshot.

Camera updates are trailing-debounced by 120 ms. Query keys use the exact camera and layout values, inactive viewport snapshots stay warm for 30 seconds to make quick back navigation seamless, and visit-status mutations invalidate the viewport cache. Previous markers remain visible while a query settles, and the visible filter controls advance with the resolved snapshot so markers never disagree with the filter shown to the user. This avoids rounded-key cache collisions without retaining hydrated camera snapshots indefinitely.

Run the isolated parity suite and profiler with:

```sh
pnpm test:map-viewport-query
pnpm profile:map-viewport-query
pnpm profile:map-viewport-query -- \
  --database="$HOME/Library/Containers/<palate-container>/Data/Documents/SQLite/photo_foodie.db" \
  --samples=7 --warmup=1
```

The test covers every visited/award filter combination, active and historical datasets, inclusive and antimeridian bounds, invalid coordinates plus valid `0,0`, exact full-field/order parity, an ordinary 532-row overscan, a 530-row Unicode/source-order boundary tie, malformed native rows, request immutability, and zero writes.

On this Mac's immutable **28,785-row** guide with zero confirmed Michelin restaurants, the viewport subsystem's initial Visited request improved from **25.448 ms to 0.218 ms median (116.73×)** and reduced the modeled SQLite result payload from **28,785 rows / 9,176,964 bytes** to **0 rows / 2 bytes**. A deterministic 28,785-row fixture with **1,515 confirmed IDs** improved from **23.685 ms to 5.960 ms (3.97×)** while reducing payload from **30,300 rows / 8,152,340 bytes** to **532 rows / 188,203 bytes (97.69% fewer bytes)**. These are viewport-subsystem Node/SQLite measurements: both real screens still load the common confirmed-restaurant query, and the model excludes Expo bridge transport, React Query scheduling, rendering, and MapKit.

The deliberately baseline-favorable 22-event camera/filter trace tells the other side of the tradeoff. Its cached-per-filter JavaScript indexes measured **93.522 ms**, while one normal native result query per event measured **226.521 ms**. The native path still transferred **86.13% fewer bytes**, retained at most 1,032 primary row proxies versus 49,483, and the production UI's trailing debounce suppresses continuous-pan query storms. This optimization is therefore an initial-load, bridge-payload, and memory win; it is not a claim that repeated isolated SQLite viewport queries beat an already-built in-memory index. The aggregate-only immutable report SHA-256 is `279bf603038fe7f3a90bf8c81a566376c1035df42e08d0745a9d32d4b9b4c748`.

A fresh signed Release then passed read-only integration on **My Mac (Designed for iPhone)**. With the live Photos/Calendar-backed database, default Visited rendered no pins as expected; switching to All rendered real Michelin markers, and List rendered hydrated names, cuisines, locations, awards, and visit state. The launched wrapper exactly matched executable SHA-256 `4a5757e775613175178a82d99ab769af96a126cedf8d60176da0a6891b83df6c` and `main.jsbundle` SHA-256 `ccae1a4c6968a53644e043c15376ff2e4a5d7081acdd7a6701f3aeda1e34e0db`; strict code-signature validation passed with CDHash `58c95510e47b57b885765598038afcc888e813a6`. After the UI check, the database main/WAL/SHM set was restored byte-for-byte, integrity returned `ok`, and foreign-key violations were zero.

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

The expensive pending-review cache now lives outside the general `visits` key family. Successful confirm/reject operations keep their exact optimistic removal visible, mark that result stale without refetching it, and still invalidate the smaller status-derived caches. The status database phase is serialized while queued optimistic removals paint immediately. A shared pre-group rollback baseline preserves both visit and exact-match order, successful IDs cannot be resurrected by a later same-ID failure, and a refresh that starts during a mutation is canceled and reconciled after the write. Errors and Undo perform an exact canonical Review refresh; restaurant-name edits, Michelin guide refreshes, photo/merge/suggestion partial-failure paths, rescans, and food detection explicitly invalidate the Review key.

The focused QueryCore contracts cover production-shaped visits and exact matches, stable different-ID rollback, same-ID success/failure ownership, immediate optimism with serialized mutation functions, a late pre-write refresh, stale marking without an active fetch, explicit active/inactive refresh, and isolation from unrelated keys. The earlier six-mount profile reduces materializations from **6 to 1**. On the current **6,511-row, 7,883,042-byte** Review shape, the new ten-action structural model measured **51.693 ms to 9.305 ms median (5.555×)** with 7/7 paired wins, avoiding **10 hydrations, 65,110 parsed rows, and 78,830,420 bytes** per trace while retaining exact final-ID parity. Report SHA-256: `30910499c14270dac13166ee22e94938404a91133ef816c937bb7a64a8ecfbb2`. These are Node/V8 QueryCore and exact-size JSON timings, not Expo SQLite, bridge, Hermes, rendering, Photos, or Calendar timings.

Review now uses the progressive path in production. One compact global manifest preserves exact-match detection, filter membership, counts, and ordering before any heavy card rows are fetched; `FlashList` then hydrates deterministic 128-row pages through one `json_each(?)` bind each. Exact confirmations remain global, so Approve All is correct even when most cards have not been loaded. Optimistic confirm/reject/batch mutations update every cached filter generation, and selective rollback restores only failed IDs without resurrecting independent successes. Quick Actions now has a separate slim all-row projection containing only the IDs, counts, food state, match candidates, Calendar title/time, top-five labels, and confirmation coordinates its bulk actions consume. It deliberately retains the same root Query key, so the existing optimistic removal and rollback contract applies to both screens while Review detail pages remain descendants.

Legacy, manifest, and page queries share the explicit suggestion order `distance ASC, Michelin ID COLLATE BINARY ASC`. A real-database audit found that implicit aggregate order previously disagreed for 997 of 6,511 visits and could select a farther duplicate-name branch for three exact confirmations; the shared order reduces those mismatches to zero. Focused fixtures now force ID order to oppose distance and verify the nearer ID, coordinates, rendered order, exact-confirmation identity, and all four filter combinations.

On the immutable current-Mac snapshot, the production bootstrap—including manifest SQL, strict parsing, global title matching/filter planning, and the first 128 heavy rows—fell from **56.144 ms to 24.622 ms median (2.280×)**. The compact manifest plus first page transferred **1,118,789 bytes** versus **7,883,042 bytes** for the monolith, while retaining all 6,511 global manifest items and selecting 276 exact plus 330 filtered-manual visits under the default on/on filters. The database and sidecars remained byte-identical; aggregate report SHA-256: `dbfadd1d3194404abf4d725465c86e389ec214f8e4d3423dccdf52616b955419`. These are Node/V8 `node:sqlite` timings and exclude Expo scheduling, Hermes, bridge conversion, and rendering.

The independent Quick Actions oracle reproduced all **6,511 pending visits**, **276 exact matches**, and every food/unmatched/threshold action count. Its slim projection reduced JSON-equivalent payload from **7,883,042 to 2,241,436 bytes (71.566%)** and median query/transform work from **67.650 ms to 32.323 ms (2.093×)**, winning all 9 paired samples. The immutable source and sidecars remained byte-identical. Aggregate report SHA-256: `1d64647e085c92fbe6d5ae108e857feda4a05ceb67804aaf1f0603e6d61da43c`. This includes Node/V8 SQLite, row conversion, JSON parsing, food-label reduction, and Calendar title matching; it excludes Expo scheduling, the native bridge, Hermes, and rendering.

## Confirmed Restaurant Modal Search

The visit restaurant-search modal no longer subscribes to the full home-card query while it is hidden. A child query under the existing `confirmedRestaurants` cache root loads only ID, name, coordinates, address, cuisine, visit count, latest visit time, and current award, and it is enabled only while the modal is visible with non-whitespace input. Matching remains the exact JavaScript `toLowerCase().includes()` behavior, while the existing similarity ranking and same-name Michelin replacement remain unchanged. Parent-key invalidation keeps the projection consistent after visit and restaurant mutations.

```sh
pnpm test:confirmed-restaurant-search
pnpm profile:confirmed-restaurant-search
```

The independent literal oracle covers confirmed-only membership, visit counts, current awards, non-ASCII matching, source ordering, query gating, production wiring, and TanStack parent-key invalidation. On a 1,200-restaurant synthetic fixture, the closed and open-blank states each fell from **one 1,200-row / 828,734-byte query to zero work**. Typed search retained exact results while reducing modeled bridge bytes to **263,274 (-68.232%)** and median SQLite/transform time from **9.153 ms to 1.878 ms (4.873×)**. This excludes Expo bridge scheduling, Hermes, and rendering; it is not a signed-app latency claim. Aggregate report SHA-256: `c99f0acd6d7b20199fafa7f8f6d711a9786b51c0ff357cfc5ede44f7b3306be0`.

## Progressive All Visits List

All Visits now requests a 128-row slim page instead of materializing every visit and unused detail column before `FlashList` can virtualize anything. Each row contains only the card's ID, names, status, time, photo count, food state, Calendar title/all-day flag, and three preview URIs. Pages use stable `(startTime DESC, id COLLATE BINARY DESC)` keyset continuation with one lookahead row and the existing visit-time/status/food plus preview indexes. The stats query remains the authoritative source for filter counts, so the header shows complete totals before the user reaches the final page.

Infinite pages remain fresh until an explicit local mutation. Status, food, Calendar, guide-import, and broad pull-to-refresh paths reset visit-list queries before refetching, which collapses an active list to page one and clears inactive pages rather than sequentially refetching every retained page. In-flight continuation requests are canceled during reset; guide imports also prevent indefinitely cached null or old Michelin names.

```sh
pnpm test:visit-list-paging
pnpm profile:visit-list-paging
pnpm profile:visit-list-paging -- \
  --database="$HOME/Library/Containers/<palate-container>/Data/Documents/SQLite/photo_foodie.db" \
  --filter=all \
  --output="$PWD/.build/visit-list-paging-all-real-profile.json"
```

The literal full-query oracle covers all five filters, page sizes 1 through 1,000, zero/exact/lookahead boundaries, fractional timestamps, equal-time ties across pages, Unicode and quoted IDs, missing joins, malformed preview JSON, preview ordering, and query plans. QueryCore tests cover active, inactive/refocus, broad-refresh, Michelin-import, and in-flight reset behavior. The executable profiler contract separately rejects direct, symlink, dangling-symlink, and hardlink aliases to main and every SQLite sidecar, rejects nonempty WAL/journal inputs and symlink sources, requires aggregate-only mode-`0600` output, and proves the source main/WAL/SHM/journal identity unchanged.

On this Mac's immutable **6,511-visit / 68,028-photo** database, the All filter reproduced the complete ordered slim output and exact 128-row prefix. Initial work fell from **6,511 rows / 4,525,164 JSON-equivalent SQLite-row bytes** to **129 rows including lookahead / 46,046 bytes (-98.982%)**. Median query plus production parsing fell from **37.044 ms to 0.551 ms (67.265×)**. A complete 51-page slim traversal measured **23.658 ms (1.566× versus the eager path)** while transferring fewer fields, but bootstrap—not forced full traversal—is the production goal. Pending measured **69.615×** on the same 6,511 rows; Food reproduced 1,020 rows and improved **8.030 ms to 0.712 ms (11.282×)** while reducing bytes from **765,362 to 52,187** for the first page. Confirmed and Rejected were empty in this snapshot, so those reports establish parity and index-plan behavior rather than populated-filter speed.

The profiler holds one immutable read transaction for deterministic full-traversal parity; production pages are independent snapshots and rely on the tested mutation resets. Timings exclude Expo scheduling and serialization, the React Native bridge, Hermes, rendering, Photos, and Calendar. All five aggregate reports are private mode `0600`; SHA-256: All `5403818fdc1b82898d631a080c9ffc906baf733ba61e916bd422f0ba61b5fac0`, Pending `4accdc41c737b58dc08f1e367259486139b14a9a19a12fe5a7d24a8d5d2623bd`, Confirmed `e04f3843013e214eabef59e38d20588d63839f648c73dbc087724c8b7a276e08`, Rejected `377ea807b83e5724e88322f6e3eb3dad4bbd0eb0892cfda9958c20d8364b3f09`, and Food `b513b359121bf524a4563a1d5f98106a368ba711ebaff3dd2d91973bf27d5353`.

## Wrapped Stats Query Performance

The all-time Wrapped Stats path now computes every yearly total and each year's top restaurant in one CTE/window query instead of issuing one follow-up query per year. The five Michelin-award queries are likewise one materialized-CTE query, with JavaScript retaining the legacy award classification rules. On the current 15-year data shape, the yearly phase falls from **16 SQLite calls to 1**, the Michelin phase from **5 calls to 1**, and the complete all-time request from **39 calls to 20**. A selected-year request falls from **23 calls to 19**. Equal-count yearly winners now use `restaurantId ASC` as a stable final key rather than depending on SQLite's chosen query plan.

`test:wrapped-stats` compares the yearly production query with an independent literal legacy oracle across indexed and unindexed plans, focused null/orphan/status/UTC/Unicode cases, and 48 randomized fixtures. Defined counts, ordering, and null behavior match exactly; any changed legacy name must be one of multiple equal-count winners. `test:wrapped-stats-michelin` independently executes the literal five-query oracle and covers empty, null, Unicode, multi-label, historical-award, orphan, and status cases in two index modes plus 48 randomized fixtures. It also parses the production source to prove that every database call remains in the single `Promise.all` plan and that the complete plan contains exactly 20 all-time or 19 selected-year calls. Both profiles reject source/output main-file and SQLite-sidecar aliases through direct, canonical, symlink, and hardlink paths.

The read-only Mac-derived profile retained all **6,511 real visit timestamps** across **15 UTC years**, replaced identifiers and names in memory, and never wrote to the source database. One warmup plus seven counterbalanced pairs measured **21.712 ms to 11.493 ms median (1.89×)** for the isolated yearly phase, saving 10.219 ms. All defined semantics matched; five displayed winner names changed only where multiple restaurants had the same maximum count. The source SHA-256 remained `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`, integrity remained `ok`, and the anonymized report SHA-256 is `fa5c8d8c1f1abb47923c9ebf0188e2ed78c171d81388bf2b2443082a068629db`. These Node/V8 in-memory SQLite timings include statement preparation, execution, row decoding, and yearly hydration, but exclude Expo scheduling, the React Native bridge, and rendering.

The separate Michelin profile retained all **6,511 real timestamps** and the full **28,785-row guide**, then built an in-memory confirmed workload using direct suggestions, nearest suggestions, and a deterministic guide fallback so all 15 reported metrics were exercised. Across nine counterbalanced samples, all-time Michelin work fell from **23.557 ms to 9.255 ms median (2.55×)** and the representative 2025 query from **9.207 ms to 2.494 ms (3.69×)**, with exact parity to the literal oracle. The source was opened through an immutable read-only URI in one read transaction after rejecting a nonempty WAL, and its main file and sidecars remained unchanged. The aggregate-only report SHA-256 is `0291019f8c48f04e83ca0950e3c920b071ef3e6caaf007b58d71f71da7ceeeed`. These are isolated Node/V8 SQLite timings, not end-to-end screen timings.

The separate macOS fixture selects one real visit for each year from 2012 through 2026 in a disposable database copy. It retains **2,304 attached photo rows and 11 Calendar-linked visits**, produces an independent all-time/2025 oracle, and requires complete schema/table multiset parity after the read-only Stats session. `test:macos-wrapped-stats-harness` covers success, stale visual timestamps, semantic mutation, signal recovery, and rejection of a mismatched Xcode-launched executable or JavaScript bundle before `READY`; every case restores the database and launch environment byte-for-byte. It verifies `sqlite_sequence`, persisted pragmas, and all table multisets, rejects any sampled nonzero WAL, removes raw fixture/oracle intermediates, and retains only aggregate report data.

A final signed Release containing both Stats consolidations, the zero-write keyword sync, and the Calendar guide projection was launched through Xcode on **My Mac (Designed for iPhone)**. The harness attested executable SHA-256 `d0ce57f9c7b0585a66939082cc2f649ce9cc76b4858c561e7b9cdf01b602e207` and `main.jsbundle` SHA-256 `3f0a0b75a9d7279e5fe54e35ac1f8273f3cff8b2320d6c60af0a9c4037e831cc`. The visible all-time screen matched 15 visits, 45 stars, and one restaurant; the selected 2025 screen matched one visit, three stars, and one restaurant. The independent oracle additionally verified 2,304 all-time photos, a 153.6 average, one map point, and 831 photos in 2025. Every 50 ms sample observed a zero-byte WAL, the prepared/result databases were byte-identical, all 13 tables including `sqlite_sequence` matched, and the live database was restored byte-for-byte to SHA-256 `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`. The aggregate-only report SHA-256 is `e8fba14ac442f91daaff00bb91d59797c302eb85f7968f90c6d8da75fa247b95`. Its 32.758-second trigger-to-ready interval includes manual UI work and is integration evidence, not an app timing result.

Wrapped Stats is hardwired to the original `eager-v1` screen. The experimental `FlashList` UI and its deferred native-map placeholder were removed because recycled-section animation, local expansion state, and perceived tab smoothness remained unresolved. Its deterministic structural profile is retained only as historical evidence: it modeled initial work falling from **14 mounted sections / 579 dynamic rows or markers / one eligible native map** to **4 / 19 / zero** (SHA-256 `d59ebb0d0aa6c64a1a07c5cda4b7166f26547cc65b6e1c4cdccb019209b02f67`), but that was a structural count rather than latency or memory evidence. The existing signed eager run grew from 483,616 to 620,128 KiB RSS and reached 124.7% sampled CPU. A virtualized Stats UI now requires a new UI-focused implementation rather than a build-time switch.

## Startup Food-Keyword Sync

Database initialization now inspects all 58 bundled food keywords once and returns without opening a transaction when the rows are already healthy. Actual repairs re-read under an exclusive transaction, update only defaults that are no longer marked built-in, and insert only missing defaults; disabled state, creation timestamps, row IDs, and unrelated user keywords are preserved. A failed insert rolls the entire repair back.

`test:food-keyword-sync` covers first install, a byte-stable steady-state rerun, missing and misclassified repair, disabled/user-row preservation, injected rollback and retry, and a real two-worker/two-connection WAL race. In the race, both workers observe the same defect before competing for the writer lock; one performs the repair and the other re-reads to a zero-write result without a uniqueness failure. The same no-write path was also run against an isolated copy of this Mac's database: it performed one read, no transaction or writes, kept `sqlite_sequence` at 232, left the WAL empty, and kept the main file byte-identical at SHA-256 `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`.

Across seven counterbalanced samples of 500 steady-state reruns, the isolated benchmark improved from **31.864 ms to 21.303 ms median (1.50×)**. More importantly, one legacy rerun added **58 total changes, 58 sequence IDs, and 8,272 WAL bytes** despite changing no row values; the optimized rerun added **zero** of each. The report SHA-256 is `4a7dad8f8e9a12f344f70cc7dbba782540dc6f58d733cf0cf629597de70fd558`. The timing is Node/V8 SQLite evidence; the write-elimination invariant is the startup-relevant result.

## Adaptive Visit Food Detection

Visit food detection now exposes a guarded native/JavaScript strategy selector. New native builds with no environment override default to `rank3-bulk-tail-v1`; an invalid explicit native override fails safe to the literal `full-plan-v1` path, and older binaries whose exported strategy is missing or invalid also retain `full-plan-v1` in JavaScript. An explicit environment override can still select either strategy. The adaptive path uses three sample-rank waves, each durably checkpointed before the next rank is planned, followed by one stable visit-major rank-4-and-later bulk tail for visits still without a positive result. It loads keywords once, uses the existing bounded Vision pipeline and one shared persistence lifecycle, then synchronizes derived visit flags once. Missing or native-failed results remain retryable; photos skipped only because their visit already became positive are never written as false. Explicit user-initiated Deep Scan remains a separate full supplied-or-pending-photo operation outside the guarded validation mode.

`test:visit-food-adaptive-scan`, `test:visit-food-detection-strategy`, and `test:visit-food-detection-orchestration` cover positive-set parity, stable ordering, missing/error behavior, checkpoint durability, latched persistence failures, terminal progress, native strategy resolution, promoted defaults, and older-binary fallback. The retained private current-control model contains **6,511 visits and 13,059 planned attempts** with **1,020 positive visits**. A fully rank-by-rank schedule would save more attempts but expand to 173 modeled native calls, so it was rejected. The bounded three-rank design preserves the existing **14 modeled calls** while reducing attempts to **11,439**, avoiding **1,620 (12.405%)** with exact positive-visit parity.

A signed real-library three-pair validation used executable SHA-256 `3a40186747dd75d16d21d29fae34ba9e4a4159eb97d306c1a7a84fcb13ea4c57`, `main.jsbundle` SHA-256 `f31f7cca98192cb58f5505dbf16b3c3a3639e894712c5900a12d66fc2cd78a1d`, the same 13,059-photo fixture, 1,000-result lookahead pages, Vision concurrency 2, and pipeline depth 4. Full-plan durable tails were **49.823970, 52.333681, and 51.143741 seconds**; adaptive tails were **43.524547, 43.044092, and 43.149852 seconds**. Adaptive won all three positional pairs and reduced the median from **51.143741 to 43.149852 seconds (-15.63%, 7.994 seconds)** while avoiding 12.405% of direct native requests. Median sampled peak RSS increased from **588,224 to 633,984 KiB (+7.78%)**. Every included run attested balanced schema-2 native work, exact strategy/visit semantics, a strict signed-build identity, a fresh trigger boundary, clean SQLite integrity, and byte-exact restoration of the live database. Aggregate-only summary SHA-256: `342c0cb8e9a85e79084ebda7bd87064b24404545e8259e4c02608cad1fdbe80e`. This repeatable result promoted `rank3-bulk-tail-v1` to the production default.

The post-promotion Release then rebuilt and passed strict signature validation with executable SHA-256 `11d86b3a47db25c9eedd05d07ff0c9ba8d710b8a6b6bee1a98519bc2e01938f8`, `main.jsbundle` SHA-256 `b28419530a518a394b7aa1fa8da353deee44100b4d27a2a299a75fd0b76fb003`, and CDHash `313086a7eabcab59755e2379fd8037ff32874036`. Those hashes are compile/sign evidence for the promoted default; the controlled real-library timing evidence remains the three-pair build identified above.

## Opt-In Thumbnail Preheating

The native PhotoKit thumbnail store retains a bounded windowed preheater for isolated profiling, but no production screen currently drives it. The visit-detail producer was removed after it added focus, AppState, viewability, and synchronous bridge work to a navigation-sensitive screen; setting `PALATE_PHOTO_THUMBNAIL_PREHEAT_STRATEGY=windowed-v1` alone therefore does not enable speculative UI work. The native implementation and pure planner remain available for future measured experiments, while the visit-detail grid issues only visible thumbnail requests.

`test:photo-thumbnail-preheat` covers ordered overlap, key and byte limits, asset-level normalization, stale leases, out-of-order fetches, missing assets, generation invalidation, render replacement, exact PhotoKit option parity, bridge caps, older-binary fallback, retained/clamped producer windows, invalid-plan cleanup, and production-UI dormancy. The fetch scheduler allows at most one physical asset fetch, replaces queued speculative work with the latest bounded window, promotes visible demand ahead of preheat work, shares in-flight requests, and reconciles cancellation and generation invalidation; deterministic scheduler tests validate that the previously observed speculative backlog cannot recur. A first real-Photos diagnostic confirmed the mechanism, but its candidate preheat began before the lead timer and continued through an untimed metrics interval. Its former lead-plus-target percentages are superseded and must not be used as end-to-end evidence. The historical mechanism-only report SHA-256 is `b34fb445b24ab20b84609c93974f0e20474aefd3faa6872a92b82644d5808eda`; historical summary SHA-256 is `897a9d05662c6835bf7f69bbef4842dc6e491263c9dde16e6f3a38af21423bc9`.

The corrected schema-2 real-library profile at `.build/initial-image-preheat-profile-20260711T0440Z.json` (SHA-256 `1ba8d966c2e39d95310ffb43c3099dfcc77267740cdfa0cdd47623ad03cdefa9`) and summary (SHA-256 `cb8e467739102b450a6c30c3f138c8b934e9fb3f0f2e2f1d56dcb2616254e2d0`) validated all 528 globally disjoint assets with correct results and a quiescent scheduler. For 9 images, the continuous cycle fell from **49.5132705 ms** to **45.805354 ms** (**1.0809494×, 7.4887%**); for 24 images, it fell from **99.052021 ms** to **90.2147085 ms** (**1.0979587×, 8.9219%**). This establishes an isolated initial-window benefit, not a production scroll-cycle win.

`test:thumbnail-scroll-profiler` covers the isolated production-shaped benchmark plan and report without opening Photos. `profile:thumbnail-scroll` is the real-library native mode: it uses globally disjoint, counterbalanced mixed image/video assignments; the exact shared store; four candidate policies; four rapid forward window replacements; strict visible-result parity; ordered per-window digests; the full fetch-scheduler/preheat counters; physical scheduler drain; and sampled resident-memory checkpoints. Defaults model three columns, four visible rows, +3/-1 rows, and 480×480 targets, for which the pixel/byte budget selects at most 18 keys. The 12-iteration report at `.build/thumbnail-scroll-profile-20260711T0445Z-12.json` (SHA-256 `275d53fa5be12cd2979f067783a5fbd817006506fa1e94a10a85b8a08065fbad`) validated all 3,456 globally disjoint mixed image/video assets with correct results and a quiescent scheduler. The production-order current-visible-first policy improved current-window latency by **1.129285×**, but its terminal scroll-cycle ratio was **0.990331×** versus control—about **0.97% slower**, effectively neutral. Ahead-and-behind-first regressed current-window latency by **18.3%**, while future-only regressed the terminal cycle by **15.3%**.

Preheat uses network access because PhotoKit requires caching options to exactly match the later visible load, which currently permits iCloud downloads. A signed Release did render 84- and 201-photo visits without blanks through repeated forward/reverse flings, background/resume, and a cross-display move, while running the attested Release executable and JavaScript bundle. That earlier stress pass also received a macOS critical-memory-pressure notification; the scheduler backlog it exposed is now fixed and deterministically validated. The scroll profiler's same-process RSS is diagnostic only: arm medians were 8–32 KiB, while the first control process contained a 26,968,064-byte warmup peak, so those samples are not promotion-quality memory evidence. Despite the isolated initial-window win, the production-shaped cycle was neutral, and the earlier memory-pressure signal plus speculative iCloud cost remain unresolved. The feature therefore remains off by default.

The next isolated Photos subsystem is the cold visible-card strip. `test:preview-cards-profiler` validates its deterministic plan/report without Photos access, and `profile:preview-cards` runs the native harness against this Mac's real library without changing the production Visits/Review renderers or enabling preheat. Defaults model four visible cards at 1,200×320 pixels with rotating 1/2/3-photo arities, giving 1,200/600/400×320 item targets. Each 12-iteration block independently crosses geometry, recency slot, and execution position for both strategies with globally disjoint, stratified recent image/video assignments.

The baseline is specifically the underlying Expo `PhotoLibraryAssetLoader` PhotoKit request behavior—per-item `PHAsset` fetch plus `PHImageManager.default()` high-quality/fast/aspect-fit at a cover target. The candidate is the shared `PhotoAssetThumbnailStore` opportunistic/exact/aspect-fill path. Reports compare all-strip-renderable and all-final latency, decoded pixels, RSS, and full store/scheduler metrics; strict validation rejects failures, timeouts, stale events, bad dimensions/digests, preheat use, non-quiescence, or raw identifier leakage. This does not claim warm `expo-image`/SDWebImage cache parity. Cancel/resubmit and warm-revisit arms are explicitly deferred.

The corrected real-library report at `.build/preview-cards-profile-commits-20260711T052431Z.json` (SHA-256 `27340641aa3f1b157ed5911d32a413ce710cfc2f8f87d1bad5d4bed6281ce3c4`) covered **192 globally disjoint assets: 168 images and 24 videos**. Every correctness, privacy, mixed-media, counterbalance, preheat-unused, and scheduler-quiescence check passed. Median full-strip renderability fell from **3,027.873 ms to 13.096 ms (231.21×)** because the candidate can display degraded PhotoKit frames, while median all-final completion fell to **912.701 ms (3.317×)**. Candidate final decoded pixels were **27.26%** of baseline. Same-process median sampled peak RSS deltas were 9,674,752 versus 270,336 bytes, but allocator and PhotoKit caches carry across arms, so that memory comparison is diagnostic only. These cold underlying-PhotoKit results justify a future signed UI A/B; they do not authorize replacing the protected `expo-image` renderers or claim warm-cache production speedups.

## Vision Result-Page Performance Validation

Vision classification results cross the native/JavaScript boundary in bounded pages. The production default is **1,000 results per page**, tunable from 1 through 2,000 with `PALATE_VISION_RESULT_PAGE_SIZE`; JavaScript falls back to the legacy 50-result behavior when a binary does not advertise a valid page size. A 1,000-result page aligns with the 1,000-row durable SQLite flush boundary and reduces native calls for the 13,059-photo fixture from 66 at 200 results per page to 14.

Result encoding is independently selectable. The production default remains `legacy`; `PALATE_VISION_RESULT_TRANSPORT=packed-v1` opts a compatible binary into the experimental binary path. JavaScript uses packed V1 only when the native module both resolves that exact value and exposes `classifyImageBatchPackedV1`; an older binary, a missing method, or an absent/invalid value safely selects the legacy method. Once packed dispatch begins, a native rejection or malformed payload fails that page instead of silently rerunning the same Vision work through legacy transport.

Packed V1 is a little-endian, versioned format with a fixed header, canonical first-use UTF-8 string table, one status record per requested asset, and bit-exact `Float32` confidences. Swift sizes and writes one final `Data` buffer and hands it to Expo with `NativeArrayBuffer.wrap(dataWithoutCopy:)`. The TypeScript decoder accepts `ArrayBuffer` or `Uint8Array` views without first cloning the page and strictly checks the magic, version, flags, declared length, slot/request identity, duplicate rules, canonical string use, UTF-8 (including a leading BOM scalar), finite confidences, and trailing bytes before returning results.

The production `lookahead` orchestration starts classification for page N+1 after page N is produced and overlaps it with N's ordered transform/persistence work. Consumption never overlaps, ordering is exact, failures stop later writes, a pending speculative page cannot delay a known persistence failure, concurrent producer/consumer failures are flattened without duplicate identities, and at most two produced pages are resident. `PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY=serial` remains available as a strict fallback. `test:vision-page-orchestration` exercises ordering, rejection, aggregation, and residency invariants. Sequential isolated timer datasets measured **1.28×**, **1.86×**, and **1.26×** median speedups for classification-dominant, balanced, and persistence-dominant delays, respectively; they exclude PhotoKit, Vision, the native bridge, SQLite, and UI work.

The isolated `test:vision-result-pages` suite covers boundary counts, exact ordered reconstruction (including duplicate and missing-asset-like identifiers), the 2,000-result cap, a final partial page, the 1,000-row flush boundary, and an exactly retryable failed write. `profile:vision-result-pages` rotates 200-, 500-, and 1,000-result strategies across the 13,059-row real-fixture shape and a 68,027-row deep-library shape. Its Node/V8 timings cover only page planning, copying, and traversal, so they are structural diagnostics rather than an end-to-end app speedup claim.

`test:vision-result-transport` runs the strict TypeScript decoder/fallback contract and the Swift encoder, runtime resolver, and native-dispatch attestation suites. The independent encoder used by TypeScript tests and profiling lives under `scripts/vision-classification-transport-oracle.ts`; it is test-only and is not shipped in the production bundle. Cross-language golden bytes, duplicate/missing/failure slots, exact confidence bits, Unicode normalization distinctions, malformed inputs, capability fallback, and the no-second-Vision-call failure rule are covered.

`profile:vision-result-transport` opens the real source as immutable, read-only SQLite and retains only aggregate output. On this Mac's 13,059 analyzed rows and 112,672 labels, the modeled legacy nested-JSON payload was **6,435,337 bytes** and binary V1 was **1,661,371 bytes**, saving **4,773,966 bytes (74.1836%)** with exact decoded semantics (SHA-256 `ad091b2bec7a920273f52e111db3ec4bc994eafe93494077df5b13c60328a571`). This is a Node/V8 structural model of JSON/binary construction, decoding, validation, and food transformation. It excludes the shipped Swift encoder, Expo/JSI transfer, Hermes, PhotoKit, Vision, SQLite persistence, scheduling, and rendering; only signed-app runs can decide the end-to-end transport default.

App-level correctness and performance are exercised with a signed Release build running as **My Mac (Designed for iPhone)** against this Mac's real Photos library and Palate database. `scripts/validate-macos-vision-result-page.sh` captures a durable guard containing the exact main/WAL/SHM/journal set before any SQLite access, installs and mutates only a disposable copy, resets the 13,059 previously classified fixture photos, observes the launched process environment, samples durable SQLite progress and RSS every 0.2 seconds, and restores the original set byte-for-byte with its modes. The supplied and running app's strict code signature, executable, and `main.jsbundle` are attested exactly.

The schema-v6 report distinguishes requested process configuration from the transport actually dispatched. After the trigger, native code atomically writes a schema-2 attestation on the first real classification method dispatch and updates its aggregate lifecycle counters through completion; the validator requires the run ID, configured, resolved, and selected transport plus timestamps inside the trigger/completion boundary. Repeated dispatches must keep the same transport. Process-environment observation alone is no longer treated as proof that a native method ran. The primary timing remains the **durable tail** from the first 0.2-second sample that observes durable database progress (after at least one 1,000-row flush) through completion. It deliberately excludes launch, UI-trigger latency, and the first observed persistence flush, so it is useful for comparing the steady classification/persistence tail but is not total user-perceived scan time. Trigger-to-durable-completion remains a diagnostic in each report.

The durable guard records the exact unset/empty/populated state of nine launch keys—visit-food strategy, page size, result transport, result-transport attestation path, classification strategy, page orchestration, concurrency, pipeline depth, and validation run ID—and eight private temporary paths, including the native attestation. An external semantic reference is attested as an exact main/WAL/SHM/journal set before use and again through report publication; nonempty WAL or rollback-journal files are rejected before SQLite can open the reference as immutable. Schema-v6 reports record each reference component's presence, SHA-256, mode, and byte count. The permission-free `test:macos-vision-result-page-harness` contract suite covers valid, missing, and mismatched native attestations; full-plan and adaptive semantic oracles; retryable/missing outcomes; rejection of writes to skipped rows; exact component modes and hashes; external-reference sidecar rejection and repeatable identity; TERM/HUP restoration; shared kernel-lock contention; mismatched launched builds; default raw cleanup; explicit raw retention; SIGKILL recovery; and corruption refusal. Recovery accepts the current nine-key manifest plus the prior eight-, seven-, and six-key forms. Reports contain aggregate data and basenames only, are published only after durable restoration is verified, and raw snapshot/result databases are deleted by default. Use `--retain-raw-databases` to opt in to private database copies. An interrupted run fails closed until `--database=PATH --recover-stale-guard` validates the durable manifest and completes exact database and launch-environment restoration.

The same validator accepts `--visit-food-detection-strategy=full-plan-v1|rank3-bulk-tail-v1`. Full-plan retains exact per-photo parity and a zero-pending completion requirement. For the adaptive arm, a temporary non-boolean visit sentinel proves the single final derived-visit synchronization completed; the oracle then requires the exact positive-visit ID set, exact reference semantics for every durably successful expected attempt, NULL state for every skipped row, no unplanned writes or IDs, and complete planned = attempted + skipped accounting. Pending rows are valid only when they are either skipped after a positive visit or consistent with a retryable missing/native-failed expected attempt. Native schema 2 adds privacy-safe direct batch and requested-asset totals with balanced begin/complete lifecycle semantics; schema 6 cross-checks them against the deterministic rank plan and durable result state without emitting asset identifiers. `--require-native-work-counters` rejects older schema-1 app builds during a controlled A/B.

Capture at least three completed, retry-free schema-6 reports per strategy with the same signed build, reference, page/tuning/orchestration/transport/classification configuration, and fixture. Then validate and summarize them with:

```bash
pnpm test:macos-vision-visit-food-summary
pnpm profile:macos-vision-visit-food-summary -- \
  --full-plan-v1=.build/full-1.json,.build/full-2.json,.build/full-3.json \
  --rank3-bulk-tail-v1=.build/rank3-1.json,.build/rank3-2.json,.build/rank3-3.json \
  --output=.build/macos-vision-visit-food-ab-summary.json
```

The mode-0600 aggregate rejects duplicate, mismatched, unbalanced, schema-1, or semantically invalid inputs before reporting per-strategy timings, sampled RSS, direct requested-asset/native-batch totals, avoided-work percentages, and positional-pair/median deltas. Its results are explicitly descriptive and non-causal: pair order is not randomization, sampled RSS is not an exact peak, and durable-tail timing excludes launch, manual trigger latency, and the first observed flush. Runtime selection is controlled in the native strategy resolver, not by the summarizer.

| Real-library A/B/A/B evidence      | 200-result pages                   | 1,000-result pages                 | Result                                                                                                                                  |
| ---------------------------------- | ---------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Earlier trigger-wall runs          | 56.863 s, 56.398 s (mean 56.630 s) | 55.600 s, 55.490 s (mean 55.545 s) | 1.92% lower mean wall time; both 1,000-page runs were faster                                                                            |
| Process-attested durable-tail runs | 62.572 s, 56.779 s (mean 59.675 s) | 56.666 s, 56.290 s (mean 56.478 s) | 5.36% lower raw mean, but the first 62.572 s baseline was cold/noisy; the second paired comparison was a more conservative 0.86% faster |

The process-attested runs averaged 608,312 KiB peak RSS at page size 200 and 599,272 KiB at page size 1,000 (1.49% lower), but two samples per configuration are not enough to characterize memory precisely. Every run reproduced all 2,526 food-positive photos and 1,020 food-probable visits with zero mismatches. The parity queries are deletion-safe: they detect missing and extra photo or visit rows as well as semantic food-label, confidence, and visit-flag differences. Every run also ended with zero pending rows, `PRAGMA integrity_check = ok`, and restoration to the original database SHA-256 `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`.

A fresh signed, three-pair counterbalanced orchestration A/B used the same 13,059-photo current-control fixture, native concurrency 2, pipeline depth 4, and 1,000-result pages. Serial measured **50.125824 s median** versus **46.852701 s** for lookahead: a descriptive **6.53% reduction** and **3.273123 s saved** in the durable tail. Lookahead was faster in all three positional pairs; median sampled peak RSS also fell from **629,040 to 622,848 KiB** (-6,192 KiB). All six runs reproduced every food label, confidence, food decision, and visit flag exactly, with clean integrity, zero foreign-key violations, attested Release bytes (`Palate` SHA-256 `f760d7b6448ee9a990eedf9adcaff337bc7cbd8c2b6347e57a43d52104e0ced9`; `main.jsbundle` SHA-256 `a6778fe9d298eb50cd21ed053b4873bc00c7d750ba07c377aa8a1d978c363f46`), unchanged pre-trigger state, and exact database/environment restoration. This evidence promoted lookahead to the production default.

The long-lived database's stored Vision metadata had drifted on 11 of 13,059 photos before the A/B, while every food/non-food decision and visit flag remained identical. A rejected serial diagnostic established that boundary; a second serial result then became an immutable external current-control reference (SHA-256 `4e8c0aa6ed2d25455446b222d5d6dd79ff66e1da91aff6ffad0c6238dc14a9ea`). The validator requires that reference to have the exact live photo/visit identity, no pending WAL or rollback journal, and a byte-stable main/WAL/SHM/journal component set, while restoration still uses the independently guarded original main/WAL/SHM set. The aggregate descriptive summary is mode 0600, rejects unbalanced or mismatched schema/build/workload/reference/restoration inputs, and has SHA-256 `c5098c8f2c9511068fafad032cae4ec45f7db5d6bae4d303adbea9fa3dea928f`.

A fresh signed Release built after promoting the native default then passed one final lookahead integration run in **50.856141 s** at **627,248 KiB** sampled peak RSS. The validator attested the new executable SHA-256 `33b3ee0d590598f4453e377aa3a6c4c49a353a7c6c4322c7020b3bd7d3cdd796`, the same Release bundle SHA-256 `a6778fe9d298eb50cd21ed053b4873bc00c7d750ba07c377aa8a1d978c363f46`, exact current-control parity, clean integrity, and byte-exact restoration. Its aggregate report SHA-256 is `7b1fc2f527a9b517b327cd7bc68478fabe94e03fce3305de1dd6c15743564be2`. The Swift resolver suite independently proves that an absent or invalid orchestration environment now resolves to lookahead while an explicit `serial` override remains supported. All temporary reference/result databases and trigger files were deleted after validation.

The same signed route supports a counterbalanced `legacy`/`packed-v1` transport A/B. Initial signed evidence has not demonstrated an end-to-end packed-transport win, and the current schema-v6 balanced series is not yet complete, so **legacy remains the production default** and packed V1 remains an explicit experiment. New inputs must use `--require-native-work-counters`. The strict aggregate summarizer accepts only balanced, multi-sample groups with uniform build, fixture, tuning, semantic reference, restoration, and schema-2 native batch/requested-asset attestations:

```bash
pnpm test:macos-vision-transport-summary
pnpm profile:macos-vision-transport-summary -- \
  --legacy=.build/legacy-1.json,.build/legacy-2.json \
  --packed-v1=.build/packed-1.json,.build/packed-2.json \
  --output=.build/macos-vision-transport-ab-summary.json
```

For a real-library rerun, quit Xcode, build an explicit signed Release into Xcode's configured build directory, set the Palate scheme's **Run > Info > Build Configuration** to **Release**, invoke the harness with the exact app path printed by the build helper, and reopen Xcode only when the harness requests the manual launch. Use **Run Without Building**, then trigger **Deep Scan All Photos** when the harness is ready. The native module enables an isolated validation-only route only when both the guarded run ID and absolute native-attestation path are present; in that mode, Deep Scan invokes the same visit-food phase for both A/B arms and all automatic Deep Scan entry points are suppressed until the manual trigger. Outside validation, explicit Deep Scan always retains its full supplied-or-pending-photo behavior regardless of the selected visit-aware strategy. Do not use **Rescan Now** for this harness because its preceding Photos and Calendar phases are outside the isolated fixture.

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
  --result-transport=legacy \
  --visit-food-detection-strategy=full-plan-v1 \
  --require-native-work-counters \
  --output-prefix="$PWD/.build/macos-vision-page1000-a" \
  --manual-launch
```

Create the reported `.trigger` file with the current epoch immediately before pressing the scan confirmation button. The harness writes an aggregate JSON report and a 0.2-second sample trace after restoring the live database and launch environment. Raw database copies are removed unless `--retain-raw-databases` is supplied explicitly.

## Thanks

Special thanks to Jerry for collecting the dataset - [jerrynsh.com](https://jerrynsh.com/building-what-michelin-wouldnt-its-awards-history/)

https://ko-fi.com/s/81041defee

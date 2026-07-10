# Native profilers

This Swift package exercises the Expo-independent calendar and photo cores used by the app without building React Native.

Run all permission-free native tests, or one subsystem in isolation:

```sh
pnpm test:native
pnpm test:calendar
pnpm test:calendar-library
pnpm test:calendar-batch-mutation
pnpm test:calendar-eventkit-mutation
pnpm test:photos
```

Profile calendar matching without EventKit, Photos, React Native, or SQLite:

```sh
pnpm profile:calendar
pnpm profile:calendar --visits 2000 --events 20000 --iterations 7 --warmup 2
```

The seeded synthetic harness validates the indexed native matcher against an exhaustive reference before recording any timing. Its JSON report includes the input sizes, match checksum, individual samples, median and p95 durations, and speedup. The fixture exercises strict overlap boundaries, stable relevance ordering, and a realistic mix in which only some visits have nearby restaurant suggestions; the focused calendar tests cover title cleaning, exact-before-fuzzy selection, accents, emoji, apostrophes, ampersands, and ECMAScript whitespace parity separately. The suite currently passes **36/36 tests**.

The production Expo module also avoids the legacy calendar bridge: one JavaScript call queries EventKit in bounded native windows when needed, filters and deduplicates full native event objects, runs this core on its serial queue, and returns only the selected minimal records. Native candidates are ordered by start time, end time, and event ID before ranking, so equal-score/equal-time selection no longer depends on EventKit input order. The synthetic profiler measures the shared matching core; the complete EventKit and Expo bridge are compile-tested by the app build below.

Profile broad and sparse Calendar query-window plans without EventKit:

```sh
pnpm profile:calendar-query-windows
pnpm profile:calendar-query-windows --database=/path/to/read-only-copy.db
```

The report validates complete buffered-visit coverage, sorted non-overlapping windows, and the production three-year maximum predicate duration while sweeping sparse coalescing gaps. It is structural timestamp analysis only: it does not invoke EventKit, materialize events, or measure EventKit latency. The real-app validation below is required before changing the production strategy.

Test the destructive/recovery contract of the macOS Calendar validator without launching Palate or opening the live database:

```sh
pnpm test:macos-calendar-query-harness
```

This test creates a two-visit temporary WAL fixture and substitutes test-only `launchctl`, process, launch, and RSS commands. It covers a successful attested run, semantic parity failure with retained artifacts, and `TERM` while awaiting the trigger. Every path must restore the database byte-for-byte, restore all Calendar and Vision launch-environment values, and stop the simulated app process.

Profile read-only EventKit windowing against this Mac's real Calendar library:

```sh
pnpm profile:calendar-library
pnpm profile:calendar-library --past-days 730 --future-days 90 --reference-window-days 14 --iterations 5 --warmup 1
```

The Calendar-library profiler defaults to checking the current authorization status without requesting access or showing a permission prompt. If this profiler's bundle identifier already has full Calendar access, it reads event identities and timing metadata over a bounded range. Otherwise it writes a privacy-safe JSON error report with the authorization status and exits. The default five-year range exercises the production three-year EventKit query-window planner; an independently implemented 31-day planner is the exact parity oracle.

Test the SQLite persistence layer used after native Calendar matching and Calendar export:

```sh
pnpm test:calendar-persistence
pnpm profile:calendar-persistence
```

The focused test covers parameterized batching, duplicate/last-write semantics, null locations, all-day flags, missing visits, Unicode identifiers, preservation of unrelated columns, and the rule that imported-event updates do not erase an existing exported-calendar ID. The profile exercises both persistence phases on 5,000 visits, validates every resulting column against an independent sequential oracle after every run, and compares the prior one-statement-per-update transactions with the production 160-row parameterized statements. It reports SQLite time and execution/preparation reductions separately because the isolated runtime excludes Expo's asynchronous bridge overhead.

The report contains only authorization/configuration metadata, calendar and event counts, query-window counts, timings, and a SHA-256 digest. Titles, notes, locations, calendar names, and raw identifiers are never printed or saved. Every production and reference pass must produce the exact same in-memory unique-event identity set before timings are accepted; the digest is only the privacy-safe report representation.

Access can be requested only with an explicit opt-in flag:

```sh
pnpm profile:calendar-library --request-access
```

Run that opt-in command only when a Calendar permission prompt is intended. The script rebuilds and ad-hoc-signs the isolated profiler app so the executable has the required Calendar usage descriptions; set `PALATE_SKIP_CALENDAR_PROFILER_BUILD=1` only when deliberately reusing an existing build. Rebuilding an ad-hoc-signed app may cause macOS to treat it as a new privacy client. Reports are saved under `.build/calendar-library-profile-*.json`, including authorization failures.

Test and profile Calendar export/delete batching without requesting Calendar access:

```sh
pnpm test:calendar-batch-mutation
pnpm profile:calendar-batch-mutation
pnpm profile:calendar-batch-mutation --items 4000 --iterations 7 --warmup 2
```

The production path feature-detects the two mutation methods independently, so an older installed binary can continue through the Expo Calendar fallback after an OTA update. A supported binary sends each create or delete phase through one native call and performs one EventKit authorization preflight; the fallback checks permission once per phase instead of once per item. Once a native mutation starts, errors are never retried through Expo because an uncertain retry could duplicate a committed event.

Valid items are staged with `save` or `remove` using `commit: false`; item-level validation and staging failures remain isolated, later items still run, and an already-absent delete satisfies the requested postcondition. A phase commits once only when at least one mutation was staged. If the final `EKEventStore.commit()` throws, the backend calls `reset()` to discard pending in-memory changes, removes event IDs from staged successes, and reports those items as `ERR_CALENDAR_BATCH_COMMIT_FAILED`. Independent validation/staging failures and `alreadyAbsent` results retain their original outcomes. This is deterministic result mapping plus pending-state discard, not a claim that EventKit documents a multi-item commit as atomic.

The default permission-free report models 4,000 creates plus 4,000 deletes. It validates ordered item outcomes and the complete final in-memory state before every timing sample, then writes `.build/calendar-batch-mutation-profile.json`. Across both phases, modeled JavaScript/native calls and authorization checks fall from 16,000 to 2, the EventKit commit upper bound falls from 8,000 to 2, and observed synthetic commits fall from 7,988 to 2. Its Swift-only timing excludes EventKit, Calendar I/O, JavaScript, and the React Native bridge and is not an EventKit speedup claim. The focused tests also cover duplicate rejection before side effects, permission and preflight failures, Unicode and optional fields, missing-delete idempotence, interspersed deletion failures, OTA routing, commit failure, and bounded SQLite cleanup planning for 68,027 visit IDs.

Test the real-EventKit harness without Calendar access, or run its bounded temporary-calendar profile:

```sh
pnpm test:calendar-eventkit-mutation
pnpm profile:calendar-eventkit-mutation
pnpm profile:calendar-eventkit-mutation --items 100 --iterations 3 --warmup 1
```

The test suite is permission-free. The profiler checks authorization without prompting by default; `--request-access` is the only permission-requesting mode. It alternates legacy per-item commits and the one-commit candidate over deterministic sets of 1, 25, and 100 events in a uniquely named temporary calendar. Every accepted sample requires exact title, start/end, location, notes, and all-day parity; nonempty unique identifiers; candidate identifiers before the final commit and unchanged after readback; and zero remaining events after delete. Timing excludes launch, TCC, temporary-calendar lifecycle, semantic readback/digests, React Native, JavaScript, and persistence.

The candidate executes Palate's production `CalendarBatchMutationExecutor` and `CalendarEventKitMutationBackend` against the profiler's EventKit store. The legacy comparator calls EventKit directly with one commit per item. Source selection is restricted to visible writable calendars; partial events are retained for cleanup, and calendar removal is rehydrated and verified after an EventKit reset.

On 2026-07-09, the signed profiler inherited Palate's existing full Calendar access and completed one warmup plus three counterbalanced samples per strategy on an active CalDAV source:

| Events | Create: per-item commits | Create: production batch | Speedup | Delete: per-item commits | Delete: production batch | Speedup |
| ------ | ------------------------ | ------------------------ | ------- | ------------------------ | ------------------------ | ------- |
| 1      | 1.513 ms                 | 1.414 ms                 | 1.07×   | 2.297 ms                 | 2.491 ms                 | 0.92×   |
| 25     | 36.949 ms                | 13.937 ms                | 2.65×   | 36.491 ms                | 17.087 ms                | 2.14×   |
| 100    | 138.666 ms               | 52.192 ms                | 2.66×   | 147.248 ms               | 59.957 ms                | 2.46×   |

All sizes had exact semantic and count parity, nonempty pre-commit identifiers that remained stable after readback, one candidate commit per create/delete phase, and zero events after every delete. Verified calendar removal and a read-only post-run audit left no active-source profiler artifacts or process. One-item delete is slightly slower because both strategies make one commit while the production path also includes executor validation and result mapping; the benefit appears once multiple commits are coalesced. The accepted report is `.build/calendar-eventkit-mutation-profile-production-backend.json`, SHA-256 `c1db51c429a4c1a9f0e14e21eaa9e38a19b9a1ed1d69c6f37fde49aef080c145`.

Build and ad-hoc-sign the macOS profiler app without launching it:

```sh
zsh scripts/build-photos-profiler.sh
```

When a real Photos-library run is intended, launch the already-built app with:

```sh
zsh scripts/profile-photos-library.sh \
  --batch-sizes 2000,500,250 \
  --iterations 5 \
  --warmup 1 \
  --vision-sample 100 \
  --vision-concurrency 2
```

The script rebuilds the small Swift profiler before launching it, so measurements cannot silently use stale native code. Set `PALATE_SKIP_PHOTOS_PROFILER_BUILD=1` only when deliberately rerunning the existing binary. The first run—and, depending on macOS TCC's code requirement for the ad-hoc signature, a rebuilt binary—can display the Photos permission prompt for bundle identifier `com.jonluca.palate.photos-profiler`.

The script emits and saves one JSON report. `metadata.coldRetainedPass` is the first, unwarmed traversal using the first requested batch size. For every batch size, the report also compares warmed retained `PHFetchResult` paging with repeated identifier refetches, validates identical asset counts and order-independent identifier digests, and reports the median segment speedup. These measurements cover the shared native PhotoKit core; the complete Expo bridge and SQLite pipeline are compile-tested by the app build below rather than included in this microbenchmark.

The Vision measurement uses the same `PhotoAssetClassifier` core as the Expo module. It reports processed and failed assets, label count, elapsed time, and throughput. Sweep `--vision-concurrency` independently to tune classification without rebuilding React Native.

Test and profile the asynchronous PhotoKit/Vision pipeline without running the metadata benchmark:

```sh
pnpm test:vision-pipeline
pnpm profile:vision-pipeline
pnpm profile:vision-pipeline --vision-concurrency 2 --vision-pipeline-depth 8
```

The dedicated wrapper selects the profiler's `vision` mode, so unrelated metadata traversal cannot warm PhotoKit first. Its default two warmups plus 20 measured comparisons allocate 22 disjoint 200-asset windows from at most 4,400 real images. Within every window it runs the synchronous baseline and asynchronous pipeline in alternating order, then requires identical asset order, success/failure kind, labels, confidence bit patterns, and error messages before accepting timing. The production defaults remain two Vision workers, four total in-flight PhotoKit/Vision assets, and 1,000 results per native/JavaScript call. Bounded app-process overrides—`PALATE_VISION_CONCURRENCY` (1–16), `PALATE_VISION_PIPELINE_DEPTH` (1–64), and `PALATE_VISION_RESULT_PAGE_SIZE` (1–2,000)—support controlled macOS tuning without rebuilding; invalid values fall back to those defaults.

The wrapper rebuilds the small profiler app and therefore has the same Photos-permission behavior as `profile:photos`. It emits only aggregate counts, timing samples, and validation fields to `.build/vision-pipeline-profile.json`; retained Photo identifiers never appear in the report. If the rebuilt profiler does not already have Photos access, it may require an intentional permission grant before real-library measurements can run.

Test and profile native-scan metadata ingestion into SQLite:

```sh
pnpm test:photo-ingestion
pnpm profile:photo-ingestion
```

The production scanner accumulates adjacent PhotoKit pages into bounded 4,000-record flushes, but never holds a database transaction while awaiting PhotoKit. Each flush uses one parameterized multi-row `INSERT OR IGNORE` below Expo SQLite's 32,766-variable limit. This preserves first-occurrence-wins duplicate behavior and existing analyzed rows while reducing the 68,030-asset high-tier path from 69 SQLite preparations/autocommits to 18; legacy 100- and 25-record page paths fall from 681 and 2,722 calls to the same 18.

Each flush is one atomic SQLite statement, so a database error rolls back only the current group of at most 4,000 records; earlier successful flushes remain committed. The scanner removes records from its pending buffer only after a successful insert, does not automatically retry a rejected SQLite flush in the same run, and surfaces the error. A user-initiated rerun scans the library again: `INSERT OR IGNORE` skips records already committed or analyzed and retries the records absent from the failed flush without overwriting them. If PhotoKit fails instead, the scanner first attempts to persist any smaller pending buffer, then surfaces the PhotoKit error; the same idempotent rerun behavior completes any remaining records.

The focused test compares complete rows and inserted counts with the former 1,000-row writer, including existing records, duplicates within and across flushes, null and zero coordinates, videos, unusual identifiers, and trigger-injected statement rollback. The latest default file-backed WAL profile uses 68,030 input records, preserves 257 pre-existing analyzed rows, and validates a full database SHA-256 after every run. Its seven-sample raw SQLite medians are 80.24 ms for the 69-call legacy path and 82.63 ms for the 18-call bounded path: the bounded path was about 3% slower in this isolated measurement, so this report does not demonstrate an end-to-end speedup.

The report at `.build/photo-ingestion-profile.json` measures Node/V8 statement construction and file-backed SQLite WAL writes only. It excludes PhotoKit extraction and paging, Expo's asynchronous bridge overhead, React Native scheduling, and the complete app pipeline. The 69-to-18 call reduction is therefore structural evidence, not a latency claim; a signed macOS app run against the real Photos library is required to determine end-to-end performance and recovery behavior.

Profile initial native preview-image loading without running the metadata or Vision passes:

```sh
pnpm profile:initial-images
pnpm profile:initial-images --image-counts 9,24 --image-width 384 --image-height 480 --image-iterations 4
```

This mode uses globally disjoint recent-image samples and counterbalances both recency and execution order. It compares the current per-image `PHAsset` refetch plus high-quality `PHImageManager.default()` path with the app's shared, batched, coalesced, opportunistic `PhotoAssetThumbnailStore`. The JSON report includes first renderable/degraded/final latency, all-visible final latency, per-image final p50/p95/max, failures and timeouts, decoded dimensions, identifier digests, and candidate speedups for each visible-image count. Raw Photos identifiers are never emitted.

Both strategies allow PhotoKit network access. This is explicit in the report because the production thumbnail store currently enables iCloud downloads; use disjoint samples and repeated runs to account for external Photos/iCloud cache state. The dedicated mode does not run metadata or Vision benchmarks first, so this process does not warm image requests before measurement.

Test and profile the Michelin location index without building the app:

```sh
pnpm test:location
pnpm profile:location --queries=5000
```

The location profile validates every indexed result against an equivalent geodesic brute-force search before timing. It reports the one-time index build, the prior approximate linear implementation, equivalent geodesic brute force, indexed geodesic lookup, and both speedup ratios.

Test and profile the initial home preview-photo SQL without building the app:

```sh
pnpm profile:home-previews
pnpm profile:home-previews --restaurants=1500 --photos-per-visit=32 --samples=9
```

This harness builds a deterministic in-memory SQLite database, checks the prior global `ROW_NUMBER` preview-query baseline against the current indexed correlated top-3 query on both edge-case and scaled datasets, and fails before timing if any restaurant's preview URI order differs. It emits JSON containing dataset sizes, correctness coverage, individual samples, median and p95 query times, and the correlated-query speedup. It uses Node's built-in SQLite module and does not need Photos permission or a React Native build.

Test and profile the main visit-list details query:

```sh
pnpm test:visit-details
pnpm profile:visit-details
```

The production query returns each visit, its restaurant metadata, and its ordered top-three preview URIs in one SQLite result row. A migration-safe expression index matches the food/creation-time/photo-ID ordering, eliminating the per-visit temporary sort; the photo-ID tie-break intentionally makes previously undefined equal-rank ordering deterministic. The focused test checks every visit filter, join and award fallback behavior, no-photo visits, JSON escaping, and the query plan. The default profile compares the prior two-call path, the one-query path on the prior indexes, and the indexed production path on 4,000 visits and 68,027 photos. It validates the complete ordered result after every run and reports database calls, rows crossing the database boundary, query plans, and the separately measured one-time synthetic index-build cost under `.build/visit-details-query-profile.json`.

Test and profile the pending-review query in isolation:

```sh
pnpm test:pending-review
pnpm profile:pending-review
```

The production query probes `idx_photos_visit_preview` once per pending visit and stops after its first three photos instead of assigning a window row number to every pending photo. The photo ID is a deterministic final key for equal food/creation-time ranks. The focused test compares complete raw rows against an independent window-function oracle across every review priority, direct and nearby suggestions, nested food labels, unanalyzed and no-photo visits, malformed JSON, status exclusion, Unicode, and equal-rank ties. It also verifies that suggestion JSON satisfies the full `SuggestedRestaurantDetail` contract, including `latestAwardYear`.

The default synthetic profile uses 4,000 pending visits and exactly 68,027 photos, validates full raw-row parity and SHA-256 checksums before, during, and after timing, alternates query order, and asserts that the preview lookup uses the expression index without a temporary sort or window function. It writes `.build/pending-visit-review-profile.json`. Timings are Node/V8 plus in-memory SQLite, not the Expo bridge or the real app database.

Test and profile Review query-cache reuse independently of React Native:

```sh
pnpm test:review-query-policy
pnpm profile:review-query-policy
```

Fresh pending-review data is reused for 30 seconds across navigation remounts. Exact active invalidation refreshes only the pending-review query after a row-changing mutation, including notes updates; if the Review screen is inactive, the cache remains invalidated and refreshes on its next mount. Manual refresh is similarly limited to the active pending-review and unanalyzed-photo-count keys. The pure QueryCore suite proves fresh, stale, active, and inactive behavior while ensuring descendant and unrelated caches remain untouched.

The structural six-mount profile reduces modeled materializations from 6 to 1, avoiding 83.33% of query calls, transferred rows, and transferred bytes. Its timing measures Node/V8 TanStack Query observer mount/unmount plus exact-size JSON parsing. It excludes Expo SQLite, the native bridge, Hermes, React rendering, and Photos/Calendar access and therefore is not an app-level speedup measurement.

Test and profile bulk visit-status changes used by Quick Actions:

```sh
pnpm test:visit-status-batch
pnpm profile:visit-status-batch
```

The production path sends one JSON-backed set update to SQLite instead of one asynchronous prepare/write/autocommit per visit, avoiding SQLite's bind-variable limit while keeping identifiers parameterized. The focused suite checks every status, duplicates, missing and unusual identifiers, deterministic randomized parity, untouched columns, 4,000-row payloads, and statement-level rollback under an injected trigger failure. The hook deduplicates optimistic input and reconciles every visit-status-derived query cache after success.

The default profile updates 4,000 of 5,000 rows on a fresh database per strategy, alternates execution order, and validates the complete ordered database checksum after every run. Its report at `.build/visit-status-batch-profile.json` separates raw SQLite timing from the larger structural reduction in Expo calls, preparations, and implicit transactions. Timings are Node/V8 plus in-memory SQLite and exclude Expo bridge overhead.

Test and profile visit export batching:

```sh
pnpm test:export-batching
pnpm profile:export-batching
pnpm test:export-stream-plan
pnpm test:export-streaming
pnpm profile:export-streaming
```

The compatibility JSON assembler loads visits and restaurants once, then walks ordered photos in bounded 4,000-row keyset pages. CSV loads visits and restaurants plus one grouped exact-count query so its photo metadata cannot inherit stale denormalized counts. The previous path loaded all restaurants and then redundantly queried each visit's restaurant again, plus one photo query per visit. At 4,000 visits and 68,030 photos this reduces compatibility JSON from 8,002 SQLite calls to 20 (18 photo pages) and CSV from 4,002 to 3. Each photo query uses one JSON visit-ID parameter, a one-row lookahead, and `idx_photos_visit_preview`, keeping binds and transient raw/parsed rows bounded while avoiding offset rescans and temporary sorting. All native reads run on Expo SQLite's dedicated transaction connection, pinning one WAL snapshot so concurrent food classification or visit-association writes cannot move rows across the page cursor.

The native JSON share path goes further: it adds one exact grouped-count query, greedily plans consecutive batches capped at 4,000 photos and 256 visits, and streams JSON through a bounded UTF-8 sink to a hidden `.part` file before atomically moving it into place. A single visit above the photo cap is streamed through repeated keyset pages, so even a pathologically large visit cannot rebuild the full export graph. Snapshot counts replace potentially stale denormalized visit counts before visit metadata and aggregate statistics are written. This path needs 21 SQLite calls at the same scale but retains at most one bounded batch/page instead of all 68,030 photo objects. `exportToJSON` remains an output-sized string API for compatibility, and web export uses a browser Blob download because Expo FileSystem is unavailable there.

The focused batching test uses an independent transcription of the old database access plus a corrected assembler and serializers to prove complete data and byte-for-byte JSON/CSV parity against the intended schema for every status filter and photo mode whose ordering is defined. It covers 5,200+ requested IDs across multiple pages, duplicates, misses, missing and repeated restaurants, malformed label JSON, nulls, videos, zero-photo visits, Unicode, quotes, newlines, and concurrent WAL writes between pages. SQLite returns visit booleans as `0`/`1`, which the previous exporter leaked into JSON despite declaring booleans; production and the independent oracle now normalize them to `false`/`true`, and the test explicitly records this intentional schema correction rather than claiming old-byte compatibility. The legacy SQL also left equal-rank/equal-time order unspecified, so the production ID tie-break is validated separately from tie-free parity.

The stream-planning test independently checks the exact grouped-count SQL and its index plan, every cap boundary, zero-photo and oversized visits, stable ordering, unusual/injection-like IDs, invalid maps, and the 4,000-visit/68,030-photo shape. The serializer test proves byte-for-byte pretty-JSON equality, UTF-8 correctness across surrogate pairs, omission of undefined fields, null malformed-label behavior, visit/page boundaries, stale-count reconciliation, state misuse, sink failures, retry safety, and buffer bounds.

The batching profile revalidates output SHA-256 after every run. The latest stable seven-sample run at `.build/export-batching-count-timing.json` measured 605.42 ms to 589.55 ms for 44.70 MB JSON (1.027×) and 218.25 ms to 208.09 ms for CSV (1.049×). The exact-count query added 11.86 ms (6.04%) relative to the prior two-call candidate median on this Mac, while the corrected path still uses 1,334× fewer CSV database calls than the 4,002-call legacy path. Expo's asynchronous bridge and real-device storage are excluded, so the structural call reduction and exact-count invariant remain the stronger app-level evidence.

The fresh-child streaming profile writes `.build/export-streaming-profile.json` and models the label-heavy worst case with 4,000 visits, 68,030 photos, and 13 food plus 13 all-label entries per photo. For the distributed 217,901,301-byte output, exact SHA-256 parity held while maximum RSS fell from 2,194,384 to 620,304 KiB, peak observed V8 heap from 682,180,056 to 194,051,624 bytes, and maximum retained photo rows from 68,030 to 3,995. When one visit owned all 68,030 photos, maximum RSS fell from 2,194,656 to 497,616 KiB, peak observed heap from 665,560,712 to 98,987,248 bytes, and retained rows to 4,000. The latest one-sample elapsed ratios were 0.865 and 0.855 respectively, but those timings are not an app-level claim: the harness covers Node/V8, file-backed SQLite, hashing, and file writes, while excluding Hermes, Expo's bridge, native FileHandle behavior, and the share sheet. The signed macOS integration run below covers the production bundle, native-module registration, and real-library scan; share-sheet export latency remains outside this microbenchmark.

Test and profile photo-to-visit association writes at the scale of the local Photos library:

```sh
pnpm test:photo-association
pnpm profile:photo-association
```

The benchmark compares the prior literal `CASE` update with the production parameterized set-based transaction on fresh deterministic databases. It models the app's 200-visit-group call size and validates every row and checksum after every run, including exact duplicate behavior across calls and legacy statement boundaries, missing IDs, apostrophes, Unicode, and untouched payload columns.

Test food-label reclassification without building the app:

```sh
pnpm test:food-reclassification
pnpm profile:food-reclassification
```

The test verifies exact keyword normalization, label order and confidence semantics, malformed JSON handling (including a malformed final row), bounded parameterized batches, and preservation of source labels and unrelated photo columns. The profile uses 68,027 labeled photos and 13 labels per photo, matching this Mac's observed Photos/Vision scale. It validates every photo and visit against an independent oracle before reporting the current per-row autocommit path versus the production 200-row set-based transaction. Timing is Node/V8 plus in-memory SQLite and therefore excludes—and likely understates—the reduction in Expo async bridge crossings.

Test and profile persistence of Vision food-detection results:

```sh
pnpm test:photo-food-persistence
pnpm profile:photo-food-persistence
```

The focused test validates labeled-last-wins and simple-false-wins duplicate rules, labeled-then-simple ordering, empty-array JSON, omitted values, zero confidence, missing IDs, Unicode, full-batch statement reuse, and transaction rollback against the prior sequential writer. The default profile models the real deep scan: 68,027 photo rows plus seven duplicate and missing-ID correctness-edge updates, delivered in 1,000-result native pages and persisted in 1,000-result flushes. It imports those production constants, validates a full ordered database SHA-256 after every run, and reports Node SQLite timing separately from Expo operation counts. Each flush uses bounded set-based statements inside one transaction instead of one asynchronous execute per photo. Reports are saved to `.build/photo-food-detection-persistence-profile.json`; `--call-size` can still model older 50- or 200-result persistence boundaries explicitly.

The latest seven-sample default run measured 100.96 ms for the sequential SQLite oracle and 109.36 ms for the set-based writer (0.92×), while reducing modeled asynchronous executions from 68,034 to 409 (166.34×). It therefore makes no raw in-process SQLite speedup claim; the production rationale is eliminating tens of thousands of Expo async crossings while retaining atomic bounded flushes.

Test the buffering and durability orchestration around those database writes:

```sh
pnpm test:food-detection-buffer
pnpm test:food-detection-orchestration
pnpm profile:food-detection-buffer
pnpm test:vision-result-pages
pnpm profile:vision-result-pages
```

The pure buffer suite proves exact page/row order, a single non-overlapping persistence writer, retention after a failed write, bounded input pages, and final-remainder flushing. The orchestration suite covers partial processing, combined processing/persistence/synchronization failures, retry boundaries, and the rule that terminal progress is reported only after durable persistence and visit synchronization. With the tuned 1,000-row native page aligned to the 1,000-row durable flush, both modeled strategies use 14 database operations for 13,060 results and 69 for 68,027; the buffer now supplies retry durability and single-writer ordering without claiming an additional crossing reduction. Peak retained rows remain 1,000. The profile measures TypeScript orchestration only; operation counts, not its sub-millisecond loop timing, are the app-relevant evidence.

The Vision-result-page suite exercises the production page planner at every 200-, 500-, and 1,000-row boundary, including the 13,059- and 68,027-row library shapes, duplicate identifiers, exact ordered concatenation, a 1,000-row persistence failure, and retry durability. Its structural profile compares page sizes 200, 500, and 1,000: on the controlled 13,059-row fixture, page size 1,000 reduces native classification calls, `PHAsset` fetches, and pipeline sessions from 66 to 14 while leaving the 14 durable database operations unchanged. The reported Node timing covers only page planning, copying, and traversal; it is not a PhotoKit, Vision, bridge, or end-to-end speedup claim. The signed macOS-app A/B/A/B runs below proved exact parity and supported a small end-to-end reduction, so 1,000 is now the bounded production default.

Test deterministic pre-Vision visit sampling in isolation:

```sh
pnpm test:food-sampling
pnpm profile:food-sampling
```

The focused test compares the combined production query with the previous one-query-per-visit algorithm across fractional, zero, negative, and over-100% sample values. It verifies visit ordering, per-visit photo ordering, the at-least-one rule, and that the sample limit is based on all visit photos while only unanalyzed photos are returned. The profile validates exact ordered parity on a cold-scan fixture of 5,000 visits and 68,027 unanalyzed photos before comparing 5,001 result-producing calls with the production single-query plan and a 400-visit chunked alternative. It reports SQLite CPU separately, because the global window query can be slower inside SQLite while still needing only four Expo prepare/execute/read/finalize awaits instead of roughly 20,004.

Test the restaurant viewport index in isolation, then profile it over a deterministic representative camera trace against the bundled Michelin database:

```sh
pnpm test:map-viewport
pnpm profile:map-viewport
```

The pure test covers coordinate normalization, zero-sized and whole-world viewports, inclusive bounds, antimeridian wrapping, ranking precedence, invalid inputs, count-only mode, and stable top-500 ties. The benchmark's exhaustive selection is an independent oracle for viewport bounds, antimeridian wrapping, ranking, stable ties, and the top-500 limit. The measured candidate imports the same persistent KDBush index and bounded top-K heap used by the app; timing starts only after exact result parity and deterministic checksums pass.

Compile the complete app for the macOS “Designed for iPhone/iPad” destination without launching it:

```sh
zsh scripts/build-macos-designed-app.sh
```

The script verifies the output executable plus the Photos and full-Calendar usage descriptions, prints its path, and deliberately defaults to `CODE_SIGNING_ALLOWED=NO`. Release builds delete only their generated bundle artifacts before invoking Xcode and require a new `main.jsbundle`, preventing native recompilation from silently validating stale JavaScript. It pins the app's 16.4 deployment target across dependency resource bundles for current Xcode compatibility; set `PALATE_IPHONEOS_DEPLOYMENT_TARGET` only when intentionally testing a different minimum. A signed Release integration build can opt in after the local Apple Development certificate is valid:

```sh
PALATE_XCODE_CONFIGURATION=Release \
PALATE_CODE_SIGNING_ALLOWED=YES \
PALATE_ALLOW_PROVISIONING_UPDATES=1 \
zsh scripts/build-macos-designed-app.sh
```

## Latest signed macOS integration validation

The real-library result-page harness is independently reusable and prints its full contract with:

```sh
zsh scripts/validate-macos-vision-result-page.sh --help
```

It snapshots the supplied live database, prepares the fixed classified-photo fixture, installs the bounded page-size override, waits for a manually launched Xcode app and a timestamped atomic trigger file, then samples durable pending-row progress and RSS every 0.2 seconds. The launched process environment must contain the exact page-size and validation-run values; the native resolver's focused tests verify that those values become the advertised module constant. No app-side marker is used. The schema-v2 primary timing is the tail from the first observed durable flush through completion, so it excludes launch, UI-trigger latency, and the first flush and is not total user-perceived scan time. Validation uses deletion-safe joins for semantic photo labels/confidences and derived visits, checks for extra rows, zero pending rows, and SQLite integrity, and writes a JSON report plus result database. Pre-existing page-size, strategy, concurrency, depth, and validation launch values are restored together with the byte-identical database on success, failure, interrupt, or timeout. Xcode's **Run Without Building** action is used with a previously verified signed Release product because a Designed-for-iPhone bundle cannot be launched correctly with `open`.

The completed Calendar and Review iteration was validated on 2026-07-09 with the shared Release scheme launched from Xcode. The earlier broad/sparse A/B used executable SHA-256 `7b0dbfbf9bd4ae617fe39d43959feaab23af18422fe1c90fa4b6ab92940eae7d` and fresh Hermes `main.jsbundle` SHA-256 `3277663b1c392be51e4fa3c3f27f190f3e563a651c107b96d1ab8a20ed9eb2eb`. The fresh batched-commit Rescan follow-up used executable SHA-256 `d0081d772b7ccdc58b4254f60f2ad6789d720feeb4df8198b950340572702fe5` and `main.jsbundle` SHA-256 `4d8ce5ba3f4fa7c5fbcad5840369cb540505a8c0b06b563599b50e22ee5c48ad`. After exposing that same backend to the isolated Swift profiler, a final signed integration rebuild also passed with executable SHA-256 `34d4cba79b78360f2d9f612b8fcb4035242211436dc12a7df7d71993cf5f11dc` and the same bundle hash.

The signed bundle was installed and launched from Xcode's **My Mac (Designed for iPhone)** destination. That is the supported integration route for this iOS bundle on Apple silicon; invoking the iPhone executable directly with `open` is not a substitute for Xcode installation. Apple documents both [running iOS apps in macOS](https://developer.apple.com/documentation/apple-silicon/running-your-ios-apps-in-macos?language=objc) and [running an app from Xcode](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices).

The schema-v3 Calendar validator snapshots and atomically restores the live database, clears only derived Calendar fields, and runs the production Rescan Photos prefix against this Mac's existing full Calendar grant without prompting. It requires the native runtime to attest the resolved strategy and gap, verifies the launched process environment independently, and can compare each run with an explicit standalone database opened through SQLite's immutable read-only URI. The reference is hash-checked before and after parity queries. Semantic failures retain their report and result database for diagnosis; success, failure, timeout, and signals still restore the original live database and launch environment.

The controlled fixture contained 68,028 photos, 6,511 visits, 2,000 Calendar links, and 1,161 distinct events. A first deterministic broad pass established the explicit A/B reference. The new start/end/event-ID tie rule changed 168 legacy event IDs that had previously depended on arbitrary EventKit input order; only 15 titles and 14 locations changed, with no restaurant-suggestion or fixture-count changes. The existing live database was restored untouched, and subsequent broad and sparse runs were required to match the deterministic reference exactly.

| Strategy                  | Warm prefix timings (n=3)          | Median     | Median peak RSS |
| ------------------------- | ---------------------------------- | ---------- | --------------- |
| Broad                     | 7.570505 s, 7.736945 s, 7.738894 s | 7.736945 s | 812,192 KiB     |
| Sparse, 30-day coalescing | 7.797055 s, 7.733106 s, 7.806115 s | 7.797055 s | 812,160 KiB     |

Sparse-30 was 0.78% slower by median wall time, while median peak RSS was effectively identical (32 KiB lower, less than 0.01%). With no demonstrated win, the proven broad strategy remains the production default. A single sparse-14 correctness run also passed in 8.228779 seconds but is not enough evidence for tuning. Every accepted run had exact visit, photo, suggested-restaurant, and app-metadata parity, matching link/event counts, clean foreign keys, and `PRAGMA integrity_check = ok`.

The fresh signed Release containing the one-commit mutation code also passed a broad production Rescan Photos integration run in 11.255348 seconds with 821,952 KiB sampled peak RSS. It reproduced 6,511 visits, 2,000 Calendar links, 1,161 distinct events, 68,028 photos, 5,147 suggestions, and 2 metadata rows with exact visit/photo/suggestion/metadata parity, clean integrity, and zero foreign-key violations. The result matched reference SHA-256 `8edb82747cf7b94b2758cb416c73a8af69d15b1df8d2352c7e75f04867354b8a`; the live database was restored to `fe74b061faaa5836d4b1e36cc056d569f28570c5748c3541c92a18ca79473d89`. This manually triggered run is integration evidence, not comparative tuning evidence, and Rescan does not invoke export/delete mutations.

The Calendar wall time is **not isolated EventKit latency**. It begins at a timestamp recorded immediately before the manual Rescan tap and ends at the first 0.2-second sample that observes durable Calendar restoration. It therefore covers the Rescan Photos prefix—including PhotoKit asset metadata scanning and visit grouping before Calendar matching—while excluding later food-detection and database-maintenance phases. Manual reaction time and 0.2-second sampling quantization limit precision. [EventKit's documented `events(matching:)` contract](https://developer.apple.com/documentation/eventkit/ekeventstore/events%28matching%3A%29) returns all events matching a predicate, while Palate additionally splits broad ranges into bounded three-year windows.

Vision validation reset the same 13,059 previously classified rows to pending while keeping the other 54,969 rows outside the fixture, then ran the same current app twice against this Mac's real Photos library. The synchronous native baseline took 60.17 seconds from scan command to durable completion; the default two-worker, depth-four pipeline took 58.84 seconds, a 1.023× (2.21%) improvement. Peak RSS was effectively unchanged at 618,928 versus 619,840 KiB. Both runs persisted in 1,000-row steps with a final 59-row remainder, produced all 13,059 outcomes, classified the same 2,526 photos as food, matched every stored label and confidence semantically, matched every derived `visits.foodProbable` value, left no pending fixture rows, and passed SQLite integrity. Raw JSON strings can differ only in native dictionary key order; label order, values, and confidence bits were identical. A depth-eight tuning run remained exact but took 59.86 seconds, so depth four remains the production default.

Result-page tuning first used the same fixture in counterbalanced 200/1,000/200/1,000 order. Trigger-to-durable-completion for page 200 was 56.863 and 56.398 seconds (56.630-second mean); page 1,000 was 55.600 and 55.490 seconds (55.545-second mean), 1.92% lower, with both 1,000-row runs faster. Mean peak RSS fell from 614,888 to 608,864 KiB.

A second A/B/A/B set added process-environment attestation and measured the durable tail from the first observed 1,000-row commit. Page 200 took 62.572 and 56.779 seconds (59.675-second raw mean); page 1,000 took 56.666 and 56.290 seconds (56.478-second mean). The 5.36% raw mean reduction is dominated by the first cold/noisy 200-row run; the second paired comparison is the more conservative 0.86% reduction. Mean peak RSS was 608,312 versus 599,272 KiB, but two samples per setting are not enough to characterize memory. All eight result-page runs had zero semantic photo mismatches, zero deletion-safe visit mismatches, zero pending rows, and clean SQLite integrity before restoring the same database hash. The production result-page default is therefore 1,000; `PALATE_VISION_RESULT_PAGE_SIZE` remains available for bounded 1–2,000 experiments, while JavaScript retains a 50-row fallback for older binaries that do not advertise a valid native value.

The pipeline timings are one controlled end-to-end A/B pair, while each result-page set uses only two counterbalanced samples per setting; none is a statistically stable device-wide benchmark. Photos and Calendar were read-only throughout these production-app fixture runs. The mutation profiler separately writes only deterministic synthetic events to a uniquely named temporary calendar and verifies their deletion. After every fixture run the app was stopped, transaction sidecars were removed, and the original database was restored byte-for-byte; the restored database contains 68,028 photos, 13,059 classifications, 2,526 food photos, 6,511 visits, and 2,000 Calendar links with a clean integrity check.

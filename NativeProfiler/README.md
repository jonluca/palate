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

Test the Calendar Imports rendered-snapshot mutation separately from EventKit discovery:

```sh
pnpm test:calendar-import-snapshot
pnpm profile:calendar-import-snapshot
```

The screen now sends the exact reviewed event snapshots into a pure planner and one exclusive SQLite transaction instead of repeating the 1,000-day EventKit/Michelin discovery pipeline. The transaction rechecks linked/dismissed IDs, applies the existing inclusive ±1-day confirmed-visit rule against every originally matched restaurant, uses `INSERT OR IGNORE ... RETURNING`, and creates suggestions only for visits actually inserted. Focused coverage includes malformed overrides, partial availability, deterministic ID collisions, alternate-restaurant conflicts, 1,002-item batching, forced rollback, a two-connection WAL dismissal race, and QueryClient cache recovery.

The aggregate-only synthetic model uses the privacy-safe shape of **8,167 eligible events and 139 import candidates**. Snapshot reuse eliminates one discovery call and all 8,167 modeled event-row traversals per mutation; pure JavaScript planning measured **56.86×** for one selected candidate and **1.735×** for all 139. This excludes EventKit, Michelin/SQLite discovery, persistence, Expo/React Native, and rendering, so the structural discovery elimination—not the sub-millisecond timer—is the production result. Report SHA-256: `8136cddce879ce5c56b40e12c12ac73995cb5b4a7a8badd5fab329eea5db90fb`.

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

The profiler waits 30 seconds for an initial permission decision by default. For an attended first authorization, keep the same bounded parser contract while extending the wrapper wait to at most five minutes:

```sh
PALATE_PHOTOS_AUTHORIZATION_TIMEOUT_SECONDS=300 pnpm profile:photos
```

The script emits and saves one JSON report. `metadata.coldRetainedPass` is the first, unwarmed traversal using the first requested batch size. For every batch size, the report also compares warmed retained `PHFetchResult` paging with repeated identifier refetches, validates identical asset counts and order-independent identifier digests, and reports the median segment speedup. These measurements cover the shared native PhotoKit core; the complete Expo bridge and SQLite pipeline are compile-tested by the app build below rather than included in this microbenchmark.

The permission-free wrapper harness verifies that valid authorization/error reports are saved and printed before optional success fields are inspected:

```sh
pnpm test:photos-profiler-wrapper
```

The Vision measurement uses the same `PhotoAssetClassifier` core as the Expo module. It reports processed and failed assets, label count, elapsed time, and throughput. Sweep `--vision-concurrency` independently to tune classification without rebuilding React Native.

Test and profile the asynchronous PhotoKit/Vision pipeline without running the metadata benchmark:

```sh
pnpm test:vision-pipeline
pnpm profile:vision-pipeline
pnpm profile:vision-pipeline --vision-concurrency 2 --vision-pipeline-depth 8
```

The dedicated wrapper selects the profiler's `vision` mode, so unrelated metadata traversal cannot warm PhotoKit first. Its default two warmups plus 20 measured comparisons allocate 22 disjoint 200-asset windows from at most 4,400 real images. Within every window it runs the synchronous baseline and asynchronous pipeline in alternating order, then requires identical asset order, success/failure kind, labels, confidence bit patterns, and error messages before accepting timing. The production defaults remain two Vision workers, four total in-flight PhotoKit/Vision assets, and 1,000 results per native/JavaScript call. Bounded app-process overrides—`PALATE_VISION_CONCURRENCY` (1–16), `PALATE_VISION_PIPELINE_DEPTH` (1–64), and `PALATE_VISION_RESULT_PAGE_SIZE` (1–2,000)—support controlled macOS tuning without rebuilding; invalid values fall back to those defaults.

The wrapper rebuilds the small profiler app and therefore has the same Photos-permission behavior as `profile:photos`. It emits only aggregate counts, timing samples, and validation fields to `.build/vision-pipeline-profile.json`; retained Photo identifiers never appear in the report. If the rebuilt profiler does not already have Photos access, it may require an intentional permission grant before real-library measurements can run.

Test and profile the Vision result transport independently of PhotoKit and Vision inference:

```sh
pnpm test:vision-result-transport
pnpm profile:vision-result-transport
```

The production default is `legacy`. `PALATE_VISION_RESULT_TRANSPORT=packed-v1` opts a compatible native module into the experimental packed path; JavaScript selects it only when the module both resolves `packed-v1` and exposes `classifyImageBatchPackedV1`. Missing capability, an old binary, or an absent/invalid setting falls back to legacy before classification starts. A rejection or malformed payload after packed dispatch is surfaced without rerunning Vision through the legacy method.

Binary V1 uses a little-endian fixed header, canonical first-use UTF-8 string table, one missing/success/failure/duplicate slot for every requested asset, and bit-exact `Float32` confidences. Swift sizes and writes one final `Data` value, then exposes it through `NativeArrayBuffer.wrap(dataWithoutCopy:)`. The TypeScript decoder works directly over `ArrayBuffer` or `Uint8Array` views and strictly validates the complete envelope, request/slot identity, canonical table use, duplicate rules, UTF-8, finite confidences, and end-of-buffer. The independent TypeScript encoder is a test/profiler oracle under `scripts/vision-classification-transport-oracle.ts`, not production bundle code.

The combined test runs TypeScript decoder, fallback, and malformed-input coverage plus the Swift encoder, transport resolver, and actual-dispatch attestation suites. On the immutable real database, the aggregate-only structural profile covered 13,059 rows and 112,672 labels. It modeled **6,435,337 bytes** for nested JSON versus **1,661,371 bytes** for binary V1, a **4,773,966-byte (74.1836%)** reduction, with exact decoded semantic SHA-256 `ad091b2bec7a920273f52e111db3ec4bc994eafe93494077df5b13c60328a571`. Its Node/V8 timing includes benchmark-oracle encoding, decoding, validation, and food transformation as labeled, but excludes the shipped Swift encoder, Expo/JSI, Hermes, PhotoKit, Vision, persistence, scheduling, and rendering. It is structural evidence rather than an app-level speed claim.

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

Test and profile the bounded native thumbnail-preheat planner without accessing Photos:

```sh
pnpm test:initial-image-preheat-planner
pnpm profile:initial-image-preheat-planner -- --window-size=48 --window-step=12
```

The planner now drives the shared `PhotoAssetThumbnailStore` behind the explicit `PALATE_PHOTO_THUMBNAIL_PREHEAT_STRATEGY=windowed-v1` opt-in. Missing or invalid values resolve to `off`. The first production producer is the visit-detail `PhotosSection`, which orders visible rows first, then three rows ahead and one behind, and ends its unique lease on blur, backgrounding, and unmount. Photo-data identity changes retain and clamp any still-valid visible rows; only bootstrap or an exhausted retained window returns to row zero, and a refresh that cannot form a valid size/scale plan ends the previous lease. The separate Visits/Review `expo-image` preview renderer is intentionally unchanged and must not inherit speed claims from this path. Native bounds are 24 unique assets, 4,194,304 target pixels, and a nominal 16 MiB at four bytes per target pixel. The store holds active `PHAsset`s strongly, stops replaced render variants before starting new ones, shares batched asset fetches with visible requests, and uses the same `PHCachingImageManager` and exact request-option values for preheat and load. Network access remains enabled to match visible requests exactly, so speculative iCloud work is a promotion risk and the feature remains off by default.

The synthetic planner profile still compiles the native planner directly, uses opaque identifiers, and validates every ordered start, stop, retained, and active-key identity before timing. Its `independentFullWindowStarts` arm models issuing all starts from fresh planner state and does not model a stop-all call; its zero stop count is therefore not comparable with the preheated arm's per-key stops. The byte bound is nominal and requires headroom for row alignment, image-object overhead, and PhotoKit's opaque cache overhead. The report always records `accessesPhotoLibrary: false`; planner CPU timings and structural operation reduction are not image-loading speed claims.

Profile the wired store against this Mac's real Photos library without running metadata or Vision work:

```sh
pnpm profile:initial-image-preheat -- --image-counts 9,24 --image-width 384 --image-height 384 --image-iterations 4
pnpm test:initial-image-preheat-summary
pnpm profile:initial-image-preheat-summary -- --input=/absolute/profile.json --output=/absolute/summary.json
```

The schema-2 dedicated mode gives each arm globally disjoint lead and target windows, counterbalances target recency and execution order independently in complete four-iteration blocks, and compares the same shared thumbnail-store request path with and without target-window preheating. Its fair performance metric is one monotonic interval that starts before candidate preheat submission (and at the equivalent point for control) and ends when the target window is terminal. Phase markers retain isolated lead and target request timings while exposing preheat submission, lead validation, the metrics barrier, and target submission; the summary therefore cannot drop the work between phases by adding two isolated timers. Native execution terminates on failed, timed-out, duplicate, unexpected, dimension-invalid, digest-mismatched, non-quiescent, or counter-inconsistent work. Every lead and target checkpoint records all fetch-scheduler counters plus an explicit quiescence bit; aggregate batch/identifier totals must equal the scheduler's visible-plus-preheat totals, and active or queued physical fetch work makes the raw profiler exit nonzero after its error report is saved. The summary repeats those checks and also rejects edited or truncated reports with missing schedule fields, duplicate/missing iteration identities, paired assignment mismatches, or incomplete four-way balance. It derives the expected active key count from the recorded target dimensions, bytes-per-pixel estimate, and key/pixel/byte bounds instead of assuming the key-count limit is always the tightest bound.

The July 10 real-library report (SHA-256 `b34fb445b24ab20b84609c93974f0e20474aefd3faa6872a92b82644d5808eda`) and summary (SHA-256 `897a9d05662c6835bf7f69bbef4842dc6e491263c9dde16e6f3a38af21423bc9`) are historical mechanism-only evidence: all requests completed correctly, target requests benefited after preheating, and the candidate used one grouped cache-start call without an extra total identifier fetch. Its former lead-plus-target percentages are superseded because that sum omitted the untimed preheat head start plus validation/metrics soak between phases. It must not be used as end-to-end performance or promotion evidence.

The corrected schema-2 profile at `.build/initial-image-preheat-profile-20260711T0440Z.json` (SHA-256 `1ba8d966c2e39d95310ffb43c3099dfcc77267740cdfa0cdd47623ad03cdefa9`) and its aggregate summary (SHA-256 `cb8e467739102b450a6c30c3f138c8b934e9fb3f0f2e2f1d56dcb2616254e2d0`) validated correct output and physical scheduler quiescence for all 528 globally disjoint assets. The fair continuous-cycle medians for 9 images were **49.5132705 ms control** and **45.805354 ms candidate** (**1.0809494×, 7.4887% lower**); for 24 images they were **99.052021 ms** and **90.2147085 ms** (**1.0979587×, 8.9219% lower**). This is repeatable evidence for an isolated initial-window benefit, but promotion also depends on the production-shaped scroll result below.

Test the production-shaped scroll planner/report without Photos access, or run its dedicated native profiler against this Mac's real image and video assets:

```sh
pnpm test:thumbnail-scroll-profiler
pnpm profile:thumbnail-scroll
pnpm profile:thumbnail-scroll -- --scroll-visible-rows 4 --scroll-fling-windows 4 --scroll-width 480 --scroll-height 480 --scroll-iterations 4
```

`thumbnail-scroll` compares four policies through the exact shared `PhotoAssetThumbnailStore`: control (no preheat), current-visible then ahead then behind candidates, ahead then nearest-behind then current-visible candidates, and future/ahead-only candidates. Every arm submits visible requests before its candidate list, matching FlashList render-before-viewability ordering; candidate order is the only arm difference. The default models the three-column grid's 3.5-row viewport as four visible rows, plus three rows ahead and one behind, at 480×480 pixels. The 4,194,304-pixel/16-MiB native budget therefore admits at most 18 of a 24-key full window, making candidate priority observable rather than assuming the nominal 24-key cap.

Each four-iteration block balances arm recency and execution-position marginals and uses globally disjoint assets. Recent image and video identifiers are interleaved at a target 5:1 ratio; both use the production `PHCachingImageManager.requestImage` path. A library with no eligible video records an explicit images-only limitation instead of implying mixed coverage. Reports contain only counts and unordered/ordered digests, never raw Photos identifiers, URIs, dates, or filenames, and the wrapper retains the JSON as mode 0600.

One burst starts current-visible requests, immediately replaces speculative windows while the first fetch may still be active, then starts the destination-visible requests without cancelling the current requests. The report separates current- and destination-window latency, destination-terminal cycle latency, and the later of both issued visible terminals. It snapshots every scheduler supersession, promotion, invalidation, queue high-water, fetch-source, preheat start/stop/retain, and cache-call counter; all visible results must be exact, the logical lease must end, and the physical asset-fetch scheduler must drain before cache cleanup.

Resident memory is sampled from `mach_task_basic_info.resident_size` on a separate serial queue. The user-phase peak through destination terminal is separate from after-end and after-cleanup diagnostics. These are same-process, allocator- and PhotoKit-cache-contaminated samples that can miss brief peaks; they are not resettable per-arm process peaks or promotion-quality memory evidence.

The 12-iteration real-library report at `.build/thumbnail-scroll-profile-20260711T0445Z-12.json` (SHA-256 `275d53fa5be12cd2979f067783a5fbd817006506fa1e94a10a85b8a08065fbad`) validated correct results and physical scheduler quiescence for all 3,456 globally disjoint mixed image/video assets. The production-order current-visible-first policy made current-window latency **1.129285× faster**, but its terminal scroll cycle was **0.990331×** control—about **0.97% slower**, effectively neutral. Ahead-and-behind-first regressed current-window latency by **18.3%**, and future-only regressed terminal cycle latency by **15.3%**. Same-process RSS medians ranged only from 8 to 32 KiB, but the first control process recorded a 26,968,064-byte warmup peak; this remains diagnostic rather than promotion-quality memory evidence.

The scheduler now admits at most one physical asset fetch, replaces obsolete queued preheat work, and promotes or shares visible demand; deterministic tests validate that the speculative backlog observed during the earlier signed UI stress pass is fixed. That pass still received a critical-memory-pressure notification, and exact option parity still permits speculative iCloud downloads. Because the production-shaped cycle is neutral despite the isolated initial-window win, and memory/iCloud risks remain, the preheater stays `off` by default. This profiler result is not a new signed Palate UI validation.

Test the production-shaped card-preview plan without opening Photos, or run its dedicated cold native benchmark against this Mac's real image and video assets:

```sh
pnpm test:preview-cards-profiler
pnpm profile:preview-cards
pnpm profile:preview-cards -- --preview-visible-cards 4 --preview-width 1200 --preview-height 320 --preview-iterations 12
```

`preview-cards` is isolated from the production renderers and never enables preheat. Its baseline reproduces the underlying Expo `PhotoLibraryAssetLoader` PhotoKit behavior used for `ph://` items: one `PHAsset.fetchAssets` call per item, `PHImageManager.default()`, current/high-quality/fast options, and an aspect-fit request at the source-aspect target needed to cover the item. The candidate uses the exact `PhotoAssetThumbnailStore` with batched asset lookup, `PHCachingImageManager`, opportunistic delivery, exact resize, and aspect-fill item targets. This is a cold underlying-PhotoKit comparison; it does **not** model or claim parity with `expo-image`/SDWebImage's warm memory or disk caches.

The default models four simultaneously visible cards. It rotates 1-, 2-, and 3-item card arities across a 1,200×320-pixel strip, producing 1,200×320, 600×320, and 400×320 item targets. Each complete 12-iteration block crosses all three geometry rotations with both recency slots and both execution positions independently for each strategy. Assignments are globally disjoint. Assets are stratified from separate recent-image and recent-video PhotoKit lists rather than claimed to be one global chronological list; when videos are available, the default selection places roughly one video in each eight-asset stride. An images-only library is labeled explicitly.

Reports separate the first and all-strip-renderable times from all-final and per-item final p50/p95/max timing. A candidate degraded result counts as renderable, matching opportunistic display behavior; the high-quality baseline becomes renderable only on its final result. Reports also retain candidate degraded counts, final decoded dimensions and pixel totals, RSS checkpoints/peaks, and the candidate store's complete fetch-scheduler and preheat metrics before and after cleanup. RSS baselines are captured after the per-run loader/store is constructed, matching an already-available production store more closely; they remain same-process diagnostics contaminated by allocator and PhotoKit state from prior runs. The run fails on missing/failing/timed-out results, invalid dimensions, unexpected or stale callbacks, digest mismatch, a non-quiescent scheduler, any preheat use, incomplete factorial balance, or raw identifier leakage. Validation booleans are derived from the completed measurements and plan before publication; aggregate JSON contains no Photos identifiers, URIs, dates, or filenames and is retained mode 0600.

Cancel/resubmit and warm-revisit arms are intentionally deferred from schema 1. They require separate semantics and, for warm revisits, cannot be described as an Expo/SDWebImage cache comparison using only this native PhotoKit executable. No real-library speedup is claimed until a retained report passes the strict wrapper validation.

Test and profile the Michelin location index without building the app:

```sh
pnpm test:location
pnpm profile:location --queries=5000
```

The location profile validates every indexed result against an equivalent geodesic brute-force search before timing. It reports the one-time index build, the prior approximate linear implementation, equivalent geodesic brute force, indexed geodesic lookup, and both speedup ratios.

Test the production Michelin suggestion-index projection, then profile it against an immutable Palate database:

```sh
pnpm test:michelin-suggestion-index-projection
pnpm profile:michelin-suggestion-index-projection -- \
  --database=/absolute/path/to/photo_foodie.db \
  --samples=11 --warmup=3
```

The app, focused test, and profiler share `ACTIVE_MICHELIN_SUGGESTION_LOCATIONS_SQL`; the production index now receives only the fields it consumes:

```sql
SELECT m.id, m.latitude, m.longitude
FROM michelin_restaurants m
JOIN app_metadata metadata
  ON metadata.key = 'michelin_dataset_version'
 AND m.datasetVersion = metadata.value
```

The baseline uses the exact literal former SQL shape, including the same `metadata.key = 'michelin_dataset_version'` predicate; it replaces only the three selected columns with `m.*`. The measured strategies therefore differ only in projected columns.

They also share the exact production search policy: a **200-meter** suggestion radius, a **100-meter** primary-match radius, and a limit of **5 suggestions** per visit. The test compares exact IDs and distances with the former full-row index across distance boundaries, ties, antimeridian and pole cases, validates the production loader seam, and exercises the profiler's immutable-source, sidecar, counterbalancing, and aggregate-only privacy contract.

The immutable real report used all **28,785 active guide rows** and all **6,511 valid stored visit centroids**. It reproduced exactly **5,141 suggestions** and **1,180 primary suggestions**, reduced the modeled JSON-structural payload by **78.614%**, and left the database main/WAL/SHM/journal set unchanged. Across 11 counterbalanced pairs, median load improved from **22.062167 ms to 8.190750 ms (2.6935466×)** and median load/build/search total improved from **69.780333 ms to 51.080167 ms (1.3660945×)**, with **11/11** projection wins. Aggregate-only report SHA-256: `492726ec6ddca9e3cee9167d5662db5d7b0c5d28bc2948a2fddca65f2da4c78b`.

This is an isolated Node/V8 `node:sqlite` measurement. It excludes Expo SQLite scheduling and serialization, Hermes and React Native, suggestion persistence, and UI work. For a stable full workload it searches every valid centroid, whereas the production paths ordinarily search pending visits during a version refresh and new visits as they are created. It is not signed-app integration evidence or an end-to-end speedup claim.

Test and profile provider reservation persistence independently of provider APIs and the UI:

```sh
pnpm test:reservation-import-persistence
pnpm profile:reservation-import-persistence
```

The candidate resolves identities and matching snapshots, plans legacy-equivalent decisions in input order, and applies ordered JSON1 set writes inside one exclusive transaction. `legacy-row-v1` remains the production default; `set-based-json-v1` is an explicit validation seam. Expo's dedicated exclusive connection starts with deferred `BEGIN`, so the candidate first installs the five-second busy timeout and takes a row-neutral writer lock before any recheck read. The independent literal oracle compares counters and complete ordered snapshots of restaurants, visits, suggestions, source mappings, and guide rows. Coverage includes more than 1,000 inputs, frozen snapshots, earlier planned-insert dependencies, repeated targets, source/ID conflicts, equal-start ties, ordered replacement, restaurant optional fields, pinned Los Angeles 23/25-hour DST dates, exact overlap boundaries, late rollback, a real two-connection WAL recheck, and the exact deferred-transaction writer interleaving.

At 256 inputs, calls fell from **709 to 10**, while median file-backed Node/SQLite time was neutral at **5.516 ms versus 5.543 ms (0.995×)**. The 1,000-input shape improved from **34.504 ms to 30.777 ms (1.121×)** and the 5,000-input shape from **1,288.488 ms to 1,097.705 ms (1.174×)**, with exact snapshot parity and 5/5 candidate wins at both larger scales. Smaller shapes were slower and JSON parameter bytes increased, so no production default or threshold has been promoted. The report excludes Expo bridge and scheduling, Hermes, provider fetch/matching, award lookup, duplicate merge, rendering, and signed-app RSS. Aggregate report SHA-256: `f5b26f61e423ad6ef4cf6319a0b2f860950698547fe253a9bb86e0b7def49cb7`.

Test and profile the provider's award-at-visit hydration separately:

```sh
pnpm test:reservation-award-batching
pnpm profile:reservation-award-batching
```

Production groups exact Michelin IDs by device-local visit year, deduplicates within each year, and caps each batch at 1,000 IDs. It maps results back by original input index, including duplicate IDs in different years. A provider-specific reader rejects on database/query failure while treating an all-null record as a successful no-award result. Only rejected batches fall back per ID, under one global eight-request concurrency limiter. Tests pin Los Angeles time and cover DST, the local/UTC New Year boundary, invalid and leading-zero IDs, `NaN`, 1,002-ID chunking, output order, empty/null values, a 1,000-ID all-null success with zero fallback, rejected-batch concurrency/failure isolation, and both production call sites.

The deterministic 139-visit fixture reduced **102 SQL queries to 15** and median file-backed Node/SQLite work from **1.553 ms to 1.239 ms (1.254×)**. The 256-, 1,000-, and 5,000-visit shapes measured **1.543×**, **1.601×**, and **3.239×**, with exact output parity and 7/7 candidate wins at every scale. The benchmark recreates the former `Promise.all` fan-out and one cached-database-promise yield per valid lookup. Its synchronous `node:sqlite` work still cannot reproduce Expo's asynchronous query queue; the synthetic fixture spans 15 local years and excludes guide initialization, provider fetch/matching, persistence, merge work, and UI. Aggregate report SHA-256: `1f8d2e252eb8fc379d043f85c5cdcc3b126868f5ec93b20a4243a110b88fb9a0`.

Test provider geocoding, review reuse, and browser replay control without provider or Google traffic:

```sh
pnpm test:provider-reservation-location
pnpm profile:provider-reservation-location
```

The pure planner shares successful exact-query lookups, retries later duplicate occurrences independently after an empty/rejected first attempt, caps work at four concurrent requests by default, and preserves stable output order plus the legacy direct-coordinate, Google-first, local-fallback, and address rules. Coordinates returned to review are reused by approval. A generation gate rejects identical pending/completed bridge messages and stale completions. The test also executes the production Tock bridge in a VM: incomplete known-count captures send status without payload, a complete retry becomes the first reviewable/cacheable payload, and later deliveries make no GraphQL calls.

At 139 inputs and roughly 50% duplicate queries, the deterministic model reduces **111 requests to 60** and latency units from **780 to 114 (6.842×)**. The 256/50% case is **204 to 108** and **7.186×**; the 1,000/90% case is **800 to 125** and **23.278×**. Three complete Tock deliveries fall from **6 to 2 GraphQL requests**; a short-first recovery falls from **6 to 4** without exposing partial data. All outputs match the literal sequential oracle. This is a fake-network request/critical-path model, not wall-clock provider evidence. Aggregate report SHA-256: `4e438efaa936bb582a596654291a52b2d94b471c66ace691a2d48ff76ea13530`.

Test the provider-review snapshot prefilter independently of provider APIs and React Native:

```sh
pnpm test:reservation-review-prefilter
pnpm profile:reservation-review-prefilter
```

One deferred transaction now selects exact source/dismissal/fingerprint facts and compact confirmed rows only for requested device-local days. The pure matcher retains legacy normalization, fuzzy-name, day, and orphan-source semantics; review construction performs no historical-award queries. After location work, a second selective snapshot covers unresolved candidates while the separate located overlap query remains in place. The WAL regression commits a matching confirmation between the initial reads and a null location result and proves the fresh snapshot excludes it.

At 139 candidates, one snapshot falls from **6 queries / 6,498 rows / 1,173,797 bytes** to **2 queries / 155 rows / 25,051 bytes**, with exact output and median file-backed Node/SQLite work falling from **108.527 ms to 0.887 ms (122.387×)**. At 5,000 candidates it falls from **23 to 2 queries**, removes **19,646,365 local-date comparisons**, and measures **3,882.978 ms to 11.287 ms (344.037×)**. The synthetic report excludes Expo scheduling, provider APIs, the conditional fresh unresolved snapshot, and the post-location overlap query. Aggregate report SHA-256: `1b43d29092b24dd3bb4c5a777497cd7be26cd528f4d3b0a2013559bd339aa9f4`.

Test and profile the production-shared set-based Michelin import against the legacy JavaScript importer:

```sh
pnpm test:michelin-import-core
pnpm test:michelin-import-production-wiring
pnpm test:michelin-import-prototype
pnpm profile:michelin-import-prototype
pnpm test:macos-michelin-import-harness
pnpm test:macos-michelin-import-summary
```

The candidate opens the protected guide through immutable SQLite `ATTACH` and performs one set-based `INSERT ... SELECT` upsert instead of decoding full rows into JavaScript and rebinding 1,000-row batches. Production materializes the signed guide through a verified `.partial` copy and atomic move, uses a dedicated URI-enabled Expo SQLite connection, commits the dataset marker and runtime attestation with the rows, and treats any failure after strategy selection as terminal rather than replaying through a second writer. The real-guide fixture retained exact parity from **28,787 source rows to 28,785 valid imports**, including metadata and production R-Tree contents; its complete restaurant/metadata/R-Tree digest is `91ddd471a6da4880b712c436ea9bde417d1036be010ed7b0756c0712200c8e43`.

Across six counterbalanced pairs, the final isolated run measured **270.677 ms median** for the legacy path and **224.702 ms** for `ATTACH`, a **1.2046× (16.985%)** reduction with **45.974 ms saved**; every pair favored the candidate. It eliminated **28,787 modeled result rows, 34,031,921 result bytes, 287,848 bound values, and 27 statements**; both strategies grew the destination WAL by exactly **8,858,000 bytes**. Aggregate-only report SHA-256: `f0a7ddd77985cc11d7480d893be5fc3bffa74a2c8823975f19842bc9077deeae`.

The Node/V8 timing is still isolated and is not signed-app latency evidence. `validate-macos-michelin-import.sh` provides that separate boundary: it byte-guards and restores the real app database, attests the exact signed Release executable/bundle/guide, verifies the Documents reference copy, and compares IDs plus every persisted field against an independent legacy-semantics oracle with exact Float64 coordinate bits. The fake harness covers both strategies, same-count semantic corruption, materialized-copy mismatch, privacy, SIGKILL recovery, and exact main/WAL/SHM/journal restoration; the strict summarizer requires counterbalanced 3×3 signed inputs with identical provenance.

Test and profile Unicode Michelin name lookup without React Native:

```sh
pnpm test:michelin-name-search
pnpm profile:michelin-name-search
```

ASCII queries retain the existing SQL path. Normalized queries that still contain non-ASCII load an active `{id, name}` projection, reuse a versioned `{id, name, lowerName}` index, apply JavaScript Unicode matching and locale ordering, and hydrate at most 50 ordered winners through JSON1. Active dataset and confirmed-visit exclusions are rechecked during hydration. QueryClient-backed initialization survives concurrent callers but is correctly removed by `clear()`; static indexes use infinite stale/collection times and versioned keys. A version-before/version-after guard retries once if the guide changes during search, removes an attempted stale index after an in-flight mismatch, and uses abort checks to stop stale publication. Only Michelin lookup is debounced by 200 ms.

The suite includes composed/decomposed text, normalization back to the ASCII route, exact ordering, pre-aborted and post-hydration cancellation, cache clear/reinit, fake-clock retention beyond five minutes, continuous version churn, and a real same-ID rename during hydration. On the immutable **28,785-row** guide, the input projection falls from **8,917,897 bytes** of full rows to **187,259 bytes** across 3,737 Unicode-name rows; the retained lowercased index models **303,755 JSON bytes**. Broad `é` improves from **27.595 ms** to **6.703 ms cold (4.117×)** and **1.565 ms warm (17.636×)**; `épi` improves from **27.799 ms** to **5.225 ms cold (5.320×)** and **0.265 ms warm (104.868×)** with exact ordered hashes. Three rapid keystrokes become one logical search and **195,721 modeled native-to-JavaScript JSON bytes** instead of **26,673,315**. These are isolated Node/V8 SQLite/cache measurements. Aggregate report SHA-256: `ec02258e9ea675a7e42be15d3b6232d13df972751948b8e2a49a7c84ba86f537`.

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

Test and profile progressive All Visits hydration separately from React Native rendering:

```sh
pnpm test:visit-list-paging
pnpm profile:visit-list-paging
pnpm profile:visit-list-paging -- \
  --database=/absolute/path/to/photo_foodie.db \
  --filter=all \
  --output="$PWD/.build/visit-list-paging-all-real-profile.json"
```

Production now selects only the fields rendered by the list card and loads 128 rows at a time with one lookahead row. Stable `(startTime DESC, id COLLATE BINARY DESC)` keyset continuation uses the existing time/status/food indexes; the title count comes from Stats rather than the loaded prefix. Infinite pages use mutation-authoritative freshness. Status, food, Calendar, guide-import, and broad-refresh paths reset active queries to one page, clear inactive pages, and cancel in-flight continuations before invalidating other data.

The literal full-query oracle covers every filter, fractional/equal timestamps across boundaries, page sizes 1 through 1,000, Unicode/quoted IDs, joins, previews, validation, and plans. QueryCore cases exercise active, inactive/refocus, broad, Michelin-import, and in-flight reset behavior. The profiler contract executes all filters against disposable databases and rejects main/sidecar output aliases through direct paths, symlinks including dangling links, and hardlinks; it also rejects nonempty WAL/journal inputs and symlink sources, requires mode `0600` aggregate-only output, and compares source component presence, mode, size, device, inode, and SHA-256 before and after.

On the immutable current-Mac **6,511-visit / 68,028-photo** database, All retained exact complete/prefix parity while the initial result fell from **6,511 rows / 4,525,164 JSON-equivalent bytes** to **129 rows including lookahead / 46,046 bytes (-98.982%)**. Median query plus parsing fell from **37.044 ms to 0.551 ms (67.265×)**; forced 51-page traversal measured **23.658 ms (1.566×)**. Pending measured **69.615×** on the same rows. Food reproduced 1,020 rows, reduced first-page bytes from **765,362 to 52,187**, and measured **8.030 ms to 0.712 ms (11.282×)**. Confirmed and Rejected were empty, so they establish parity and plans only.

The profiler holds one read transaction; production page calls use independent snapshots plus tested mutation resets. Node/V8 timings exclude Expo, the bridge, Hermes, FlashList, Photos, and Calendar. Aggregate report SHA-256 values: All `5403818fdc1b82898d631a080c9ffc906baf733ba61e916bd422f0ba61b5fac0`, Pending `4accdc41c737b58dc08f1e367259486139b14a9a19a12fe5a7d24a8d5d2623bd`, Confirmed `e04f3843013e214eabef59e38d20588d63839f648c73dbc087724c8b7a276e08`, Rejected `377ea807b83e5724e88322f6e3eb3dad4bbd0eb0892cfda9958c20d8364b3f09`, and Food `b513b359121bf524a4563a1d5f98106a368ba711ebaff3dd2d91973bf27d5353`.

Test and profile the pending-review query in isolation:

```sh
pnpm test:pending-review
pnpm profile:pending-review
pnpm test:pending-review-paging
pnpm profile:pending-review-paging
```

The production query probes `idx_photos_visit_preview` once per pending visit and stops after its first three photos instead of assigning a window row number to every pending photo. The photo ID is a deterministic final key for equal food/creation-time ranks. The focused test compares complete raw rows against an independent window-function oracle across every review priority, direct and nearby suggestions, nested food labels, unanalyzed and no-photo visits, malformed JSON, status exclusion, Unicode, and equal-rank ties. It also verifies that suggestion JSON satisfies the full `SuggestedRestaurantDetail` contract, including `latestAwardYear`.

The default synthetic profile uses 4,000 pending visits and exactly 68,027 photos, validates full raw-row parity and SHA-256 checksums before, during, and after timing, alternates query order, and asserts that the preview lookup uses the expression index without a temporary sort or window function. It writes `.build/pending-visit-review-profile.json`. Timings are Node/V8 plus in-memory SQLite, not the Expo bridge or the real app database.

The production Review screen now consumes a compact global manifest and progressively hydrates 128-row `json_each(?)` detail pages. The manifest retains global exact matches, filter membership, counts, and order; Approve All therefore remains complete before every card is loaded. Infinite-query cache updates cover every filter generation, and selective rollback restores only failed IDs. Quick Actions uses a separate slim all-row projection containing only its bulk-decision fields while retaining the same root Query key, so optimistic removal and rollback remain shared and Review pages stay descendant caches.

All three suggestion aggregates share `vsr.distance ASC, m.id COLLATE BINARY ASC`. A read-only real-database audit found that the former implicit orders disagreed for 997 of 6,511 visits and selected a farther duplicate-name branch in three exact matches; after the shared order there are zero mismatches. The regression fixture makes the far ID sort first, then asserts the near ID and coordinates, rendered order, exact confirmation identity, and all four filters.

On the immutable current-Mac snapshot, the promoted bootstrap—including manifest SQL, strict parsing, global title matching/filter planning, and the first 128 heavy rows—measured **24.622 ms median** versus **56.144 ms** for the monolith (**2.280×**). Manifest plus first page transferred **1,118,789 bytes** instead of **7,883,042 bytes**. It retained all 6,511 manifest items and selected 276 exact plus 330 manual visits under the default on/on filters; the source database and sidecars remained byte-identical. Aggregate report SHA-256: `dbfadd1d3194404abf4d725465c86e389ec214f8e4d3423dccdf52616b955419`. These timings exclude Expo scheduling, Hermes, bridge conversion, rendering, Photos, and live Calendar access.

The Quick Actions projection has its own independent legacy oracle and focused wiring/cache tests:

```sh
pnpm test:quick-actions-query
pnpm profile:quick-actions-query
```

On the same immutable source it reproduced all **6,511 pending visits**, **276 exact matches**, and every food/unmatched/threshold action count. JSON-equivalent payload fell from **7,883,042 to 2,241,436 bytes (71.566%)** and median query/transform work from **67.650 ms to 32.323 ms (2.093×)**, with 9/9 paired wins and byte-identical database sidecars. Report SHA-256: `1d64647e085c92fbe6d5ae108e857feda4a05ceb67804aaf1f0603e6d61da43c`. These timings include Node/V8 SQLite, row conversion, JSON parsing, food-label reduction, and Calendar title matching, but exclude Expo scheduling, the native bridge, Hermes, rendering, Photos, and live Calendar access.

The always-mounted visit restaurant-search modal now has a separate lazy projection:

```sh
pnpm test:confirmed-restaurant-search
pnpm profile:confirmed-restaurant-search
```

It executes no query while closed or open with blank input. Typed search loads only the fields consumed by visited-restaurant options plus latest-visit ordering, while retaining the exact JavaScript name filter, similarity ranking, Michelin replacement, and parent-key invalidation contract. On 1,200 synthetic confirmed restaurants, closed and blank states each fall from **1,200 rows / 828,734 bytes to zero**. Typed search retains exact results while reducing modeled bridge bytes by **68.232%** and median SQLite/transform work from **9.153 ms to 1.878 ms (4.873×)**. This excludes Expo scheduling, Hermes, bridge conversion, and rendering. Aggregate report SHA-256: `c99f0acd6d7b20199fafa7f8f6d711a9786b51c0ff357cfc5ede44f7b3306be0`.

Test and profile Review query-cache reuse independently of React Native:

```sh
pnpm test:review-query-policy
pnpm profile:review-query-policy
pnpm test:review-mutation-cache-policy
pnpm profile:review-mutation-cache-policy
```

Fresh pending-review data is reused for 30 seconds across navigation remounts. The large cache is isolated from general visit-prefix invalidation, so successful optimistic status actions no longer immediately fetch it again. Scoped mutation functions, a shared ordered rollback baseline, successful-ID ownership, late-refresh cancellation, and canonical error/Undo refreshes preserve correctness under overlap. Manual refresh remains limited to the active pending-review and unanalyzed-photo-count keys.

The mutation contract uses production-shaped visits/exact matches and covers stable rollback, different- and same-ID outcomes, immediate optimism with serialized database work, no-refetch stale marking, and a pre-write refresh that starts after optimistic setup. At the live 6,511-row/7,883,042-byte scale, the ten-action structural model measured 51.693 ms to 9.305 ms median (5.555×, 7/7 paired wins) and avoided 78,830,420 modeled parsed bytes. Its aggregate report SHA-256 is `30910499c14270dac13166ee22e94938404a91133ef816c937bb7a64a8ecfbb2`. This is QueryCore plus exact-size Node/V8 JSON parsing and excludes Expo SQLite, bridge transfer, Hermes, rendering, Photos, and Calendar access.

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

Test and model the adaptive visit-food schedule:

```sh
pnpm test:visit-food-adaptive-scan
pnpm profile:visit-food-adaptive-scan
pnpm test:visit-food-detection-strategy
pnpm test:visit-food-detection-orchestration
```

New native builds with no environment override default to `rank3-bulk-tail-v1`; an invalid explicit native override fails safe to the literal `full-plan-v1` path, and older binaries whose exported strategy is missing or invalid retain `full-plan-v1` in JavaScript. Either strategy remains available through `PALATE_VISIT_FOOD_DETECTION_STRATEGY`. The adaptive path uses three sample-rank waves, each durably checkpointed before the next wave is planned, followed by one stable visit-major rank-4-and-later tail for visits still nonpositive. It reuses one keyword load, the bounded Vision pipeline, one buffered persistence lifecycle, and one final derived-visit synchronization. Missing or failed results stay retryable; rows skipped because their visit already became positive are never written false. Tests cover native/TypeScript strategy fallback, exact positive-set parity, stable ordering, checkpoint durability, latched persistence failures, retry boundaries, and terminal progress.

The retained current-control model contains **6,511 visits, 13,059 planned attempts, and 1,020 positive visits**. A fully adaptive schedule would use 173 modeled native calls and was rejected. The bounded three-rank candidate keeps the full plan's **14 calls** while attempting **11,439 rows**, avoiding **1,620 (12.405%)**, with exact positive-visit parity.

The guarded signed real-library A/B used executable SHA-256 `3a40186747dd75d16d21d29fae34ba9e4a4159eb97d306c1a7a84fcb13ea4c57`, `main.jsbundle` SHA-256 `f31f7cca98192cb58f5505dbf16b3c3a3639e894712c5900a12d66fc2cd78a1d`, and semantic-reference SHA-256 `a5ca25545c7be494cf3461e2b7246f8e5b16fd332b573b98f38e7bbe63e26620`. Across three valid reports per arm, full-plan measured **51.143741 seconds median** and adaptive measured **43.149852 seconds median** in the durable tail, a descriptive **15.63% reduction**; adaptive won all three positional pairs and avoided exactly 1,620 direct native requests per run. Median sampled peak RSS increased **7.78%**, from 588,224 to 633,984 KiB. Every included run had exact strategy/visit parity, balanced schema-2 dispatch counters, strict signed-build identity, and exact database/environment restoration. Aggregate summary SHA-256: `342c0cb8e9a85e79084ebda7bd87064b24404545e8259e4c02608cad1fdbe80e`. One additional back-to-back full-plan attempt was excluded before report publication after macOS cancelled an Apple Neural Engine request with 933 rows pending; its guard still restored the live database exactly, and the same full arm passed after restarting Xcode. The validated adaptive strategy is now the production default.

The post-promotion Release rebuilt and passed strict signature validation with executable SHA-256 `11d86b3a47db25c9eedd05d07ff0c9ba8d710b8a6b6bee1a98519bc2e01938f8`, `main.jsbundle` SHA-256 `b28419530a518a394b7aa1fa8da353deee44100b4d27a2a299a75fd0b76fb003`, and CDHash `313086a7eabcab59755e2379fd8037ff32874036`. This is compile/sign evidence only; the controlled real-library timings above belong to the attested three-pair build.

Test the restaurant viewport index in isolation, then profile it over a deterministic representative camera trace against the bundled Michelin database:

```sh
pnpm test:map-viewport
pnpm profile:map-viewport
```

The pure test covers coordinate normalization, zero-sized and whole-world viewports, inclusive bounds, antimeridian wrapping, ranking precedence, invalid inputs, count-only mode, and stable top-500 ties. The benchmark's exhaustive selection is an independent oracle for viewport bounds, antimeridian wrapping, ranking, stable ties, and the top-500 limit. The measured candidate imports the same persistent KDBush index and bounded top-K heap used by the app; timing starts only after exact result parity and deterministic checksums pass.

The production map's SQLite/R-Tree selector has its own full-field parity suite and aggregate-only benchmark:

```sh
pnpm test:map-viewport-query
pnpm profile:map-viewport-query
pnpm profile:map-viewport-query -- --database=/absolute/path/to/photo_foodie.db
```

The real-database mode opens main as `mode=ro, immutable=1`, rejects nonempty WAL/journal inputs and output aliases, builds the R-Tree only in a disposable scratch database, and verifies main/WAL/SHM/journal hashes, modes, integrity, foreign keys, and `total_changes()` before and after. The report separates the single viewport-subsystem initial request from a baseline-favorable repeated camera/filter trace; neither timing includes the screen's common confirmed-restaurant query, Expo bridge transport, React rendering, or MapKit drawing.

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

It captures the supplied live main/WAL/SHM/journal set and modes in a durable guard before any SQLite access, prepares and installs only a disposable classified-photo fixture, waits for a manually launched Xcode app and timestamped atomic trigger, then samples durable pending-row progress and RSS every 0.2 seconds. The supplied and running signed Release executable and `main.jsbundle` must match exactly. Xcode's **Run Without Building** action is used because a Designed-for-iPhone bundle cannot be launched correctly with `open`.

Schema 6 supplements process-environment observation with an atomic native schema-2 result-transport attestation updated at every classification dispatch start and completion. Its run ID, configured, resolved, and selected transport must all match the request; its timestamps must fall between trigger and durable completion; and its privacy-safe aggregate batch/requested-asset counters must have a balanced, fully resolved lifecycle. The validator compares those direct totals with the strategy plan and durable result-state oracle. Older schema-1 attestations remain accepted for compatibility unless `--require-native-work-counters` is supplied. The report's primary timing remains the tail from the first observed durable flush through completion, so it excludes launch, UI-trigger latency, and the first flush and is not total user-perceived scan time. Full-plan validation uses deletion-safe joins for exact semantic photo/visit parity and requires zero pending rows. The adaptive arm instead requires exact positive-visit IDs, exact reference semantics for every durable successful expected attempt, NULL skipped rows, and complete planned/attempted/skipped/retryable accounting. Its pending rows must be explainable only as skipped-after-positive or retryable missing/native-failed expected attempts. Both strategies require integrity `ok`, no foreign-key violations, and exact restoration before aggregate output is published.

The guard records the exact unset, empty, or populated state of all nine Vision launch variables: visit-food strategy, result page size, result transport, native-attestation path, classification strategy, page orchestration strategy, concurrency, pipeline depth, and validation run ID. It also records eight private temporary paths, including the attestation path. Success, failure, interrupt, and timeout restore the original database components, modes, and environment exactly; raw database copies are deleted by default. Stale-guard recovery accepts the current nine-key manifest and older eight-, seven-, or six-key forms, while rejecting malformed or corrupted recovery evidence.

`--visit-food-detection-strategy=full-plan-v1|rank3-bulk-tail-v1` selects the validation arm and defaults to full-plan. The adaptive completion boundary uses a disposable non-boolean visit sentinel that only the final derived-visit synchronization can clear. Schema 6 reports the direct native batch/requested-asset aggregates alongside the deterministic rank-plan and durable-state breakdown; it emits no asset identifiers. The fake harness covers schema-1 compatibility, strict schema-2 enforcement, lifecycle and count mismatch rejection, both strategies, retryable early-rank and tail outcomes, skipped-write rejection, process-environment mismatch, private reports, and exact recovery.

Trigger **Deep Scan All Photos** for controlled visit-food runs. The native validation-only gate requires both the existing nonempty run ID and an absolute result-transport attestation path; only then does Deep Scan invoke the same visit-food phase for both arms while suppressing every automatic Deep Scan entry point before the manual trigger. Outside validation, explicit Deep Scan always retains its full supplied-or-pending-photo contract regardless of strategy. **Rescan Now** is not valid for this isolated harness because its earlier Photos and Calendar phases can import newly visible library state. The production visit-aware default is `rank3-bulk-tail-v1`; the validator itself still defaults to the full-plan control arm unless a strategy option is supplied.

For the signed strategy A/B, collect at least three retry-free schema-6 reports per arm with `--require-native-work-counters` and otherwise identical signed build, reference, fixture, tuning, orchestration, transport, and classification configuration. The strict mode-0600 summarizer rejects duplicate, mismatched, or unbalanced evidence and emits only aggregate descriptive results:

```sh
pnpm test:macos-vision-visit-food-summary
pnpm profile:macos-vision-visit-food-summary -- \
  --full-plan-v1=.build/full-1.json,.build/full-2.json,.build/full-3.json \
  --rank3-bulk-tail-v1=.build/rank3-1.json,.build/rank3-2.json,.build/rank3-3.json \
  --output=.build/macos-vision-visit-food-ab-summary.json
```

Reported timing, sampled RSS, direct requested assets/native batches, avoided work, and positional-pair/median deltas are non-causal diagnostics, not significance claims. The durable tail excludes launch, manual trigger latency, and the first observed flush. `rank3-bulk-tail-v1` is the production visit-aware default; full-plan remains available as the control and older-binary fallback.

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

The 2026-07-10 signed replay exercised the changed real library without retaining its private reference. Capture A attested five newly visible assets and baseline-preserving growth to 68,033 photos, 6,512 visits, 2,001 Calendar links, and 1,162 distinct events in 7.995144 seconds. Replay B reproduced every visit (excluding only `updatedAt`), photo, suggestion, and metadata row exactly in 6.203330 seconds; integrity was `ok`, foreign-key violations were zero, and the identifier-list attestation balanced 68,028 excluded plus five unknown assets against the 68,033-asset PhotoKit total. The supplied and running Release hashes matched at executable `d0c0cdb18c52a24c46249c82f237f4c9ac2102c13ac3229558ff735324550bbb` and `main.jsbundle` `b51c28926ed81b2680ec651a93934aad0836b5867e41a6149a70a9450dd4c6c3`; replay report SHA-256 is `3e0f2d32ee9ec42cf4f3cd6a31debbc1bcc7ed1b313dd256ca27756411913730`. The private reference and triggers were deleted, while the live database main, empty WAL, and SHM were restored to their exact pre-run hashes. This pair is correctness/integration evidence, not an A/B performance result.

The Calendar wall time is **not isolated EventKit latency**. It begins at a timestamp recorded immediately before the manual Rescan tap and ends at the first 0.2-second sample that observes durable Calendar restoration. It therefore covers the Rescan Photos prefix—including PhotoKit asset metadata scanning and visit grouping before Calendar matching—while excluding later food-detection and database-maintenance phases. Manual reaction time and 0.2-second sampling quantization limit precision. [EventKit's documented `events(matching:)` contract](https://developer.apple.com/documentation/eventkit/ekeventstore/events%28matching%3A%29) returns all events matching a predicate, while Palate additionally splits broad ranges into bounded three-year windows.

Vision validation reset the same 13,059 previously classified rows to pending while keeping the other 54,969 rows outside the fixture, then ran the same current app twice against this Mac's real Photos library. The synchronous native baseline took 60.17 seconds from scan command to durable completion; the default two-worker, depth-four pipeline took 58.84 seconds, a 1.023× (2.21%) improvement. Peak RSS was effectively unchanged at 618,928 versus 619,840 KiB. Both runs persisted in 1,000-row steps with a final 59-row remainder, produced all 13,059 outcomes, classified the same 2,526 photos as food, matched every stored label and confidence semantically, matched every derived `visits.foodProbable` value, left no pending fixture rows, and passed SQLite integrity. Raw JSON strings can differ only in native dictionary key order; label order, values, and confidence bits were identical. A depth-eight tuning run remained exact but took 59.86 seconds, so depth four remains the production default.

Result-page tuning first used the same fixture in counterbalanced 200/1,000/200/1,000 order. Trigger-to-durable-completion for page 200 was 56.863 and 56.398 seconds (56.630-second mean); page 1,000 was 55.600 and 55.490 seconds (55.545-second mean), 1.92% lower, with both 1,000-row runs faster. Mean peak RSS fell from 614,888 to 608,864 KiB.

A second A/B/A/B set added process-environment attestation and measured the durable tail from the first observed 1,000-row commit. Page 200 took 62.572 and 56.779 seconds (59.675-second raw mean); page 1,000 took 56.666 and 56.290 seconds (56.478-second mean). The 5.36% raw mean reduction is dominated by the first cold/noisy 200-row run; the second paired comparison is the more conservative 0.86% reduction. Mean peak RSS was 608,312 versus 599,272 KiB, but two samples per setting are not enough to characterize memory. All eight result-page runs had zero semantic photo mismatches, zero deletion-safe visit mismatches, zero pending rows, and clean SQLite integrity before restoring the same database hash. The production result-page default is therefore 1,000; `PALATE_VISION_RESULT_PAGE_SIZE` remains available for bounded 1–2,000 experiments, while JavaScript retains a 50-row fallback for older binaries that do not advertise a valid native value.

The same signed validator now accepts `--result-transport=legacy|packed-v1` and defaults to legacy. Initial signed evidence did not demonstrate an end-to-end packed win, while the current balanced schema-6 series remains incomplete, so legacy remains the production default and packed V1 remains opt-in. New A/B inputs must be captured with `--require-native-work-counters`; both strict summarizers reject schema-1 inputs and require balanced schema-2 batch/requested-asset totals. Validate the aggregator contract and summarize only completed balanced report groups with:

```sh
pnpm test:macos-vision-transport-summary
pnpm profile:macos-vision-transport-summary -- \
  --legacy=.build/legacy-1.json,.build/legacy-2.json \
  --packed-v1=.build/packed-1.json,.build/packed-2.json \
  --output=.build/macos-vision-transport-ab-summary.json
```

The validator rejects an external semantic reference with a nonempty WAL or rollback journal before opening it as immutable, attests the exact main/WAL/SHM/journal set through report publication, and records each component's presence, SHA-256, mode, and byte count in schema 6. The summarizer requires those component attestations, distinct run IDs, at least two samples per transport, and uniform build bytes, fixture, tuning, semantic reference, original database set, parity, privacy, restoration, native selected-transport attestation, and direct balanced native work counters before calculating descriptive timing and RSS statistics.

The pipeline timings are one controlled end-to-end A/B pair, while each result-page set uses only two counterbalanced samples per setting; none is a statistically stable device-wide benchmark. Photos and Calendar were read-only throughout these production-app fixture runs. The mutation profiler separately writes only deterministic synthetic events to a uniquely named temporary calendar and verifies their deletion. After every fixture run the app was stopped, transaction sidecars were removed, and the original database was restored byte-for-byte; the restored database contains 68,028 photos, 13,059 classifications, 2,526 food photos, 6,511 visits, and 2,000 Calendar links with a clean integrity check.

# Native profilers

This Swift package exercises the Expo-independent calendar and photo cores used by the app without building React Native.

Run all permission-free native tests, or one subsystem in isolation:

```sh
pnpm test:native
pnpm test:calendar
pnpm test:photos
```

Profile calendar matching without EventKit, Photos, React Native, or SQLite:

```sh
pnpm profile:calendar
pnpm profile:calendar --visits 2000 --events 20000 --iterations 7 --warmup 2
```

The seeded synthetic harness validates the indexed native matcher against an exhaustive reference before recording any timing. Its JSON report includes the input sizes, match checksum, individual samples, median and p95 durations, and speedup. The fixture exercises strict overlap boundaries, stable relevance ordering, and a realistic mix in which only some visits have nearby restaurant suggestions; the focused calendar tests cover title cleaning, exact-before-fuzzy selection, accents, emoji, apostrophes, ampersands, and ECMAScript whitespace parity separately.

The production Expo module also avoids the legacy calendar bridge: one JavaScript call queries EventKit in bounded native windows when needed, filters and deduplicates full native event objects, runs this core on its serial queue, and returns only the selected minimal records. The synthetic profiler measures the shared matching core; the complete EventKit and Expo bridge are compile-tested by the app build below.

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

Compile the complete app for the macOS “Designed for iPhone/iPad” destination without launching it:

```sh
zsh scripts/build-macos-designed-app.sh
```

The script verifies the output executable and `NSPhotoLibraryUsageDescription`, prints its path, and deliberately defaults to `CODE_SIGNING_ALLOWED=NO`. A signed integration build can opt in after the local Apple Development certificate is valid:

```sh
PALATE_CODE_SIGNING_ALLOWED=YES \
PALATE_ALLOW_PROVISIONING_UPDATES=1 \
zsh scripts/build-macos-designed-app.sh
```

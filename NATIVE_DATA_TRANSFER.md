# Native data transfer and parsing

Research and source verification: September 5, 2026. This checkout now uses Expo
57.0.20, ExpoModulesCore 57.0.16, ExpoModulesJSI 57.0.8, and React Native 0.86.3.
The buffer direction and ownership table was rechecked against these installed
versions after the dependency update.

The codec and standalone Hermes measurements below were captured before that
update with Expo 57.0.10, ExpoModulesCore 57.0.9, ExpoModulesJSI 57.0.4, and React
Native 0.86.2. Their timings and recorded runtime provenance remain unchanged;
they are not measurements of the upgraded dependency set.

Recheck the installed implementation after upgrades; Expo's `main` branch already
changes the relationship between `ArrayBuffer` and `NativeArrayBuffer`.

## Choose the representation before the framework

Use bounded batches containing only fields the caller consumes. Small scalar
records are the default: their shape is clear, validation is straightforward, and
callers already need their fields as JavaScript values. For large repeated numeric
or classification payloads, a versioned binary buffer can avoid thousands of
native dictionaries, boxed values, and individual JSI property writes. Packing and
decoding still have a cost. Keep large media and reusable native state behind
handles such as Expo `SharedObject` when JavaScript does not need the bytes.
[Expo SharedObjects](https://docs.expo.dev/modules/shared-objects/) describe that
ownership model.

React Native already uses JSI for direct native communication; crossing this
boundary does not inherently require a JSON string. Avoid adding JSON, base64, or
another serialization layer to ordinary module arguments.
[React Native architecture](https://reactnative.dev/architecture/landing-page)
explains the removal of the serialized bridge.

## Actual buffer copies in this installed SDK

| Direction and declared Swift type                       | Payload ownership and work                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Native `NativeArrayBuffer.wrap(dataWithoutCopy:)` to JS | Retains native storage; JS receives a wrapper over the same bytes.                 |
| Native `Data` to JS `Uint8Array`                        | Allocates a JS buffer and copies the bytes.                                        |
| JS `Uint8Array` to native `Data`                        | Copies the view into native-owned `Data`.                                          |
| JS `ArrayBuffer` to native `ArrayBuffer`                | References JS storage; retains a runtime-dependent wrapper.                        |
| JS typed-array view to native `ArrayBuffer`             | Copies the view, respecting `byteOffset` and `byteLength`.                         |
| JS buffer/view to native `NativeArrayBuffer`            | Borrows native-owned backing storage when available; copies JS-heap-owned storage. |
| JS typed-array view to native concrete `TypedArray`     | Wraps the view; element access shares JS storage.                                  |

These distinctions come from the installed `expo-modules-core/ios/Core/ArrayBuffers`,
`DynamicTypes/DynamicArrayBufferType.swift`, `DynamicDataType.swift`,
`DynamicTypedArrayType.swift`, and `Conversions.swift`. The corresponding
[SDK57 buffer implementation](https://github.com/expo/expo/blob/sdk-57/packages/expo-modules-core/ios/Core/ArrayBuffers/NativeArrayBuffer.swift)
and [conversion implementation](https://github.com/expo/expo/blob/sdk-57/packages/expo-modules-core/ios/Core/DynamicTypes/DynamicArrayBufferType.swift)
show allocation, borrowing, and cleanup explicitly.

`wrap(dataWithoutCopy:)` retains an `NSData` bridge of the supplied `Data`; the JS
wrapper shares that retained storage. Bridging tiny inline `Data` values can itself
copy, so this is not a blanket guarantee about every Foundation conversion.

Zero-copy buffers need ownership discipline: finish native writes before handing
the buffer to JavaScript, retain its backing storage until the consumer releases
it, and avoid concurrent mutation. Wrapping `Data` bypasses its copy-on-write
protection against JavaScript mutation. A JavaScript-owned buffer is not an
independent background-work snapshot; copy it when independent ownership is needed.
Never discard a typed-array view's offset by passing its entire `.buffer` blindly.

## Typed records and redundant JavaScript copies

For scalar Records and ordinary arrays, Expo `AsyncFunction` converts arguments
on the JavaScript thread before dispatching the Swift body. `DynamicArrayType`
converts each element, and Record conversion stores native field values. The
Calendar module can therefore accept TypeScript `readonly` arrays and pass them
directly: cloning IDs or rebuilding identical request objects before the call
duplicates the snapshot work. This applies to the current scalar Calendar fields,
not to SharedObjects, buffers, or explicit JavaScript object references.
See [SDK57 AsyncFunction conversion and dispatch](https://github.com/expo/expo/blob/sdk-57/packages/expo-modules-core/ios/Core/Functions/AsyncFunctionDefinition.swift).

Expo's installed `@Record` macro generates direct, statically typed field reads
and writes. It removes the `Mirror`, `@Field` wrapper allocations, property-name
set, and dynamic field conversion of reflective Records. Existing declared
defaults, optional nulls, and domain validation remain explicit. This is still
per-field conversion, not zero-copy object transfer. Inspect
`node_modules/@expo/expo-modules-macros-plugin/apple/Sources/ExpoModulesMacros/RecordMacro.swift`
and `node_modules/expo-modules-core/ios/Core/DynamicTypes/DynamicConvertibleType.swift`.

Validate each external representation at its owning boundary, then use the
validated typed value internally. A binary decoder should check bounds, versions,
UTF-8, identity, and numeric validity while reading rather than build an unchecked
object and traverse it again. Native argument conversion still enforces Swift
types; domain constraints such as timestamp ranges need their own validation.
TypeScript `as`, interfaces, and `readonly` annotations are erased: removing casts
does not remove runtime work, and adding casts does not validate native results.
[TypeScript assertions](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions)
document this distinction.

## Measurements and rollout

Local September 5 codec measurements with equivalent inputs:

| Operation                                               |   Before |    After | Scope                                                         |
| ------------------------------------------------------- | -------: | -------: | ------------------------------------------------------------- |
| Packed TypeScript decoder                               | 5.251 ms | 3.806 ms | Node/V8, 13,059 synthetic results / 107,166 labels / 14 pages |
| Swift packed encoder, 1,000 results with 10 labels each | 0.932 ms | 0.681 ms | Optimized Mac native codec benchmark                          |

These timings exclude Expo/JSI transfer, Hermes, PhotoKit, Vision, SQLite, and
rendering. They establish local codec improvements, not a measured app-wide gain.
The TypeScript run used six warmups and 16 samples; its legacy decode control
remained 12.507–12.525 ms. Local reports are `.build/vision-transport-before.json`
and `.build/vision-transport-after.json`.
The Swift workload, compiler flags, byte parity, and native build commands are in
`.build/native-transfer-encoder-benchmark.json`.
Calendar's generated conversion removes known work; no device latency reduction
is claimed without runtime measurement.

### Shared buffers in an actual Hermes runtime

A September 5 standalone macOS experiment compiled the installed ExpoModulesJSI
sources and exact `NativeArrayBuffer` implementation with Swift 6.3.3, `-O`, and
whole-module optimization. The runtime reported Hermes **Release**, static Hermes,
bytecode version **98**, Hades GC, and OSS version **250829098.0.16**. Each arm used
six warmups and 24 measured samples, alternating execution order. Native packing,
JSI publication, and JavaScript consumption ran synchronously; explicit GC was
measured separately after each sample.

The copy control confirmed that sharing avoids work: publishing an existing
128 KiB `Data` and touching its endpoints took **3.715 µs** through copied
`Data.encode` versus **0.632 µs** through `NativeArrayBuffer.wrap(dataWithoutCopy:)`.
Sharing won all 24 pairs. Palate's packed transport already uses that shared path;
this is evidence for the existing representation, not a newly achieved speedup.

The candidate wrote packed bytes directly into an uninitialized
`NativeArrayBuffer`, replacing the current pre-sized `Data` followed by a shared
wrapper. Both arms produced identical bytes. The measured medians were:

| Assets / labels | JavaScript consumer | Current shared Data | Direct allocation | Candidate change | Faster pairs |
| --------------- | ------------------- | ------------------: | ----------------: | ---------------: | -----------: |
| 1,000 / 10,000  | Touch endpoints     |            1.467 ms |          1.439 ms |           −1.90% |        14/24 |
| 1,000 / 10,000  | Sum every byte      |            6.142 ms |          6.104 ms |           −0.62% |        12/24 |
| 2,000 / 20,000  | Touch endpoints     |            2.851 ms |          3.114 ms |           +9.22% |         9/24 |
| 2,000 / 20,000  | Sum every byte      |           14.193 ms |         16.031 ms |          +12.95% |         9/24 |

The small 1,000-asset median advantage was inconsistent across pairs, and larger
pages regressed. Sample spreads were wide. The direct-allocation candidate was
rejected; the simpler existing shared-Data encoder remains. These results do not
establish an intrinsic slowdown for every workload or justify changing the
legacy/packed transport default.

Runtime checks verified shared-pointer identity, independent copied storage,
readability after the original Swift owner left scope, typed-array view offsets,
and native cleanup exactly once after JavaScript released its reference and GC
ran. Full encoded-byte equality and JavaScript checksums also passed. The
standalone runtime remained alive for the lifetime of all associated JS values.

This experiment excludes asynchronous module dispatch, React scheduling,
TextDecoder and result reconstruction, PhotoKit, Vision, SQLite, and rendering.
It measures native encoding and buffer transfer with a bounded synthetic consumer;
the signed-app workflow in the README remains necessary to assess the complete pipeline.
Mode-0600 reports retain raw samples, medians and quartiles, GC timings, runtime
identity, source/framework hashes, and reproduction commands:

- `.build/native-buffer-hermes-transfer.json`
- `.build/native-buffer-hermes-encoder.json`
- `.build/native-buffer-hermes-summary.json`
- `.build/native-buffer-hermes-ownership.log`

The fresh signed iOS Release app built successfully, but the full Photos run
could not launch on this Mac: direct launch reported an incorrect executable
format, and the compatible Xcode GUI was blocked on its required system-component
setup. No scan was triggered. The current fixture contained 29,909 classified
photos; a disposable reference excluded 13 unlinked photos, leaving 29,896
eligible requests without changing row identities. The original database's main,
WAL, SHM, and journal state was independently verified byte-for-byte with matching
modes after the attempts, and all four disposable database copies were removed.
`.build/native-buffer-full-app-attempt.json` records the build hashes, failed
preflight/launch attempts, restoration proof, and cleanup. No app-level timing or
transport-default promotion is claimed from these attempts.

Packed Vision transport remains opt-in with
`PALATE_VISION_RESULT_TRANSPORT=packed-v1`; the production default is `legacy`.
Measure the complete signed-app pipeline before changing that default: production,
packing, transfer, decoding/validation, consumption, persistence, scheduling, and
memory residency. Preserve ordered results and test older-binary capability
fallback. Once a packed request starts, failure must not silently repeat Vision
work through another transport. See the README's Vision validation workflow.

Nitro offers generated Swift/C++ bindings and retained native buffers, but its
[Swift buffer implementation](https://github.com/margelo/nitro/blob/main/packages/react-native-nitro-modules/ios/core/ArrayBuffer.swift)
also distinguishes borrowed from owned storage and may copy to obtain ownership.
Installed Expo already provides the needed native-owned buffer path and generated
Record conversion. A module-framework migration needs an application benchmark
showing that framework overhead remains material after reducing payloads and
redundant conversions; generic microbenchmarks do not establish that for Palate.

// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "PalateNativeProfiling",
  platforms: [
    .macOS(.v13),
    .iOS(.v16),
  ],
  products: [
    .library(name: "BatchAssetInfoCore", targets: ["BatchAssetInfoCore"]),
    .library(
      name: "CalendarBatchMutationCore",
      targets: ["CalendarBatchMutationCore"]
    ),
    .library(
      name: "CalendarBatchMutationProfilerSupport",
      targets: ["CalendarBatchMutationProfilerSupport"]
    ),
    .library(
      name: "CalendarEventKitMutationProfilerSupport",
      targets: ["CalendarEventKitMutationProfilerSupport"]
    ),
    .library(
      name: "CalendarLibraryProfilerSupport",
      targets: ["CalendarLibraryProfilerSupport"]
    ),
    .library(name: "CalendarMatchingCore", targets: ["CalendarMatchingCore"]),
    .library(name: "PhotosProfilerSupport", targets: ["PhotosProfilerSupport"]),
    .executable(name: "PalateCalendarProfiler", targets: ["PalateCalendarProfiler"]),
    .executable(
      name: "PalateCalendarBatchMutationProfiler",
      targets: ["PalateCalendarBatchMutationProfiler"]
    ),
    .executable(
      name: "PalateCalendarEventKitMutationProfiler",
      targets: ["PalateCalendarEventKitMutationProfiler"]
    ),
    .executable(
      name: "PalateCalendarLibraryProfiler",
      targets: ["PalateCalendarLibraryProfiler"]
    ),
    .executable(name: "PalatePhotosProfiler", targets: ["PalatePhotosProfiler"]),
  ],
  targets: [
    .target(
      name: "BatchAssetInfoCore",
      path: "modules/batch-asset-info/ios/Core"
    ),
    .target(
      name: "CalendarBatchMutationCore",
      path: "modules/calendar-matching/ios/MutationCore"
    ),
    .target(
      name: "CalendarBatchMutationProfilerSupport",
      path: "NativeProfiler/Sources/CalendarBatchMutationProfilerSupport",
      linkerSettings: [
        .linkedFramework("CryptoKit")
      ]
    ),
    .target(
      name: "CalendarEventKitMutationAdapter",
      dependencies: ["CalendarBatchMutationCore"],
      path: "modules/calendar-matching/ios",
      exclude: [
        "CalendarDeleteEventMutationRecord.swift",
        "CalendarEventRecord+Eligibility.swift",
        "CalendarEventRecord.swift",
        "CalendarEventStore.swift",
        "CalendarEventTitleFilter.swift",
        "CalendarExportEventMutationRecord.swift",
        "CalendarMatchingModule.podspec",
        "CalendarMatchingModule.swift",
        "CalendarMatchingModuleError.swift",
        "CalendarMutationResultRecord.swift",
        "CalendarSuggestedRestaurantRecord.swift",
        "CalendarVisitMatchRecord.swift",
        "CalendarVisitMatchRequest.swift",
        "CalendarVisitRecord.swift",
        "Core",
        "MutationCore",
      ],
      sources: [
        "CalendarEventKitMutationBackend.swift",
        "CalendarEventKitMutationError.swift",
      ],
      linkerSettings: [
        .linkedFramework("EventKit")
      ]
    ),
    .target(
      name: "CalendarEventKitMutationProfilerSupport",
      dependencies: [
        "CalendarBatchMutationCore",
        "CalendarEventKitMutationAdapter",
      ],
      path: "NativeProfiler/Sources/CalendarEventKitMutationProfilerSupport",
      linkerSettings: [
        .linkedFramework("CryptoKit"),
        .linkedFramework("EventKit"),
      ]
    ),
    .target(
      name: "CalendarMatchingCore",
      path: "modules/calendar-matching/ios/Core"
    ),
    .target(
      name: "CalendarLibraryProfilerSupport",
      dependencies: ["CalendarMatchingCore"],
      path: "NativeProfiler/Sources/CalendarLibraryProfilerSupport",
      linkerSettings: [
        .linkedFramework("CryptoKit"),
        .linkedFramework("EventKit"),
      ]
    ),
    .target(
      name: "PhotosProfilerSupport",
      dependencies: ["BatchAssetInfoCore"],
      path: "NativeProfiler/Sources/PhotosProfilerSupport",
      linkerSettings: [
        .linkedFramework("Photos")
      ]
    ),
    .executableTarget(
      name: "PalateCalendarProfiler",
      dependencies: ["CalendarMatchingCore"],
      path: "NativeProfiler/Sources/PalateCalendarProfiler"
    ),
    .executableTarget(
      name: "PalateCalendarBatchMutationProfiler",
      dependencies: ["CalendarBatchMutationProfilerSupport"],
      path: "NativeProfiler/Sources/PalateCalendarBatchMutationProfiler"
    ),
    .executableTarget(
      name: "PalateCalendarEventKitMutationProfiler",
      dependencies: ["CalendarEventKitMutationProfilerSupport"],
      path: "NativeProfiler/Sources/PalateCalendarEventKitMutationProfiler",
      linkerSettings: [
        .linkedFramework("AppKit")
      ]
    ),
    .executableTarget(
      name: "PalateCalendarLibraryProfiler",
      dependencies: ["CalendarLibraryProfilerSupport"],
      path: "NativeProfiler/Sources/PalateCalendarLibraryProfiler",
      linkerSettings: [
        .linkedFramework("AppKit")
      ]
    ),
    .executableTarget(
      name: "PalatePhotosProfiler",
      dependencies: ["PhotosProfilerSupport"],
      path: "NativeProfiler/Sources/PalatePhotosProfiler",
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("Photos"),
      ]
    ),
    .testTarget(
      name: "PhotosProfilerSupportTests",
      dependencies: ["BatchAssetInfoCore", "PhotosProfilerSupport"],
      path: "NativeProfiler/Tests/PhotosProfilerSupportTests"
    ),
    .testTarget(
      name: "CalendarMatchingCoreTests",
      dependencies: ["CalendarMatchingCore"],
      path: "NativeProfiler/Tests/CalendarMatchingCoreTests"
    ),
    .testTarget(
      name: "CalendarBatchMutationCoreTests",
      dependencies: ["CalendarBatchMutationCore"],
      path: "NativeProfiler/Tests/CalendarBatchMutationCoreTests"
    ),
    .testTarget(
      name: "CalendarBatchMutationProfilerSupportTests",
      dependencies: ["CalendarBatchMutationProfilerSupport"],
      path: "NativeProfiler/Tests/CalendarBatchMutationProfilerSupportTests"
    ),
    .testTarget(
      name: "CalendarEventKitMutationProfilerSupportTests",
      dependencies: [
        "CalendarBatchMutationCore",
        "CalendarEventKitMutationProfilerSupport",
      ],
      path: "NativeProfiler/Tests/CalendarEventKitMutationProfilerSupportTests"
    ),
    .testTarget(
      name: "CalendarLibraryProfilerSupportTests",
      dependencies: ["CalendarLibraryProfilerSupport"],
      path: "NativeProfiler/Tests/CalendarLibraryProfilerSupportTests"
    ),
  ]
)

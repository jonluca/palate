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
    .library(name: "CalendarMatchingCore", targets: ["CalendarMatchingCore"]),
    .library(name: "PhotosProfilerSupport", targets: ["PhotosProfilerSupport"]),
    .executable(name: "PalateCalendarProfiler", targets: ["PalateCalendarProfiler"]),
    .executable(name: "PalatePhotosProfiler", targets: ["PalatePhotosProfiler"]),
  ],
  targets: [
    .target(
      name: "BatchAssetInfoCore",
      path: "modules/batch-asset-info/ios/Core"
    ),
    .target(
      name: "CalendarMatchingCore",
      path: "modules/calendar-matching/ios/Core"
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
  ]
)

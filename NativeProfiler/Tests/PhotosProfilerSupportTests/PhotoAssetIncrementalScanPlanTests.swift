import Testing

@testable import BatchAssetInfoCore

@Suite("Incremental photo asset scan plan")
struct PhotoAssetIncrementalScanPlanTests {
  private struct Asset {
    let id: String
    let hasUsableCreationTime: Bool
    let hasValidLocation: Bool
  }

  @Test("Unknown assets preserve stable PhotoKit order and existing duplicates are harmless")
  func stableUnknownOrder() {
    let assets = [
      Asset(id: "new-first", hasUsableCreationTime: true, hasValidLocation: false),
      Asset(id: "known", hasUsableCreationTime: true, hasValidLocation: true),
      Asset(id: "new-second", hasUsableCreationTime: true, hasValidLocation: true),
      Asset(id: "known", hasUsableCreationTime: false, hasValidLocation: true),
    ]

    let plan = makePlan(assets: assets, existing: ["known", "known", "not-visible"])

    #expect(plan.unknownAssetIndexes == [0, 2])
    #expect(plan.excludedVisibleCount == 2)
    #expect(plan.excludedPhotosWithLocation == 1)
    #expect(plan.excludedSkippedAssets == 1)
  }

  @Test("Empty and all-known databases retain exact boundary behavior")
  func emptyAndAllKnown() {
    let assets = [
      Asset(id: "one", hasUsableCreationTime: true, hasValidLocation: true),
      Asset(id: "two", hasUsableCreationTime: true, hasValidLocation: false),
    ]

    let emptyPlan = makePlan(assets: assets, existing: [])
    #expect(emptyPlan.unknownAssetIndexes == [0, 1])
    #expect(emptyPlan.excludedVisibleCount == 0)
    #expect(emptyPlan.excludedPhotosWithLocation == 0)
    #expect(emptyPlan.excludedSkippedAssets == 0)

    let allKnownPlan = makePlan(assets: assets, existing: ["two", "one"])
    #expect(allKnownPlan.unknownAssetIndexes.isEmpty)
    #expect(allKnownPlan.excludedVisibleCount == 2)
    #expect(allKnownPlan.excludedPhotosWithLocation == 1)
    #expect(allKnownPlan.excludedSkippedAssets == 0)
  }

  @Test("Identifiers remain exact across Unicode, quotes, and duplicate visible values")
  func identifierExactness() {
    let assets = [
      Asset(id: "雪/'quoted'", hasUsableCreationTime: true, hasValidLocation: true),
      Asset(id: "emoji-🍼", hasUsableCreationTime: true, hasValidLocation: false),
      Asset(id: "emoji-🍼", hasUsableCreationTime: true, hasValidLocation: true),
    ]

    let plan = makePlan(assets: assets, existing: ["雪/'quoted'"])

    #expect(plan.unknownAssetIndexes == [1, 2])
    #expect(plan.excludedVisibleCount == 1)
    #expect(plan.excludedPhotosWithLocation == 1)
  }

  @Test("Identifier-list planning reads each asset once and derives metrics only for known assets")
  func exactAssetReadCounts() {
    let assets = [
      Asset(id: "new-first", hasUsableCreationTime: true, hasValidLocation: true),
      Asset(id: "known-located", hasUsableCreationTime: true, hasValidLocation: true),
      Asset(id: "new-second", hasUsableCreationTime: false, hasValidLocation: false),
      Asset(id: "known-skipped", hasUsableCreationTime: false, hasValidLocation: true),
    ]
    var assetReadCounts = Array(repeating: 0, count: assets.count)
    var metricsReadCounts = Array(repeating: 0, count: assets.count)

    let plan = PhotoAssetIncrementalScanPlan(
      assetCount: assets.count,
      existingAssetIdentifiers: ["known-located", "known-skipped", "stale"],
      assetAt: { index in
        assetReadCounts[index] += 1
        let asset = assets[index]
        return (
          identifier: asset.id,
          excludedMetrics: {
            metricsReadCounts[index] += 1
            return PhotoAssetScanStoredMetrics(
              hasUsableCreationTime: asset.hasUsableCreationTime,
              hasValidLocation: asset.hasValidLocation
            )
          }
        )
      }
    )

    #expect(assetReadCounts == [1, 1, 1, 1])
    #expect(metricsReadCounts == [0, 1, 0, 1])
    #expect(plan.unknownAssetIndexes == [0, 2])
    #expect(plan.excludedVisibleCount == 2)
    #expect(plan.excludedPhotosWithLocation == 1)
    #expect(plan.excludedSkippedAssets == 1)
  }

  private func makePlan(
    assets: [Asset],
    existing: [String]
  ) -> PhotoAssetIncrementalScanPlan {
    PhotoAssetIncrementalScanPlan(
      assetCount: assets.count,
      existingAssetIdentifiers: existing,
      assetAt: { index in
        let asset = assets[index]
        return (
          identifier: asset.id,
          excludedMetrics: {
            PhotoAssetScanStoredMetrics(
              hasUsableCreationTime: asset.hasUsableCreationTime,
              hasValidLocation: asset.hasValidLocation
            )
          }
        )
      }
    )
  }
}

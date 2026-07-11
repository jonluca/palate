import Foundation

struct ThumbnailScrollSamplePlan: Sendable {
  enum MediaType: String, Encodable, Equatable, Sendable {
    case image
    case video
  }

  struct Asset: Equatable, Sendable {
    let identifier: String
    let mediaType: MediaType
  }

  struct Assignment: Sendable {
    let assets: [Asset]
    let columnCount: Int
    let visibleRowCount: Int
    let aheadRowCount: Int
    let behindRowCount: Int
    let flingTransitionCount: Int
    let identifierDigest: String
    let imageCount: Int
    let videoCount: Int

    var currentVisibleAssets: [Asset] {
      visibleAssets(at: 0)
    }

    var nextVisibleAssets: [Asset] {
      visibleAssets(at: flingTransitionCount)
    }

    func visibleAssets(at transition: Int) -> [Asset] {
      let firstRow = behindRowCount + transition * visibleRowCount
      return assets(inRows: firstRow..<(firstRow + visibleRowCount))
    }

    func candidateAssets(
      for arm: ThumbnailScrollBenchmarkArm,
      at transition: Int
    ) -> [Asset] {
      guard arm != .control else {
        return []
      }

      let firstVisibleRow = behindRowCount + transition * visibleRowCount
      let visible = assets(inRows: firstVisibleRow..<(firstVisibleRow + visibleRowCount))
      let aheadStart = firstVisibleRow + visibleRowCount
      let ahead = assets(inRows: aheadStart..<(aheadStart + aheadRowCount))
      let behindStart = max(0, firstVisibleRow - behindRowCount)
      var behind: [Asset] = []
      for row in stride(from: firstVisibleRow - 1, through: behindStart, by: -1) {
        behind.append(contentsOf: assets(inRows: row..<(row + 1)))
      }

      switch arm {
      case .control:
        return []
      case .currentVisibleFirst:
        return visible + ahead + behind
      case .aheadBehindFirst:
        return ahead + behind + visible
      case .futureOnly:
        return ahead
      }
    }

    private func assets(inRows rows: Range<Int>) -> [Asset] {
      let lowerBound = rows.lowerBound * columnCount
      let upperBound = rows.upperBound * columnCount
      return Array(assets[lowerBound..<upperBound])
    }
  }

  struct Run: Sendable {
    let arm: ThumbnailScrollBenchmarkArm
    let iteration: Int
    let recencySlot: Int
    let executionPosition: Int
    let assignment: Assignment
  }

  let runs: [Run]
  let sampledIdentifierCount: Int
  let sampledIdentifierDigest: String
  let sampledImageCount: Int
  let sampledVideoCount: Int
  let assetsPerAssignment: Int

  init(
    assets: [Asset],
    columnCount: Int,
    visibleRowCount: Int,
    aheadRowCount: Int,
    behindRowCount: Int,
    flingTransitionCount: Int,
    iterations: Int
  ) throws {
    guard columnCount > 0, visibleRowCount > 0, aheadRowCount > 0, behindRowCount > 0,
      flingTransitionCount > 0
    else {
      throw ThumbnailScrollBenchmarkError.invalidGrid
    }
    guard iterations > 0, iterations.isMultiple(of: ThumbnailScrollBenchmarkArm.allCases.count)
    else {
      throw ThumbnailScrollBenchmarkError.iterationsMustBeMultipleOfFour
    }

    let required = try Self.requiredIdentifierCount(
      columnCount: columnCount,
      visibleRowCount: visibleRowCount,
      aheadRowCount: aheadRowCount,
      behindRowCount: behindRowCount,
      flingTransitionCount: flingTransitionCount,
      iterations: iterations
    )
    guard assets.count >= required else {
      throw ThumbnailScrollBenchmarkError.insufficientAssets(
        required: required,
        available: assets.count
      )
    }

    let sampledAssets = Array(assets.prefix(required))
    guard Set(sampledAssets.map(\.identifier)).count == sampledAssets.count else {
      throw ThumbnailScrollBenchmarkError.duplicateAssetIdentifier
    }

    let totalRowCount = try Self.totalRowCount(
      visibleRowCount: visibleRowCount,
      aheadRowCount: aheadRowCount,
      behindRowCount: behindRowCount,
      flingTransitionCount: flingTransitionCount
    )
    let assignmentSize = try Self.multiplied(totalRowCount, columnCount)
    let recencyOrders: [[ThumbnailScrollBenchmarkArm]] = [
      [.control, .currentVisibleFirst, .aheadBehindFirst, .futureOnly],
      [.futureOnly, .control, .currentVisibleFirst, .aheadBehindFirst],
      [.aheadBehindFirst, .futureOnly, .control, .currentVisibleFirst],
      [.currentVisibleFirst, .aheadBehindFirst, .futureOnly, .control],
    ]
    let executionOrders: [[ThumbnailScrollBenchmarkArm]] = [
      [.control, .currentVisibleFirst, .aheadBehindFirst, .futureOnly],
      [.currentVisibleFirst, .futureOnly, .control, .aheadBehindFirst],
      [.aheadBehindFirst, .control, .futureOnly, .currentVisibleFirst],
      [.futureOnly, .aheadBehindFirst, .currentVisibleFirst, .control],
    ]

    var nextAssetIndex = 0
    var runs: [Run] = []
    runs.reserveCapacity(iterations * ThumbnailScrollBenchmarkArm.allCases.count)
    for zeroBasedIteration in 0..<iterations {
      var assignmentByArm: [ThumbnailScrollBenchmarkArm: (Int, Assignment)] = [:]
      for (recencySlot, arm) in recencyOrders[zeroBasedIteration % recencyOrders.count].enumerated()
      {
        let endIndex = nextAssetIndex + assignmentSize
        let assignmentAssets = Array(sampledAssets[nextAssetIndex..<endIndex])
        nextAssetIndex = endIndex
        var digest = StableIdentifierDigest()
        for asset in assignmentAssets {
          digest.add(asset.identifier)
        }
        assignmentByArm[arm] = (
          recencySlot,
          Assignment(
            assets: assignmentAssets,
            columnCount: columnCount,
            visibleRowCount: visibleRowCount,
            aheadRowCount: aheadRowCount,
            behindRowCount: behindRowCount,
            flingTransitionCount: flingTransitionCount,
            identifierDigest: digest.signature,
            imageCount: assignmentAssets.filter { $0.mediaType == .image }.count,
            videoCount: assignmentAssets.filter { $0.mediaType == .video }.count
          )
        )
      }

      for (executionPosition, arm) in executionOrders[
        zeroBasedIteration % executionOrders.count
      ].enumerated() {
        guard let (recencySlot, assignment) = assignmentByArm[arm] else {
          preconditionFailure("Every benchmark arm must have one recency assignment")
        }
        runs.append(
          Run(
            arm: arm,
            iteration: zeroBasedIteration + 1,
            recencySlot: recencySlot,
            executionPosition: executionPosition,
            assignment: assignment
          )
        )
      }
    }

    var sampledDigest = StableIdentifierDigest()
    for asset in sampledAssets {
      sampledDigest.add(asset.identifier)
    }
    self.runs = runs
    sampledIdentifierCount = sampledAssets.count
    sampledIdentifierDigest = sampledDigest.signature
    sampledImageCount = sampledAssets.filter { $0.mediaType == .image }.count
    sampledVideoCount = sampledAssets.filter { $0.mediaType == .video }.count
    assetsPerAssignment = assignmentSize
  }

  static func requiredIdentifierCount(
    columnCount: Int,
    visibleRowCount: Int,
    aheadRowCount: Int,
    behindRowCount: Int,
    flingTransitionCount: Int,
    iterations: Int
  ) throws -> Int {
    let rows = try totalRowCount(
      visibleRowCount: visibleRowCount,
      aheadRowCount: aheadRowCount,
      behindRowCount: behindRowCount,
      flingTransitionCount: flingTransitionCount
    )
    let assignmentSize = try multiplied(rows, columnCount)
    let perIteration = try multiplied(assignmentSize, ThumbnailScrollBenchmarkArm.allCases.count)
    return try multiplied(perIteration, iterations)
  }

  private static func totalRowCount(
    visibleRowCount: Int,
    aheadRowCount: Int,
    behindRowCount: Int,
    flingTransitionCount: Int
  ) throws -> Int {
    let visibleWindowCount = try added(flingTransitionCount, 1)
    let traversedVisibleRows = try multiplied(visibleRowCount, visibleWindowCount)
    return try added(try added(behindRowCount, traversedVisibleRows), aheadRowCount)
  }

  private static func added(_ left: Int, _ right: Int) throws -> Int {
    let result = left.addingReportingOverflow(right)
    guard !result.overflow else {
      throw ThumbnailScrollBenchmarkError.sampleSizeOverflow
    }
    return result.partialValue
  }

  private static func multiplied(_ left: Int, _ right: Int) throws -> Int {
    let result = left.multipliedReportingOverflow(by: right)
    guard !result.overflow else {
      throw ThumbnailScrollBenchmarkError.sampleSizeOverflow
    }
    return result.partialValue
  }
}

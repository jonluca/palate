import Foundation

struct PreviewCardsSamplePlan: Sendable {
  enum MediaType: String, Encodable, Equatable, Sendable {
    case image
    case video
  }

  struct Asset: Equatable, Sendable {
    let identifier: String
    let mediaType: MediaType
  }

  struct Card: Equatable, Sendable {
    let arity: Int
    let assets: [Asset]
  }

  struct Assignment: Sendable {
    let cards: [Card]
    let identifierDigest: String
    let orderedIdentifierDigest: String
    let imageCount: Int
    let videoCount: Int

    var assets: [Asset] {
      cards.flatMap(\.assets)
    }

    var arities: [Int] {
      cards.map(\.arity)
    }
  }

  struct Run: Sendable {
    let strategy: PreviewCardsBenchmarkStrategy
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

  var hasGloballyDisjointAssignments: Bool {
    let identifiers = runs.flatMap { $0.assignment.assets.map(\.identifier) }
    return identifiers.count == sampledIdentifierCount
      && Set(identifiers).count == sampledIdentifierCount
  }

  var isFullyCounterbalanced: Bool {
    PreviewCardsBenchmarkStrategy.allProfilerCases.allSatisfy { strategy in
      let strategyRuns = runs.filter { $0.strategy == strategy }
      guard !strategyRuns.isEmpty, strategyRuns.count.isMultiple(of: 12) else {
        return false
      }
      var cellCounts: [String: Int] = [:]
      for run in strategyRuns {
        let cell = "\(run.assignment.arities)-\(run.recencySlot)-\(run.executionPosition)"
        cellCounts[cell, default: 0] += 1
      }
      let expectedPerCell = strategyRuns.count / 12
      return cellCounts.count == 12 && cellCounts.values.allSatisfy { $0 == expectedPerCell }
    }
  }

  init(assets: [Asset], visibleCardCount: Int, iterations: Int) throws {
    guard visibleCardCount > 0 else {
      throw PreviewCardsBenchmarkError.invalidVisibleCardCount
    }
    guard iterations > 0, iterations.isMultiple(of: 12) else {
      throw PreviewCardsBenchmarkError.iterationsMustBeMultipleOfTwelve
    }

    let required = try Self.requiredIdentifierCount(
      visibleCardCount: visibleCardCount,
      iterations: iterations
    )
    guard assets.count >= required else {
      throw PreviewCardsBenchmarkError.insufficientAssets(
        required: required,
        available: assets.count
      )
    }
    let sampledAssets = Array(assets.prefix(required))
    guard Set(sampledAssets.map(\.identifier)).count == sampledAssets.count else {
      throw PreviewCardsBenchmarkError.duplicateAssetIdentifier
    }

    var nextAssetIndex = 0
    var runs: [Run] = []
    runs.reserveCapacity(iterations * 2)
    for zeroBasedIteration in 0..<iterations {
      let arities = Self.arities(
        visibleCardCount: visibleCardCount,
        rotation: zeroBasedIteration % PreviewCardsGeometry.supportedArities.count
      )
      let assignmentSize = try Self.sum(arities)
      let first = Self.assignment(
        assets: Array(sampledAssets[nextAssetIndex..<(nextAssetIndex + assignmentSize)]),
        arities: arities
      )
      nextAssetIndex += assignmentSize
      let second = Self.assignment(
        assets: Array(sampledAssets[nextAssetIndex..<(nextAssetIndex + assignmentSize)]),
        arities: arities
      )
      nextAssetIndex += assignmentSize

      let factorialState = zeroBasedIteration % 4
      let baselineRecencySlot = factorialState / 2
      let baselineExecutionPosition = factorialState % 2
      let baseline = baselineRecencySlot == 0 ? first : second
      let candidate = baselineRecencySlot == 0 ? second : first

      let executionOrder:
        [(
          strategy: PreviewCardsBenchmarkStrategy,
          recencySlot: Int,
          assignment: Assignment
        )] =
          baselineExecutionPosition == 0
          ? [
            (.expoPhotoLibraryAssetLoaderPhotoKit, baselineRecencySlot, baseline),
            (.photoAssetThumbnailStore, 1 - baselineRecencySlot, candidate),
          ]
          : [
            (.photoAssetThumbnailStore, 1 - baselineRecencySlot, candidate),
            (.expoPhotoLibraryAssetLoaderPhotoKit, baselineRecencySlot, baseline),
          ]
      for (executionPosition, execution) in executionOrder.enumerated() {
        runs.append(
          Run(
            strategy: execution.strategy,
            iteration: zeroBasedIteration + 1,
            recencySlot: execution.recencySlot,
            executionPosition: executionPosition,
            assignment: execution.assignment
          )
        )
      }
    }

    var digest = StableIdentifierDigest()
    for asset in sampledAssets {
      digest.add(asset.identifier)
    }
    self.runs = runs
    sampledIdentifierCount = sampledAssets.count
    sampledIdentifierDigest = digest.signature
    sampledImageCount = sampledAssets.filter { $0.mediaType == .image }.count
    sampledVideoCount = sampledAssets.filter { $0.mediaType == .video }.count
  }

  static func requiredIdentifierCount(visibleCardCount: Int, iterations: Int) throws -> Int {
    guard visibleCardCount > 0 else {
      throw PreviewCardsBenchmarkError.invalidVisibleCardCount
    }
    guard iterations > 0, iterations.isMultiple(of: 12) else {
      throw PreviewCardsBenchmarkError.iterationsMustBeMultipleOfTwelve
    }
    var count = 0
    for zeroBasedIteration in 0..<iterations {
      let arities = arities(
        visibleCardCount: visibleCardCount,
        rotation: zeroBasedIteration % PreviewCardsGeometry.supportedArities.count
      )
      let assignmentSize = try sum(arities)
      count = try added(count, try multiplied(assignmentSize, 2))
    }
    return count
  }

  static func arities(visibleCardCount: Int, rotation: Int) -> [Int] {
    (0..<visibleCardCount).map { index in
      PreviewCardsGeometry.supportedArities[
        (index + rotation) % PreviewCardsGeometry.supportedArities.count
      ]
    }
  }

  private static func assignment(assets: [Asset], arities: [Int]) -> Assignment {
    var nextIndex = 0
    let cards = arities.map { arity in
      let cardAssets = Array(assets[nextIndex..<(nextIndex + arity)])
      nextIndex += arity
      return Card(arity: arity, assets: cardAssets)
    }
    var digest = StableIdentifierDigest()
    var orderedDigest = ThumbnailScrollOrderedIdentifierDigest()
    for asset in assets {
      digest.add(asset.identifier)
      orderedDigest.add(asset.identifier)
    }
    return Assignment(
      cards: cards,
      identifierDigest: digest.signature,
      orderedIdentifierDigest: orderedDigest.signature,
      imageCount: assets.filter { $0.mediaType == .image }.count,
      videoCount: assets.filter { $0.mediaType == .video }.count
    )
  }

  private static func sum(_ values: [Int]) throws -> Int {
    try values.reduce(0) { partial, value in
      try added(partial, value)
    }
  }

  private static func added(_ left: Int, _ right: Int) throws -> Int {
    let result = left.addingReportingOverflow(right)
    guard !result.overflow else {
      throw PreviewCardsBenchmarkError.sampleSizeOverflow
    }
    return result.partialValue
  }

  private static func multiplied(_ left: Int, _ right: Int) throws -> Int {
    let result = left.multipliedReportingOverflow(by: right)
    guard !result.overflow else {
      throw PreviewCardsBenchmarkError.sampleSizeOverflow
    }
    return result.partialValue
  }
}

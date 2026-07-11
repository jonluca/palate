import Foundation

struct PreviewCardsMeasurementAccumulator {
  private struct Entry {
    let targetPixelCount: Int64
    var isRenderable = false
    var isTerminal = false
  }

  private let requestedIdentifiers: [String]
  private let requestedIdentifierSet: Set<String>
  private let cardCount: Int
  private let displayDegradedImages: Bool
  private var entries: [String: Entry]
  private var degradedIdentifiers: Set<String> = []
  private var finalIdentifiers: [String] = []
  private var finalLatencies: [Double] = []
  private var finalDimensions: [(width: Int, height: Int)] = []
  private var failureCodeCounts: [String: Int] = [:]
  private(set) var unexpectedEventCount = 0
  private(set) var staleEventCount = 0
  private(set) var invalidDimensionCount = 0
  private(set) var degradedEventCount = 0
  private(set) var renderableCount = 0
  private(set) var finalCount = 0
  private(set) var failureCount = 0
  private(set) var timedOutCount = 0
  private(set) var firstRenderableMilliseconds: Double?
  private(set) var firstDegradedMilliseconds: Double?
  private(set) var firstFinalMilliseconds: Double?
  private(set) var allStripRenderableMilliseconds: Double?
  private(set) var allFinalMilliseconds: Double?

  init(
    requests: [PreviewCardsAssetRequest],
    cardCount: Int,
    displayDegradedImages: Bool
  ) {
    requestedIdentifiers = requests.map(\.identifier)
    requestedIdentifierSet = Set(requestedIdentifiers)
    self.cardCount = cardCount
    self.displayDegradedImages = displayDegradedImages
    entries = Dictionary(
      uniqueKeysWithValues: requests.map { request in
        (
          request.identifier,
          Entry(
            targetPixelCount: Int64(request.target.pixelWidth)
              * Int64(request.target.pixelHeight)
          )
        )
      }
    )
  }

  var isTerminal: Bool {
    finalCount + failureCount == requestedIdentifiers.count
  }

  mutating func record(_ event: InitialImageLoadEvent, elapsedMilliseconds: Double) {
    switch event {
    case .image(let identifier, let pixelWidth, let pixelHeight, let isDegraded):
      recordImage(
        identifier: identifier,
        pixelWidth: pixelWidth,
        pixelHeight: pixelHeight,
        isDegraded: isDegraded,
        elapsedMilliseconds: elapsedMilliseconds
      )
    case .failure(let identifier, let code):
      recordFailure(identifier: identifier, code: code)
    }
  }

  mutating func recordTimeouts(elapsedMilliseconds: Double) {
    for identifier in requestedIdentifiers {
      guard var entry = entries[identifier], !entry.isTerminal else {
        continue
      }
      entry.isTerminal = true
      entries[identifier] = entry
      failureCount += 1
      timedOutCount += 1
      failureCodeCounts["TIMEOUT", default: 0] += 1
    }
    if finalCount == requestedIdentifiers.count {
      allFinalMilliseconds = elapsedMilliseconds
    }
  }

  func makeMeasurement(allTerminalMilliseconds: Double)
    -> PreviewCardsBenchmarkReport.LoadMeasurement
  {
    var requestedDigest = StableIdentifierDigest()
    for identifier in requestedIdentifiers {
      requestedDigest.add(identifier)
    }
    var finalDigest = StableIdentifierDigest()
    for identifier in finalIdentifiers {
      finalDigest.add(identifier)
    }

    let dimensions: InitialImageBenchmarkReport.DimensionSummary?
    if finalDimensions.isEmpty {
      dimensions = nil
    } else {
      dimensions = InitialImageBenchmarkReport.DimensionSummary(
        minimumPixelWidth: finalDimensions.map(\.width).min() ?? 0,
        maximumPixelWidth: finalDimensions.map(\.width).max() ?? 0,
        minimumPixelHeight: finalDimensions.map(\.height).min() ?? 0,
        maximumPixelHeight: finalDimensions.map(\.height).max() ?? 0,
        totalDecodedPixels: finalDimensions.reduce(into: Int64(0)) { total, dimension in
          total += Int64(dimension.width) * Int64(dimension.height)
        }
      )
    }
    return PreviewCardsBenchmarkReport.LoadMeasurement(
      requestedCount: requestedIdentifierSet.count,
      cardCount: cardCount,
      requestedIdentifierDigest: requestedDigest.signature,
      finalIdentifierDigest: finalDigest.signature,
      requestedTargetPixelCount: entries.values.reduce(0) { $0 + $1.targetPixelCount },
      renderableCount: renderableCount,
      degradedAssetCount: degradedIdentifiers.count,
      degradedEventCount: degradedEventCount,
      finalCount: finalCount,
      failureCount: failureCount,
      timedOutCount: timedOutCount,
      unexpectedEventCount: unexpectedEventCount,
      staleEventCount: staleEventCount,
      invalidDimensionCount: invalidDimensionCount,
      failureCodeCounts: failureCodeCounts,
      firstRenderableMilliseconds: firstRenderableMilliseconds,
      firstDegradedMilliseconds: firstDegradedMilliseconds,
      firstFinalMilliseconds: firstFinalMilliseconds,
      allStripRenderableMilliseconds: allStripRenderableMilliseconds,
      allFinalMilliseconds: allFinalMilliseconds,
      allTerminalMilliseconds: allTerminalMilliseconds,
      finalLatency: InitialImageBenchmarkReport.LatencySummary.calculate(finalLatencies),
      finalDimensions: dimensions
    )
  }

  private mutating func recordImage(
    identifier: String,
    pixelWidth: Int,
    pixelHeight: Int,
    isDegraded: Bool,
    elapsedMilliseconds: Double
  ) {
    guard var entry = entries[identifier] else {
      unexpectedEventCount += 1
      return
    }
    guard !entry.isTerminal else {
      staleEventCount += 1
      return
    }
    guard pixelWidth > 0, pixelHeight > 0 else {
      invalidDimensionCount += 1
      return
    }

    if isDegraded {
      degradedEventCount += 1
      degradedIdentifiers.insert(identifier)
      firstDegradedMilliseconds = minimum(firstDegradedMilliseconds, elapsedMilliseconds)
      if displayDegradedImages, !entry.isRenderable {
        entry.isRenderable = true
        entries[identifier] = entry
        recordRenderable(elapsedMilliseconds: elapsedMilliseconds)
      }
      return
    }

    if !entry.isRenderable {
      entry.isRenderable = true
      recordRenderable(elapsedMilliseconds: elapsedMilliseconds)
    }
    entry.isTerminal = true
    entries[identifier] = entry
    finalIdentifiers.append(identifier)
    finalLatencies.append(elapsedMilliseconds)
    finalDimensions.append((pixelWidth, pixelHeight))
    finalCount += 1
    firstFinalMilliseconds = minimum(firstFinalMilliseconds, elapsedMilliseconds)
    if finalCount == requestedIdentifiers.count {
      allFinalMilliseconds = elapsedMilliseconds
    }
  }

  private mutating func recordRenderable(elapsedMilliseconds: Double) {
    renderableCount += 1
    firstRenderableMilliseconds = minimum(firstRenderableMilliseconds, elapsedMilliseconds)
    if renderableCount == requestedIdentifiers.count {
      allStripRenderableMilliseconds = elapsedMilliseconds
    }
  }

  private mutating func recordFailure(identifier: String, code: String) {
    guard var entry = entries[identifier] else {
      unexpectedEventCount += 1
      return
    }
    guard !entry.isTerminal else {
      staleEventCount += 1
      return
    }
    entry.isTerminal = true
    entries[identifier] = entry
    failureCount += 1
    failureCodeCounts[code, default: 0] += 1
  }

  private func minimum(_ current: Double?, _ candidate: Double) -> Double {
    current.map { min($0, candidate) } ?? candidate
  }
}

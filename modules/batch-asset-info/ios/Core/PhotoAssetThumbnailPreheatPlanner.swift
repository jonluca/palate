public struct PhotoAssetThumbnailPreheatPlanner: Sendable {
  public private(set) var generation: UInt64
  public private(set) var activeKeys: [PhotoAssetThumbnailRequestKey] = []
  public private(set) var activePixelCount: UInt64 = 0
  public private(set) var activeEstimatedByteCount: UInt64 = 0

  private var activeKeySet: Set<PhotoAssetThumbnailRequestKey> = []

  public init(generation: UInt64 = 0) {
    self.generation = generation
  }

  /// Produces the minimal ordered start/stop delta for an ordered list of desired cache keys.
  ///
  /// Exact duplicate keys retain their first position. Candidates that would exceed either
  /// planning bound are omitted while later, smaller candidates may still be selected.
  /// Advancing `generation` discards prior planner state without emitting stale stops, because a
  /// generation change represents an external cache invalidation. Transitions from an older
  /// generation are ignored without mutating the current state. Serial-number ordering treats a
  /// direct `UInt64` wrap from `.max` to zero as one forward generation.
  public mutating func transition(
    to candidates: [PhotoAssetThumbnailRequestKey],
    budget: PhotoAssetThumbnailPreheatBudget,
    generation requestedGeneration: UInt64
  ) -> PhotoAssetThumbnailPreheatDelta {
    let generationDistance = requestedGeneration &- generation
    let isSameGeneration = generationDistance == 0
    let isNewerGeneration = generationDistance > 0 && generationDistance <= UInt64.max / 2
    guard isSameGeneration || isNewerGeneration else {
      return makeDelta(
        requestedGeneration: requestedGeneration,
        transition: .ignoredStaleGeneration,
        starts: [],
        stops: [],
        retained: activeKeys
      )
    }

    let selection = Self.boundedSelection(candidates, budget: budget)
    if isNewerGeneration {
      generation = requestedGeneration
      replaceActiveState(with: selection)
      return makeDelta(
        requestedGeneration: requestedGeneration,
        transition: .resetGeneration,
        starts: activeKeys,
        stops: [],
        retained: []
      )
    }

    let nextKeySet = Set(selection.keys)
    let stops = activeKeys.filter { !nextKeySet.contains($0) }
    let starts = selection.keys.filter { !activeKeySet.contains($0) }
    let retained = selection.keys.filter { activeKeySet.contains($0) }
    replaceActiveState(with: selection)

    return makeDelta(
      requestedGeneration: requestedGeneration,
      transition: .updated,
      starts: starts,
      stops: stops,
      retained: retained
    )
  }

  private mutating func replaceActiveState(
    with selection: (
      keys: [PhotoAssetThumbnailRequestKey],
      pixelCount: UInt64,
      estimatedByteCount: UInt64
    )
  ) {
    activeKeys = selection.keys
    activeKeySet = Set(selection.keys)
    activePixelCount = selection.pixelCount
    activeEstimatedByteCount = selection.estimatedByteCount
  }

  private func makeDelta(
    requestedGeneration: UInt64,
    transition: PhotoAssetThumbnailPreheatTransition,
    starts: [PhotoAssetThumbnailRequestKey],
    stops: [PhotoAssetThumbnailRequestKey],
    retained: [PhotoAssetThumbnailRequestKey]
  ) -> PhotoAssetThumbnailPreheatDelta {
    PhotoAssetThumbnailPreheatDelta(
      requestedGeneration: requestedGeneration,
      activeGeneration: generation,
      transition: transition,
      starts: starts,
      stops: stops,
      retained: retained,
      activeKeys: activeKeys,
      activePixelCount: activePixelCount,
      activeEstimatedByteCount: activeEstimatedByteCount
    )
  }

  private static func boundedSelection(
    _ candidates: [PhotoAssetThumbnailRequestKey],
    budget: PhotoAssetThumbnailPreheatBudget
  ) -> (
    keys: [PhotoAssetThumbnailRequestKey],
    pixelCount: UInt64,
    estimatedByteCount: UInt64
  ) {
    var seen: Set<PhotoAssetThumbnailRequestKey> = []
    var keys: [PhotoAssetThumbnailRequestKey] = []
    keys.reserveCapacity(candidates.count)
    var totalPixelCount: UInt64 = 0
    var totalEstimatedByteCount: UInt64 = 0

    for candidate in candidates where seen.insert(candidate).inserted {
      guard keys.count < budget.maximumKeyCount else {
        break
      }
      let width = UInt64(candidate.target.pixelWidth)
      let height = UInt64(candidate.target.pixelHeight)
      let (pixelCount, pixelOverflow) = width.multipliedReportingOverflow(by: height)
      let (estimatedByteCount, byteOverflow) = pixelCount.multipliedReportingOverflow(
        by: PhotoAssetThumbnailPreheatBudget.estimatedBytesPerPixel
      )
      guard !pixelOverflow, !byteOverflow else {
        continue
      }
      guard pixelCount <= budget.maximumPixelCount - totalPixelCount else {
        continue
      }
      guard estimatedByteCount <= budget.maximumEstimatedByteCount - totalEstimatedByteCount else {
        continue
      }

      keys.append(candidate)
      totalPixelCount += pixelCount
      totalEstimatedByteCount += estimatedByteCount
    }

    return (keys, totalPixelCount, totalEstimatedByteCount)
  }
}

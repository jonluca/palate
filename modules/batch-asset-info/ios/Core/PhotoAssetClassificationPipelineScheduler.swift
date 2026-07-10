struct PhotoAssetClassificationPipelineScheduler: Sendable {
  let itemCount: Int
  let maximumInFlight: Int

  private(set) var completedCount = 0
  private(set) var activeIndices: Set<Int> = []
  private var nextIndex = 0

  init(itemCount: Int, maximumInFlight: Int) {
    precondition(itemCount >= 0, "Photo classification itemCount must be non-negative")
    precondition(maximumInFlight > 0, "Photo classification maximumInFlight must be positive")
    self.itemCount = itemCount
    self.maximumInFlight = maximumInFlight
  }

  var isComplete: Bool {
    completedCount == itemCount
  }

  mutating func fillAvailableSlots() -> [Int] {
    var started: [Int] = []
    started.reserveCapacity(maximumInFlight - activeIndices.count)
    while activeIndices.count < maximumInFlight, nextIndex < itemCount {
      let index = nextIndex
      nextIndex += 1
      activeIndices.insert(index)
      started.append(index)
    }
    return started
  }

  mutating func complete(index: Int) -> Bool {
    guard activeIndices.remove(index) != nil else {
      return false
    }
    completedCount += 1
    return true
  }

  mutating func cancelUnstarted() -> [Int] {
    guard nextIndex < itemCount else {
      return []
    }
    let cancelledIndices = Array(nextIndex..<itemCount)
    nextIndex = itemCount
    completedCount += cancelledIndices.count
    return cancelledIndices
  }
}

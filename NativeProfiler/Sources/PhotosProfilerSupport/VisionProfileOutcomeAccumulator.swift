import BatchAssetInfoCore
import Foundation

final class VisionProfileOutcomeAccumulator: @unchecked Sendable {
  private let lock = NSLock()
  private var outcomes: [PhotoAssetClassificationOutcome?]

  init(count: Int) {
    outcomes = Array(repeating: nil, count: count)
  }

  func record(_ outcome: PhotoAssetClassificationOutcome, at index: Int) {
    lock.lock()
    outcomes[index] = outcome
    lock.unlock()
  }

  func snapshot() -> [PhotoAssetClassificationOutcome] {
    lock.lock()
    defer { lock.unlock() }
    return outcomes.compactMap { $0 }
  }
}

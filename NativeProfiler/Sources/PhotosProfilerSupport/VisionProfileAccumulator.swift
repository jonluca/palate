import BatchAssetInfoCore
import Foundation

final class VisionProfileAccumulator: @unchecked Sendable {
  private let lock = NSLock()
  private var successfulClassifications = 0
  private var failedClassifications = 0
  private var totalLabels = 0
  private var sampledErrorDescriptions: [String] = []

  func record(_ result: Result<PhotoAssetClassification, Error>) {
    lock.lock()
    defer { lock.unlock() }

    switch result {
    case .success(let classification):
      successfulClassifications += 1
      totalLabels += classification.labels.count
    case .failure(let error):
      failedClassifications += 1
      if sampledErrorDescriptions.count < 3 {
        sampledErrorDescriptions.append(error.localizedDescription)
      }
    }
  }

  func snapshot() -> (
    successfulClassifications: Int,
    failedClassifications: Int,
    totalLabels: Int,
    sampledErrorDescriptions: [String]
  ) {
    lock.lock()
    defer { lock.unlock() }
    return (
      successfulClassifications,
      failedClassifications,
      totalLabels,
      sampledErrorDescriptions
    )
  }
}

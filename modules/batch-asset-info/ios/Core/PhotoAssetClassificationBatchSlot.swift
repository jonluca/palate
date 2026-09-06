import Foundation

public enum PhotoAssetClassificationBatchSlot: Sendable {
  case missing(assetId: String)
  case success(PhotoAssetClassification)
  case failure(assetId: String, message: String)
  case duplicate(assetId: String)

  public var assetId: String {
    switch self {
    case .missing(let assetId), .failure(let assetId, _), .duplicate(let assetId):
      assetId
    case .success(let classification):
      classification.assetId
    }
  }

  public static func make(
    requestedAssetIds: [String],
    outcomes: [PhotoAssetClassificationOutcome]
  ) -> [PhotoAssetClassificationBatchSlot] {
    var slots: [PhotoAssetClassificationBatchSlot] = []
    slots.reserveCapacity(requestedAssetIds.count)
    // Keep canonically equivalent but byte-distinct identifiers separate.
    var firstRequestedIndexByAssetIdBytes: [Data: Int] = [:]
    firstRequestedIndexByAssetIdBytes.reserveCapacity(requestedAssetIds.count)
    for (index, assetId) in requestedAssetIds.enumerated() {
      let bytes = Data(assetId.utf8)
      if firstRequestedIndexByAssetIdBytes[bytes] == nil {
        firstRequestedIndexByAssetIdBytes[bytes] = index
        slots.append(.missing(assetId: assetId))
      } else {
        slots.append(.duplicate(assetId: assetId))
      }
    }

    for outcome in outcomes {
      let bytes = Data(outcome.assetId.utf8)
      guard
        let firstRequestedIndex = firstRequestedIndexByAssetIdBytes[bytes],
        case .missing(let assetId) = slots[firstRequestedIndex]
      else {
        continue
      }
      switch outcome {
      case .success(let classification):
        slots[firstRequestedIndex] = .success(classification)
      case .failure(_, let message):
        slots[firstRequestedIndex] = .failure(assetId: assetId, message: message)
      }
    }
    return slots
  }
}

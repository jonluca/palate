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
    var requestedAssetIdBytes: [Data] = []
    requestedAssetIdBytes.reserveCapacity(requestedAssetIds.count)
    var firstRequestedIndexByAssetIdBytes: [Data: Int] = [:]
    firstRequestedIndexByAssetIdBytes.reserveCapacity(requestedAssetIds.count)
    for (index, assetId) in requestedAssetIds.enumerated() {
      let bytes = Data(assetId.utf8)
      requestedAssetIdBytes.append(bytes)
      if firstRequestedIndexByAssetIdBytes[bytes] == nil {
        firstRequestedIndexByAssetIdBytes[bytes] = index
      }
    }

    var outcomeByFirstRequestedIndex = [PhotoAssetClassificationOutcome?](
      repeating: nil,
      count: requestedAssetIds.count
    )
    for outcome in outcomes {
      let bytes = Data(outcome.assetId.utf8)
      guard
        let firstRequestedIndex = firstRequestedIndexByAssetIdBytes[bytes],
        outcomeByFirstRequestedIndex[firstRequestedIndex] == nil
      else {
        continue
      }
      outcomeByFirstRequestedIndex[firstRequestedIndex] = outcome
    }

    return requestedAssetIds.indices.map { index in
      let assetId = requestedAssetIds[index]
      let assetIdBytes = requestedAssetIdBytes[index]
      guard firstRequestedIndexByAssetIdBytes[assetIdBytes] == index else {
        return .duplicate(assetId: assetId)
      }
      guard let outcome = outcomeByFirstRequestedIndex[index] else {
        return .missing(assetId: assetId)
      }
      switch outcome {
      case .success(let classification):
        return .success(classification)
      case .failure(_, let message):
        return .failure(assetId: assetId, message: message)
      }
    }
  }
}

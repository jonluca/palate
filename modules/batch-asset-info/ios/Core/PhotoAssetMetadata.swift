import Foundation
import Photos

public struct PhotoAssetMetadata: Sendable {
  public let id: String
  public let uri: String
  public let creationTime: Double?
  public let modificationTime: Double?
  public let width: Int
  public let height: Int
  public let mediaType: PhotoAssetMediaType
  public let duration: Double
  public let location: PhotoAssetLocation?

  public init(asset: PHAsset) {
    id = asset.localIdentifier
    uri = "ph://\(asset.localIdentifier)"
    creationTime = asset.creationDate.map { $0.timeIntervalSince1970 * 1000 }
    modificationTime = asset.modificationDate.map { $0.timeIntervalSince1970 * 1000 }
    width = asset.pixelWidth
    height = asset.pixelHeight
    mediaType = PhotoAssetMediaType(asset.mediaType)
    duration = asset.duration
    location = PhotoAssetLocation(asset.location)
  }
}

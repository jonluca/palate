public struct PhotoAssetScanRecord: Sendable {
  public let id: String
  public let uri: String
  public let creationTime: Double?
  public let latitude: Double?
  public let longitude: Double?
  public let mediaType: PhotoAssetMediaType
  public let duration: Double?

  init(metadata: PhotoAssetMetadata) throws {
    guard metadata.mediaType == .photo || metadata.mediaType == .video else {
      throw PhotoAssetScanError.unsupportedMediaType(id: metadata.id, mediaType: metadata.mediaType)
    }

    id = metadata.id
    uri = metadata.uri
    creationTime = metadata.creationTime
    latitude = metadata.location?.latitude
    longitude = metadata.location?.longitude
    mediaType = metadata.mediaType
    duration = metadata.mediaType == .video ? metadata.duration : nil
  }
}

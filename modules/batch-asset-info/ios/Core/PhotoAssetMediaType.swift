import Photos

public enum PhotoAssetMediaType: String, Sendable {
  case photo
  case video
  case audio
  case unknown

  init(_ mediaType: PHAssetMediaType) {
    switch mediaType {
    case .image:
      self = .photo
    case .video:
      self = .video
    case .audio:
      self = .audio
    case .unknown:
      self = .unknown
    @unknown default:
      self = .unknown
    }
  }
}

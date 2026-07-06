import Photos

public enum PhotoAssetThumbnailContentMode: String, Hashable, Sendable {
  case aspectFill
  case aspectFit

  var photoKitValue: PHImageContentMode {
    switch self {
    case .aspectFill:
      return .aspectFill
    case .aspectFit:
      return .aspectFit
    }
  }
}

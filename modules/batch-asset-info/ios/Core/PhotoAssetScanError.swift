import Foundation

public enum PhotoAssetScanError: LocalizedError, Sendable {
  case photoLibraryAccessRequired(status: Int)
  case invalidOffset(offset: Int, totalCount: Int)
  case invalidLimit(limit: Int, maximum: Int)
  case unsupportedMediaType(id: String, mediaType: PhotoAssetMediaType)

  public var code: String {
    switch self {
    case .photoLibraryAccessRequired:
      return "ERR_PHOTO_LIBRARY_ACCESS_REQUIRED"
    case .invalidOffset:
      return "ERR_ASSET_SCAN_INVALID_OFFSET"
    case .invalidLimit:
      return "ERR_ASSET_SCAN_INVALID_LIMIT"
    case .unsupportedMediaType:
      return "ERR_ASSET_SCAN_UNSUPPORTED_MEDIA_TYPE"
    }
  }

  public var errorDescription: String? {
    switch self {
    case .photoLibraryAccessRequired(let status):
      return "Photo library read access is required to begin an asset scan (authorization status: \(status))."
    case .invalidOffset(let offset, let totalCount):
      return "Asset scan offset \(offset) is outside the valid range 0...\(totalCount)."
    case .invalidLimit(let limit, let maximum):
      return "Asset scan page limit \(limit) is outside the valid range 1...\(maximum)."
    case .unsupportedMediaType(let id, let mediaType):
      return "Asset \(id) has unsupported media type \(mediaType.rawValue)."
    }
  }
}

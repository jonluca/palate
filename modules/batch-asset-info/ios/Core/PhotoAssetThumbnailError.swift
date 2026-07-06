import Foundation

public enum PhotoAssetThumbnailError: Error, Equatable, LocalizedError, Sendable {
  case invalidURI(String)
  case invalidAssetIdentifier
  case invalidTarget(width: Double, height: Double, scale: Double)
  case targetTooLarge(width: Int, height: Int, maximumDimension: Int)
  case targetPixelCountTooLarge(width: Int, height: Int, maximumPixelCount: Int)
  case photoLibraryAccessRequired(status: Int)
  case assetNotFound(String)
  case requestCancelled(String)
  case imageUnavailable(String)
  case photoKitFailure(assetIdentifier: String, message: String)
  case cacheCleared

  public var code: String {
    switch self {
    case .invalidURI:
      return "ERR_THUMBNAIL_INVALID_URI"
    case .invalidAssetIdentifier:
      return "ERR_THUMBNAIL_INVALID_ASSET_ID"
    case .invalidTarget, .targetTooLarge, .targetPixelCountTooLarge:
      return "ERR_THUMBNAIL_INVALID_TARGET"
    case .photoLibraryAccessRequired:
      return "ERR_THUMBNAIL_PHOTOS_PERMISSION"
    case .assetNotFound:
      return "ERR_THUMBNAIL_ASSET_NOT_FOUND"
    case .requestCancelled:
      return "ERR_THUMBNAIL_CANCELLED"
    case .imageUnavailable:
      return "ERR_THUMBNAIL_IMAGE_UNAVAILABLE"
    case .photoKitFailure:
      return "ERR_THUMBNAIL_PHOTOKIT"
    case .cacheCleared:
      return "ERR_THUMBNAIL_CACHE_CLEARED"
    }
  }

  public var errorDescription: String? {
    switch self {
    case .invalidURI(let uri):
      return "The photo thumbnail URI is not a valid ph:// URI: \(uri)"
    case .invalidAssetIdentifier:
      return "The photo thumbnail asset identifier must not be empty."
    case .invalidTarget(let width, let height, let scale):
      return "Photo thumbnail dimensions and scale must be finite and greater than zero (width: \(width), height: \(height), scale: \(scale))."
    case .targetTooLarge(let width, let height, let maximumDimension):
      return "Photo thumbnail target \(width)x\(height) exceeds the maximum dimension of \(maximumDimension) pixels."
    case .targetPixelCountTooLarge(let width, let height, let maximumPixelCount):
      return "Photo thumbnail target \(width)x\(height) exceeds the maximum decoded pixel count of \(maximumPixelCount)."
    case .photoLibraryAccessRequired(let status):
      return "Photo library read access is required to load thumbnails (authorization status: \(status))."
    case .assetNotFound(let assetIdentifier):
      return "Photo asset \(assetIdentifier) was not found or is no longer accessible."
    case .requestCancelled(let assetIdentifier):
      return "Photo thumbnail request for \(assetIdentifier) was cancelled."
    case .imageUnavailable(let assetIdentifier):
      return "PhotoKit did not return a thumbnail for asset \(assetIdentifier)."
    case .photoKitFailure(let assetIdentifier, let message):
      return "PhotoKit failed to load thumbnail \(assetIdentifier): \(message)"
    case .cacheCleared:
      return "The photo thumbnail cache was cleared while the request was active."
    }
  }
}

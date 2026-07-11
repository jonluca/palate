public enum PhotoAssetThumbnailPreheatTransition: String, Equatable, Sendable {
  case updated
  case resetGeneration
  case ignoredStaleGeneration
}

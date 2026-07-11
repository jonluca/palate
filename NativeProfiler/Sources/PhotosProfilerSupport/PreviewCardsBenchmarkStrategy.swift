import Foundation

public enum PreviewCardsBenchmarkStrategy: String, Encodable, Equatable, Sendable {
  case expoPhotoLibraryAssetLoaderPhotoKit = "expo-photo-library-asset-loader-photokit"
  case photoAssetThumbnailStore = "photo-asset-thumbnail-store"
}

extension PreviewCardsBenchmarkStrategy {
  static let allProfilerCases: [PreviewCardsBenchmarkStrategy] = [
    .expoPhotoLibraryAssetLoaderPhotoKit,
    .photoAssetThumbnailStore,
  ]
}

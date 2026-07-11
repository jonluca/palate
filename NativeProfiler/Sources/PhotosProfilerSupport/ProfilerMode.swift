import Foundation

public enum ProfilerMode: String, Encodable, Equatable, Sendable {
  case photos
  case vision
  case initialImages = "initial-images"
  case initialImagePreheat = "initial-image-preheat"
  case thumbnailScroll = "thumbnail-scroll"
  case previewCards = "preview-cards"
}

import BatchAssetInfoCore

#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif

enum InitialImagePixelSize {
  static func read(_ image: PhotoAssetThumbnailImage) -> (width: Int, height: Int) {
    #if canImport(UIKit)
      if let cgImage = image.cgImage {
        return (cgImage.width, cgImage.height)
      }
      return (
        max(1, Int((image.size.width * image.scale).rounded(.up))),
        max(1, Int((image.size.height * image.scale).rounded(.up)))
      )
    #elseif canImport(AppKit)
      if let representation = image.representations.max(by: {
        $0.pixelsWide * $0.pixelsHigh < $1.pixelsWide * $1.pixelsHigh
      }) {
        return (max(1, representation.pixelsWide), max(1, representation.pixelsHigh))
      }
      return (
        max(1, Int(image.size.width.rounded(.up))),
        max(1, Int(image.size.height.rounded(.up)))
      )
    #endif
  }
}

#if canImport(UIKit)
import UIKit

public typealias PhotoAssetThumbnailImage = UIImage

func photoAssetThumbnailImageCost(_ image: UIImage) -> Int {
  if let cgImage = image.cgImage {
    return cgImage.bytesPerRow * cgImage.height
  }

  let pixelWidth = max(1, Int((image.size.width * image.scale).rounded(.up)))
  let pixelHeight = max(1, Int((image.size.height * image.scale).rounded(.up)))
  return pixelWidth * pixelHeight * 4
}

func photoAssetThumbnailPixelSize(_ image: UIImage) -> (width: Int, height: Int) {
  if let cgImage = image.cgImage {
    return (cgImage.width, cgImage.height)
  }

  return (
    max(1, Int((image.size.width * image.scale).rounded(.up))),
    max(1, Int((image.size.height * image.scale).rounded(.up)))
  )
}
#elseif canImport(AppKit)
import AppKit

public typealias PhotoAssetThumbnailImage = NSImage

func photoAssetThumbnailImageCost(_ image: NSImage) -> Int {
  let size = photoAssetThumbnailPixelSize(image)
  return size.width * size.height * 4
}

func photoAssetThumbnailPixelSize(_ image: NSImage) -> (width: Int, height: Int) {
  if let representation = image.representations.max(by: { $0.pixelsWide * $0.pixelsHigh < $1.pixelsWide * $1.pixelsHigh }) {
    return (max(1, representation.pixelsWide), max(1, representation.pixelsHigh))
  }

  return (
    max(1, Int(image.size.width.rounded(.up))),
    max(1, Int(image.size.height.rounded(.up)))
  )
}
#endif

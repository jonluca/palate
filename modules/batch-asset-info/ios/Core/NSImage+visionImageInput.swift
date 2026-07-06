#if canImport(AppKit) && !canImport(UIKit)
import AppKit
import ImageIO

extension NSImage {
  func visionImageInput() -> VisionImageInput? {
    var proposedRect = CGRect(origin: .zero, size: size)
    guard let cgImage = cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
      return nil
    }
    return VisionImageInput(image: cgImage, orientation: .up)
  }
}
#endif

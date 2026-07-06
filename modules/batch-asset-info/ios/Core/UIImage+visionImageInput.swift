#if canImport(UIKit)
import ImageIO
import UIKit

extension UIImage {
  func visionImageInput() -> VisionImageInput? {
    guard let cgImage else {
      return nil
    }

    let orientation: CGImagePropertyOrientation
    switch imageOrientation {
    case .up:
      orientation = .up
    case .upMirrored:
      orientation = .upMirrored
    case .down:
      orientation = .down
    case .downMirrored:
      orientation = .downMirrored
    case .left:
      orientation = .left
    case .leftMirrored:
      orientation = .leftMirrored
    case .right:
      orientation = .right
    case .rightMirrored:
      orientation = .rightMirrored
    @unknown default:
      orientation = .up
    }

    return VisionImageInput(image: cgImage, orientation: orientation)
  }
}
#endif

import Foundation

public struct PhotoAssetThumbnailTarget: Hashable, Sendable {
  public static let maximumDimension = 8_192
  public static let maximumPixelCount = 8_388_608

  public let pixelWidth: Int
  public let pixelHeight: Int

  public init(pixelWidth: Int, pixelHeight: Int) throws {
    guard pixelWidth > 0, pixelHeight > 0 else {
      throw PhotoAssetThumbnailError.invalidTarget(
        width: Double(pixelWidth),
        height: Double(pixelHeight),
        scale: 1
      )
    }
    guard pixelWidth <= Self.maximumDimension, pixelHeight <= Self.maximumDimension else {
      throw PhotoAssetThumbnailError.targetTooLarge(
        width: pixelWidth,
        height: pixelHeight,
        maximumDimension: Self.maximumDimension
      )
    }
    guard pixelWidth <= Self.maximumPixelCount / pixelHeight else {
      throw PhotoAssetThumbnailError.targetPixelCountTooLarge(
        width: pixelWidth,
        height: pixelHeight,
        maximumPixelCount: Self.maximumPixelCount
      )
    }

    self.pixelWidth = pixelWidth
    self.pixelHeight = pixelHeight
  }

  public init(pointWidth: Double, pointHeight: Double, scale: Double) throws {
    guard pointWidth.isFinite,
          pointHeight.isFinite,
          scale.isFinite,
          pointWidth > 0,
          pointHeight > 0,
          scale > 0
    else {
      throw PhotoAssetThumbnailError.invalidTarget(width: pointWidth, height: pointHeight, scale: scale)
    }

    let scaledWidth = (pointWidth * scale).rounded(.up)
    let scaledHeight = (pointHeight * scale).rounded(.up)
    guard scaledWidth <= Double(Int.max), scaledHeight <= Double(Int.max) else {
      throw PhotoAssetThumbnailError.targetTooLarge(
        width: Self.maximumDimension + 1,
        height: Self.maximumDimension + 1,
        maximumDimension: Self.maximumDimension
      )
    }

    try self.init(pixelWidth: Int(scaledWidth), pixelHeight: Int(scaledHeight))
  }

  var size: CGSize {
    CGSize(width: pixelWidth, height: pixelHeight)
  }
}

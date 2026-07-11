import BatchAssetInfoCore
import Foundation

struct PreviewCardsGeometry: Equatable, Sendable {
  static let supportedArities = [1, 2, 3]

  let totalCardPixelWidth: Int
  let cardPixelHeight: Int

  init(totalCardPixelWidth: Int, cardPixelHeight: Int) throws {
    _ = try PhotoAssetThumbnailTarget(
      pixelWidth: totalCardPixelWidth,
      pixelHeight: cardPixelHeight
    )
    self.totalCardPixelWidth = totalCardPixelWidth
    self.cardPixelHeight = cardPixelHeight
  }

  func target(for arity: Int) throws -> PhotoAssetThumbnailTarget {
    guard Self.supportedArities.contains(arity) else {
      throw PreviewCardsBenchmarkError.invalidCardArity(arity)
    }
    return try PhotoAssetThumbnailTarget(
      pixelWidth: max(1, totalCardPixelWidth / arity),
      pixelHeight: cardPixelHeight
    )
  }
}

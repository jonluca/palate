public struct PhotoAssetThumbnailPreheatBudget: Equatable, Sendable {
  /// A nominal four-byte-per-target-pixel planning estimate. It excludes row alignment, image
  /// object overhead, and opaque PhotoKit cache overhead, so callers must reserve safety headroom.
  public static let estimatedBytesPerPixel: UInt64 = 4

  public static let unbounded = PhotoAssetThumbnailPreheatBudget(
    maximumPixelCount: .max,
    maximumEstimatedByteCount: .max,
    maximumKeyCount: .max
  )

  public static let windowedV1 = PhotoAssetThumbnailPreheatBudget(
    maximumPixelCount: 4_194_304,
    maximumEstimatedByteCount: 16 * 1_024 * 1_024,
    maximumKeyCount: 24
  )

  public let maximumPixelCount: UInt64
  /// Caps the nominal estimate, not PhotoKit's actual resident-memory usage.
  public let maximumEstimatedByteCount: UInt64
  /// Caps the number of distinct request keys even when their pixel targets are very small.
  public let maximumKeyCount: Int

  public init(
    maximumPixelCount: UInt64,
    maximumEstimatedByteCount: UInt64,
    maximumKeyCount: Int = .max
  ) {
    self.maximumPixelCount = maximumPixelCount
    self.maximumEstimatedByteCount = maximumEstimatedByteCount
    self.maximumKeyCount = max(0, maximumKeyCount)
  }
}

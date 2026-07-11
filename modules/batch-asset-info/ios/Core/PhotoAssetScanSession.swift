import Foundation
import Photos

public final class PhotoAssetScanSession {
  public static let maximumPageSize = 5_000

  private enum ExclusionSource {
    case none
    case identifiers([String])
    case database(PhotoAssetDatabaseIndex)
  }

  private let fetchResult: PHFetchResult<PHAsset>
  private let assetIndexes: [Int]?

  public let libraryTotalCount: Int
  public let excludedVisibleCount: Int
  public let excludedPhotosWithLocation: Int
  public let excludedSkippedAssets: Int

  public var totalCount: Int {
    assetIndexes?.count ?? libraryTotalCount
  }

  public convenience init() throws {
    try self.init(exclusionSource: .none)
  }

  public convenience init(existingAssetIdentifiers: [String]) throws {
    try self.init(exclusionSource: .identifiers(existingAssetIdentifiers))
  }

  public convenience init(databasePath: String) throws {
    let databaseIndex = try PhotoAssetDatabaseIndex(databasePath: databasePath)
    try self.init(exclusionSource: .database(databaseIndex))
  }

  private init(exclusionSource: ExclusionSource) throws {
    let authorizationStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    switch authorizationStatus {
    case .authorized, .limited:
      break
    case .denied, .restricted, .notDetermined:
      throw PhotoAssetScanError.photoLibraryAccessRequired(status: authorizationStatus.rawValue)
    @unknown default:
      throw PhotoAssetScanError.photoLibraryAccessRequired(status: authorizationStatus.rawValue)
    }

    let options = PHFetchOptions()
    options.predicate = NSPredicate(
      format: "mediaType IN %@",
      [
        NSNumber(value: PHAssetMediaType.image.rawValue),
        NSNumber(value: PHAssetMediaType.video.rawValue),
      ]
    )
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    options.includeAssetSourceTypes = .typeUserLibrary
    options.includeAllBurstAssets = false
    options.includeHiddenAssets = false

    let fetchedAssets = PHAsset.fetchAssets(with: options)
    fetchResult = fetchedAssets
    libraryTotalCount = fetchedAssets.count

    switch exclusionSource {
    case .none:
      assetIndexes = nil
      excludedVisibleCount = 0
      excludedPhotosWithLocation = 0
      excludedSkippedAssets = 0
    case .identifiers(let existingAssetIdentifiers):
      let plan = PhotoAssetIncrementalScanPlan(
        assetCount: fetchedAssets.count,
        existingAssetIdentifiers: existingAssetIdentifiers,
        assetAt: { index in
          let asset = fetchedAssets.object(at: index)
          return (
            identifier: asset.localIdentifier,
            excludedMetrics: {
              let creationTime = asset.creationDate.map { $0.timeIntervalSince1970 * 1_000 }
              return PhotoAssetScanStoredMetrics(
                hasUsableCreationTime: creationTime?.isFinite == true,
                hasValidLocation: PhotoAssetLocation(asset.location) != nil
              )
            }
          )
        }
      )
      assetIndexes = plan.unknownAssetIndexes
      excludedVisibleCount = plan.excludedVisibleCount
      excludedPhotosWithLocation = plan.excludedPhotosWithLocation
      excludedSkippedAssets = plan.excludedSkippedAssets
    case .database(let databaseIndex):
      let plan = PhotoAssetIncrementalScanPlan(
        assetCount: fetchedAssets.count,
        storedMetricsByIdentifier: databaseIndex.metricsByIdentifier,
        identifierAt: { index in
          fetchedAssets.object(at: index).localIdentifier
        }
      )
      assetIndexes = plan.unknownAssetIndexes
      excludedVisibleCount = plan.excludedVisibleCount
      excludedPhotosWithLocation = plan.excludedPhotosWithLocation
      excludedSkippedAssets = plan.excludedSkippedAssets
    }
  }

  public func page(offset: Int, limit: Int) throws -> PhotoAssetScanPage {
    guard offset >= 0, offset <= totalCount else {
      throw PhotoAssetScanError.invalidOffset(offset: offset, totalCount: totalCount)
    }
    guard limit > 0, limit <= Self.maximumPageSize else {
      throw PhotoAssetScanError.invalidLimit(limit: limit, maximum: Self.maximumPageSize)
    }

    let pageCount = min(limit, totalCount - offset)
    let endOffset = offset + pageCount
    var assets: [PhotoAssetScanRecord] = []
    assets.reserveCapacity(pageCount)

    for index in offset..<endOffset {
      let record = try autoreleasepool {
        let assetIndex = assetIndexes?[index] ?? index
        let metadata = PhotoAssetMetadata(asset: fetchResult.object(at: assetIndex))
        return try PhotoAssetScanRecord(metadata: metadata)
      }
      assets.append(record)
    }

    let hasNextPage = endOffset < totalCount
    return PhotoAssetScanPage(
      assets: assets,
      offset: offset,
      nextOffset: hasNextPage ? endOffset : nil,
      totalCount: totalCount,
      hasNextPage: hasNextPage
    )
  }
}

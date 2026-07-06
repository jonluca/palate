import Foundation
import Photos

public final class PhotoAssetScanSession {
  public static let maximumPageSize = 5_000

  private let fetchResult: PHFetchResult<PHAsset>

  public var totalCount: Int {
    fetchResult.count
  }

  public init() throws {
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
        NSNumber(value: PHAssetMediaType.video.rawValue)
      ]
    )
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    options.includeAssetSourceTypes = .typeUserLibrary
    options.includeAllBurstAssets = false
    options.includeHiddenAssets = false

    fetchResult = PHAsset.fetchAssets(with: options)
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
        let metadata = PhotoAssetMetadata(asset: fetchResult.object(at: index))
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

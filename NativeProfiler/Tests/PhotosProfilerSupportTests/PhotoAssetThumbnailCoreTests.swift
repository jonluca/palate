@testable import BatchAssetInfoCore
import Foundation
import Testing

@Suite("Photo asset thumbnail core")
struct PhotoAssetThumbnailCoreTests {
  @Test("Photo asset URI parsing preserves the complete opaque identifier")
  func opaqueIdentifierParsing() {
    let identifier = "A1B2C3/L0/001?opaque=value%2Fstill-opaque"

    #expect(PhotoAssetURI.localIdentifier(from: "ph://\(identifier)") == identifier)
    #expect(PhotoAssetURI.localIdentifier(from: "PH://\(identifier)") == nil)
    #expect(PhotoAssetURI.localIdentifier(from: "ph://") == nil)
    #expect(PhotoAssetURI.localIdentifier(from: "file://\(identifier)") == nil)
  }

  @Test("Point dimensions become exact nonzero pixel targets")
  func targetPixels() throws {
    let target = try PhotoAssetThumbnailTarget(pointWidth: 100.1, pointHeight: 55.5, scale: 2)

    #expect(target.pixelWidth == 201)
    #expect(target.pixelHeight == 111)
    #expect(throws: PhotoAssetThumbnailError.self) {
      try PhotoAssetThumbnailTarget(pointWidth: 0, pointHeight: 10, scale: 2)
    }
    #expect(throws: PhotoAssetThumbnailError.self) {
      try PhotoAssetThumbnailTarget(pointWidth: 10, pointHeight: .nan, scale: 2)
    }
    #expect(throws: PhotoAssetThumbnailError.self) {
      try PhotoAssetThumbnailTarget(
        pixelWidth: PhotoAssetThumbnailTarget.maximumDimension + 1,
        pixelHeight: 1
      )
    }
    #expect(throws: PhotoAssetThumbnailError.self) {
      try PhotoAssetThumbnailTarget(pixelWidth: 4_096, pixelHeight: 4_096)
    }
  }

  @Test("Request keys coalesce only identical rendering requests")
  func requestKeyIdentity() throws {
    let square = try PhotoAssetThumbnailTarget(pixelWidth: 300, pixelHeight: 300)
    let wide = try PhotoAssetThumbnailTarget(pixelWidth: 600, pixelHeight: 300)
    let first = try PhotoAssetThumbnailRequestKey(assetIdentifier: "asset", target: square)
    let duplicate = try PhotoAssetThumbnailRequestKey(assetIdentifier: "asset", target: square)
    let differentSize = try PhotoAssetThumbnailRequestKey(assetIdentifier: "asset", target: wide)
    let differentMode = try PhotoAssetThumbnailRequestKey(
      assetIdentifier: "asset",
      target: square,
      contentMode: .aspectFit
    )

    #expect(first == duplicate)
    #expect(first != differentSize)
    #expect(first != differentMode)
  }

  @Test("Batch accumulation is ordered and deduplicates request keys")
  func batchAccumulation() throws {
    let target = try PhotoAssetThumbnailTarget(pixelWidth: 300, pixelHeight: 300)
    let first = try PhotoAssetThumbnailRequestKey(assetIdentifier: "first", target: target)
    let second = try PhotoAssetThumbnailRequestKey(assetIdentifier: "second", target: target)
    var accumulator = PhotoAssetThumbnailBatchAccumulator()

    accumulator.enqueue(first)
    accumulator.enqueue(first)
    accumulator.enqueue(second)

    #expect(accumulator.drain() == [first, second])
    #expect(accumulator.isEmpty)
  }

  @Test("Cancellation is synchronous and invokes coordination once")
  func cancellationToken() {
    let state = CancellationState()
    let token = PhotoAssetThumbnailRequestToken {
      state.recordCancellation()
    }

    token.cancel()
    token.cancel()

    #expect(token.isCancelled)
    #expect(state.cancellationCount == 1)
  }

  @Test("Equivalent request keys address the same bounded-cache entry")
  func cacheKeyEquality() throws {
    let target = try PhotoAssetThumbnailTarget(pixelWidth: 320, pixelHeight: 240)
    let requestKey = try PhotoAssetThumbnailRequestKey(assetIdentifier: "opaque/L0/001", target: target)
    let cache = NSCache<PhotoAssetThumbnailCacheKey, NSString>()
    cache.setObject("cached", forKey: PhotoAssetThumbnailCacheKey(requestKey))

    #expect(cache.object(forKey: PhotoAssetThumbnailCacheKey(requestKey)) == "cached")
  }

  @Test("Cancellation before the batch flush suppresses all delivery")
  func cancellationBeforeFlush() async throws {
    let target = try PhotoAssetThumbnailTarget(pixelWidth: 120, pixelHeight: 120)
    let key = try PhotoAssetThumbnailRequestKey(assetIdentifier: "cancel-before-flush", target: target)
    let state = CancellationState()
    let store = PhotoAssetThumbnailStore(batchDelay: 0.05)

    let token = store.requestThumbnail(for: key) { _ in
      state.recordDelivery()
    }
    token.cancel()
    try await Task.sleep(for: .milliseconds(100))

    #expect(state.deliveryCount == 0)
  }

  @Test("A replacement entry rejects callbacks from the canceled request")
  func staleRequestIdentity() {
    let currentId = UUID()
    let staleId = UUID()
    let entry = PhotoAssetThumbnailRequestEntry(
      id: currentId,
      subscribers: [:],
      phase: .requesting,
      requestId: nil,
      latestDegradedImage: nil
    )

    #expect(entry.acceptsImageResult(from: currentId))
    #expect(!entry.acceptsImageResult(from: staleId))
  }
}

private final class CancellationState: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  private var deliveries = 0

  var cancellationCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return count
  }

  var deliveryCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return deliveries
  }

  func recordCancellation() {
    lock.lock()
    count += 1
    lock.unlock()
  }

  func recordDelivery() {
    lock.lock()
    deliveries += 1
    lock.unlock()
  }
}

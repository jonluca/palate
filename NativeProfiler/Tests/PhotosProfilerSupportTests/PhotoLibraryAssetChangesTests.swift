import Foundation
import Testing

@testable import BatchAssetInfoCore

@Suite("Photo library persistent change planning")
struct PhotoLibraryAssetChangesTests {
  @Test("Coalescing retains old imported timestamps, unknown updates, and restores after deletion")
  func orderedChanges() {
    var changes = PhotoLibraryAssetChanges()
    changes.apply(
      inserted: ["backdated-import", "deleted-later", "restored"],
      updated: ["previously-inaccessible"],
      deleted: []
    )
    changes.apply(inserted: [], updated: ["backdated-import"], deleted: ["deleted-later", "restored"])
    changes.apply(inserted: ["restored"], updated: [], deleted: [])

    #expect(changes.candidateIdentifiers == ["backdated-import", "previously-inaccessible", "restored"])
  }

  @Test("Empty history remains empty and a terminal deletion wins within one change")
  func emptyAndDeletedChanges() {
    var changes = PhotoLibraryAssetChanges()
    #expect(changes.candidateIdentifiers.isEmpty)
    changes.apply(inserted: ["same"], updated: ["same"], deleted: ["same"])
    #expect(changes.candidateIdentifiers.isEmpty)
  }

  @Test("Checkpoints preserve opaque bytes and reject malformed, future, or different-scope values")
  func checkpointRoundTripAndValidation() throws {
    let checkpoint = PhotoLibraryChangeCheckpoint(archive: Data([0, 1, 255]), authorizationStatus: 3)
    let serialized = try checkpoint.serialized()
    #expect(PhotoLibraryChangeCheckpoint.decode(serialized, authorizationStatus: 3) == checkpoint)
    #expect(PhotoLibraryChangeCheckpoint.decode(serialized, authorizationStatus: 4) == nil)
    #expect(PhotoLibraryChangeCheckpoint.decode("not-base64", authorizationStatus: 3) == nil)
    let future = Data(#"{"version":2,"authorizationStatus":3,"archive":"AQ=="}"#.utf8).base64EncodedString()
    #expect(PhotoLibraryChangeCheckpoint.decode(future, authorizationStatus: 3) == nil)
    let empty = try PhotoLibraryChangeCheckpoint(archive: Data(), authorizationStatus: 3).serialized()
    #expect(PhotoLibraryChangeCheckpoint.decode(empty, authorizationStatus: 3) == nil)
  }
}

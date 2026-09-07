import Foundation
import Photos

/// Owns preparation only. The caller checkpoints the returned token after durable metadata import.
public final class PhotoLibraryChangeScan {
  public enum Mode: String {
    case full
    case delta
  }

  public let session: PhotoAssetScanSession
  public let changeToken: String?
  public let mode: Mode

  public init(databasePath: String, serializedToken: String?) throws {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    let library = PHPhotoLibrary.shared()

    // Changes to the selected asset set need a full reconciliation. Never advance a limited-scope token.
    if status == .authorized,
      let serializedToken,
      let checkpoint = PhotoLibraryChangeCheckpoint.decode(serializedToken, authorizationStatus: status.rawValue),
      let token = try? NSKeyedUnarchiver.unarchivedObject(
        ofClass: PHPersistentChangeToken.self, from: checkpoint.archive)
    {
      do {
        let history = try library.fetchPersistentChanges(since: token)
        var changes = PhotoLibraryAssetChanges()
        var lastToken = token
        for change in history {
          let details = try change.changeDetails(for: .asset)
          changes.apply(
            inserted: details.insertedLocalIdentifiers,
            updated: details.updatedLocalIdentifiers,
            deleted: details.deletedLocalIdentifiers
          )
          lastToken = change.changeToken
        }
        // A stable retained result contains all candidates through lastToken. Later events remain replayable.
        let nextToken = try Self.serialize(lastToken, authorizationStatus: status.rawValue)
        let deltaSession = try PhotoAssetScanSession(
          databasePath: databasePath,
          assetIdentifiers: Array(changes.candidateIdentifiers)
        )
        session = deltaSession
        changeToken = PHPhotoLibrary.authorizationStatus(for: .readWrite) == status ? nextToken : nil
        mode = .delta
        return
      } catch {
        // Expired tokens, unavailable details, and malformed history all retain the established full path.
      }
    }

    // Capture BEFORE both the database read and PhotoKit snapshot, so concurrent additions are replayed.
    let checkpoint = status == .authorized
      ? try? Self.serialize(library.currentChangeToken, authorizationStatus: status.rawValue)
      : nil
    session = try PhotoAssetScanSession(databasePath: databasePath)
    changeToken = PHPhotoLibrary.authorizationStatus(for: .readWrite) == status ? checkpoint : nil
    mode = .full
  }

  private static func serialize(_ token: PHPersistentChangeToken, authorizationStatus: Int) throws -> String {
    let archive = try NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true)
    return try PhotoLibraryChangeCheckpoint(archive: archive, authorizationStatus: authorizationStatus).serialized()
  }
}

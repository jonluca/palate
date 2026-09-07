import Foundation

/// Versioned wrapper prevents a token from being reused under a different authorization scope.
struct PhotoLibraryChangeCheckpoint: Codable, Equatable, Sendable {
  let version: Int
  let authorizationStatus: Int
  let archive: Data

  init(archive: Data, authorizationStatus: Int) {
    version = 1
    self.authorizationStatus = authorizationStatus
    self.archive = archive
  }

  func serialized() throws -> String {
    try JSONEncoder().encode(self).base64EncodedString()
  }

  static func decode(_ serialized: String, authorizationStatus: Int) -> Self? {
    guard
      let data = Data(base64Encoded: serialized),
      let checkpoint = try? JSONDecoder().decode(Self.self, from: data),
      checkpoint.version == 1,
      checkpoint.authorizationStatus == authorizationStatus,
      !checkpoint.archive.isEmpty
    else {
      return nil
    }
    return checkpoint
  }
}

enum PhotoAssetScanImplementation: String, Equatable, Sendable {
  case legacy
  case identifierList = "identifier-list"
  case databaseBacked = "database-backed"

  var scanKind: PhotoAssetScanStrategy {
    switch self {
    case .legacy:
      return .legacy
    case .identifierList, .databaseBacked:
      return .incremental
    }
  }
}

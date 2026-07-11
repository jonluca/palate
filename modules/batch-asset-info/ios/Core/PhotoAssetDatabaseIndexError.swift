import Foundation

enum PhotoAssetDatabaseIndexError: LocalizedError, Equatable, Sendable {
  case invalidPath(String)
  case openFailed(code: Int32, message: String)
  case schemaReadFailed(code: Int32, message: String)
  case incompatibleSchema
  case rowReadFailed(code: Int32, message: String)
  case invalidIdentifier(row: Int)
  case duplicateIdentifier(row: Int)
  case invalidColumnType(column: String, row: Int)

  var errorDescription: String? {
    switch self {
    case .invalidPath(let path):
      return "Photo scan database path is missing or is not a file: \(path)"
    case .openFailed(let code, let message):
      return "Unable to open the photo scan database read-only (SQLite \(code)): \(message)"
    case .schemaReadFailed(let code, let message):
      return "Photo scan database schema is incompatible (SQLite \(code)): \(message)"
    case .incompatibleSchema:
      return "Photo scan database does not contain the required photos table schema."
    case .rowReadFailed(let code, let message):
      return "Unable to read the photo scan database (SQLite \(code)): \(message)"
    case .invalidIdentifier(let row):
      return "Photo scan database row \(row) has an invalid asset identifier."
    case .duplicateIdentifier(let row):
      return "Photo scan database row \(row) repeats an asset identifier."
    case .invalidColumnType(let column, let row):
      return "Photo scan database column \(column) has an invalid value at row \(row)."
    }
  }
}

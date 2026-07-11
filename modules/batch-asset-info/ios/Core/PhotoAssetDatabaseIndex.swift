import Foundation

struct PhotoAssetDatabaseIndex: Equatable, Sendable {
  private static let selectSQL =
    "SELECT id, creationTime, latitude, longitude FROM photos"

  let metricsByIdentifier: [String: PhotoAssetScanStoredMetrics]

  init(databasePath: String) throws {
    var isDirectory = ObjCBool(false)
    guard
      !databasePath.isEmpty,
      FileManager.default.fileExists(atPath: databasePath, isDirectory: &isDirectory),
      !isDirectory.boolValue
    else {
      throw PhotoAssetDatabaseIndexError.invalidPath(databasePath)
    }

    var database: OpaquePointer?
    let openResult = PhotoAssetSQLite.openReadOnlyDatabase(
      path: databasePath,
      database: &database
    )
    guard openResult == PhotoAssetSQLite.ok, let database else {
      let message = PhotoAssetSQLite.errorMessage(database)
      if let database {
        _ = PhotoAssetSQLite.close(database)
      }
      throw PhotoAssetDatabaseIndexError.openFailed(code: openResult, message: message)
    }
    defer { _ = PhotoAssetSQLite.close(database) }
    PhotoAssetSQLite.enableExtendedResultCodes(database)
    PhotoAssetSQLite.setBusyTimeout(database, milliseconds: 1_000)

    guard PhotoAssetSQLite.isReadOnly(database) else {
      throw PhotoAssetDatabaseIndexError.openFailed(
        code: PhotoAssetSQLite.readOnly,
        message: "SQLite did not open the main database read-only"
      )
    }

    try Self.validateSchema(database: database)

    var statement: OpaquePointer?
    let prepareResult = PhotoAssetSQLite.prepare(
      database: database,
      sql: Self.selectSQL,
      statement: &statement
    )
    guard prepareResult == PhotoAssetSQLite.ok, let statement else {
      throw PhotoAssetDatabaseIndexError.schemaReadFailed(
        code: prepareResult,
        message: PhotoAssetSQLite.errorMessage(database)
      )
    }
    defer { _ = PhotoAssetSQLite.finalize(statement) }

    var metrics: [String: PhotoAssetScanStoredMetrics] = [:]
    var row = 0
    while true {
      let stepResult = PhotoAssetSQLite.step(statement)
      switch stepResult {
      case PhotoAssetSQLite.row:
        row += 1
        let identifier = try Self.requiredIdentifier(statement: statement, row: row)
        guard metrics[identifier] == nil else {
          throw PhotoAssetDatabaseIndexError.duplicateIdentifier(row: row)
        }
        let creationTime = try Self.optionalNumber(
          statement: statement,
          columnIndex: 1,
          columnName: "creationTime",
          row: row
        )
        let latitude = try Self.optionalNumber(
          statement: statement,
          columnIndex: 2,
          columnName: "latitude",
          row: row
        )
        let longitude = try Self.optionalNumber(
          statement: statement,
          columnIndex: 3,
          columnName: "longitude",
          row: row
        )
        let hasValidLocation: Bool
        if let latitude, let longitude {
          hasValidLocation =
            PhotoAssetLocation(
              latitude: latitude,
              longitude: longitude
            ) != nil
        } else {
          hasValidLocation = false
        }
        metrics[identifier] = PhotoAssetScanStoredMetrics(
          hasUsableCreationTime: creationTime?.isFinite == true,
          hasValidLocation: hasValidLocation
        )
      case PhotoAssetSQLite.done:
        metricsByIdentifier = metrics
        return
      default:
        throw PhotoAssetDatabaseIndexError.rowReadFailed(
          code: stepResult,
          message: PhotoAssetSQLite.errorMessage(database)
        )
      }
    }
  }

  private static func requiredIdentifier(
    statement: OpaquePointer,
    row: Int
  ) throws -> String {
    guard let identifier = text(statement: statement, columnIndex: 0), !identifier.isEmpty else {
      throw PhotoAssetDatabaseIndexError.invalidIdentifier(row: row)
    }
    return identifier
  }

  private static func optionalNumber(
    statement: OpaquePointer,
    columnIndex: Int32,
    columnName: String,
    row: Int
  ) throws -> Double? {
    switch PhotoAssetSQLite.columnType(statement, index: columnIndex) {
    case PhotoAssetSQLite.null:
      return nil
    case PhotoAssetSQLite.integer, PhotoAssetSQLite.float:
      return PhotoAssetSQLite.columnDouble(statement, index: columnIndex)
    default:
      throw PhotoAssetDatabaseIndexError.invalidColumnType(
        column: columnName,
        row: row
      )
    }
  }

  private static func validateSchema(database: OpaquePointer) throws {
    var objectStatement: OpaquePointer?
    let objectPrepareResult = PhotoAssetSQLite.prepare(
      database: database,
      sql: "SELECT type FROM sqlite_schema WHERE name = 'photos'",
      statement: &objectStatement
    )
    guard objectPrepareResult == PhotoAssetSQLite.ok, let objectStatement else {
      throw PhotoAssetDatabaseIndexError.schemaReadFailed(
        code: objectPrepareResult,
        message: PhotoAssetSQLite.errorMessage(database)
      )
    }
    defer { _ = PhotoAssetSQLite.finalize(objectStatement) }

    let objectStepResult = PhotoAssetSQLite.step(objectStatement)
    guard objectStepResult == PhotoAssetSQLite.row else {
      if objectStepResult == PhotoAssetSQLite.done {
        throw PhotoAssetDatabaseIndexError.incompatibleSchema
      }
      throw PhotoAssetDatabaseIndexError.schemaReadFailed(
        code: objectStepResult,
        message: PhotoAssetSQLite.errorMessage(database)
      )
    }
    guard
      text(statement: objectStatement, columnIndex: 0) == "table",
      PhotoAssetSQLite.step(objectStatement) == PhotoAssetSQLite.done
    else {
      throw PhotoAssetDatabaseIndexError.incompatibleSchema
    }

    var columnStatement: OpaquePointer?
    let columnPrepareResult = PhotoAssetSQLite.prepare(
      database: database,
      sql: "PRAGMA table_info('photos')",
      statement: &columnStatement
    )
    guard columnPrepareResult == PhotoAssetSQLite.ok, let columnStatement else {
      throw PhotoAssetDatabaseIndexError.schemaReadFailed(
        code: columnPrepareResult,
        message: PhotoAssetSQLite.errorMessage(database)
      )
    }
    defer { _ = PhotoAssetSQLite.finalize(columnStatement) }

    var hasIdentifier = false
    var hasCreationTime = false
    var hasLatitude = false
    var hasLongitude = false
    while true {
      let stepResult = PhotoAssetSQLite.step(columnStatement)
      switch stepResult {
      case PhotoAssetSQLite.row:
        guard
          let name = text(statement: columnStatement, columnIndex: 1),
          let declaredType = text(statement: columnStatement, columnIndex: 2)
        else {
          throw PhotoAssetDatabaseIndexError.incompatibleSchema
        }
        let normalizedType = declaredType.uppercased()
        let isNotNull = PhotoAssetSQLite.columnInt64(columnStatement, index: 3) == 1
        let primaryKeyPosition = PhotoAssetSQLite.columnInt64(columnStatement, index: 5)
        switch name {
        case "id":
          hasIdentifier = normalizedType == "TEXT" && primaryKeyPosition > 0
        case "creationTime":
          hasCreationTime = normalizedType == "INTEGER" && isNotNull
        case "latitude":
          hasLatitude = normalizedType == "REAL" && !isNotNull
        case "longitude":
          hasLongitude = normalizedType == "REAL" && !isNotNull
        default:
          break
        }
      case PhotoAssetSQLite.done:
        guard hasIdentifier, hasCreationTime, hasLatitude, hasLongitude else {
          throw PhotoAssetDatabaseIndexError.incompatibleSchema
        }
        return
      default:
        throw PhotoAssetDatabaseIndexError.schemaReadFailed(
          code: stepResult,
          message: PhotoAssetSQLite.errorMessage(database)
        )
      }
    }
  }

  private static func text(
    statement: OpaquePointer,
    columnIndex: Int32
  ) -> String? {
    guard PhotoAssetSQLite.columnType(statement, index: columnIndex) == PhotoAssetSQLite.text else {
      return nil
    }
    let byteCount = Int(PhotoAssetSQLite.columnBytes(statement, index: columnIndex))
    guard byteCount >= 0, let bytes = PhotoAssetSQLite.columnText(statement, index: columnIndex)
    else {
      return byteCount == 0 ? "" : nil
    }
    return String(
      bytes: UnsafeBufferPointer(start: bytes, count: byteCount),
      encoding: .utf8
    )
  }

}

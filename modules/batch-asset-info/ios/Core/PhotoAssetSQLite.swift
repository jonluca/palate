#if SWIFT_PACKAGE
  import SQLite3
#else
  import ExpoSQLite
#endif

enum PhotoAssetSQLite {
  static let ok = SQLITE_OK
  static let row = SQLITE_ROW
  static let done = SQLITE_DONE
  static let readOnly = SQLITE_READONLY
  static let integer = SQLITE_INTEGER
  static let float = SQLITE_FLOAT
  static let text = SQLITE_TEXT
  static let null = SQLITE_NULL
  static let openReadOnly = SQLITE_OPEN_READONLY
  static let openNoMutex = SQLITE_OPEN_NOMUTEX

  static func openReadOnlyDatabase(
    path: String,
    database: inout OpaquePointer?
  ) -> Int32 {
    #if SWIFT_PACKAGE
      return sqlite3_open_v2(path, &database, openReadOnly | openNoMutex, nil)
    #else
      return exsqlite3_open_v2(path, &database, openReadOnly | openNoMutex, nil)
    #endif
  }

  static func close(_ database: OpaquePointer) -> Int32 {
    #if SWIFT_PACKAGE
      return sqlite3_close_v2(database)
    #else
      return exsqlite3_close_v2(database)
    #endif
  }

  static func enableExtendedResultCodes(_ database: OpaquePointer) {
    #if SWIFT_PACKAGE
      sqlite3_extended_result_codes(database, 1)
    #else
      exsqlite3_extended_result_codes(database, 1)
    #endif
  }

  static func setBusyTimeout(_ database: OpaquePointer, milliseconds: Int32) {
    #if SWIFT_PACKAGE
      sqlite3_busy_timeout(database, milliseconds)
    #else
      exsqlite3_busy_timeout(database, milliseconds)
    #endif
  }

  static func isReadOnly(_ database: OpaquePointer) -> Bool {
    #if SWIFT_PACKAGE
      return sqlite3_db_readonly(database, "main") == 1
    #else
      return exsqlite3_db_readonly(database, "main") == 1
    #endif
  }

  static func prepare(
    database: OpaquePointer,
    sql: String,
    statement: inout OpaquePointer?
  ) -> Int32 {
    #if SWIFT_PACKAGE
      return sqlite3_prepare_v2(database, sql, -1, &statement, nil)
    #else
      return exsqlite3_prepare_v2(database, sql, -1, &statement, nil)
    #endif
  }

  static func finalize(_ statement: OpaquePointer) -> Int32 {
    #if SWIFT_PACKAGE
      return sqlite3_finalize(statement)
    #else
      return exsqlite3_finalize(statement)
    #endif
  }

  static func step(_ statement: OpaquePointer) -> Int32 {
    #if SWIFT_PACKAGE
      return sqlite3_step(statement)
    #else
      return exsqlite3_step(statement)
    #endif
  }

  static func columnType(_ statement: OpaquePointer, index: Int32) -> Int32 {
    #if SWIFT_PACKAGE
      return sqlite3_column_type(statement, index)
    #else
      return exsqlite3_column_type(statement, index)
    #endif
  }

  static func columnBytes(_ statement: OpaquePointer, index: Int32) -> Int32 {
    #if SWIFT_PACKAGE
      return sqlite3_column_bytes(statement, index)
    #else
      return exsqlite3_column_bytes(statement, index)
    #endif
  }

  static func columnText(
    _ statement: OpaquePointer,
    index: Int32
  ) -> UnsafePointer<UInt8>? {
    #if SWIFT_PACKAGE
      return sqlite3_column_text(statement, index)
    #else
      return exsqlite3_column_text(statement, index)
    #endif
  }

  static func columnDouble(_ statement: OpaquePointer, index: Int32) -> Double {
    #if SWIFT_PACKAGE
      return sqlite3_column_double(statement, index)
    #else
      return exsqlite3_column_double(statement, index)
    #endif
  }

  static func columnInt64(_ statement: OpaquePointer, index: Int32) -> Int64 {
    #if SWIFT_PACKAGE
      return sqlite3_column_int64(statement, index)
    #else
      return exsqlite3_column_int64(statement, index)
    #endif
  }

  static func errorMessage(_ database: OpaquePointer?) -> String {
    guard let database else {
      return "unknown SQLite error"
    }
    #if SWIFT_PACKAGE
      return String(cString: sqlite3_errmsg(database))
    #else
      return String(cString: exsqlite3_errmsg(database))
    #endif
  }
}

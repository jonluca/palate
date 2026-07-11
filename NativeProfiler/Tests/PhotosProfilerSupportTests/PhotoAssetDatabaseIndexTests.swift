import Foundation
import SQLite3
import Testing

@testable import BatchAssetInfoCore

@Suite("Photo asset database-backed scan")
struct PhotoAssetDatabaseIndexTests {
  private struct Row {
    let id: String
    let creationTime: Double
    let latitude: Double?
    let longitude: Double?
  }

  @Test("Database metrics preserve finite creation times and exact coordinate semantics")
  func readsStoredMetrics() throws {
    let database = try TemporaryDatabase(rows: [
      Row(id: "known-'食'-🍜", creationTime: 100.5, latitude: 0, longitude: 0),
      Row(id: "boundary", creationTime: 0, latitude: 90, longitude: -180),
      Row(id: "invalid-latitude", creationTime: 200, latitude: 91, longitude: 0),
      Row(id: "partial-location", creationTime: 300, latitude: nil, longitude: -122),
      Row(id: "infinite-location", creationTime: 400, latitude: .infinity, longitude: 1),
      Row(id: "infinite-time", creationTime: .infinity, latitude: 1, longitude: 1),
      Row(id: "stale-database-id", creationTime: 500, latitude: 2, longitude: 2),
    ])
    defer { database.remove() }

    let index = try PhotoAssetDatabaseIndex(databasePath: database.fileURL.path)

    #expect(index.metricsByIdentifier.count == 7)
    #expect(
      index.metricsByIdentifier["known-'食'-🍜"]
        == PhotoAssetScanStoredMetrics(
          hasUsableCreationTime: true,
          hasValidLocation: true
        )
    )
    #expect(
      index.metricsByIdentifier["boundary"]
        == PhotoAssetScanStoredMetrics(
          hasUsableCreationTime: true,
          hasValidLocation: true
        )
    )
    for identifier in ["invalid-latitude", "partial-location", "infinite-location"] {
      #expect(
        index.metricsByIdentifier[identifier]
          == PhotoAssetScanStoredMetrics(
            hasUsableCreationTime: true,
            hasValidLocation: false
          )
      )
    }
    #expect(
      index.metricsByIdentifier["infinite-time"]
        == PhotoAssetScanStoredMetrics(
          hasUsableCreationTime: false,
          hasValidLocation: true
        )
    )
  }

  @Test("Stored metrics filter once per visible asset in stable PhotoKit order")
  func stableDatabaseBackedPlan() throws {
    let database = try TemporaryDatabase(rows: [
      Row(id: "known-valid", creationTime: 100, latitude: 0, longitude: 0),
      Row(id: "known-no-location", creationTime: 200, latitude: nil, longitude: nil),
      Row(id: "known-skipped", creationTime: .infinity, latitude: 1, longitude: 1),
      Row(id: "stale", creationTime: 300, latitude: 2, longitude: 2),
    ])
    defer { database.remove() }
    let index = try PhotoAssetDatabaseIndex(databasePath: database.fileURL.path)
    let visibleIdentifiers = [
      "new-first",
      "known-no-location",
      "known-valid",
      "new-second",
      "known-skipped",
    ]
    var visibleAssetReads = 0

    let plan = PhotoAssetIncrementalScanPlan(
      assetCount: visibleIdentifiers.count,
      storedMetricsByIdentifier: index.metricsByIdentifier,
      identifierAt: { index in
        visibleAssetReads += 1
        return visibleIdentifiers[index]
      }
    )

    #expect(visibleAssetReads == visibleIdentifiers.count)
    #expect(plan.unknownAssetIndexes == [0, 3])
    #expect(plan.excludedVisibleCount == 3)
    #expect(plan.excludedPhotosWithLocation == 1)
    #expect(plan.excludedSkippedAssets == 1)
  }

  @Test("Empty and all-known databases preserve boundary and stale-ID accounting")
  func emptyAndAllKnownBoundaries() throws {
    let emptyDatabase = try TemporaryDatabase()
    defer { emptyDatabase.remove() }
    let emptyIndex = try PhotoAssetDatabaseIndex(databasePath: emptyDatabase.fileURL.path)
    let visible = ["one", "two"]
    let emptyPlan = PhotoAssetIncrementalScanPlan(
      assetCount: visible.count,
      storedMetricsByIdentifier: emptyIndex.metricsByIdentifier,
      identifierAt: { visible[$0] }
    )
    #expect(emptyPlan.unknownAssetIndexes == [0, 1])
    #expect(emptyPlan.excludedVisibleCount == 0)

    let allKnownDatabase = try TemporaryDatabase(rows: [
      Row(id: "two", creationTime: 2, latitude: nil, longitude: nil),
      Row(id: "one", creationTime: 1, latitude: 0, longitude: 0),
      Row(id: "stale", creationTime: 3, latitude: 1, longitude: 1),
    ])
    defer { allKnownDatabase.remove() }
    let allKnownIndex = try PhotoAssetDatabaseIndex(databasePath: allKnownDatabase.fileURL.path)
    let allKnownPlan = PhotoAssetIncrementalScanPlan(
      assetCount: visible.count,
      storedMetricsByIdentifier: allKnownIndex.metricsByIdentifier,
      identifierAt: { visible[$0] }
    )
    #expect(allKnownPlan.unknownAssetIndexes.isEmpty)
    #expect(allKnownPlan.excludedVisibleCount == 2)
    #expect(allKnownPlan.excludedPhotosWithLocation == 1)
    #expect(allKnownPlan.excludedSkippedAssets == 0)
  }

  @Test("Database-backed and identifier-list plans have exact pure-plan parity")
  func purePlanParity() {
    let assets: [(id: String, usableTime: Bool, validLocation: Bool)] = [
      ("new", true, true),
      ("known-located", true, true),
      ("known-skipped", false, true),
      ("known-unlocated", true, false),
    ]
    let existingIdentifiers = ["known-unlocated", "stale", "known-skipped", "known-located"]
    let identifierPlan = PhotoAssetIncrementalScanPlan(
      assetCount: assets.count,
      existingAssetIdentifiers: existingIdentifiers,
      assetAt: { index in
        let asset = assets[index]
        return (
          identifier: asset.id,
          excludedMetrics: {
            PhotoAssetScanStoredMetrics(
              hasUsableCreationTime: asset.usableTime,
              hasValidLocation: asset.validLocation
            )
          }
        )
      }
    )
    let storedMetrics = Dictionary(
      uniqueKeysWithValues: assets.compactMap { asset in
        existingIdentifiers.contains(asset.id)
          ? (
            asset.id,
            PhotoAssetScanStoredMetrics(
              hasUsableCreationTime: asset.usableTime,
              hasValidLocation: asset.validLocation
            )
          ) : nil
      } + [
        (
          "stale",
          PhotoAssetScanStoredMetrics(
            hasUsableCreationTime: true,
            hasValidLocation: true
          )
        )
      ]
    )
    let databasePlan = PhotoAssetIncrementalScanPlan(
      assetCount: assets.count,
      storedMetricsByIdentifier: storedMetrics,
      identifierAt: { assets[$0].id }
    )

    #expect(databasePlan == identifierPlan)
  }

  @Test("Read-only loading leaves the source bytes and directory unchanged")
  func sourceIsImmutable() throws {
    let database = try TemporaryDatabase(rows: [
      Row(id: "one", creationTime: 1, latitude: 0, longitude: 0)
    ])
    defer { database.remove() }
    let beforeData = try Data(contentsOf: database.fileURL)
    let beforeFiles = try FileManager.default.contentsOfDirectory(
      atPath: database.directoryURL.path)

    let index = try PhotoAssetDatabaseIndex(databasePath: database.fileURL.path)

    #expect(index.metricsByIdentifier.count == 1)
    #expect(try Data(contentsOf: database.fileURL) == beforeData)
    #expect(
      try FileManager.default.contentsOfDirectory(atPath: database.directoryURL.path) == beforeFiles
    )
    try database.execute(
      "INSERT INTO photos (id, creationTime, latitude, longitude) VALUES ('after-read', 2, 1, 1)"
    )
    #expect(
      try PhotoAssetDatabaseIndex(databasePath: database.fileURL.path).metricsByIdentifier.count
        == 2)
  }

  @Test("Read-only loading sees committed WAL rows without disturbing the writer")
  func readsLiveWriteAheadLog() throws {
    let database = try TemporaryDatabase()
    defer { database.remove() }
    var writer: OpaquePointer?
    #expect(
      sqlite3_open_v2(database.fileURL.path, &writer, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK)
    let unwrappedWriter = try #require(writer)
    defer { sqlite3_close_v2(unwrappedWriter) }
    try TemporaryDatabase.execute(
      database: unwrappedWriter,
      sql: "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;"
    )
    try TemporaryDatabase.execute(
      database: unwrappedWriter,
      sql: "INSERT INTO photos (id, creationTime, latitude, longitude) VALUES ('wal-one', 1, 0, 0)"
    )

    #expect(
      try PhotoAssetDatabaseIndex(databasePath: database.fileURL.path).metricsByIdentifier.count
        == 1)
    try TemporaryDatabase.execute(
      database: unwrappedWriter,
      sql: "INSERT INTO photos (id, creationTime, latitude, longitude) VALUES ('wal-two', 2, 1, 1)"
    )
    #expect(
      try PhotoAssetDatabaseIndex(databasePath: database.fileURL.path).metricsByIdentifier.count
        == 2)
  }

  @Test("Missing paths and malformed schemas fail closed")
  func rejectsPathAndSchemaErrors() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let missingPath = directory.appendingPathComponent("missing.sqlite").path
    expectError(.invalidPath(missingPath)) {
      _ = try PhotoAssetDatabaseIndex(databasePath: missingPath)
    }
    expectError(.invalidPath(directory.path)) {
      _ = try PhotoAssetDatabaseIndex(databasePath: directory.path)
    }

    let missingColumn = try TemporaryDatabase(
      schema: """
        CREATE TABLE photos (
          id TEXT PRIMARY KEY,
          creationTime INTEGER NOT NULL,
          latitude REAL
        )
        """
    )
    defer { missingColumn.remove() }
    expectError(.incompatibleSchema) {
      _ = try PhotoAssetDatabaseIndex(databasePath: missingColumn.fileURL.path)
    }

    let view = try TemporaryDatabase(
      schema: """
        CREATE TABLE source (
          id TEXT PRIMARY KEY,
          creationTime INTEGER NOT NULL,
          latitude REAL,
          longitude REAL
        );
        CREATE VIEW photos AS SELECT * FROM source
        """
    )
    defer { view.remove() }
    expectError(.incompatibleSchema) {
      _ = try PhotoAssetDatabaseIndex(databasePath: view.fileURL.path)
    }
  }

  @Test("Invalid dynamic row types and identifiers fail closed")
  func rejectsMalformedRows() throws {
    let invalidLocation = try TemporaryDatabase()
    defer { invalidLocation.remove() }
    try invalidLocation.execute(
      "INSERT INTO photos (id, creationTime, latitude, longitude) VALUES ('bad-location', 1, 'north', 0)"
    )
    expectError(.invalidColumnType(column: "latitude", row: 1)) {
      _ = try PhotoAssetDatabaseIndex(databasePath: invalidLocation.fileURL.path)
    }

    let emptyIdentifier = try TemporaryDatabase(rows: [
      Row(id: "", creationTime: 1, latitude: 0, longitude: 0)
    ])
    defer { emptyIdentifier.remove() }
    expectError(.invalidIdentifier(row: 1)) {
      _ = try PhotoAssetDatabaseIndex(databasePath: emptyIdentifier.fileURL.path)
    }
  }

  private func expectError(
    _ expected: PhotoAssetDatabaseIndexError,
    operation: () throws -> Void
  ) {
    do {
      try operation()
      Issue.record("Expected photo database index error: \(expected)")
    } catch let error as PhotoAssetDatabaseIndexError {
      #expect(error == expected)
    } catch {
      Issue.record("Unexpected error: \(error)")
    }
  }

  private struct TemporaryDatabase {
    private static let schema = """
      CREATE TABLE photos (
        id TEXT PRIMARY KEY,
        creationTime INTEGER NOT NULL,
        latitude REAL,
        longitude REAL
      )
      """
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    let directoryURL: URL
    let fileURL: URL

    init(schema: String = Self.schema, rows: [Row] = []) throws {
      directoryURL = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
      fileURL = directoryURL.appendingPathComponent("photos.sqlite")
      try FileManager.default.createDirectory(
        at: directoryURL,
        withIntermediateDirectories: false
      )
      do {
        var database: OpaquePointer?
        guard
          sqlite3_open_v2(
            fileURL.path,
            &database,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
            nil
          ) == SQLITE_OK,
          let database
        else {
          throw FixtureError.sqlite("unable to create fixture database")
        }
        defer { sqlite3_close_v2(database) }
        try Self.execute(database: database, sql: schema)
        try Self.insert(rows: rows, database: database)
      } catch {
        remove()
        throw error
      }
    }

    func execute(_ sql: String) throws {
      var database: OpaquePointer?
      guard
        sqlite3_open_v2(fileURL.path, &database, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK,
        let database
      else {
        throw FixtureError.sqlite("unable to reopen fixture database")
      }
      defer { sqlite3_close_v2(database) }
      try Self.execute(database: database, sql: sql)
    }

    static func execute(database: OpaquePointer, sql: String) throws {
      var errorMessage: UnsafeMutablePointer<CChar>?
      let result = sqlite3_exec(database, sql, nil, nil, &errorMessage)
      guard result == SQLITE_OK else {
        let message = errorMessage.map { String(cString: $0) } ?? "unknown SQLite error"
        sqlite3_free(errorMessage)
        throw FixtureError.sqlite(message)
      }
    }

    func remove() {
      try? FileManager.default.removeItem(at: directoryURL)
    }

    private static func insert(rows: [Row], database: OpaquePointer) throws {
      guard !rows.isEmpty else {
        return
      }
      var statement: OpaquePointer?
      guard
        sqlite3_prepare_v2(
          database,
          "INSERT INTO photos (id, creationTime, latitude, longitude) VALUES (?, ?, ?, ?)",
          -1,
          &statement,
          nil
        ) == SQLITE_OK,
        let statement
      else {
        throw FixtureError.sqlite("unable to prepare fixture insert")
      }
      defer { sqlite3_finalize(statement) }

      for row in rows {
        sqlite3_reset(statement)
        sqlite3_clear_bindings(statement)
        let idResult = row.id.withCString {
          sqlite3_bind_text(statement, 1, $0, -1, transient)
        }
        guard idResult == SQLITE_OK else {
          throw FixtureError.sqlite("unable to bind fixture identifier")
        }
        sqlite3_bind_double(statement, 2, row.creationTime)
        bind(row.latitude, statement: statement, index: 3)
        bind(row.longitude, statement: statement, index: 4)
        guard sqlite3_step(statement) == SQLITE_DONE else {
          throw FixtureError.sqlite(String(cString: sqlite3_errmsg(database)))
        }
      }
    }

    private static func bind(
      _ value: Double?,
      statement: OpaquePointer,
      index: Int32
    ) {
      if let value {
        sqlite3_bind_double(statement, index, value)
      } else {
        sqlite3_bind_null(statement, index)
      }
    }

    private enum FixtureError: Error {
      case sqlite(String)
    }
  }
}

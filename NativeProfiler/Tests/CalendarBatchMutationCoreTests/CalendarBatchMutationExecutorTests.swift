import Testing

@testable import CalendarBatchMutationCore

@Suite("Calendar batch mutation executor")
struct CalendarBatchMutationExecutorTests {
  @Test("Duplicate request IDs fail before backend construction or preflight")
  func duplicateRequestIDsFailBeforeBackendAccess() {
    let backend = FakeCalendarBatchMutationBackend()
    var backendFactoryCallCount = 0
    let executor = CalendarBatchMutationExecutor {
      backendFactoryCallCount += 1
      return backend
    }
    let duplicateCreates = [
      Self.exportRequest(id: "duplicate"),
      Self.exportRequest(id: "duplicate", startMs: 3_000, endMs: 4_000),
    ]
    let duplicateDeletes = [
      Self.deleteRequest(id: "duplicate", eventID: "event-a"),
      Self.deleteRequest(id: "duplicate", eventID: "event-b"),
    ]

    #expect(
      throws: CalendarBatchMutationValidationError.duplicateRequestID("duplicate")
    ) {
      try executor.createExportEvents(
        calendarID: "calendar",
        timeZoneID: "America/Los_Angeles",
        requests: duplicateCreates
      )
    }
    #expect(
      throws: CalendarBatchMutationValidationError.duplicateRequestID("duplicate")
    ) {
      try executor.deleteEvents(requests: duplicateDeletes)
    }
    #expect(backendFactoryCallCount == 0)
    #expect(backend.prepareCreateCallCount == 0)
    #expect(backend.prepareDeleteCallCount == 0)
  }

  @Test("Create preflights once and continues through ordered item failures")
  func orderedCreateResultsAndExactInputs() throws {
    let backend = FakeCalendarBatchMutationBackend()
    backend.createHandler = { request in
      if request.requestID == "fails" {
        throw CalendarBatchMutationTestError.operationFailed
      }
      return "event-\(request.requestID)"
    }
    var backendFactoryCallCount = 0
    let executor = CalendarBatchMutationExecutor {
      backendFactoryCallCount += 1
      return backend
    }
    let requests = [
      Self.exportRequest(
        id: "雪's-table",
        title: "Dîner at L’Atelier 🍜",
        location: nil,
        notes: "予約\n\n[Palate Export] Visit ID: 雪's-table"
      ),
      Self.exportRequest(id: "fails", title: "Failure", location: ""),
      Self.exportRequest(id: "after", title: "After", location: "1 Main St"),
    ]

    let results = try executor.createExportEvents(
      calendarID: "writable-calendar",
      timeZoneID: "America/Los_Angeles",
      requests: requests
    )

    #expect(backendFactoryCallCount == 1)
    #expect(backend.prepareCreateCallCount == 1)
    #expect(backend.preparedCalendarID == "writable-calendar")
    #expect(backend.preparedTimeZoneID == "America/Los_Angeles")
    #expect(backend.createCallCount == 3)
    #expect(backend.commitCallCount == 1)
    #expect(backend.discardCallCount == 0)
    #expect(backend.createdRequests == requests)
    #expect(results.map { $0.inputIndex } == [0, 1, 2])
    #expect(results.map { $0.requestID } == ["雪's-table", "fails", "after"])
    #expect(
      results.map { $0.status }
        == [
          CalendarMutationStatus.created, CalendarMutationStatus.failed,
          CalendarMutationStatus.created,
        ]
    )
    #expect(results.map { $0.eventID } == ["event-雪's-table", nil, "event-after"])
    #expect(results[1].errorCode == "TEST_OPERATION_FAILED")
    #expect(backend.createdRequests[0].location == nil)
    #expect(backend.createdRequests[1].location == "")
    #expect(backend.createdRequests[2].location == "1 Main St")
    #expect(backend.createdRequests[0].notes.contains("予約"))
  }

  @Test("Deletes distinguish already absent events and continue after failures")
  func deleteOutcomesAndCommitCounts() throws {
    let backend = FakeCalendarBatchMutationBackend()
    backend.deleteHandler = { request in
      switch request.requestID {
      case "missing":
        return .alreadyAbsent
      case "fails":
        throw CalendarBatchMutationTestError.operationFailed
      default:
        return .deleted
      }
    }
    let executor = CalendarBatchMutationExecutor { backend }
    let requests = [
      Self.deleteRequest(id: "before", eventID: "event-before"),
      Self.deleteRequest(id: "fails", eventID: "event-fails", futureEvents: true),
      Self.deleteRequest(id: "missing", eventID: "event-missing"),
      Self.deleteRequest(id: "after", eventID: "event-after", instanceStartMs: 42_000),
    ]

    let results = try executor.deleteEvents(requests: requests)

    #expect(backend.prepareDeleteCallCount == 1)
    #expect(backend.deleteCallCount == 4)
    #expect(backend.commitCallCount == 1)
    #expect(backend.discardCallCount == 0)
    #expect(backend.deletedRequests == requests)
    #expect(results.map { $0.inputIndex } == [0, 1, 2, 3])
    #expect(
      results.map { $0.status }
        == [
          CalendarMutationStatus.deleted,
          CalendarMutationStatus.failed,
          CalendarMutationStatus.alreadyAbsent,
          CalendarMutationStatus.deleted,
        ]
    )
    #expect(results[0].eventID == "event-before")
    #expect(results[1].eventID == nil)
    #expect(results[2].eventID == "event-missing")
    #expect(results[3].eventID == "event-after")
    #expect(results[1].errorCode == "TEST_OPERATION_FAILED")
    #expect(backend.deletedRequests[1].futureEvents)
    #expect(backend.deletedRequests[3].instanceStartMs == 42_000)
  }

  @Test("Malformed items are isolated before the backend and all-invalid batches stay pure")
  func invalidItemsDoNotReachBackend() throws {
    let mixedBackend = FakeCalendarBatchMutationBackend()
    var mixedFactoryCallCount = 0
    let mixedExecutor = CalendarBatchMutationExecutor {
      mixedFactoryCallCount += 1
      return mixedBackend
    }
    let mixedResults = try mixedExecutor.createExportEvents(
      calendarID: "calendar",
      timeZoneID: "UTC",
      requests: [
        Self.exportRequest(id: "nan", startMs: .nan, endMs: 2_000),
        Self.exportRequest(id: "valid"),
        Self.exportRequest(id: "reversed", startMs: 3_000, endMs: 2_000),
      ]
    )

    #expect(mixedFactoryCallCount == 1)
    #expect(mixedBackend.prepareCreateCallCount == 1)
    #expect(mixedBackend.createCallCount == 1)
    #expect(mixedBackend.commitCallCount == 1)
    #expect(mixedBackend.createdRequests.map { $0.requestID } == ["valid"])
    #expect(
      mixedResults.map { $0.status }
        == [
          CalendarMutationStatus.failed, CalendarMutationStatus.created,
          CalendarMutationStatus.failed,
        ]
    )
    #expect(mixedResults[0].errorCode == "ERR_CALENDAR_INVALID_DATE_RANGE")
    #expect(mixedResults[2].errorCode == "ERR_CALENDAR_INVALID_DATE_RANGE")

    let invalidBackend = FakeCalendarBatchMutationBackend()
    var invalidFactoryCallCount = 0
    let invalidExecutor = CalendarBatchMutationExecutor {
      invalidFactoryCallCount += 1
      return invalidBackend
    }
    let invalidCreateResults = try invalidExecutor.createExportEvents(
      calendarID: "calendar",
      timeZoneID: "UTC",
      requests: [
        Self.exportRequest(id: "nan", startMs: .nan, endMs: 2_000),
        Self.exportRequest(id: "reversed", startMs: 3_000, endMs: 2_000),
      ]
    )
    let invalidDeleteResults = try invalidExecutor.deleteEvents(requests: [
      Self.deleteRequest(id: "empty", eventID: ""),
      Self.deleteRequest(id: "infinite", eventID: "event", instanceStartMs: .infinity),
    ])

    #expect(invalidFactoryCallCount == 0)
    #expect(invalidBackend.prepareCreateCallCount == 0)
    #expect(invalidBackend.prepareDeleteCallCount == 0)
    #expect(invalidBackend.createCallCount == 0)
    #expect(invalidBackend.deleteCallCount == 0)
    #expect(
      invalidCreateResults.map { $0.status }
        == [CalendarMutationStatus.failed, CalendarMutationStatus.failed]
    )
    #expect(
      invalidDeleteResults.map { $0.status }
        == [CalendarMutationStatus.failed, CalendarMutationStatus.failed]
    )
    #expect(invalidDeleteResults[0].errorCode == "ERR_CALENDAR_EVENT_ID_REQUIRED")
    #expect(invalidDeleteResults[1].errorCode == "ERR_CALENDAR_INVALID_INSTANCE_DATE")
  }

  @Test("Global preflight errors produce one ordered failure per valid input")
  func globalPreflightErrors() throws {
    let createBackend = FakeCalendarBatchMutationBackend()
    createBackend.prepareCreateError = CalendarBatchMutationTestError.invalidTimeZone
    let createExecutor = CalendarBatchMutationExecutor { createBackend }
    let createResults = try createExecutor.createExportEvents(
      calendarID: "calendar",
      timeZoneID: "Not/AZone",
      requests: [Self.exportRequest(id: "one"), Self.exportRequest(id: "two")]
    )

    #expect(createBackend.prepareCreateCallCount == 1)
    #expect(createBackend.createCallCount == 0)
    #expect(createBackend.commitCallCount == 0)
    #expect(createResults.map { $0.requestID } == ["one", "two"])
    #expect(createResults.allSatisfy { $0.status == CalendarMutationStatus.failed })
    #expect(createResults.allSatisfy { $0.errorCode == "TEST_INVALID_TIME_ZONE" })

    let deleteBackend = FakeCalendarBatchMutationBackend()
    deleteBackend.prepareDeleteError = CalendarBatchMutationTestError.denied
    let deleteExecutor = CalendarBatchMutationExecutor { deleteBackend }
    let deleteResults = try deleteExecutor.deleteEvents(requests: [
      Self.deleteRequest(id: "one", eventID: "event-one"),
      Self.deleteRequest(id: "two", eventID: "event-two"),
    ])

    #expect(deleteBackend.prepareDeleteCallCount == 1)
    #expect(deleteBackend.deleteCallCount == 0)
    #expect(deleteBackend.commitCallCount == 0)
    #expect(deleteResults.map { $0.requestID } == ["one", "two"])
    #expect(deleteResults.allSatisfy { $0.status == CalendarMutationStatus.failed })
    #expect(deleteResults.allSatisfy { $0.errorCode == "TEST_ACCESS_DENIED" })
  }

  @Test("A failed batch commit invalidates only staged successes and discards pending state")
  func batchCommitFailureMapping() throws {
    let createBackend = FakeCalendarBatchMutationBackend()
    createBackend.commitError = CalendarBatchMutationTestError.commitFailed
    createBackend.createHandler = { request in
      if request.requestID == "stage-fails" {
        throw CalendarBatchMutationTestError.operationFailed
      }
      return "event-\(request.requestID)"
    }
    let createResults = try CalendarBatchMutationExecutor { createBackend }
      .createExportEvents(
        calendarID: "calendar",
        timeZoneID: "UTC",
        requests: [
          Self.exportRequest(id: "before"),
          Self.exportRequest(id: "stage-fails"),
          Self.exportRequest(id: "after"),
        ]
      )

    #expect(createBackend.commitCallCount == 1)
    #expect(createBackend.discardCallCount == 1)
    #expect(
      createResults.map { $0.status }
        == [
          CalendarMutationStatus.failed,
          CalendarMutationStatus.failed,
          CalendarMutationStatus.failed,
        ]
    )
    #expect(createResults.map { $0.eventID } == [nil, nil, nil])
    #expect(
      createResults.map { $0.errorCode } == [
        "TEST_COMMIT_FAILED", "TEST_OPERATION_FAILED", "TEST_COMMIT_FAILED",
      ])

    let deleteBackend = FakeCalendarBatchMutationBackend()
    deleteBackend.commitError = CalendarBatchMutationTestError.commitFailed
    deleteBackend.deleteHandler = { request in
      switch request.requestID {
      case "missing":
        return .alreadyAbsent
      case "stage-fails":
        throw CalendarBatchMutationTestError.operationFailed
      default:
        return .deleted
      }
    }
    let deleteResults = try CalendarBatchMutationExecutor { deleteBackend }
      .deleteEvents(requests: [
        Self.deleteRequest(id: "deleted", eventID: "event-deleted"),
        Self.deleteRequest(id: "missing", eventID: "event-missing"),
        Self.deleteRequest(id: "stage-fails", eventID: "event-fails"),
      ])

    #expect(deleteBackend.commitCallCount == 1)
    #expect(deleteBackend.discardCallCount == 1)
    #expect(
      deleteResults.map { $0.status }
        == [
          CalendarMutationStatus.failed,
          CalendarMutationStatus.alreadyAbsent,
          CalendarMutationStatus.failed,
        ]
    )
    #expect(deleteResults.map { $0.eventID } == [nil, "event-missing", nil])
    #expect(
      deleteResults.map { $0.errorCode } == [
        "TEST_COMMIT_FAILED", nil, "TEST_OPERATION_FAILED",
      ])
  }

  @Test("Batches with no staged mutations skip commit and discard")
  func noStagedMutationsSkipCommit() throws {
    let createBackend = FakeCalendarBatchMutationBackend()
    createBackend.createHandler = { _ in
      throw CalendarBatchMutationTestError.operationFailed
    }
    let createResults = try CalendarBatchMutationExecutor { createBackend }
      .createExportEvents(
        calendarID: "calendar",
        timeZoneID: "UTC",
        requests: [Self.exportRequest(id: "fails")]
      )

    #expect(createResults.map { $0.status } == [CalendarMutationStatus.failed])
    #expect(createBackend.commitCallCount == 0)
    #expect(createBackend.discardCallCount == 0)

    let deleteBackend = FakeCalendarBatchMutationBackend()
    deleteBackend.deleteHandler = { request in
      if request.requestID == "fails" {
        throw CalendarBatchMutationTestError.operationFailed
      }
      return .alreadyAbsent
    }
    let deleteResults = try CalendarBatchMutationExecutor { deleteBackend }
      .deleteEvents(requests: [
        Self.deleteRequest(id: "missing", eventID: "event-missing"),
        Self.deleteRequest(id: "fails", eventID: "event-fails"),
      ])

    #expect(
      deleteResults.map { $0.status }
        == [CalendarMutationStatus.alreadyAbsent, CalendarMutationStatus.failed]
    )
    #expect(deleteBackend.commitCallCount == 0)
    #expect(deleteBackend.discardCallCount == 0)
  }

  @Test("Empty batches do not construct or preflight a backend")
  func emptyBatchesAreNoOps() throws {
    let backend = FakeCalendarBatchMutationBackend()
    var backendFactoryCallCount = 0
    let executor = CalendarBatchMutationExecutor {
      backendFactoryCallCount += 1
      return backend
    }

    let createResults = try executor.createExportEvents(
      calendarID: "calendar",
      timeZoneID: "UTC",
      requests: []
    )
    let deleteResults = try executor.deleteEvents(requests: [])

    #expect(createResults.isEmpty)
    #expect(deleteResults.isEmpty)
    #expect(backendFactoryCallCount == 0)
    #expect(backend.prepareCreateCallCount == 0)
    #expect(backend.prepareDeleteCallCount == 0)
    #expect(backend.commitCallCount == 0)
    #expect(backend.discardCallCount == 0)
  }

  private static func exportRequest(
    id: String,
    title: String = "Restaurant",
    startMs: Double = 1_000,
    endMs: Double = 2_000,
    location: String? = nil,
    notes: String = "[Palate Export]"
  ) -> CalendarExportMutation {
    CalendarExportMutation(
      requestID: id,
      title: title,
      startMs: startMs,
      endMs: endMs,
      location: location,
      notes: notes
    )
  }

  private static func deleteRequest(
    id: String,
    eventID: String,
    instanceStartMs: Double? = nil,
    futureEvents: Bool = false
  ) -> CalendarDeleteMutation {
    CalendarDeleteMutation(
      requestID: id,
      eventID: eventID,
      instanceStartMs: instanceStartMs,
      futureEvents: futureEvents
    )
  }
}

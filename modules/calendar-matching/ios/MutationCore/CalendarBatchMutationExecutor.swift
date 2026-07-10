import Foundation

public final class CalendarBatchMutationExecutor<Backend: CalendarBatchMutationBackend> {
  private let makeBackend: () -> Backend

  public init(makeBackend: @escaping () -> Backend) {
    self.makeBackend = makeBackend
  }

  public func createExportEvents(
    calendarID: String,
    timeZoneID: String,
    requests: [CalendarExportMutation]
  ) throws -> [CalendarMutationResult] {
    try CalendarBatchMutationValidator.validateUniqueRequestIDs(requests.map(\.requestID))
    guard !requests.isEmpty else {
      return []
    }

    var results = [CalendarMutationResult?](repeating: nil, count: requests.count)
    let validRequests = validatedCreateRequests(requests, results: &results)
    guard !validRequests.isEmpty else {
      return results.compactMap { $0 }
    }

    let backend = makeBackend()
    do {
      try backend.prepareCreateBatch(calendarID: calendarID, timeZoneID: timeZoneID)
    } catch {
      for (index, request) in validRequests {
        results[index] = failureResult(
          inputIndex: index,
          requestID: request.requestID,
          error: error
        )
      }
      return results.compactMap { $0 }
    }

    var stagedResultIndices: [Int] = []
    stagedResultIndices.reserveCapacity(validRequests.count)
    for (index, request) in validRequests {
      do {
        let eventID = try backend.createExportEvent(request)
        results[index] = CalendarMutationResult(
          inputIndex: index,
          requestID: request.requestID,
          status: .created,
          eventID: eventID,
          errorCode: nil,
          errorMessage: nil
        )
        stagedResultIndices.append(index)
      } catch {
        results[index] = failureResult(
          inputIndex: index,
          requestID: request.requestID,
          error: error
        )
      }
    }
    commitStagedResults(
      at: stagedResultIndices,
      backend: backend,
      results: &results
    )
    return results.compactMap { $0 }
  }

  public func deleteEvents(
    requests: [CalendarDeleteMutation]
  ) throws -> [CalendarMutationResult] {
    try CalendarBatchMutationValidator.validateUniqueRequestIDs(requests.map(\.requestID))
    guard !requests.isEmpty else {
      return []
    }

    var results = [CalendarMutationResult?](repeating: nil, count: requests.count)
    let validRequests = validatedDeleteRequests(requests, results: &results)
    guard !validRequests.isEmpty else {
      return results.compactMap { $0 }
    }

    let backend = makeBackend()
    do {
      try backend.prepareDeleteBatch()
    } catch {
      for (index, request) in validRequests {
        results[index] = failureResult(
          inputIndex: index,
          requestID: request.requestID,
          error: error
        )
      }
      return results.compactMap { $0 }
    }

    var stagedResultIndices: [Int] = []
    stagedResultIndices.reserveCapacity(validRequests.count)
    for (index, request) in validRequests {
      do {
        let outcome = try backend.deleteEvent(request)
        results[index] = CalendarMutationResult(
          inputIndex: index,
          requestID: request.requestID,
          status: outcome == .deleted ? .deleted : .alreadyAbsent,
          eventID: request.eventID,
          errorCode: nil,
          errorMessage: nil
        )
        if outcome == .deleted {
          stagedResultIndices.append(index)
        }
      } catch {
        results[index] = failureResult(
          inputIndex: index,
          requestID: request.requestID,
          error: error
        )
      }
    }
    commitStagedResults(
      at: stagedResultIndices,
      backend: backend,
      results: &results
    )
    return results.compactMap { $0 }
  }

  private func commitStagedResults(
    at indices: [Int],
    backend: Backend,
    results: inout [CalendarMutationResult?]
  ) {
    guard !indices.isEmpty else {
      return
    }

    do {
      try backend.commitBatch()
    } catch {
      backend.discardBatch()
      for index in indices {
        guard let result = results[index] else {
          continue
        }
        results[index] = failureResult(
          inputIndex: result.inputIndex,
          requestID: result.requestID,
          error: error
        )
      }
    }
  }

  private func validatedCreateRequests(
    _ requests: [CalendarExportMutation],
    results: inout [CalendarMutationResult?]
  ) -> [(index: Int, request: CalendarExportMutation)] {
    requests.enumerated().compactMap { index, request in
      do {
        try request.validate()
        return (index, request)
      } catch {
        results[index] = failureResult(
          inputIndex: index,
          requestID: request.requestID,
          error: error
        )
        return nil
      }
    }
  }

  private func validatedDeleteRequests(
    _ requests: [CalendarDeleteMutation],
    results: inout [CalendarMutationResult?]
  ) -> [(index: Int, request: CalendarDeleteMutation)] {
    requests.enumerated().compactMap { index, request in
      do {
        try request.validate()
        return (index, request)
      } catch {
        results[index] = failureResult(
          inputIndex: index,
          requestID: request.requestID,
          error: error
        )
        return nil
      }
    }
  }

  private func failureResult(
    inputIndex: Int,
    requestID: String,
    error: Error
  ) -> CalendarMutationResult {
    let errorCode =
      (error as? any CalendarMutationCodedError)?.calendarMutationCode
      ?? "ERR_CALENDAR_MUTATION_FAILED"
    let errorMessage =
      (error as? any LocalizedError)?.errorDescription
      ?? error.localizedDescription
    return CalendarMutationResult(
      inputIndex: inputIndex,
      requestID: requestID,
      status: .failed,
      eventID: nil,
      errorCode: errorCode,
      errorMessage: errorMessage
    )
  }
}

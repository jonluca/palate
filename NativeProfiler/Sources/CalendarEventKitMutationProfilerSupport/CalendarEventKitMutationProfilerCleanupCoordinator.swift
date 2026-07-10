import Foundation

@MainActor
public enum CalendarEventKitMutationProfilerCleanupCoordinator {
  public static func finish<Value>(
    benchmarkResult: Result<Value, Error>,
    cleanupActiveEvents: () throws -> Void,
    cleanupTemporaryCalendar: () throws -> Void
  ) throws -> Value {
    let activeEventCleanupResult = Result(catching: cleanupActiveEvents)
    let temporaryCalendarCleanupResult = Result(catching: cleanupTemporaryCalendar)
    let cleanupMessages = [
      failureMessage(label: "active events", result: activeEventCleanupResult),
      failureMessage(label: "temporary calendar", result: temporaryCalendarCleanupResult),
    ].compactMap { $0 }

    switch (benchmarkResult, cleanupMessages.isEmpty) {
    case (.success(let value), true):
      return value
    case (.success, false):
      throw CalendarEventKitMutationProfilerError.temporaryCalendarCleanupFailed(
        cleanupMessages.joined(separator: "; ")
      )
    case (.failure(let benchmarkError), true):
      throw benchmarkError
    case (.failure(let benchmarkError), false):
      throw CalendarEventKitMutationProfilerError.temporaryCalendarAndBenchmarkFailed(
        benchmark: benchmarkError.localizedDescription,
        cleanup: cleanupMessages.joined(separator: "; ")
      )
    }
  }

  private static func failureMessage(
    label: String,
    result: Result<Void, Error>
  ) -> String? {
    guard case .failure(let error) = result else {
      return nil
    }
    return "\(label): \(error.localizedDescription)"
  }
}

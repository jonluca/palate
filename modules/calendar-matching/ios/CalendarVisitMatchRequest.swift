import Foundation

struct CalendarVisitMatchRequest {
  let visits: [CalendarMatchingVisit]
  let bufferMilliseconds: Double
  let searchStartMs: Double
  let searchEndMs: Double

  init(visits records: [CalendarVisitRecord], bufferMinutes: Double) throws {
    guard bufferMinutes.isFinite, bufferMinutes >= 0 else {
      throw CalendarMatchingModuleError.invalidBufferMinutes(bufferMinutes)
    }
    let bufferMilliseconds = bufferMinutes * 60_000
    guard bufferMilliseconds.isFinite else {
      throw CalendarMatchingModuleError.invalidBufferMinutes(bufferMinutes)
    }

    let visits = try records.map { try $0.validatedCoreVisit() }
    self.visits = visits
    self.bufferMilliseconds = bufferMilliseconds

    guard let minimumStart = visits.map(\.startTimeMs).min(),
      let maximumEnd = visits.map(\.endTimeMs).max()
    else {
      searchStartMs = 0
      searchEndMs = 0
      return
    }

    let searchStartMs = minimumStart - bufferMilliseconds
    let searchEndMs = maximumEnd + bufferMilliseconds
    guard CalendarMatchingTimestamp.isSupported(searchStartMs),
      CalendarMatchingTimestamp.isSupported(searchEndMs)
    else {
      throw CalendarMatchingModuleError.invalidDateRange(
        startMs: searchStartMs,
        endMs: searchEndMs
      )
    }
    self.searchStartMs = searchStartMs
    self.searchEndMs = searchEndMs
  }
}

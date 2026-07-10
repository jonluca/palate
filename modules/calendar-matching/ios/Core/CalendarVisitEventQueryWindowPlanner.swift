public enum CalendarVisitEventQueryWindowPlanner {
  private struct BufferedVisitInterval {
    let visitID: String
    let inputIndex: Int
    let startDateMs: Double
    var endDateMs: Double
  }

  public static func windows(
    visits: [CalendarMatchingVisit],
    bufferMilliseconds: Double,
    coalescingGapMilliseconds: Double
  ) throws -> [CalendarEventQueryWindow] {
    guard bufferMilliseconds.isFinite, bufferMilliseconds >= 0 else {
      throw CalendarVisitEventQueryWindowPlannerError.invalidBufferMilliseconds(
        bufferMilliseconds
      )
    }
    guard coalescingGapMilliseconds.isFinite, coalescingGapMilliseconds >= 0 else {
      throw CalendarVisitEventQueryWindowPlannerError.invalidCoalescingGapMilliseconds(
        coalescingGapMilliseconds
      )
    }

    let sortedIntervals = try visits.enumerated().map { inputIndex, visit in
      try bufferedInterval(
        for: visit,
        inputIndex: inputIndex,
        bufferMilliseconds: bufferMilliseconds
      )
    }.sorted(by: intervalPrecedes)
    guard var currentInterval = sortedIntervals.first else {
      return []
    }

    var mergedIntervals: [BufferedVisitInterval] = []
    mergedIntervals.reserveCapacity(sortedIntervals.count)
    for interval in sortedIntervals.dropFirst() {
      if shouldCoalesce(
        currentInterval,
        with: interval,
        maximumGapMilliseconds: coalescingGapMilliseconds
      ) {
        currentInterval.endDateMs = max(currentInterval.endDateMs, interval.endDateMs)
      } else {
        mergedIntervals.append(currentInterval)
        currentInterval = interval
      }
    }
    mergedIntervals.append(currentInterval)

    return mergedIntervals.flatMap { interval in
      CalendarEventQueryWindowPlanner.windows(
        startDateMs: interval.startDateMs,
        endDateMs: interval.endDateMs
      )
    }
  }

  private static func bufferedInterval(
    for visit: CalendarMatchingVisit,
    inputIndex: Int,
    bufferMilliseconds: Double
  ) throws -> BufferedVisitInterval {
    guard CalendarMatchingTimestamp.isSupported(visit.startTimeMs),
      CalendarMatchingTimestamp.isSupported(visit.endTimeMs),
      visit.endTimeMs >= visit.startTimeMs
    else {
      throw CalendarVisitEventQueryWindowPlannerError.invalidVisitRange(
        visitID: visit.id,
        startTimeMs: visit.startTimeMs,
        endTimeMs: visit.endTimeMs
      )
    }

    let maximumTimestamp = CalendarMatchingTimestamp.maximumAbsoluteMilliseconds
    let lowerTimeClipHeadroom = visit.startTimeMs + maximumTimestamp
    guard bufferMilliseconds <= lowerTimeClipHeadroom else {
      throw CalendarVisitEventQueryWindowPlannerError.bufferedStartOutsideSupportedRange(
        visitID: visit.id
      )
    }
    let upperTimeClipHeadroom = maximumTimestamp - visit.endTimeMs
    guard bufferMilliseconds <= upperTimeClipHeadroom else {
      throw CalendarVisitEventQueryWindowPlannerError.bufferedEndOutsideSupportedRange(
        visitID: visit.id
      )
    }
    let bufferedStart = visit.startTimeMs - bufferMilliseconds
    let bufferedEnd = visit.endTimeMs + bufferMilliseconds
    guard CalendarMatchingTimestamp.isSupported(bufferedStart) else {
      throw CalendarVisitEventQueryWindowPlannerError.bufferedStartOutsideSupportedRange(
        visitID: visit.id
      )
    }
    guard CalendarMatchingTimestamp.isSupported(bufferedEnd) else {
      throw CalendarVisitEventQueryWindowPlannerError.bufferedEndOutsideSupportedRange(
        visitID: visit.id
      )
    }

    return BufferedVisitInterval(
      visitID: visit.id,
      inputIndex: inputIndex,
      startDateMs: bufferedStart,
      endDateMs: bufferedEnd
    )
  }

  private static func intervalPrecedes(
    _ first: BufferedVisitInterval,
    _ second: BufferedVisitInterval
  ) -> Bool {
    if first.startDateMs != second.startDateMs {
      return first.startDateMs < second.startDateMs
    }
    if first.endDateMs != second.endDateMs {
      return first.endDateMs < second.endDateMs
    }
    if first.visitID != second.visitID {
      return first.visitID < second.visitID
    }
    return first.inputIndex < second.inputIndex
  }

  private static func shouldCoalesce(
    _ first: BufferedVisitInterval,
    with second: BufferedVisitInterval,
    maximumGapMilliseconds: Double
  ) -> Bool {
    guard second.startDateMs > first.endDateMs else {
      return true
    }
    // Subtracting two supported timestamps cannot overflow. Comparing the gap this way avoids
    // adding a potentially very large coalescing threshold to a timestamp near TimeClip's edge.
    return second.startDateMs - first.endDateMs <= maximumGapMilliseconds
  }
}

public enum CalendarVisitEventQueryWindowPlannerError: Error, Equatable, Sendable {
  case invalidBufferMilliseconds(Double)
  case invalidCoalescingGapMilliseconds(Double)
  case invalidVisitRange(
    visitID: String,
    startTimeMs: Double,
    endTimeMs: Double
  )
  case bufferedStartOutsideSupportedRange(visitID: String)
  case bufferedEndOutsideSupportedRange(visitID: String)
}

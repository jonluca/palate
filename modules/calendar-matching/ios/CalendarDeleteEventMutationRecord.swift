import ExpoModulesCore

#if SWIFT_PACKAGE
  import CalendarBatchMutationCore
#endif

@Record
struct CalendarDeleteEventMutationRecord {
  var requestId: String = ""
  var eventId: String = ""
  var instanceStartMs: Double?
  var futureEvents: Bool = false

  var coreMutation: CalendarDeleteMutation {
    CalendarDeleteMutation(
      requestID: requestId,
      eventID: eventId,
      instanceStartMs: instanceStartMs,
      futureEvents: futureEvents
    )
  }
}

import ExpoModulesCore

#if SWIFT_PACKAGE
  import CalendarBatchMutationCore
#endif

struct CalendarDeleteEventMutationRecord: Record {
  @Field var requestId: String = ""
  @Field var eventId: String = ""
  @Field var instanceStartMs: Double?
  @Field var futureEvents: Bool = false

  var coreMutation: CalendarDeleteMutation {
    CalendarDeleteMutation(
      requestID: requestId,
      eventID: eventId,
      instanceStartMs: instanceStartMs,
      futureEvents: futureEvents
    )
  }
}

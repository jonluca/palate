import ExpoModulesCore

#if SWIFT_PACKAGE
  import CalendarBatchMutationCore
#endif

struct CalendarExportEventMutationRecord: Record {
  @Field var requestId: String = ""
  @Field var title: String = ""
  @Field var startMs: Double = 0
  @Field var endMs: Double = 0
  @Field var location: String?
  @Field var notes: String = ""

  var coreMutation: CalendarExportMutation {
    CalendarExportMutation(
      requestID: requestId,
      title: title,
      startMs: startMs,
      endMs: endMs,
      location: location,
      notes: notes
    )
  }
}

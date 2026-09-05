import ExpoModulesCore

#if SWIFT_PACKAGE
  import CalendarBatchMutationCore
#endif

@Record
struct CalendarExportEventMutationRecord {
  var requestId: String = ""
  var title: String = ""
  var startMs: Double = 0
  var endMs: Double = 0
  var location: String?
  var notes: String = ""

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

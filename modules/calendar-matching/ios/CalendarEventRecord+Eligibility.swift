import EventKit

extension CalendarEventRecord {
  static func initIfEligible(event: EKEvent) -> CalendarEventRecord? {
    guard !event.isAllDay,
      event.recurrenceRules?.isEmpty ?? true,
      let title = CalendarEventTitleFilter.eligibleTitle(event.title)
    else {
      return nil
    }
    return CalendarEventRecord(event: event, title: title)
  }
}

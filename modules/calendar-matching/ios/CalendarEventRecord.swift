import EventKit
import ExpoModulesCore
import Foundation

struct CalendarEventRecord: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var notes: String?
  @Field var location: String?
  @Field var startDate: Double = 0
  @Field var endDate: Double = 0
  @Field var isAllDay: Bool = false
  @Field var calendarTitle: String?

  init() {}

  init(event: EKEvent, title: String) {
    id = event.calendarItemIdentifier
    self.title = title
    notes = event.notes
    location = event.location
    // expo-calendar's ISO serializer exposes millisecond precision to JavaScript.
    startDate = (event.startDate.timeIntervalSince1970 * 1_000).rounded()
    endDate = (event.endDate.timeIntervalSince1970 * 1_000).rounded()
    isAllDay = event.isAllDay
    calendarTitle = event.calendar.title
  }

  var coreEvent: CalendarMatchingEvent {
    CalendarMatchingEvent(
      id: id,
      title: title,
      notes: notes,
      location: location,
      startDateMs: startDate,
      endDateMs: endDate,
      isAllDay: isAllDay,
      calendarTitle: calendarTitle
    )
  }
}

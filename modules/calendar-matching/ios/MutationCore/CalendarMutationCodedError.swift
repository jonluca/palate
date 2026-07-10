public protocol CalendarMutationCodedError: Error {
  var calendarMutationCode: String { get }
}

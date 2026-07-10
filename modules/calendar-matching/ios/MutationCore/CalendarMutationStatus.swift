public enum CalendarMutationStatus: String, Equatable, Sendable {
  case created
  case deleted
  case alreadyAbsent
  case failed
}

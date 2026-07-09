enum CalendarEventTitleFilter {
  static func eligibleTitle(_ title: String?) -> String? {
    guard let title else {
      return nil
    }
    let trimmed = CalendarJavaScriptWhitespace.trim(title)
    guard CalendarMatchingEventEvaluator.hasValidTitle(trimmed),
      !CalendarMatchingEventEvaluator.isLikelyNonReservationTitle(trimmed)
    else {
      return nil
    }
    return trimmed
  }
}

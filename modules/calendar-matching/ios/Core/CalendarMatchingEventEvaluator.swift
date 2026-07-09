import Foundation

internal enum CalendarMatchingEventEvaluator {
  private static let nonReservationTitlePatterns = [
    CalendarMatchingRegularExpression(#"[✈️✈︎🛫🛬🛩️🚆🚄🚅🚇🚈🚉🚌🚍🚎🚗🚕🚖🚘🚙🛻🚲🚴🚤⛴️🚢🚋🚝🚞🚊🛳️]"#),
    CalendarMatchingRegularExpression(
      #"(?<![A-Za-z0-9_])(airbnb|check(?:-|\s)?in|check(?:-|\s)?out)(?![A-Za-z0-9_])"#,
      options: [.caseInsensitive]
    ),
  ]

  private static let reservationPattern = CalendarMatchingRegularExpression(
    [
      #"reserv(ation|e|ed)"#,
      #"resy"#,
      #"opentable"#,
      #"yelp"#,
      #"tock"#,
      #"seated"#,
      #"bookatable"#,
      #"quandoo"#,
      #"the\s*fork"#,
      #"dinner"#,
      #"lunch"#,
      #"brunch"#,
      #"breakfast"#,
      #"restaurant"#,
      #"bistro"#,
      #"cafe"#,
      #"table\s+(at|for)"#,
      #"party\s+of\s+[0-9]+"#,
      #"[0-9]+\s*(people|guests|pax)"#,
    ].map { "(?:\($0))" }.joined(separator: "|"), options: [.caseInsensitive])

  private static let domainPattern = CalendarMatchingRegularExpression(
    #"^[a-z0-9-]+\.(com|org|net|io|co|app|ly|me|us|uk|ca|de|fr|it|es|au|jp|cn)(?![A-Za-z0-9_])"#
  )

  internal static func isEligible(_ event: CalendarMatchingEvent) -> Bool {
    !event.isAllDay && hasValidTitle(event.title) && !isLikelyNonReservationTitle(event.title)
  }

  internal static func hasValidTitle(_ title: String) -> Bool {
    let trimmed = CalendarJavaScriptWhitespace.trim(title)
    guard !trimmed.isEmpty else {
      return false
    }

    let normalized = trimmed.lowercased()
    return normalized != "untitled event" && normalized != "custom"
  }

  internal static func isLikelyNonReservationTitle(_ title: String) -> Bool {
    nonReservationTitlePatterns.contains { $0.matches(title) }
  }

  internal static func overlaps(
    visitStartMs: Double,
    visitEndMs: Double,
    eventStartMs: Double,
    eventEndMs: Double,
    bufferMilliseconds: Double
  ) -> Bool {
    visitStartMs < eventEndMs + bufferMilliseconds && visitEndMs > eventStartMs - bufferMilliseconds
  }

  internal static func score(
    _ event: CalendarMatchingEvent,
    visitStartMs: Double,
    visitEndMs: Double
  ) -> Int {
    baseScore(event)
      + proximityScore(
        event,
        visitStartMs: visitStartMs,
        visitEndMs: visitEndMs
      )
  }

  internal static func baseScore(_ event: CalendarMatchingEvent) -> Int {
    var score = 0

    if !event.isAllDay {
      score += 100
    }
    if looksLikeReservation(event) {
      score += 200
    }
    if let location = event.location, !location.isEmpty {
      score += looksLikeURL(location) ? -100 : 50
    }
    if let notes = event.notes, !notes.isEmpty {
      score += 10
    }

    let duration = event.endDateMs - event.startDateMs
    if duration < 4 * 60 * 60 * 1_000.0 {
      score += 15
    } else if duration < 8 * 60 * 60 * 1_000.0 {
      score += 5
    }

    return score
  }

  internal static func proximityScore(
    _ event: CalendarMatchingEvent,
    visitStartMs: Double,
    visitEndMs: Double
  ) -> Int {
    guard !event.isAllDay else {
      return 0
    }
    let visitMidpoint = (visitStartMs + visitEndMs) / 2
    let eventMidpoint = (event.startDateMs + event.endDateMs) / 2
    let difference = abs(visitMidpoint - eventMidpoint)
    let twoHours = 2 * 60 * 60 * 1_000.0
    guard difference < twoHours else {
      return 0
    }
    let proximity = 20 * (1 - difference / twoHours)
    return Int(proximity.rounded(.toNearestOrAwayFromZero))
  }

  private static func looksLikeReservation(_ event: CalendarMatchingEvent) -> Bool {
    let text = "\(event.title) \(event.location ?? "") \(event.notes ?? "")"
    return reservationPattern.matches(text)
  }

  private static func looksLikeURL(_ value: String) -> Bool {
    let normalized = CalendarJavaScriptWhitespace.trim(value.lowercased())
    return normalized.hasPrefix("http://") || normalized.hasPrefix("https://")
      || normalized.hasPrefix("www.") || domainPattern.matches(normalized)
  }
}

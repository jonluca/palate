import CalendarMatchingCore
import Foundation

enum ExhaustiveCalendarEventEvaluator {
  private static let nonReservationTitlePatterns = [
    ExhaustiveCalendarRegularExpression(
      #"[✈️✈︎🛫🛬🛩️🚆🚄🚅🚇🚈🚉🚌🚍🚎🚗🚕🚖🚘🚙🛻🚲🚴🚤⛴️🚢🚋🚝🚞🚊🛳️]"#
    ),
    ExhaustiveCalendarRegularExpression(
      #"(?<![A-Za-z0-9_])(airbnb|check(?:-|\s)?in|check(?:-|\s)?out)(?![A-Za-z0-9_])"#,
      options: [.caseInsensitive]
    ),
  ]

  private static let reservationPatterns = [
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
  ].map { ExhaustiveCalendarRegularExpression($0, options: [.caseInsensitive]) }

  private static let bareDomainPattern = ExhaustiveCalendarRegularExpression(
    #"^[a-z0-9-]+\.(com|org|net|io|co|app|ly|me|us|uk|ca|de|fr|it|es|au|jp|cn)(?![A-Za-z0-9_])"#
  )

  static func isEligible(_ event: CalendarMatchingEvent) -> Bool {
    !event.isAllDay && hasValidTitle(event.title) && !isLikelyNonReservationTitle(event.title)
  }

  static func trimmedTitle(_ title: String) -> String {
    ExhaustiveCalendarJavaScriptWhitespace.trim(title)
  }

  static func overlaps(
    visitStartMs: Double,
    visitEndMs: Double,
    eventStartMs: Double,
    eventEndMs: Double,
    bufferMilliseconds: Double
  ) -> Bool {
    visitStartMs < eventEndMs + bufferMilliseconds && visitEndMs > eventStartMs - bufferMilliseconds
  }

  static func score(
    _ event: CalendarMatchingEvent,
    visitStartMs: Double,
    visitEndMs: Double
  ) -> Int {
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

    if !event.isAllDay {
      let visitMidpoint = (visitStartMs + visitEndMs) / 2
      let eventMidpoint = (event.startDateMs + event.endDateMs) / 2
      let difference = abs(visitMidpoint - eventMidpoint)
      let twoHours = 2 * 60 * 60 * 1_000.0
      if difference < twoHours {
        score += Int((20 * (1 - difference / twoHours)).rounded(.toNearestOrAwayFromZero))
      }
    }

    let duration = event.endDateMs - event.startDateMs
    if duration < 4 * 60 * 60 * 1_000.0 {
      score += 15
    } else if duration < 8 * 60 * 60 * 1_000.0 {
      score += 5
    }
    return score
  }

  private static func hasValidTitle(_ title: String) -> Bool {
    let trimmed = trimmedTitle(title)
    guard !trimmed.isEmpty else {
      return false
    }
    let normalized = trimmed.lowercased()
    return normalized != "untitled event" && normalized != "custom"
  }

  private static func isLikelyNonReservationTitle(_ title: String) -> Bool {
    nonReservationTitlePatterns.contains { $0.matches(title) }
  }

  private static func looksLikeReservation(_ event: CalendarMatchingEvent) -> Bool {
    let text = "\(event.title) \(event.location ?? "") \(event.notes ?? "")"
    return reservationPatterns.contains { $0.matches(text) }
  }

  private static func looksLikeURL(_ value: String) -> Bool {
    let normalized = trimmedTitle(value.lowercased())
    return normalized.hasPrefix("http://") || normalized.hasPrefix("https://")
      || normalized.hasPrefix("www.") || bareDomainPattern.matches(normalized)
  }
}

import CalendarMatchingCore
import Foundation

enum ExhaustiveCalendarMatcher {
  private struct PreparedEvent {
    let event: CalendarMatchingEvent
    let originalIndex: Int
  }

  private struct PreparedTitle {
    let cleanedTitle: String
    let normalizedExactTitle: String
    let normalizedFuzzyTitle: String
  }

  private struct PreparedRestaurant {
    let restaurant: CalendarMatchingRestaurant
    let cleanedExactName: String
    let normalizedExactName: String
    let normalizedFuzzyName: String
  }

  private struct Candidate {
    let preparedEvent: PreparedEvent
    let score: Int
  }

  static func match(
    visits: [CalendarMatchingVisit],
    events: [CalendarMatchingEvent],
    bufferMilliseconds: Double
  ) -> [CalendarVisitMatch] {
    let preparedEvents = prepareEvents(events)
    var preparedTitleCache: [Int: PreparedTitle] = [:]
    preparedTitleCache.reserveCapacity(min(events.count, visits.count * 2))
    var matches: [CalendarVisitMatch] = []
    matches.reserveCapacity(visits.count)

    for visit in visits {
      let ranked =
        preparedEvents
        .compactMap { preparedEvent -> Candidate? in
          let event = preparedEvent.event
          guard
            ExhaustiveCalendarEventEvaluator.overlaps(
              visitStartMs: visit.startTimeMs,
              visitEndMs: visit.endTimeMs,
              eventStartMs: event.startDateMs,
              eventEndMs: event.endDateMs,
              bufferMilliseconds: bufferMilliseconds
            )
          else {
            return nil
          }
          return Candidate(
            preparedEvent: preparedEvent,
            score: ExhaustiveCalendarEventEvaluator.score(
              event,
              visitStartMs: visit.startTimeMs,
              visitEndMs: visit.endTimeMs
            )
          )
        }
        .sorted(by: ranksBefore)
      guard let fallback = ranked.first else {
        continue
      }

      var selectedEvent = fallback.preparedEvent.event
      var selectedRestaurantId: String?
      if !visit.suggestedRestaurants.isEmpty {
        let preparedRestaurants = visit.suggestedRestaurants.map(prepareRestaurant)
        matching: for useFuzzyMatching in [false, true] {
          for candidate in ranked {
            let originalIndex = candidate.preparedEvent.originalIndex
            let preparedTitle: PreparedTitle
            if let cached = preparedTitleCache[originalIndex] {
              preparedTitle = cached
            } else {
              let created = prepareTitle(candidate.preparedEvent.event.title)
              preparedTitleCache[originalIndex] = created
              preparedTitle = created
            }
            guard preparedTitle.cleanedTitle.utf16.count >= 3 else {
              continue
            }
            if let restaurant = preparedRestaurants.first(where: { restaurant in
              ExhaustiveCalendarRestaurantNameMatcher.isExactMatch(
                normalizedCalendar: preparedTitle.normalizedExactTitle,
                cleanedRestaurant: restaurant.cleanedExactName,
                normalizedRestaurant: restaurant.normalizedExactName
              )
                || (useFuzzyMatching
                  && ExhaustiveCalendarRestaurantNameMatcher.isFuzzyMatch(
                    normalizedFirst: preparedTitle.normalizedFuzzyTitle,
                    normalizedSecond: restaurant.normalizedFuzzyName
                  ))
            }) {
              selectedEvent = candidate.preparedEvent.event
              selectedRestaurantId = restaurant.restaurant.id
              break matching
            }
          }
        }
      }

      matches.append(
        CalendarVisitMatch(
          visitId: visit.id,
          event: selectedEvent,
          suggestedRestaurantId: selectedRestaurantId
        )
      )
    }
    return matches
  }

  private static func prepareEvents(_ events: [CalendarMatchingEvent]) -> [PreparedEvent] {
    events.enumerated().compactMap { index, event in
      guard ExhaustiveCalendarEventEvaluator.isEligible(event) else {
        return nil
      }
      let trimmedTitle = ExhaustiveCalendarEventEvaluator.trimmedTitle(event.title)
      let preparedEvent: CalendarMatchingEvent
      if trimmedTitle == event.title {
        preparedEvent = event
      } else {
        preparedEvent = CalendarMatchingEvent(
          id: event.id,
          title: trimmedTitle,
          notes: event.notes,
          location: event.location,
          startDateMs: event.startDateMs,
          endDateMs: event.endDateMs,
          isAllDay: event.isAllDay,
          calendarTitle: event.calendarTitle
        )
      }
      return PreparedEvent(event: preparedEvent, originalIndex: index)
    }
  }

  private static func prepareTitle(_ title: String) -> PreparedTitle {
    let cleanedTitle = ExhaustiveCalendarTitleCleaner.cleanEventTitle(title)
    return PreparedTitle(
      cleanedTitle: cleanedTitle,
      normalizedExactTitle: ExhaustiveCalendarNameNormalizer.normalize(
        ExhaustiveCalendarTitleCleaner.stripComparisonAffixes(cleanedTitle)
      ),
      normalizedFuzzyTitle: ExhaustiveCalendarNameNormalizer.normalize(cleanedTitle)
    )
  }

  private static func prepareRestaurant(
    _ restaurant: CalendarMatchingRestaurant
  ) -> PreparedRestaurant {
    let cleanedExactName = ExhaustiveCalendarTitleCleaner.stripComparisonAffixes(restaurant.name)
    return PreparedRestaurant(
      restaurant: restaurant,
      cleanedExactName: cleanedExactName,
      normalizedExactName: ExhaustiveCalendarNameNormalizer.normalize(cleanedExactName),
      normalizedFuzzyName: ExhaustiveCalendarNameNormalizer.normalize(restaurant.name)
    )
  }

  private static func ranksBefore(_ first: Candidate, _ second: Candidate) -> Bool {
    if first.score != second.score {
      return first.score > second.score
    }
    if first.preparedEvent.event.startDateMs != second.preparedEvent.event.startDateMs {
      return first.preparedEvent.event.startDateMs < second.preparedEvent.event.startDateMs
    }
    if first.preparedEvent.event.endDateMs != second.preparedEvent.event.endDateMs {
      return first.preparedEvent.event.endDateMs < second.preparedEvent.event.endDateMs
    }
    return first.preparedEvent.originalIndex < second.preparedEvent.originalIndex
  }
}

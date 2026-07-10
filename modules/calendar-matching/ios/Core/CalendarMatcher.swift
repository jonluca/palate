import Foundation

public enum CalendarMatcher {
  private struct IndexedEvent {
    let event: CalendarMatchingEvent
    let cacheIndex: Int
    let baseScore: Int
  }

  private struct PreparedEventTitle {
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

  private struct ScoredEvent {
    let indexedEvent: IndexedEvent
    let score: Int
  }

  public static func match(
    visits: [CalendarMatchingVisit],
    events: [CalendarMatchingEvent],
    bufferMilliseconds: Double = 30 * 60 * 1_000
  ) -> [CalendarVisitMatch] {
    match(
      visits: visits,
      events: events,
      bufferMilliseconds: bufferMilliseconds,
      filterIneligibleEvents: true
    )
  }

  /// Matches events that have already passed the native EventKit eligibility filter.
  public static func matchEligibleEvents(
    visits: [CalendarMatchingVisit],
    events: [CalendarMatchingEvent],
    bufferMilliseconds: Double = 30 * 60 * 1_000
  ) -> [CalendarVisitMatch] {
    match(
      visits: visits,
      events: events,
      bufferMilliseconds: bufferMilliseconds,
      filterIneligibleEvents: false
    )
  }

  private static func match(
    visits: [CalendarMatchingVisit],
    events: [CalendarMatchingEvent],
    bufferMilliseconds: Double,
    filterIneligibleEvents: Bool
  ) -> [CalendarVisitMatch] {
    guard !visits.isEmpty else {
      return []
    }

    let timedEvents = preparedEvents(events, filterIneligibleEvents: filterIneligibleEvents)
    guard !timedEvents.isEmpty else {
      return []
    }

    let maximumDuration = timedEvents.reduce(0.0) { maximum, indexedEvent in
      max(maximum, max(0, indexedEvent.event.endDateMs - indexedEvent.event.startDateMs))
    }
    var results: [CalendarVisitMatch] = []
    results.reserveCapacity(visits.count)
    var preparedEventTitles: [Int: PreparedEventTitle] = [:]
    preparedEventTitles.reserveCapacity(min(events.count, visits.count * 2))

    for visit in visits {
      if visit.suggestedRestaurants.isEmpty {
        guard
          let bestCandidate = bestCandidate(
            for: visit,
            events: timedEvents,
            maximumDuration: maximumDuration,
            bufferMilliseconds: bufferMilliseconds
          )
        else {
          continue
        }

        results.append(
          CalendarVisitMatch(
            visitId: visit.id,
            event: bestCandidate.indexedEvent.event,
            suggestedRestaurantId: nil
          )
        )
        continue
      }

      let candidates = rankedCandidates(
        for: visit,
        events: timedEvents,
        maximumDuration: maximumDuration,
        bufferMilliseconds: bufferMilliseconds
      )
      guard let bestCandidate = candidates.first else {
        continue
      }

      var selectedEvent = bestCandidate.indexedEvent.event
      var suggestedRestaurantId: String?

      let preparedRestaurants = visit.suggestedRestaurants.map(prepareRestaurant)
      matching: for useFuzzyMatching in [false, true] {
        for candidate in candidates {
          let indexedEvent = candidate.indexedEvent
          let preparedTitle: PreparedEventTitle
          if let cachedTitle = preparedEventTitles[indexedEvent.cacheIndex] {
            preparedTitle = cachedTitle
          } else {
            let newTitle = prepareEventTitle(indexedEvent.event.title)
            preparedEventTitles[indexedEvent.cacheIndex] = newTitle
            preparedTitle = newTitle
          }
          guard preparedTitle.cleanedTitle.utf16.count >= 3 else {
            continue
          }

          if let preparedRestaurant = preparedRestaurants.first(where: { preparedRestaurant in
            CalendarRestaurantNameMatcher.isExactMatch(
              normalizedCalendar: preparedTitle.normalizedExactTitle,
              cleanedRestaurant: preparedRestaurant.cleanedExactName,
              normalizedRestaurant: preparedRestaurant.normalizedExactName
            )
              || (useFuzzyMatching
                && CalendarRestaurantNameMatcher.isFuzzyMatch(
                  normalizedFirst: preparedTitle.normalizedFuzzyTitle,
                  normalizedSecond: preparedRestaurant.normalizedFuzzyName
                ))
          }) {
            selectedEvent = candidate.indexedEvent.event
            suggestedRestaurantId = preparedRestaurant.restaurant.id
            break matching
          }
        }
      }

      results.append(
        CalendarVisitMatch(
          visitId: visit.id,
          event: selectedEvent,
          suggestedRestaurantId: suggestedRestaurantId
        )
      )
    }

    return results
  }

  private static func preparedEvents(
    _ events: [CalendarMatchingEvent],
    filterIneligibleEvents: Bool
  ) -> [IndexedEvent] {
    events.enumerated()
      .compactMap { index, event -> IndexedEvent? in
        guard !filterIneligibleEvents || CalendarMatchingEventEvaluator.isEligible(event) else {
          return nil
        }

        let trimmedTitle = CalendarJavaScriptWhitespace.trim(event.title)
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

        return IndexedEvent(
          event: preparedEvent,
          cacheIndex: index,
          baseScore: CalendarMatchingEventEvaluator.baseScore(preparedEvent)
        )
      }
      .sorted { first, second in
        if first.event.startDateMs != second.event.startDateMs {
          return first.event.startDateMs < second.event.startDateMs
        }
        if first.event.endDateMs != second.event.endDateMs {
          return first.event.endDateMs < second.event.endDateMs
        }
        return first.event.id < second.event.id
      }
  }

  private static func prepareEventTitle(_ title: String) -> PreparedEventTitle {
    let cleanedTitle = CalendarTitleCleaner.cleanEventTitle(title)
    return PreparedEventTitle(
      cleanedTitle: cleanedTitle,
      normalizedExactTitle: CalendarNameNormalizer.normalize(
        CalendarTitleCleaner.stripComparisonAffixes(cleanedTitle)
      ),
      normalizedFuzzyTitle: CalendarNameNormalizer.normalize(cleanedTitle)
    )
  }

  private static func prepareRestaurant(_ restaurant: CalendarMatchingRestaurant)
    -> PreparedRestaurant
  {
    let cleanedExactName = CalendarTitleCleaner.stripComparisonAffixes(restaurant.name)
    return PreparedRestaurant(
      restaurant: restaurant,
      cleanedExactName: cleanedExactName,
      normalizedExactName: CalendarNameNormalizer.normalize(cleanedExactName),
      normalizedFuzzyName: CalendarNameNormalizer.normalize(restaurant.name)
    )
  }

  private static func rankedCandidates(
    for visit: CalendarMatchingVisit,
    events: [IndexedEvent],
    maximumDuration: Double,
    bufferMilliseconds: Double
  ) -> [ScoredEvent] {
    guard
      let candidateRange = candidateRange(
        for: visit,
        events: events,
        maximumDuration: maximumDuration,
        bufferMilliseconds: bufferMilliseconds
      )
    else {
      return []
    }

    var candidates: [ScoredEvent] = []
    candidates.reserveCapacity(candidateRange.count)

    for index in candidateRange {
      let indexedEvent = events[index]
      let event = indexedEvent.event
      guard
        CalendarMatchingEventEvaluator.overlaps(
          visitStartMs: visit.startTimeMs,
          visitEndMs: visit.endTimeMs,
          eventStartMs: event.startDateMs,
          eventEndMs: event.endDateMs,
          bufferMilliseconds: bufferMilliseconds
        )
      else {
        continue
      }

      candidates.append(
        ScoredEvent(
          indexedEvent: indexedEvent,
          score: indexedEvent.baseScore
            + CalendarMatchingEventEvaluator.proximityScore(
              event,
              visitStartMs: visit.startTimeMs,
              visitEndMs: visit.endTimeMs
            )
        )
      )
    }

    candidates.sort { isPreferred($0, over: $1) }

    return candidates
  }

  private static func bestCandidate(
    for visit: CalendarMatchingVisit,
    events: [IndexedEvent],
    maximumDuration: Double,
    bufferMilliseconds: Double
  ) -> ScoredEvent? {
    guard
      let candidateRange = candidateRange(
        for: visit,
        events: events,
        maximumDuration: maximumDuration,
        bufferMilliseconds: bufferMilliseconds
      )
    else {
      return nil
    }

    var best: ScoredEvent?
    for index in candidateRange {
      let indexedEvent = events[index]
      let event = indexedEvent.event
      guard
        CalendarMatchingEventEvaluator.overlaps(
          visitStartMs: visit.startTimeMs,
          visitEndMs: visit.endTimeMs,
          eventStartMs: event.startDateMs,
          eventEndMs: event.endDateMs,
          bufferMilliseconds: bufferMilliseconds
        )
      else {
        continue
      }

      let candidate = ScoredEvent(
        indexedEvent: indexedEvent,
        score: indexedEvent.baseScore
          + CalendarMatchingEventEvaluator.proximityScore(
            event,
            visitStartMs: visit.startTimeMs,
            visitEndMs: visit.endTimeMs
          )
      )
      if best.map({ isPreferred(candidate, over: $0) }) ?? true {
        best = candidate
      }
    }
    return best
  }

  private static func candidateRange(
    for visit: CalendarMatchingVisit,
    events: [IndexedEvent],
    maximumDuration: Double,
    bufferMilliseconds: Double
  ) -> Range<Int>? {
    let windowStart = visit.startTimeMs - bufferMilliseconds
    let windowEnd = visit.endTimeMs + bufferMilliseconds
    let startIndex = lowerBound(events, target: windowStart - maximumDuration)
    let endIndex = upperBound(events, target: windowEnd)
    guard startIndex < endIndex else {
      return nil
    }
    return startIndex..<endIndex
  }

  private static func isPreferred(_ first: ScoredEvent, over second: ScoredEvent) -> Bool {
    if first.score != second.score {
      return first.score > second.score
    }
    if first.indexedEvent.event.startDateMs != second.indexedEvent.event.startDateMs {
      return first.indexedEvent.event.startDateMs < second.indexedEvent.event.startDateMs
    }
    if first.indexedEvent.event.endDateMs != second.indexedEvent.event.endDateMs {
      return first.indexedEvent.event.endDateMs < second.indexedEvent.event.endDateMs
    }
    return first.indexedEvent.event.id < second.indexedEvent.event.id
  }

  private static func lowerBound(_ events: [IndexedEvent], target: Double) -> Int {
    var lower = 0
    var upper = events.count
    while lower < upper {
      let middle = (lower + upper) / 2
      if events[middle].event.startDateMs < target {
        lower = middle + 1
      } else {
        upper = middle
      }
    }
    return lower
  }

  private static func upperBound(_ events: [IndexedEvent], target: Double) -> Int {
    var lower = 0
    var upper = events.count
    while lower < upper {
      let middle = (lower + upper) / 2
      if events[middle].event.startDateMs <= target {
        lower = middle + 1
      } else {
        upper = middle
      }
    }
    return lower
  }
}

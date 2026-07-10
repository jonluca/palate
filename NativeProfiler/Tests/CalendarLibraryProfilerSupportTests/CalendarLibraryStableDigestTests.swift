import Testing

@testable import CalendarLibraryProfilerSupport

@Suite("Calendar library privacy-safe digest")
struct CalendarLibraryStableDigestTests {
  @Test("Digest is order-independent and never contains identifiers")
  func stableOrdering() {
    let first = CalendarLibraryEventIdentity(
      calendarItemIdentifier: "private-identifier-one",
      startDateMilliseconds: 1_000,
      endDateMilliseconds: 2_000
    )
    let second = CalendarLibraryEventIdentity(
      calendarItemIdentifier: "private-identifier-two",
      startDateMilliseconds: 3_000,
      endDateMilliseconds: 4_000
    )
    let forward = CalendarLibraryStableDigest.signature(for: [first, second])
    let reverse = CalendarLibraryStableDigest.signature(for: [second, first])

    #expect(forward == reverse)
    #expect(forward.count == 64)
    #expect(!forward.contains("private"))
  }

  @Test("Identity timing contributes to the digest")
  func timingSensitivity() {
    let first = CalendarLibraryEventIdentity(
      calendarItemIdentifier: "same-id",
      startDateMilliseconds: 1_000,
      endDateMilliseconds: 2_000
    )
    let shifted = CalendarLibraryEventIdentity(
      calendarItemIdentifier: "same-id",
      startDateMilliseconds: 1_001,
      endDateMilliseconds: 2_000
    )

    #expect(
      CalendarLibraryStableDigest.signature(for: [first])
        != CalendarLibraryStableDigest.signature(for: [shifted])
    )
  }
}

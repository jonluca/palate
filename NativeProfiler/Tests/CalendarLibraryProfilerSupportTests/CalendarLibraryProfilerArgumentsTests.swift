import Testing

@testable import CalendarLibraryProfilerSupport

@Suite("Calendar library profiler arguments")
struct CalendarLibraryProfilerArgumentsTests {
  @Test("Defaults are bounded and never request access")
  func defaults() throws {
    let arguments = try CalendarLibraryProfilerArguments(commandLineArguments: [])

    #expect(arguments.pastDays == 1_460)
    #expect(arguments.futureDays == 365)
    #expect(arguments.referenceWindowDays == 31)
    #expect(arguments.iterations == 3)
    #expect(arguments.warmupIterations == 1)
    #expect(!arguments.requestAccess)
  }

  @Test("Custom values and explicit access request parse")
  func customValues() throws {
    let arguments = try CalendarLibraryProfilerArguments(commandLineArguments: [
      "--past-days", "730",
      "--future-days", "30",
      "--reference-window-days", "7",
      "--iterations", "5",
      "--warmup", "0",
      "--request-access",
    ])

    #expect(arguments.pastDays == 730)
    #expect(arguments.futureDays == 30)
    #expect(arguments.referenceWindowDays == 7)
    #expect(arguments.iterations == 5)
    #expect(arguments.warmupIterations == 0)
    #expect(arguments.requestAccess)
  }

  @Test("Unknown, duplicate, and missing options fail before EventKit access")
  func malformedOptions() {
    #expect(throws: CalendarLibraryProfilerArgumentsError.unknownOption("positional")) {
      try CalendarLibraryProfilerArguments(commandLineArguments: ["positional"])
    }
    #expect(throws: CalendarLibraryProfilerArgumentsError.duplicateOption("--past-days")) {
      try CalendarLibraryProfilerArguments(commandLineArguments: [
        "--past-days", "5", "--past-days", "6",
      ])
    }
    #expect(throws: CalendarLibraryProfilerArgumentsError.missingValue(option: "--iterations")) {
      try CalendarLibraryProfilerArguments(commandLineArguments: ["--iterations"])
    }
  }

  @Test("Range and work limits reject accidental unbounded runs")
  func boundedWork() {
    #expect(
      throws: CalendarLibraryProfilerArgumentsError.rangeAboveMaximum(
        maximumDays: CalendarLibraryProfilerArguments.maximumRangeDays
      )
    ) {
      try CalendarLibraryProfilerArguments(
        pastDays: 2_000,
        futureDays: 2_000
      )
    }
    #expect(
      throws: CalendarLibraryProfilerArgumentsError.optionAboveMaximum(
        option: "--iterations",
        maximum: CalendarLibraryProfilerArguments.maximumIterations
      )
    ) {
      try CalendarLibraryProfilerArguments(iterations: 26)
    }
    #expect(throws: CalendarLibraryProfilerArgumentsError.zeroLengthRange) {
      try CalendarLibraryProfilerArguments(pastDays: 0, futureDays: 0)
    }
  }
}

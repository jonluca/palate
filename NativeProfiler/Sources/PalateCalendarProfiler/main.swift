import Foundation

do {
  let arguments = try CalendarProfilerArguments(
    commandLineArguments: Array(CommandLine.arguments.dropFirst())
  )
  if arguments.showHelp {
    print(CalendarProfilerArguments.usage)
  } else {
    let report = try CalendarProfilerRunner().run(arguments: arguments)
    print(try CalendarProfilerJSONEncoder.string(for: report))
  }
} catch {
  let failure = CalendarProfilerFailureReport(
    errorType: String(reflecting: type(of: error)),
    message: error.localizedDescription
  )
  if let json = try? CalendarProfilerJSONEncoder.string(for: failure) {
    print(json)
  } else {
    print(
      "{\"schemaVersion\":1,\"status\":\"error\",\"message\":\"Failed to encode profiler error\"}")
  }
  Foundation.exit(EXIT_FAILURE)
}

import CalendarBatchMutationProfilerSupport
import Foundation

@main
struct PalateCalendarBatchMutationProfilerMain {
  static func main() {
    do {
      let arguments = try CalendarBatchMutationProfilerArguments(
        commandLineArguments: Array(CommandLine.arguments.dropFirst())
      )
      if arguments.showHelp {
        print(CalendarBatchMutationProfilerArguments.usage)
        return
      }

      let report = try CalendarBatchMutationProfilerRunner().run(arguments: arguments)
      print(try CalendarBatchMutationProfilerJSONEncoder.string(for: report))
    } catch {
      let failure = CalendarBatchMutationProfilerFailureReport(
        errorType: String(reflecting: type(of: error)),
        message: error.localizedDescription
      )
      if let json = try? CalendarBatchMutationProfilerJSONEncoder.string(for: failure) {
        print(json)
      } else {
        print(
          "{\"schemaVersion\":1,\"status\":\"error\",\"message\":\"Failed to encode profiler error\"}"
        )
      }
      Foundation.exit(EXIT_FAILURE)
    }
  }
}

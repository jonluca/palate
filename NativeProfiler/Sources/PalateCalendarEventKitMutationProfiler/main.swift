import AppKit
import CalendarEventKitMutationProfilerSupport
import Foundation

@main
struct PalateCalendarEventKitMutationProfilerMain {
  static func main() async {
    await MainActor.run {
      _ = NSApplication.shared
      NSApp.setActivationPolicy(.accessory)
    }

    do {
      let arguments = try CalendarEventKitMutationProfilerArguments(
        commandLineArguments: Array(CommandLine.arguments.dropFirst())
      )
      if arguments.showHelp {
        print(CalendarEventKitMutationProfilerArguments.usage)
        return
      }

      let report = try await CalendarEventKitMutationProfilerRunner().run(
        arguments: arguments
      )
      print(try CalendarEventKitMutationProfilerJSONEncoder.string(for: report))
    } catch {
      let authorizationStatus: String?
      if case CalendarEventKitMutationProfilerError.calendarAccessUnavailable(let status, _) =
        error
      {
        authorizationStatus = status
      } else {
        authorizationStatus = nil
      }
      let failure = CalendarEventKitMutationProfilerFailureReport(
        errorType: String(reflecting: type(of: error)),
        message: error.localizedDescription,
        authorizationStatus: authorizationStatus
      )
      if let json = try? CalendarEventKitMutationProfilerJSONEncoder.string(for: failure) {
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

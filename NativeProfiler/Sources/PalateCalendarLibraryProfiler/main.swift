import AppKit
import CalendarLibraryProfilerSupport
import Foundation

@main
struct PalateCalendarLibraryProfilerMain {
  static func main() async {
    await MainActor.run {
      _ = NSApplication.shared
      NSApp.setActivationPolicy(.accessory)
    }

    do {
      let arguments = try CalendarLibraryProfilerArguments(
        commandLineArguments: Array(CommandLine.arguments.dropFirst())
      )
      if arguments.showHelp {
        print(CalendarLibraryProfilerArguments.usage)
        return
      }

      let report = try await CalendarLibraryProfilerRunner().run(
        arguments: arguments
      )
      print(try CalendarLibraryProfilerJSONEncoder.string(for: report))
    } catch {
      let authorizationStatus: String?
      if case CalendarLibraryProfilerError.calendarAccessUnavailable(let status, _) = error {
        authorizationStatus = status
      } else {
        authorizationStatus = nil
      }
      let failure = CalendarLibraryProfilerFailureReport(
        errorType: String(reflecting: type(of: error)),
        message: error.localizedDescription,
        authorizationStatus: authorizationStatus
      )
      if let json = try? CalendarLibraryProfilerJSONEncoder.string(for: failure) {
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

import AppKit
import Foundation
import PhotosProfilerSupport

@main
struct PalatePhotosProfilerMain {
  static func main() async {
    await MainActor.run {
      _ = NSApplication.shared
      NSApp.setActivationPolicy(.accessory)
    }

    do {
      let arguments = try ProfilerArguments(commandLineArguments: Array(CommandLine.arguments.dropFirst()))
      if arguments.showHelp {
        print(ProfilerArguments.usage)
        return
      }

      let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.jonluca.palate.photos-profiler"
      let report = try await PhotosProfilerRunner().run(
        arguments: arguments,
        bundleIdentifier: bundleIdentifier
      )
      print(try ProfilerJSONEncoder.string(for: report))
    } catch {
      let authorizationStatus: String?
      if case PhotosProfilerError.photoLibraryAccessUnavailable(let status) = error {
        authorizationStatus = status
      } else {
        authorizationStatus = nil
      }

      let failure = ProfilerFailureReport(
        errorType: String(reflecting: type(of: error)),
        message: error.localizedDescription,
        authorizationStatus: authorizationStatus
      )
      if let json = try? ProfilerJSONEncoder.string(for: failure) {
        print(json)
      } else {
        print("{\"schemaVersion\":1,\"status\":\"error\",\"message\":\"Failed to encode profiler error\"}")
      }
      Foundation.exit(EXIT_FAILURE)
    }
  }
}

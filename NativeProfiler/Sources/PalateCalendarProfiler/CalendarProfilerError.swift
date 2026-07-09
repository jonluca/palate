import Foundation

enum CalendarProfilerError: Error, LocalizedError {
  case checksumChanged(strategy: String, expected: String, actual: String)
  case parityMismatch(
    optimizedChecksum: String, exhaustiveChecksum: String, firstDifference: String)

  var errorDescription: String? {
    switch self {
    case .checksumChanged(let strategy, let expected, let actual):
      return
        "\(strategy) checksum changed during measurement: expected \(expected), received \(actual)."
    case .parityMismatch(let optimizedChecksum, let exhaustiveChecksum, let firstDifference):
      return
        "Optimized and exhaustive results differ: \(optimizedChecksum) != \(exhaustiveChecksum). "
        + firstDifference
    }
  }
}

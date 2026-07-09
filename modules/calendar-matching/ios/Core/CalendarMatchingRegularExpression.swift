import Foundation

internal struct CalendarMatchingRegularExpression: @unchecked Sendable {
  private let expression: NSRegularExpression

  internal init(
    _ pattern: String,
    options: NSRegularExpression.Options = []
  ) {
    do {
      let compatiblePattern = pattern.replacingOccurrences(
        of: #"\s"#,
        with: CalendarJavaScriptWhitespace.regularExpressionCharacterClass
      )
      expression = try NSRegularExpression(pattern: compatiblePattern, options: options)
    } catch {
      preconditionFailure("Invalid calendar matching regular expression: \(pattern)")
    }
  }

  internal func replacingMatches(in value: String, with replacement: String = "") -> String {
    expression.stringByReplacingMatches(
      in: value,
      range: NSRange(value.startIndex..<value.endIndex, in: value),
      withTemplate: replacement
    )
  }

  internal func matches(_ value: String) -> Bool {
    expression.firstMatch(
      in: value,
      range: NSRange(value.startIndex..<value.endIndex, in: value)
    ) != nil
  }
}

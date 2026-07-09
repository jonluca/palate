import Foundation

struct ExhaustiveCalendarRegularExpression: @unchecked Sendable {
  private let expression: NSRegularExpression

  init(_ pattern: String, options: NSRegularExpression.Options = []) {
    let compatiblePattern = pattern.replacingOccurrences(
      of: #"\s"#,
      with: ExhaustiveCalendarJavaScriptWhitespace.regularExpressionCharacterClass
    )
    do {
      expression = try NSRegularExpression(pattern: compatiblePattern, options: options)
    } catch {
      preconditionFailure("Invalid exhaustive calendar regular expression: \(pattern)")
    }
  }

  func replacingMatches(in value: String, with replacement: String = "") -> String {
    expression.stringByReplacingMatches(
      in: value,
      range: NSRange(value.startIndex..<value.endIndex, in: value),
      withTemplate: replacement
    )
  }

  func matches(_ value: String) -> Bool {
    expression.firstMatch(
      in: value,
      range: NSRange(value.startIndex..<value.endIndex, in: value)
    ) != nil
  }
}

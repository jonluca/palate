import Foundation

enum ExhaustiveCalendarJavaScriptWhitespace {
  static let regularExpressionCharacterClass =
    #"[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]"#

  static func trim(_ value: String) -> String {
    let scalars = value.unicodeScalars
    var lower = scalars.startIndex
    var upper = scalars.endIndex

    while lower < upper, contains(scalars[lower].value) {
      lower = scalars.index(after: lower)
    }
    while lower < upper {
      let previous = scalars.index(before: upper)
      guard contains(scalars[previous].value) else {
        break
      }
      upper = previous
    }
    return String(scalars[lower..<upper])
  }

  private static func contains(_ value: UInt32) -> Bool {
    switch value {
    case 0x0009...0x000D,
      0x0020,
      0x00A0,
      0x1680,
      0x2000...0x200A,
      0x2028,
      0x2029,
      0x202F,
      0x205F,
      0x3000,
      0xFEFF:
      true
    default:
      false
    }
  }
}

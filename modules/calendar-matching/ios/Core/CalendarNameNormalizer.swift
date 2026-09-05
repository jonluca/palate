import Foundation

internal enum CalendarNameNormalizer {
  private static let emojiPattern = CalendarMatchingRegularExpression(
    #"\p{Emoji_Presentation}|\p{Extended_Pictographic}"#
  )
  private static let apostropheStylePattern = CalendarMatchingRegularExpression(#"['’`´ʼʻ]"#)
  private static let dashPattern = CalendarMatchingRegularExpression(#"[–—−‐‑‒―]"#)
  private static let ampersandPattern = CalendarMatchingRegularExpression(#"\s*&\s*"#)
  private static let possessivePattern = CalendarMatchingRegularExpression(
    #"'s(?=$|[^A-Za-z0-9_])"#)
  private static let apostrophePattern = CalendarMatchingRegularExpression("'")
  private static let nonASCIIWordPattern = CalendarMatchingRegularExpression(
    #"[^A-Za-z0-9_\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]"#
  )
  private static let whitespacePattern = CalendarMatchingRegularExpression(#"\s+"#)

  private static let deburredLetters: [UInt32: String] = {
    var replacements: [UInt32: String] = [:]

    func add(_ characters: String, replacement: String) {
      for scalar in characters.unicodeScalars {
        replacements[scalar.value] = replacement
      }
    }

    add("ÀÁÂÃÄÅĀĂĄ", replacement: "A")
    add("àáâãäåāăą", replacement: "a")
    add("ÇĆĈĊČ", replacement: "C")
    add("çćĉċč", replacement: "c")
    add("ÐĎĐ", replacement: "D")
    add("ðďđ", replacement: "d")
    add("ÈÉÊËĒĔĖĘĚ", replacement: "E")
    add("èéêëēĕėęě", replacement: "e")
    add("ĜĞĠĢ", replacement: "G")
    add("ĝğġģ", replacement: "g")
    add("ĤĦ", replacement: "H")
    add("ĥħ", replacement: "h")
    add("ÌÍÎÏĨĪĬĮİ", replacement: "I")
    add("ìíîïĩīĭįı", replacement: "i")
    add("Ĵ", replacement: "J")
    add("ĵ", replacement: "j")
    add("Ķ", replacement: "K")
    add("ķĸ", replacement: "k")
    add("ĹĻĽĿŁ", replacement: "L")
    add("ĺļľŀł", replacement: "l")
    add("ÑŃŅŇŊ", replacement: "N")
    add("ñńņňŋ", replacement: "n")
    add("ÒÓÔÕÖØŌŎŐ", replacement: "O")
    add("òóôõöøōŏő", replacement: "o")
    add("ŔŖŘ", replacement: "R")
    add("ŕŗř", replacement: "r")
    add("ŚŜŞŠ", replacement: "S")
    add("śŝşš", replacement: "s")
    add("ŢŤŦ", replacement: "T")
    add("ţťŧ", replacement: "t")
    add("ÙÚÛÜŨŪŬŮŰŲ", replacement: "U")
    add("ùúûüũūŭůűų", replacement: "u")
    add("Ŵ", replacement: "W")
    add("ŵ", replacement: "w")
    add("ÝŶŸ", replacement: "Y")
    add("ýÿŷ", replacement: "y")
    add("ŹŻŽ", replacement: "Z")
    add("źżž", replacement: "z")
    add("Æ", replacement: "Ae")
    add("æ", replacement: "ae")
    add("Þ", replacement: "Th")
    add("þ", replacement: "th")
    add("ß", replacement: "ss")
    add("Ĳ", replacement: "IJ")
    add("ĳ", replacement: "ij")
    add("Œ", replacement: "Oe")
    add("œ", replacement: "oe")
    add("ŉ", replacement: "'n")
    add("ſ", replacement: "s")

    return replacements
  }()

  internal static func normalize(_ value: String) -> String {
    if hasNormalizedASCIIWords(value) {
      return value.lowercased()
    }

    var result = deburr(value).lowercased()
    result = emojiPattern.replacingMatches(in: result)
    result = apostropheStylePattern.replacingMatches(in: result, with: "'")
    result = dashPattern.replacingMatches(in: result, with: " ")
    result = ampersandPattern.replacingMatches(in: result, with: " and ")
    result = possessivePattern.replacingMatches(in: result, with: "s")
    result = apostrophePattern.replacingMatches(in: result)
    result = nonASCIIWordPattern.replacingMatches(in: result, with: " ")
    result = whitespacePattern.replacingMatches(in: result, with: " ")
    return CalendarJavaScriptWhitespace.trim(result)
  }

  /// Plain words with single interior spaces only need case folding. Keep punctuation,
  /// Unicode, and whitespace cleanup on the full normalization path.
  private static func hasNormalizedASCIIWords(_ value: String) -> Bool {
    var previousWasSpace = true
    for byte in value.utf8 {
      switch byte {
      case 65...90, 97...122, 48...57, 95:
        previousWasSpace = false
      case 32:
        guard !previousWasSpace else {
          return false
        }
        previousWasSpace = true
      default:
        return false
      }
    }
    return !previousWasSpace
  }

  private static func deburr(_ value: String) -> String {
    var result = ""
    result.reserveCapacity(value.utf8.count)

    for scalar in value.unicodeScalars {
      if let replacement = deburredLetters[scalar.value] {
        result.append(contentsOf: replacement)
      } else if isCombiningMark(scalar.value) {
        continue
      } else {
        result.unicodeScalars.append(scalar)
      }
    }

    return result
  }

  private static func isCombiningMark(_ value: UInt32) -> Bool {
    (0x0300...0x036F).contains(value) || (0xFE20...0xFE2F).contains(value)
      || (0x20D0...0x20FF).contains(value)
  }
}

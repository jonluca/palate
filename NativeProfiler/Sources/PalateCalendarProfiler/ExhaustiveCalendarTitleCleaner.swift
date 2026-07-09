import Foundation

enum ExhaustiveCalendarTitleCleaner {
  private static let dashPattern = ExhaustiveCalendarRegularExpression(#"[–—−‐‑‒―-]"#)
  private static let whitespacePattern = ExhaustiveCalendarRegularExpression(#"\s+"#)

  private static let titlePrefixes = expressions([
    #"^resevervation\s+(at|for|@)\s+"#,
    #"^reservation\s+(at|for|@)\s+"#,
    #"^booking\s+appointment\s+(at|for|@)\s+"#,
    #"^resy\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^opentable\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^yelp\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^tock\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^seated\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^bookatable\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^quandoo\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^the\s+fork\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^exploretock\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^sevenrooms\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^tripleseat\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^tablein\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^eat\s*app\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?"#,
    #"^via\s+(resy|opentable|tock|yelp)\s*[-:@]?\s*"#,
    #"^(dinner|lunch|brunch|breakfast|supper|tea|coffee|happy\s*hour|drinks|appetizers)\s+(at|@)\s+"#,
    #"^(dinner|lunch|brunch|breakfast|supper)\s+reservation\s+(at|for|@)?\s*"#,
    #"^(date\s*night|anniversary|birthday|celebration|celebrate|party)\s+(at|@)\s+"#,
    #"^(date\s*night|anniversary|birthday|celebration)\s+dinner\s+(at|@)?\s*"#,
    #"^[0-9]{1,2}:?[0-9]{0,2}\s*(am|pm)?\s+(at|@)\s+"#,
    #"^(eating\s+)?at\s+"#,
    #"^(going\s+to|meet\s+at|meeting\s+at|dining\s+at)\s+"#,
    #"^meal\s+(at|@)\s+"#,
    #"^table\s+(at|for|@)\s+"#,
    #"^booking\s+(at|for|@)\s+"#,
    #"^your\s+(reservation|table|booking)\s+(at|for|@)\s+"#,
    #"^ticket:\s+"#,
    #"^reservation\s*:\s+"#,
    #"^confirmation\s*:\s+"#,
    #"^confirmed\s*:\s+"#,
    #"^booking\s*:\s+"#,
    #"^reminder\s*:\s+"#,
    #"^don'?t\s+forget\s*:\s+"#,
    #"^event\s+(at|@)\s+"#,
    #"^upcoming reservation (at|for|@)\s+"#,
    #"^reservation\s+(at|for|@)\s+"#,
    #"^dinner\s*\|"#,
    #"^cena\s*\|"#,
    #"^(pranzo|almuerzo|déjeuner|mittagessen|almoço)\s+(at|@|a|à|en|bei|em)?\s*"#,
    #"^(cena|comida|dîner|abendessen|jantar)\s+(at|@|a|à|en|bei|em)?\s*"#,
    #"^(colazione|desayuno|petit\s*déjeuner|frühstück|café\s*da\s*manhã)\s+(at|@|a|à|en|bei|em)?\s*"#,
    #"^[🍴🍕🍔🍣🍜🥘🍝🍲🥗🍛🍱🥡🍷🍺🍸🥂🍾☕🍵🍽]\s*"#,
  ])

  private static let titleSuffixes = expressions([
    #"\s*[-–—]\s*[0-9]+\s*(people|guests|pax|persons?)$"#,
    #"\s*[-–—]\s*table\s+for\s+[0-9]+$"#,
    #"\s*[-–—]\s*party\s+of\s+[0-9]+$"#,
    #"\s*\([0-9]+\s*(people|guests|pax|persons?)\)$"#,
    #"\s*\(party\s+of\s+[0-9]+\)$"#,
    #"\s*\(table\s+for\s+[0-9]+\)$"#,
    #"\s*\(for\s+[0-9]+\)$"#,
    #"\s*for\s+[0-9]+$"#,
    #"\s*(dinner|lunch|brunch|cena|breakfast|supper)\s*$"#,
    #"\s*[-–—]\s*(confirmed|pending|waitlist|wait\s*list)$"#,
    #"\s*\((confirmed|pending|waitlist|wait\s*list)\)$"#,
    #"\s*[-–—]\s*[0-9]{1,2}:[0-9]{2}\s*(am|pm)?$"#,
    #"\s*@\s*[0-9]{1,2}:[0-9]{2}\s*(am|pm)?$"#,
    #"\s*on\s+[A-Za-z0-9_]+\s*,\s*[A-Za-z0-9_]+\s+[0-9]{1,2}(st|nd|rd|th)?\s*,\s*[0-9]{4}\s*,?\s*[0-9]{1,2}:[0-9]{2}\s*(AM|PM)?$"#,
    #"\s*[-–—]\s*[0-9]{1,2}/[0-9]{1,2}(/[0-9]{2,4})?$"#,
    #"\s*[-–—]\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[A-Za-z0-9_]*\s+[0-9]{1,2}(st|nd|rd|th)?$"#,
    #"\s*\((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[A-Za-z0-9_]*\s+[0-9]{1,2}(st|nd|rd|th)?\)$"#,
    #"\s*[-–—]\s*(conf|confirmation)\s*#?\s*[A-Za-z0-9_]+$"#,
    #"\s*\(confirmation\s*:?\s*[A-Za-z0-9_]+\)$"#,
    #"\s*\(reservation\s*:?\s*[A-Za-z0-9_]+\)$"#,
    #"\s*\(booking\s*:?\s*[A-Za-z0-9_]+\)$"#,
    #"\s*#\s*[A-Za-z0-9_]{4,}$"#,
    #"\s*[-–—]\s*w/?\s+[A-Za-z0-9_]+.*$"#,
    #"\s*[-–—]\s*with\s+[A-Za-z0-9_]+.*$"#,
    #"\s*\(w/?\s+[A-Za-z0-9_]+.*\)$"#,
    #"\s*\(with\s+[A-Za-z0-9_]+.*\)$"#,
    #"\s*[-–—]\s*via\s+(resy|opentable|tock|yelp|thefork)$"#,
    #"\s*\(via\s+(resy|opentable|tock|yelp|thefork)\)$"#,
    #"\s*\((resy|opentable|tock|yelp|thefork)\)$"#,
    #"\s*[-–—]\s*(downtown|midtown|uptown|westside|eastside)$"#,
    #"\s*[-–—]\s*(main|flagship|original)\s*(location|branch)?$"#,
    #"\s+reservation$"#,
    #"\s+booking$"#,
  ])

  private static let descriptorTerms = [
    #"wine\s+bar"#,
    #"cocktail\s+bar"#,
    #"steak\s?house"#,
    "restaurant", "gourmet", "cafe", "café", "bar", "bistro", "kitchen", "grill",
    "company", "brewing", "house", "japanese", "farm", "inn", "room", "place",
    "experience", "eatery", "dining", "tavern", "pub", "pizzeria", "trattoria", "osteria",
    "ristorante", "brasserie", "chophouse", "seafood", "sushi", "ramen", "izakaya",
    "taqueria", "cantina", "bodega", "diner", "lounge", "gastropub", "bakery", "patisserie",
    "delicatessen", "deli", "creamery", "rooftop", "terrace", "garden", "spot", "joint",
    "shack", "club",
  ]

  private static let comparisonSuffixes: [ExhaustiveCalendarRegularExpression] = {
    let descriptors = descriptorTerms.joined(separator: "|")
    return expressions([
      "\\s+(?:\(descriptors))(?:\\s+(?:(?:and|&|/)\\s+)?(?:\(descriptors)))*\\s*$",
      #"\s+(nyc|la|sf|london|dc|atl|chi|bos|sea|pdx|phx|den|mia|dal|hou|austin)\s*$"#,
      #"^the\s+"#,
    ])
  }()

  private static let comparisonPrefixes = expressions([
    #"^reservation\s+(at|for|@)\s+"#,
    #"^upcoming reservation (at|for|@)\s+"#,
    #"^reservation\s*:\s+"#,
    #"^the\s+(dining room|dining hall|experience|kitchen table|table)?\s*(at)?\s*:?\s*"#,
    #"^restaurant\s*:?\s*"#,
    #"^bar\s*:?\s*"#,
    #"^confirmation\s*:?\s+"#,
    #"^booking\s*:?\s+"#,
    #"^confirmed\s*:?\s+"#,
    #"^dinner\s*(at|@)?\s+"#,
    #"^lunch\s*(at|@)?\s+"#,
    #"^brunch\s*(at|@)\s+"#,
    #"^breakfast\s*(at|@)?\s+"#,
    #"^supper\s+(at|@)\s+"#,
    #"^meal\s+(at|@)\s+"#,
    #"^table\s*(at|for|@)?\s+"#,
    #"^eating\s+(at|@)\s+"#,
    #"^dining\s+(at|@)\s+"#,
    #"^visit\s+to\s+"#,
    #"^going\s+to\s+"#,
    #"^meet(ing)?\s+(at|@)\s+"#,
    #"^date\s+(at|@)\s+"#,
    #"^date\s+night\s+(at|@)\s+"#,
    #"^anniversary\s+(at|@)\s+"#,
    #"^birthday\s+(at|@)\s+"#,
    #"^celebration\s+(at|@)\s+"#,
    #"^the\s+"#,
    #"^resy\s*[-:@]?\s*"#,
    #"^opentable\s*[-:@]?\s*"#,
    #"^tock\s*[-:@]?\s*"#,
    #"^yelp\s*[-:@]?\s*"#,
    #"^via\s+(resy|opentable|tock|yelp)\s*[-:@]?\s*"#,
  ])

  static func cleanEventTitle(_ title: String) -> String {
    guard !title.isEmpty else {
      return ""
    }
    var result = normalizeSpacing(title)
    var previous: String
    repeat {
      previous = result
      for expression in titlePrefixes {
        result = expression.replacingMatches(in: result)
      }
      for expression in titleSuffixes {
        result = expression.replacingMatches(in: result)
      }
      result = ExhaustiveCalendarJavaScriptWhitespace.trim(result)
    } while result != previous
    return result
  }

  static func stripComparisonAffixes(_ value: String) -> String {
    var result = normalizeSpacing(value)
    var previous: String
    repeat {
      previous = result
      for expression in comparisonPrefixes {
        result = expression.replacingMatches(in: result)
      }
      for expression in comparisonSuffixes {
        result = expression.replacingMatches(in: result)
      }
      result = ExhaustiveCalendarJavaScriptWhitespace.trim(result)
    } while result != previous
    return result
  }

  private static func normalizeSpacing(_ value: String) -> String {
    let trimmed = ExhaustiveCalendarJavaScriptWhitespace.trim(value)
    let withoutDashes = dashPattern.replacingMatches(in: trimmed, with: " ")
    return whitespacePattern.replacingMatches(in: withoutDashes, with: " ")
  }

  private static func expressions(_ patterns: [String]) -> [ExhaustiveCalendarRegularExpression] {
    patterns.map { ExhaustiveCalendarRegularExpression($0, options: [.caseInsensitive]) }
  }
}

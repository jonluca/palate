import Foundation

public enum ProfilerJSONEncoder {
  public static func string<T: Encodable>(for value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(value)
    guard let string = String(data: data, encoding: .utf8) else {
      throw ProfilerJSONEncoderError.invalidUTF8
    }
    return string
  }
}

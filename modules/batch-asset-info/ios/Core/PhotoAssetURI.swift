import Foundation

public enum PhotoAssetURI {
  public static let schemePrefix = "ph://"

  public static func localIdentifier(from uri: String) -> String? {
    guard uri.hasPrefix(schemePrefix) else {
      return nil
    }

    let identifier = String(uri.dropFirst(schemePrefix.count))
    return identifier.isEmpty ? nil : identifier
  }
}

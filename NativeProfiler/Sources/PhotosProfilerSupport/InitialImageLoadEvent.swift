import Foundation

enum InitialImageLoadEvent: Sendable {
  case image(identifier: String, pixelWidth: Int, pixelHeight: Int, isDegraded: Bool)
  case failure(identifier: String, code: String)
}

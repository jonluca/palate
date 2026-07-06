import Foundation

public enum InitialImageStrategy: String, Encodable, Equatable, Sendable {
  case currentPerItemRefetch
  case batchedThumbnailStore
}

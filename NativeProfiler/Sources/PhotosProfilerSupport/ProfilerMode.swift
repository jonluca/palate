import Foundation

public enum ProfilerMode: String, Encodable, Equatable, Sendable {
  case photos
  case vision
  case initialImages = "initial-images"
}

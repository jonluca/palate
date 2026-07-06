import Foundation

public enum PhotosProfilerError: Error, Equatable, Sendable {
  case photoLibraryAccessUnavailable(status: String)
}

extension PhotosProfilerError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .photoLibraryAccessUnavailable(let status):
      return "Photos access is required to profile the library (authorization status: \(status))"
    }
  }
}

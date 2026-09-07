import Foundation

/// Coalesces ordered history while allowing an identifier deleted and later restored to reappear.
struct PhotoLibraryAssetChanges: Equatable, Sendable {
  private(set) var candidateIdentifiers: Set<String> = []

  mutating func apply(inserted: Set<String>, updated: Set<String>, deleted: Set<String>) {
    candidateIdentifiers.formUnion(inserted)
    candidateIdentifiers.formUnion(updated)
    candidateIdentifiers.subtract(deleted)
  }
}

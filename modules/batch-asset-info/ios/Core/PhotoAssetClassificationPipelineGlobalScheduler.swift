import Foundation

struct PhotoAssetClassificationPipelineGlobalScheduler: Sendable {
  private(set) var activeSessionID: UUID?
  private(set) var pendingSessionIDs: [UUID] = []

  mutating func enqueue(sessionID: UUID) -> UUID? {
    guard activeSessionID == nil else {
      pendingSessionIDs.append(sessionID)
      return nil
    }
    activeSessionID = sessionID
    return sessionID
  }

  mutating func finish(sessionID: UUID) -> UUID? {
    guard activeSessionID == sessionID else {
      return nil
    }
    activeSessionID = pendingSessionIDs.isEmpty ? nil : pendingSessionIDs.removeFirst()
    return activeSessionID
  }

  mutating func cancel(sessionIDs: Set<UUID>) -> (
    activeSessionID: UUID?,
    pendingSessionIDs: [UUID]
  ) {
    let activeCancellation = activeSessionID.flatMap { sessionIDs.contains($0) ? $0 : nil }
    let pendingCancellations = pendingSessionIDs.filter(sessionIDs.contains)
    pendingSessionIDs.removeAll(where: sessionIDs.contains)
    return (activeCancellation, pendingCancellations)
  }
}

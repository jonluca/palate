import Foundation

final class PhotoAssetClassificationPipelineCoordinator: @unchecked Sendable {
  static let shared = PhotoAssetClassificationPipelineCoordinator()

  private let stateQueue = DispatchQueue(
    label: "com.jonluca.palate.photo-classification-pipeline.global-sessions",
    qos: .userInitiated
  )
  private var scheduler = PhotoAssetClassificationPipelineGlobalScheduler()
  private var sessions: [UUID: PhotoAssetClassificationPipelineSession] = [:]

  private init() {}

  func enqueue(_ session: PhotoAssetClassificationPipelineSession) {
    stateQueue.async { [self] in
      sessions[session.id] = session
      guard scheduler.enqueue(sessionID: session.id) != nil else {
        return
      }
      session.start()
    }
  }

  func cancelSessions(ownerID: UUID) {
    stateQueue.async { [self] in
      let ownedSessionIDs = Set(
        sessions.values.lazy.filter { $0.ownerID == ownerID }.map(\.id)
      )
      let cancellations = scheduler.cancel(sessionIDs: ownedSessionIDs)

      for sessionID in cancellations.pendingSessionIDs {
        sessions.removeValue(forKey: sessionID)?.cancel(suppressCompletion: true)
      }
      if let activeSessionID = cancellations.activeSessionID {
        sessions[activeSessionID]?.cancel(suppressCompletion: true)
      }
    }
  }

  func sessionDidFinish(id: UUID) {
    stateQueue.async { [self] in
      sessions.removeValue(forKey: id)
      guard let nextSessionID = scheduler.finish(sessionID: id) else {
        return
      }
      sessions[nextSessionID]?.start()
    }
  }
}

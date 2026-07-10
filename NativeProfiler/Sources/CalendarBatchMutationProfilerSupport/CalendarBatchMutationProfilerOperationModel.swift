import Foundation

public struct CalendarBatchMutationProfilerOperationModel: Encodable, Equatable, Sendable {
  public struct Phase: Encodable, Equatable, Sendable {
    public let mutationItems: Int
    public let jsToNativeCalls: Int
    public let authorizationChecks: Int
    public let eventKitCommitUpperBound: Int
    public let observedSyntheticEventKitCommits: Int

    fileprivate static func combined(_ first: Phase, _ second: Phase) -> Phase {
      Phase(
        mutationItems: first.mutationItems + second.mutationItems,
        jsToNativeCalls: first.jsToNativeCalls + second.jsToNativeCalls,
        authorizationChecks: first.authorizationChecks + second.authorizationChecks,
        eventKitCommitUpperBound: first.eventKitCommitUpperBound
          + second.eventKitCommitUpperBound,
        observedSyntheticEventKitCommits: first.observedSyntheticEventKitCommits
          + second.observedSyntheticEventKitCommits
      )
    }
  }

  public struct Strategy: Encodable, Equatable, Sendable {
    public let create: Phase
    public let delete: Phase
    public let combined: Phase
  }

  public let currentJavaScriptOrchestration: Strategy
  public let nativeSingleCallOrchestration: Strategy
  public let eventKitCommitUpperBoundReduction: Int

  public static func make(
    itemCount: Int,
    observedCreateCommits: Int,
    observedDeleteCommits: Int
  ) -> CalendarBatchMutationProfilerOperationModel {
    precondition(itemCount >= 0)
    precondition(observedCreateCommits >= 0 && observedCreateCommits <= itemCount)
    precondition(observedDeleteCommits >= 0 && observedDeleteCommits <= itemCount)

    let currentCreate = Phase(
      mutationItems: itemCount,
      jsToNativeCalls: itemCount * 2,
      authorizationChecks: itemCount * 2,
      eventKitCommitUpperBound: itemCount,
      observedSyntheticEventKitCommits: observedCreateCommits
    )
    let currentDelete = Phase(
      mutationItems: itemCount,
      jsToNativeCalls: itemCount * 2,
      authorizationChecks: itemCount * 2,
      eventKitCommitUpperBound: itemCount,
      observedSyntheticEventKitCommits: observedDeleteCommits
    )
    let nativeCreate = Phase(
      mutationItems: itemCount,
      jsToNativeCalls: itemCount == 0 ? 0 : 1,
      authorizationChecks: itemCount == 0 ? 0 : 1,
      eventKitCommitUpperBound: itemCount == 0 ? 0 : 1,
      observedSyntheticEventKitCommits: observedCreateCommits == 0 ? 0 : 1
    )
    let nativeDelete = Phase(
      mutationItems: itemCount,
      jsToNativeCalls: itemCount == 0 ? 0 : 1,
      authorizationChecks: itemCount == 0 ? 0 : 1,
      eventKitCommitUpperBound: itemCount == 0 ? 0 : 1,
      observedSyntheticEventKitCommits: observedDeleteCommits == 0 ? 0 : 1
    )
    let current = Strategy(
      create: currentCreate,
      delete: currentDelete,
      combined: Phase.combined(currentCreate, currentDelete)
    )
    let native = Strategy(
      create: nativeCreate,
      delete: nativeDelete,
      combined: Phase.combined(nativeCreate, nativeDelete)
    )

    return CalendarBatchMutationProfilerOperationModel(
      currentJavaScriptOrchestration: current,
      nativeSingleCallOrchestration: native,
      eventKitCommitUpperBoundReduction: current.combined.eventKitCommitUpperBound
        - native.combined.eventKitCommitUpperBound
    )
  }
}

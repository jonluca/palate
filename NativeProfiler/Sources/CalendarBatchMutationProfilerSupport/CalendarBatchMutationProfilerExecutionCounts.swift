import Foundation

struct CalendarBatchMutationProfilerExecutionCounts: Equatable, Sendable {
  struct Phase: Equatable, Sendable {
    var mutationItems = 0
    var jsToNativeCalls = 0
    var authorizationChecks = 0
    var eventKitCommits = 0
  }

  var create = Phase()
  var delete = Phase()
}

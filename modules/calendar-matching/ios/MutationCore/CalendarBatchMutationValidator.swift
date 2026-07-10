public enum CalendarBatchMutationValidator {
  public static func validateUniqueRequestIDs(_ requestIDs: [String]) throws {
    var seenRequestIDs: Set<String> = []
    seenRequestIDs.reserveCapacity(requestIDs.count)
    for requestID in requestIDs where !seenRequestIDs.insert(requestID).inserted {
      throw CalendarBatchMutationValidationError.duplicateRequestID(requestID)
    }
  }
}

import Foundation

struct InitialImagePreheatSamplePlan: Sendable {
  struct Assignment: Sendable {
    let leadIdentifiers: [String]
    let targetIdentifiers: [String]
    let position: InitialImageSamplePosition
  }

  struct Pair: Sendable {
    let imageCount: Int
    let iteration: Int
    let control: Assignment
    let candidate: Assignment
    let executeCandidateFirst: Bool
  }

  let pairs: [Pair]
  let sampledIdentifierCount: Int
  let sampledIdentifierDigest: String

  init(identifiers: [String], imageCounts: [Int], iterations: Int) throws {
    let requiredIdentifierCount = try Self.requiredIdentifierCount(
      imageCounts: imageCounts,
      iterations: iterations
    )
    guard identifiers.count >= requiredIdentifierCount else {
      throw InitialImageBenchmarkError.insufficientImageAssets(
        required: requiredIdentifierCount,
        available: identifiers.count
      )
    }

    let sampledIdentifiers = Array(identifiers.prefix(requiredIdentifierCount))
    guard Set(sampledIdentifiers).count == sampledIdentifiers.count else {
      throw InitialImageBenchmarkError.duplicateAssetIdentifier
    }

    var nextIndex = 0
    var pairs: [Pair] = []
    for imageCount in imageCounts {
      for zeroBasedIteration in 0..<iterations {
        let earlier = Assignment(
          leadIdentifiers: Self.take(
            imageCount,
            from: sampledIdentifiers,
            nextIndex: &nextIndex
          ),
          targetIdentifiers: Self.take(
            imageCount,
            from: sampledIdentifiers,
            nextIndex: &nextIndex
          ),
          position: .earlier
        )
        let later = Assignment(
          leadIdentifiers: Self.take(
            imageCount,
            from: sampledIdentifiers,
            nextIndex: &nextIndex
          ),
          targetIdentifiers: Self.take(
            imageCount,
            from: sampledIdentifiers,
            nextIndex: &nextIndex
          ),
          position: .later
        )

        let candidateUsesEarlierWindow = !zeroBasedIteration.isMultiple(of: 2)
        // A four-run rotation visits every candidate-recency by execution-order combination.
        let orderPosition = zeroBasedIteration % 4
        let executeCandidateFirst = orderPosition == 1 || orderPosition == 2
        pairs.append(
          Pair(
            imageCount: imageCount,
            iteration: zeroBasedIteration + 1,
            control: candidateUsesEarlierWindow ? later : earlier,
            candidate: candidateUsesEarlierWindow ? earlier : later,
            executeCandidateFirst: executeCandidateFirst
          )
        )
      }
    }

    var digest = StableIdentifierDigest()
    for identifier in sampledIdentifiers {
      digest.add(identifier)
    }
    self.pairs = pairs
    sampledIdentifierCount = sampledIdentifiers.count
    sampledIdentifierDigest = digest.signature
  }

  static func requiredIdentifierCount(imageCounts: [Int], iterations: Int) throws -> Int {
    var imagesPerIteration = 0
    for count in imageCounts {
      let addition = imagesPerIteration.addingReportingOverflow(count)
      guard !addition.overflow else {
        throw InitialImageBenchmarkError.sampleSizeOverflow
      }
      imagesPerIteration = addition.partialValue
    }

    let iterationProduct = imagesPerIteration.multipliedReportingOverflow(by: iterations)
    guard !iterationProduct.overflow else {
      throw InitialImageBenchmarkError.sampleSizeOverflow
    }
    let windowProduct = iterationProduct.partialValue.multipliedReportingOverflow(by: 4)
    guard !windowProduct.overflow else {
      throw InitialImageBenchmarkError.sampleSizeOverflow
    }
    return windowProduct.partialValue
  }

  private static func take(
    _ count: Int,
    from identifiers: [String],
    nextIndex: inout Int
  ) -> [String] {
    let endIndex = nextIndex + count
    let result = Array(identifiers[nextIndex..<endIndex])
    nextIndex = endIndex
    return result
  }
}

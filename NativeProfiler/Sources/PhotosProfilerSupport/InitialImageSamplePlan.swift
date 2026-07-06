import Foundation

struct InitialImageSamplePlan: Sendable {
  struct Assignment: Sendable {
    let identifiers: [String]
    let position: InitialImageSamplePosition
  }

  struct Pair: Sendable {
    let imageCount: Int
    let iteration: Int
    let baseline: Assignment
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
    pairs.reserveCapacity(imageCounts.count * iterations)
    for imageCount in imageCounts {
      for zeroBasedIteration in 0..<iterations {
        let first = Array(sampledIdentifiers[nextIndex..<(nextIndex + imageCount)])
        nextIndex += imageCount
        let second = Array(sampledIdentifiers[nextIndex..<(nextIndex + imageCount)])
        nextIndex += imageCount

        let baseline: Assignment
        let candidate: Assignment
        if zeroBasedIteration.isMultiple(of: 2) {
          baseline = Assignment(identifiers: first, position: .earlier)
          candidate = Assignment(identifiers: second, position: .later)
        } else {
          baseline = Assignment(identifiers: second, position: .later)
          candidate = Assignment(identifiers: first, position: .earlier)
        }

        pairs.append(
          Pair(
            imageCount: imageCount,
            iteration: zeroBasedIteration + 1,
            baseline: baseline,
            candidate: candidate,
            executeCandidateFirst: !zeroBasedIteration.isMultiple(of: 2)
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
    let strategyProduct = iterationProduct.partialValue.multipliedReportingOverflow(by: 2)
    guard !strategyProduct.overflow else {
      throw InitialImageBenchmarkError.sampleSizeOverflow
    }
    return strategyProduct.partialValue
  }
}

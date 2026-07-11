import Foundation

public struct PhotoAssetClassificationPackedResultV1Encoder: Sendable {
  public static let magic: [UInt8] = [0x50, 0x56, 0x43, 0x31]
  public static let schemaVersion: UInt16 = 1
  public static let headerByteLength = 20

  public enum EncodingError: Error, Equatable, LocalizedError {
    case invalidDuplicateStatus(assetId: String, slotIndex: Int)
    case nonFiniteConfidence(assetId: String, labelIndex: Int)
    case payloadTooLarge
    case tooManyLabels(assetId: String, count: Int)
    case tooManySlots
    case tooManyStrings

    public var errorDescription: String? {
      switch self {
      case .invalidDuplicateStatus(let assetId, let slotIndex):
        "Photo classification slot \(slotIndex) has an invalid duplicate status for \(assetId)."
      case .nonFiniteConfidence(let assetId, let labelIndex):
        "Photo classification for \(assetId) has a non-finite confidence at label \(labelIndex)."
      case .payloadTooLarge:
        "Packed photo classification result exceeds the V1 byte-length limit."
      case .tooManyLabels(let assetId, let count):
        "Photo classification for \(assetId) has \(count) labels, exceeding the V1 limit."
      case .tooManySlots:
        "Packed photo classification result contains too many request slots."
      case .tooManyStrings:
        "Packed photo classification result contains too many unique strings."
      }
    }
  }

  private enum EncodedBody {
    case missing
    case success(labels: [(stringIndex: UInt32, confidenceBits: UInt32)])
    case failure(errorStringIndex: UInt32)
    case duplicate

    var status: UInt8 {
      switch self {
      case .missing:
        0
      case .success:
        1
      case .failure:
        2
      case .duplicate:
        3
      }
    }
  }

  private struct EncodedSlot {
    let assetStringIndex: UInt32
    let body: EncodedBody
  }

  private struct StringTable {
    var values: [Data] = []
    var indexByBytes: [Data: UInt32] = [:]

    mutating func intern(_ value: String) throws -> UInt32 {
      // Swift String equality folds canonical Unicode equivalents. The legacy bridge
      // preserves their original scalar sequences, so intern exact UTF-8 bytes instead.
      let bytes = Data(value.utf8)
      if let existing = indexByBytes[bytes] {
        return existing
      }
      guard let index = UInt32(exactly: values.count) else {
        throw EncodingError.tooManyStrings
      }
      values.append(bytes)
      indexByBytes[bytes] = index
      return index
    }
  }

  public static func encode(_ slots: [PhotoAssetClassificationBatchSlot]) throws -> Data {
    guard let slotCount = UInt32(exactly: slots.count) else {
      throw EncodingError.tooManySlots
    }

    var stringTable = StringTable()
    var encodedSlots: [EncodedSlot] = []
    encodedSlots.reserveCapacity(slots.count)
    var encounteredAssetStringIndices = Set<UInt32>()
    encounteredAssetStringIndices.reserveCapacity(slots.count)
    for (slotIndex, slot) in slots.enumerated() {
      let assetStringIndex = try stringTable.intern(slot.assetId)
      let isDuplicate = !encounteredAssetStringIndices.insert(assetStringIndex).inserted
      let hasDuplicateStatus: Bool
      if case .duplicate = slot {
        hasDuplicateStatus = true
      } else {
        hasDuplicateStatus = false
      }
      if isDuplicate != hasDuplicateStatus {
        throw EncodingError.invalidDuplicateStatus(
          assetId: slot.assetId,
          slotIndex: slotIndex
        )
      }
      let body: EncodedBody
      switch slot {
      case .missing:
        body = .missing
      case .duplicate:
        body = .duplicate
      case .failure(_, let message):
        body = .failure(errorStringIndex: try stringTable.intern(message))
      case .success(let classification):
        guard classification.labels.count <= Int(UInt16.max) else {
          throw EncodingError.tooManyLabels(
            assetId: classification.assetId,
            count: classification.labels.count
          )
        }
        var labels: [(stringIndex: UInt32, confidenceBits: UInt32)] = []
        labels.reserveCapacity(classification.labels.count)
        for (labelIndex, label) in classification.labels.enumerated() {
          guard label.confidence.isFinite else {
            throw EncodingError.nonFiniteConfidence(
              assetId: classification.assetId,
              labelIndex: labelIndex
            )
          }
          labels.append(
            (
              stringIndex: try stringTable.intern(label.identifier),
              confidenceBits: label.confidence.bitPattern
            ))
        }
        body = .success(labels: labels)
      }
      encodedSlots.append(EncodedSlot(assetStringIndex: assetStringIndex, body: body))
    }

    guard let stringCount = UInt32(exactly: stringTable.values.count) else {
      throw EncodingError.tooManyStrings
    }
    var totalByteLength = headerByteLength
    for bytes in stringTable.values {
      guard let byteLength = UInt32(exactly: bytes.count) else {
        throw EncodingError.payloadTooLarge
      }
      try addV1ByteLength(4, to: &totalByteLength)
      try addV1ByteLength(Int(byteLength), to: &totalByteLength)
    }
    for slot in encodedSlots {
      try addV1ByteLength(5, to: &totalByteLength)
      switch slot.body {
      case .missing, .duplicate:
        break
      case .failure:
        try addV1ByteLength(4, to: &totalByteLength)
      case .success(let labels):
        try addV1ByteLength(2 + labels.count * 8, to: &totalByteLength)
      }
    }
    guard let totalByteLengthV1 = UInt32(exactly: totalByteLength) else {
      throw EncodingError.payloadTooLarge
    }

    var data = Data(capacity: totalByteLength)
    data.append(contentsOf: magic)
    appendUInt16(schemaVersion, to: &data)
    appendUInt16(0, to: &data)
    appendUInt32(totalByteLengthV1, to: &data)
    appendUInt32(slotCount, to: &data)
    appendUInt32(stringCount, to: &data)
    for bytes in stringTable.values {
      appendUInt32(UInt32(bytes.count), to: &data)
      data.append(bytes)
    }
    for slot in encodedSlots {
      appendUInt32(slot.assetStringIndex, to: &data)
      data.append(slot.body.status)
      switch slot.body {
      case .missing, .duplicate:
        break
      case .failure(let errorStringIndex):
        appendUInt32(errorStringIndex, to: &data)
      case .success(let labels):
        appendUInt16(UInt16(labels.count), to: &data)
        for label in labels {
          appendUInt32(label.stringIndex, to: &data)
          appendUInt32(label.confidenceBits, to: &data)
        }
      }
    }
    guard data.count == totalByteLength else {
      throw EncodingError.payloadTooLarge
    }
    return data
  }

  private static func addV1ByteLength(_ increment: Int, to byteLength: inout Int) throws {
    let (nextByteLength, overflow) = byteLength.addingReportingOverflow(increment)
    guard !overflow, UInt32(exactly: nextByteLength) != nil else {
      throw EncodingError.payloadTooLarge
    }
    byteLength = nextByteLength
  }

  private static func appendUInt16(_ value: UInt16, to data: inout Data) {
    var littleEndianValue = value.littleEndian
    withUnsafeBytes(of: &littleEndianValue) { bytes in
      data.append(contentsOf: bytes)
    }
  }

  private static func appendUInt32(_ value: UInt32, to data: inout Data) {
    var littleEndianValue = value.littleEndian
    withUnsafeBytes(of: &littleEndianValue) { bytes in
      data.append(contentsOf: bytes)
    }
  }
}

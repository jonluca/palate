import Foundation
import Testing

@testable import BatchAssetInfoCore

@Suite("Photo classification packed result V1")
struct PhotoAssetClassificationPackedResultV1Tests {
  private struct ParsedSlot {
    let assetStringIndex: UInt32
    let status: UInt8
    let labelStringIndices: [UInt32]
    let confidenceBits: [UInt32]
    let errorStringIndex: UInt32?
  }

  private struct ParsedPayload {
    let magic: [UInt8]
    let schemaVersion: UInt16
    let reserved: UInt16
    let declaredByteLength: UInt32
    let slotCount: UInt32
    let stringCount: UInt32
    let stringBytes: [[UInt8]]
    let slots: [ParsedSlot]
    let consumedByteLength: Int
  }

  private struct ByteCursor {
    let bytes: [UInt8]
    var offset = 0

    mutating func readByte() -> UInt8 {
      precondition(offset < bytes.count)
      defer { offset += 1 }
      return bytes[offset]
    }

    mutating func readBytes(count: Int) -> [UInt8] {
      precondition(count >= 0 && offset + count <= bytes.count)
      defer { offset += count }
      return Array(bytes[offset..<(offset + count)])
    }

    mutating func readUInt16() -> UInt16 {
      let raw = readBytes(count: 2)
      return UInt16(raw[0]) | (UInt16(raw[1]) << 8)
    }

    mutating func readUInt32() -> UInt32 {
      let raw = readBytes(count: 4)
      return UInt32(raw[0])
        | (UInt32(raw[1]) << 8)
        | (UInt32(raw[2]) << 16)
        | (UInt32(raw[3]) << 24)
    }
  }

  @Test("Slot construction retains request order and legacy outcome semantics")
  func slotConstruction() throws {
    let firstDuplicateOutcome = PhotoAssetClassification(
      assetId: "duplicate",
      labels: [PhotoAssetClassificationLabel(identifier: "first", confidence: 0.75)]
    )
    let emptySuccess = PhotoAssetClassification(assetId: "empty-success", labels: [])
    let slots = PhotoAssetClassificationBatchSlot.make(
      requestedAssetIds: [
        "ordered-success",
        "missing",
        "duplicate",
        "duplicate",
        "failure",
        "empty-success",
      ],
      outcomes: [
        .failure(assetId: "unknown", message: "must be ignored"),
        .success(PhotoAssetClassification(assetId: "ordered-success", labels: [])),
        .success(firstDuplicateOutcome),
        .failure(assetId: "duplicate", message: "later outcome must be ignored"),
        .failure(assetId: "failure", message: "failed"),
        .success(emptySuccess),
      ]
    )

    #expect(
      slots.map(\.assetId) == [
        "ordered-success",
        "missing",
        "duplicate",
        "duplicate",
        "failure",
        "empty-success",
      ])
    guard case .success(let ordered) = slots[0] else {
      Issue.record("First request slot must be a success")
      return
    }
    #expect(ordered.labels.isEmpty)
    guard case .missing(assetId: "missing") = slots[1] else {
      Issue.record("Absent outcome must produce a missing slot")
      return
    }
    guard case .success(let firstDuplicate) = slots[2] else {
      Issue.record("First duplicate request must receive the first matching outcome")
      return
    }
    #expect(firstDuplicate.labels.first?.identifier == "first")
    guard case .duplicate(assetId: "duplicate") = slots[3] else {
      Issue.record("Later duplicate request must produce a duplicate slot")
      return
    }
    guard case .failure(assetId: "failure", message: "failed") = slots[4] else {
      Issue.record("Failure outcome must remain a failure slot")
      return
    }
    guard case .success(let successfulWithoutLabels) = slots[5] else {
      Issue.record("Empty-label success must not be encoded as failure or missing")
      return
    }
    #expect(successfulWithoutLabels.labels.isEmpty)

    let encoded = parse(try PhotoAssetClassificationPackedResultV1Encoder.encode(slots))
    #expect(encoded.slots.map(\.status) == [1, 0, 1, 3, 2, 1])
    #expect(encoded.slots[4].errorStringIndex != nil)
    #expect(encoded.slots[5].labelStringIndices.isEmpty)
    #expect(encoded.slots[5].errorStringIndex == nil)
  }

  @Test("Slot construction distinguishes canonically equivalent UTF-8 identifiers")
  func slotConstructionUsesExactUTF8Identity() {
    let composed = "caf\u{e9}"
    let decomposed = "cafe\u{301}"
    #expect(composed == decomposed)
    #expect(Array(composed.utf8) != Array(decomposed.utf8))

    let slots = PhotoAssetClassificationBatchSlot.make(
      requestedAssetIds: [composed, decomposed, composed],
      outcomes: [
        .success(
          PhotoAssetClassification(
            assetId: decomposed,
            labels: [
              PhotoAssetClassificationLabel(identifier: "decomposed", confidence: 0.75)
            ]
          )),
        .success(
          PhotoAssetClassification(
            assetId: composed,
            labels: [
              PhotoAssetClassificationLabel(identifier: "composed", confidence: 0.5)
            ]
          )),
      ]
    )

    guard case .success(let first) = slots[0] else {
      Issue.record("Composed identifier must retain its exact matching outcome")
      return
    }
    #expect(Array(first.assetId.utf8) == Array(composed.utf8))
    #expect(first.labels.first?.identifier == "composed")
    guard case .success(let second) = slots[1] else {
      Issue.record("Decomposed identifier must remain a distinct successful request")
      return
    }
    #expect(Array(second.assetId.utf8) == Array(decomposed.utf8))
    #expect(second.labels.first?.identifier == "decomposed")
    guard case .duplicate(let duplicateAssetId) = slots[2] else {
      Issue.record("Only the exact repeated UTF-8 identifier may be marked duplicate")
      return
    }
    #expect(Array(duplicateAssetId.utf8) == Array(composed.utf8))

    let exactMismatch = PhotoAssetClassificationBatchSlot.make(
      requestedAssetIds: [composed],
      outcomes: [
        .success(PhotoAssetClassification(assetId: decomposed, labels: []))
      ]
    )
    guard case .missing(let missingAssetId) = exactMismatch[0] else {
      Issue.record("A canonically equivalent but byte-distinct outcome must remain unmatched")
      return
    }
    #expect(Array(missingAssetId.utf8) == Array(composed.utf8))
  }

  @Test("Encoder produces deterministic golden little-endian bytes")
  func deterministicGoldenBytes() throws {
    let slots: [PhotoAssetClassificationBatchSlot] = [
      .success(
        PhotoAssetClassification(
          assetId: "asset-a",
          labels: [
            PhotoAssetClassificationLabel(identifier: "pizza", confidence: 0.5),
            PhotoAssetClassificationLabel(
              identifier: "café",
              confidence: Float(bitPattern: 0x8000_0000)
            ),
          ]
        )),
      .missing(assetId: "missing"),
      .failure(assetId: "asset-b", message: ""),
      .duplicate(assetId: "asset-a"),
    ]

    let first = try PhotoAssetClassificationPackedResultV1Encoder.encode(slots)
    let second = try PhotoAssetClassificationPackedResultV1Encoder.encode(slots)
    #expect(first == second)
    #expect(
      hex(first)
        == "5056433101000000750000000400000006000000"
        + "0700000061737365742d610500000070697a7a6105000000636166c3a9"
        + "070000006d697373696e670700000061737365742d6200000000"
        + "00000000010200010000000000003f0200000000000080"
        + "0300000000"
        + "040000000205000000"
        + "0000000003"
    )

    let parsed = parse(first)
    #expect(parsed.magic == PhotoAssetClassificationPackedResultV1Encoder.magic)
    #expect(parsed.schemaVersion == PhotoAssetClassificationPackedResultV1Encoder.schemaVersion)
    #expect(parsed.reserved == 0)
    #expect(parsed.declaredByteLength == UInt32(first.count))
    #expect(parsed.declaredByteLength == 117)
    #expect(parsed.slotCount == 4)
    #expect(parsed.stringCount == 6)
    #expect(parsed.consumedByteLength == first.count)
    #expect(
      parsed.stringBytes == [
        Array("asset-a".utf8),
        Array("pizza".utf8),
        Array("café".utf8),
        Array("missing".utf8),
        Array("asset-b".utf8),
        [],
      ])
    #expect(parsed.slots.map(\.status) == [1, 0, 2, 3])
    #expect(parsed.slots.map(\.assetStringIndex) == [0, 3, 4, 0])
    #expect(parsed.slots[0].labelStringIndices == [1, 2])
    #expect(parsed.slots[0].confidenceBits == [0x3f00_0000, 0x8000_0000])
    #expect(parsed.slots[2].errorStringIndex == 5)
  }

  @Test("String table preserves UTF-8, decomposition, embedded NUL, and repeated strings")
  func unicodeAndRepeatedStringInterning() throws {
    let composed = "é"
    let decomposed = "e\u{301}"
    let emoji = "🧑🏽‍🍳"
    let nulString = "before\0after"
    #expect(Array(composed.utf8) != Array(decomposed.utf8))

    let data = try PhotoAssetClassificationPackedResultV1Encoder.encode([
      .success(
        PhotoAssetClassification(
          assetId: "写真-" + emoji,
          labels: [
            PhotoAssetClassificationLabel(identifier: composed, confidence: 0.25),
            PhotoAssetClassificationLabel(identifier: emoji, confidence: 0.5),
            PhotoAssetClassificationLabel(identifier: nulString, confidence: 0.75),
          ]
        )),
      .success(
        PhotoAssetClassification(
          assetId: "дубликат",
          labels: [
            PhotoAssetClassificationLabel(identifier: decomposed, confidence: 1),
            PhotoAssetClassificationLabel(identifier: emoji, confidence: 0),
          ]
        )),
      .failure(assetId: "خطأ", message: nulString),
      .failure(assetId: "خطأ-آخر", message: nulString),
    ])
    let parsed = parse(data)

    #expect(
      parsed.stringBytes == [
        Array(("写真-" + emoji).utf8),
        Array(composed.utf8),
        Array(emoji.utf8),
        Array(nulString.utf8),
        Array("дубликат".utf8),
        Array(decomposed.utf8),
        Array("خطأ".utf8),
        Array("خطأ-آخر".utf8),
      ])
    #expect(parsed.stringCount == 8)
    #expect(parsed.slots[0].labelStringIndices == [1, 2, 3])
    #expect(parsed.slots[1].labelStringIndices == [5, 2])
    #expect(parsed.slots[2].errorStringIndex == 3)
    #expect(parsed.slots[3].errorStringIndex == 3)
    #expect(parsed.stringBytes[3].contains(0))
  }

  @Test("A label reused as a later asset ID does not create a duplicate asset slot")
  func crossRoleStringReuse() throws {
    let data = try PhotoAssetClassificationPackedResultV1Encoder.encode([
      .success(
        PhotoAssetClassification(
          assetId: "first",
          labels: [
            PhotoAssetClassificationLabel(identifier: "later-asset", confidence: 0.75)
          ]
        )),
      .success(PhotoAssetClassification(assetId: "later-asset", labels: [])),
    ])
    let parsed = parse(data)

    #expect(parsed.stringBytes == [Array("first".utf8), Array("later-asset".utf8)])
    #expect(parsed.slots.map(\.status) == [1, 1])
    #expect(parsed.slots.map(\.assetStringIndex) == [0, 1])
    #expect(parsed.slots[0].labelStringIndices == [1])
  }

  @Test("Float32 confidence bit patterns survive exactly")
  func floatBitPatterns() throws {
    let bitPatterns: [UInt32] = [
      0x0000_0000,
      0x8000_0000,
      0x3f7f_ffff,
      0x3f80_0000,
      0x3f80_0001,
      0x0000_0001,
      0x7f7f_ffff,
    ]
    let labels = bitPatterns.enumerated().map { index, bitPattern in
      PhotoAssetClassificationLabel(
        identifier: "value-\(index)",
        confidence: Float(bitPattern: bitPattern)
      )
    }
    let data = try PhotoAssetClassificationPackedResultV1Encoder.encode([
      .success(PhotoAssetClassification(assetId: "float-bits", labels: labels))
    ])
    let parsed = parse(data)

    #expect(parsed.slots[0].confidenceBits == bitPatterns)
    #expect(parsed.slots[0].confidenceBits[1] == Float(-0.0).bitPattern)
    #expect(parsed.slots[0].confidenceBits[2] + 1 == parsed.slots[0].confidenceBits[3])
    #expect(parsed.slots[0].confidenceBits[3] + 1 == parsed.slots[0].confidenceBits[4])
  }

  @Test("Empty page contains only the exact V1 header")
  func emptyPage() throws {
    let data = try PhotoAssetClassificationPackedResultV1Encoder.encode([])
    #expect(
      [UInt8](data)
        == [
          0x50, 0x56, 0x43, 0x31,
          0x01, 0x00,
          0x00, 0x00,
          0x14, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00,
        ]
    )
    let parsed = parse(data)
    #expect(
      parsed.declaredByteLength == PhotoAssetClassificationPackedResultV1Encoder.headerByteLength)
    #expect(parsed.slotCount == 0)
    #expect(parsed.stringCount == 0)
    #expect(parsed.stringBytes.isEmpty)
    #expect(parsed.slots.isEmpty)
  }

  @Test("Encoder rejects inconsistent duplicate statuses")
  func invalidDuplicateStatuses() {
    let invalidPages: [[PhotoAssetClassificationBatchSlot]] = [
      [.duplicate(assetId: "first")],
      [.missing(assetId: "repeated"), .missing(assetId: "repeated")],
    ]

    for slots in invalidPages {
      #expect(throws: PhotoAssetClassificationPackedResultV1Encoder.EncodingError.self) {
        try PhotoAssetClassificationPackedResultV1Encoder.encode(slots)
      }
    }
  }

  @Test(
    "Non-finite confidences are rejected with exact slot context",
    arguments: [
      Float.nan,
      Float.infinity,
      -Float.infinity,
    ])
  func nonFiniteConfidence(confidence: Float) {
    let labels = [
      PhotoAssetClassificationLabel(identifier: "finite", confidence: 0.5),
      PhotoAssetClassificationLabel(identifier: "invalid", confidence: confidence),
    ]

    do {
      _ = try PhotoAssetClassificationPackedResultV1Encoder.encode([
        .success(PhotoAssetClassification(assetId: "bad-float", labels: labels))
      ])
      Issue.record("Expected non-finite confidence to be rejected")
    } catch let error as PhotoAssetClassificationPackedResultV1Encoder.EncodingError {
      #expect(
        error
          == PhotoAssetClassificationPackedResultV1Encoder.EncodingError.nonFiniteConfidence(
            assetId: "bad-float",
            labelIndex: 1
          )
      )
    } catch {
      Issue.record("Unexpected error: \(error)")
    }
  }

  private func parse(_ data: Data) -> ParsedPayload {
    var cursor = ByteCursor(bytes: [UInt8](data))
    let magic = cursor.readBytes(count: 4)
    let schemaVersion = cursor.readUInt16()
    let reserved = cursor.readUInt16()
    let declaredByteLength = cursor.readUInt32()
    let slotCount = cursor.readUInt32()
    let stringCount = cursor.readUInt32()

    var strings: [[UInt8]] = []
    strings.reserveCapacity(Int(stringCount))
    for _ in 0..<stringCount {
      strings.append(cursor.readBytes(count: Int(cursor.readUInt32())))
    }

    var slots: [ParsedSlot] = []
    slots.reserveCapacity(Int(slotCount))
    for _ in 0..<slotCount {
      let assetStringIndex = cursor.readUInt32()
      let status = cursor.readByte()
      var labelStringIndices: [UInt32] = []
      var confidenceBits: [UInt32] = []
      var errorStringIndex: UInt32?
      switch status {
      case 0, 3:
        break
      case 1:
        let labelCount = cursor.readUInt16()
        labelStringIndices.reserveCapacity(Int(labelCount))
        confidenceBits.reserveCapacity(Int(labelCount))
        for _ in 0..<labelCount {
          labelStringIndices.append(cursor.readUInt32())
          confidenceBits.append(cursor.readUInt32())
        }
      case 2:
        errorStringIndex = cursor.readUInt32()
      default:
        preconditionFailure("Unexpected packed result status \(status)")
      }
      slots.append(
        ParsedSlot(
          assetStringIndex: assetStringIndex,
          status: status,
          labelStringIndices: labelStringIndices,
          confidenceBits: confidenceBits,
          errorStringIndex: errorStringIndex
        ))
    }

    return ParsedPayload(
      magic: magic,
      schemaVersion: schemaVersion,
      reserved: reserved,
      declaredByteLength: declaredByteLength,
      slotCount: slotCount,
      stringCount: stringCount,
      stringBytes: strings,
      slots: slots,
      consumedByteLength: cursor.offset
    )
  }

  private func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }
}

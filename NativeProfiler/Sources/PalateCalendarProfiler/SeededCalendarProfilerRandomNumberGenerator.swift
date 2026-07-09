struct SeededCalendarProfilerRandomNumberGenerator: RandomNumberGenerator {
  private var state: UInt64

  init(seed: UInt64) {
    state = seed
  }

  mutating func next() -> UInt64 {
    state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
    return state
  }

  mutating func integer(upperBound: Int) -> Int {
    precondition(upperBound > 0)
    return Int(next() % UInt64(upperBound))
  }
}

import ExpoModulesCore

struct ClassificationOptions: Record {
  @Field
  var confidenceThreshold: Float = 0.1

  @Field
  var maxLabels: Int = 50
}

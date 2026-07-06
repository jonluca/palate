import CoreLocation

public struct PhotoAssetLocation: Sendable {
  public let latitude: Double
  public let longitude: Double
  public let altitude: Double
  public let speed: Double
  public let heading: Double

  public init?(
    latitude: Double,
    longitude: Double,
    altitude: Double = 0,
    speed: Double = -1,
    heading: Double = -1
  ) {
    let coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    guard CLLocationCoordinate2DIsValid(coordinate) else {
      return nil
    }

    self.latitude = latitude
    self.longitude = longitude
    self.altitude = altitude
    self.speed = speed
    self.heading = heading
  }

  init?(_ location: CLLocation?) {
    guard let location else {
      return nil
    }

    guard let validated = PhotoAssetLocation(
      latitude: location.coordinate.latitude,
      longitude: location.coordinate.longitude,
      altitude: location.altitude,
      speed: location.speed,
      heading: location.course
    ) else {
      return nil
    }

    self = validated
  }
}

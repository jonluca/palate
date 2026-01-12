import ExpoModulesCore
import MapKit
import CoreLocation

public class MapKitSearchModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MapKitSearch")

    AsyncFunction("searchNearbyRestaurants") { (latitude: Double, longitude: Double, radiusMeters: Double, promise: Promise) in
      self.searchNearbyRestaurants(latitude: latitude, longitude: longitude, radiusMeters: radiusMeters, promise: promise)
    }

    AsyncFunction("searchNearbyPOI") { (latitude: Double, longitude: Double, radiusMeters: Double, options: SearchOptions, promise: Promise) in
      self.searchNearbyPOI(latitude: latitude, longitude: longitude, radiusMeters: radiusMeters, options: options, promise: promise)
    }

    AsyncFunction("searchByText") { (query: String, latitude: Double, longitude: Double, radiusMeters: Double, promise: Promise) in
      self.searchByText(query: query, latitude: latitude, longitude: longitude, radiusMeters: radiusMeters, promise: promise)
    }
  }

  // MARK: - Search for nearby restaurants using MKLocalPointsOfInterestRequest

  private func searchNearbyRestaurants(latitude: Double, longitude: Double, radiusMeters: Double, promise: Promise) {
    let coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    let region = MKCoordinateRegion(
      center: coordinate,
      latitudinalMeters: radiusMeters * 2,
      longitudinalMeters: radiusMeters * 2
    )

    // Use MKLocalPointsOfInterestRequest for food-related POIs (iOS 14+)
    let request = MKLocalPointsOfInterestRequest(coordinateRegion: region)
    request.pointOfInterestFilter = MKPointOfInterestFilter(including: [
      .restaurant,
      .cafe,
      .bakery,
      .foodMarket,
      .brewery,
      .winery
    ])

    let search = MKLocalSearch(request: request)
    search.start { response, error in
      if let error = error {
        DispatchQueue.main.async {
          promise.reject("SEARCH_ERROR", error.localizedDescription)
        }
        return
      }

      guard let response = response else {
        DispatchQueue.main.async {
          promise.resolve([])
        }
        return
      }

      let results = self.mapItemsToResults(response.mapItems, userCoordinate: coordinate)

      DispatchQueue.main.async {
        promise.resolve(results)
      }
    }
  }

  // MARK: - Search for nearby POIs with custom categories

  private func searchNearbyPOI(latitude: Double, longitude: Double, radiusMeters: Double, options: SearchOptions, promise: Promise) {
    let coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    let region = MKCoordinateRegion(
      center: coordinate,
      latitudinalMeters: radiusMeters * 2,
      longitudinalMeters: radiusMeters * 2
    )

    let request = MKLocalPointsOfInterestRequest(coordinateRegion: region)

    // Build POI filter from categories
    var categories: [MKPointOfInterestCategory] = []
    for category in options.categories {
      if let poiCategory = self.stringToCategory(category) {
        categories.append(poiCategory)
      }
    }

    if categories.isEmpty {
      // Default to food-related categories
      categories = [.restaurant, .cafe, .bakery, .foodMarket]
    }

    request.pointOfInterestFilter = MKPointOfInterestFilter(including: categories)

    let search = MKLocalSearch(request: request)
    search.start { response, error in
      if let error = error {
        DispatchQueue.main.async {
          promise.reject("SEARCH_ERROR", error.localizedDescription)
        }
        return
      }

      guard let response = response else {
        DispatchQueue.main.async {
          promise.resolve([])
        }
        return
      }

      let results = self.mapItemsToResults(response.mapItems, userCoordinate: coordinate)

      DispatchQueue.main.async {
        promise.resolve(results)
      }
    }
  }

  // MARK: - Text-based search using MKLocalSearch

  private func searchByText(query: String, latitude: Double, longitude: Double, radiusMeters: Double, promise: Promise) {
    let coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    let region = MKCoordinateRegion(
      center: coordinate,
      latitudinalMeters: radiusMeters * 2,
      longitudinalMeters: radiusMeters * 2
    )

    let request = MKLocalSearch.Request()
    request.naturalLanguageQuery = query
    request.region = region
    request.resultTypes = .pointOfInterest

    let search = MKLocalSearch(request: request)
    search.start { response, error in
      if let error = error {
        DispatchQueue.main.async {
          promise.reject("SEARCH_ERROR", error.localizedDescription)
        }
        return
      }

      guard let response = response else {
        DispatchQueue.main.async {
          promise.resolve([])
        }
        return
      }

      let results = self.mapItemsToResults(response.mapItems, userCoordinate: coordinate)

      DispatchQueue.main.async {
        promise.resolve(results)
      }
    }
  }

  // MARK: - Helper methods

  private func mapItemsToResults(_ mapItems: [MKMapItem], userCoordinate: CLLocationCoordinate2D) -> [[String: Any?]] {
    let userLocation = CLLocation(latitude: userCoordinate.latitude, longitude: userCoordinate.longitude)

    return mapItems.map { item -> [String: Any?] in
      let itemLocation = CLLocation(
        latitude: item.placemark.coordinate.latitude,
        longitude: item.placemark.coordinate.longitude
      )
      let distance = userLocation.distance(from: itemLocation)

      return [
        "name": item.name,
        "latitude": item.placemark.coordinate.latitude,
        "longitude": item.placemark.coordinate.longitude,
        "address": self.formatAddress(item.placemark),
        "phoneNumber": item.phoneNumber,
        "url": item.url?.absoluteString,
        "category": item.pointOfInterestCategory?.rawValue,
        "distance": distance,
        "timeZone": item.timeZone?.identifier
      ]
    }.sorted { (a, b) -> Bool in
      // Sort by distance
      let distA = a["distance"] as? Double ?? Double.infinity
      let distB = b["distance"] as? Double ?? Double.infinity
      return distA < distB
    }
  }

  private func formatAddress(_ placemark: MKPlacemark) -> String? {
    var components: [String] = []

    if let subThoroughfare = placemark.subThoroughfare {
      components.append(subThoroughfare)
    }
    if let thoroughfare = placemark.thoroughfare {
      components.append(thoroughfare)
    }
    if let locality = placemark.locality {
      if !components.isEmpty {
        components.append(", \(locality)")
      } else {
        components.append(locality)
      }
    }
    if let administrativeArea = placemark.administrativeArea {
      components.append(administrativeArea)
    }
    if let postalCode = placemark.postalCode {
      components.append(postalCode)
    }

    return components.isEmpty ? nil : components.joined(separator: " ")
  }

  private func stringToCategory(_ category: String) -> MKPointOfInterestCategory? {
    switch category.lowercased() {
    case "restaurant":
      return .restaurant
    case "cafe":
      return .cafe
    case "bakery":
      return .bakery
    case "foodmarket":
      return .foodMarket
    case "brewery":
      return .brewery
    case "winery":
      return .winery
    case "nightlife":
      return .nightlife
    case "hotel":
      return .hotel
    case "airport":
      return .airport
    case "bank":
      return .bank
    case "hospital":
      return .hospital
    case "pharmacy":
      return .pharmacy
    case "police":
      return .police
    case "postoffice":
      return .postOffice
    case "school":
      return .school
    case "university":
      return .university
    case "library":
      return .library
    case "museum":
      return .museum
    case "theater":
      return .theater
    case "park":
      return .park
    case "beach":
      return .beach
    case "marina":
      return .marina
    case "evcharger":
      return .evCharger
    case "gasstation":
      return .gasStation
    case "parking":
      return .parking
    case "publictransport":
      return .publicTransport
    case "store":
      return .store
    case "fitnessCenter":
      return .fitnessCenter
    case "stadium":
      return .stadium
    case "zoo":
      return .zoo
    case "amusementpark":
      return .amusementPark
    case "aquarium":
      return .aquarium
    case "campground":
      return .campground
    case "movietheater":
      return .movieTheater
    default:
      return nil
    }
  }
}

struct SearchOptions: Record {
  @Field
  var categories: [String] = ["restaurant", "cafe", "bakery", "foodMarket"]
}

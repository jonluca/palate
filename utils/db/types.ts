export interface FoodLabel {
  label: string;
  confidence: number;
}

export interface PhotoRecord {
  id: string;
  uri: string;
  creationTime: number;
  latitude: number | null;
  longitude: number | null;
  visitId: string | null;
  foodDetected: boolean | null;
  foodLabels: FoodLabel[] | null | undefined;
  foodConfidence: number | null | undefined;
  /** All classification labels returned by the ML classifier (not just food-related) */
  allLabels: FoodLabel[] | null | undefined;
  /** Media type: 'photo' or 'video' */
  mediaType: "photo" | "video";
  /** Duration in seconds (for videos only) */
  duration: number | null;
}

export interface VisitRecord {
  id: string;
  restaurantId: string | null;
  suggestedRestaurantId: string | null;
  status: "pending" | "confirmed" | "rejected";
  startTime: number;
  endTime: number;
  centerLat: number;
  centerLon: number;
  photoCount: number;
  foodProbable: boolean;
  // Calendar event metadata (from imported calendar events)
  calendarEventId: string | null;
  calendarEventTitle: string | null;
  calendarEventLocation: string | null;
  calendarEventIsAllDay: boolean | null;
  // Exported calendar event tracking (events WE created)
  exportedToCalendarId: string | null;
  // User notes
  notes: string | null;
  // Timestamps
  updatedAt: number | null;
  // Historical Michelin award at the time of visit (for confirmed visits)
  awardAtVisit: string | null;
}

export interface MichelinRestaurantRecord {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string;
  location: string;
  cuisine: string;
  award: string;
}

export interface RestaurantRecord {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  // Extended fields
  address: string | null;
  phone: string | null;
  website: string | null;
  googlePlaceId: string | null;
  cuisine: string | null;
  priceLevel: number | null;
  rating: number | null;
  notes: string | null;
}

export interface VisitSuggestedRestaurant {
  visitId: string;
  restaurantId: string;
  distance: number;
}

export interface IgnoredLocationRecord {
  id: string;
  latitude: number;
  longitude: number;
  radius: number; // in meters
  name: string | null;
  createdAt: number;
}

export interface FoodKeywordRecord {
  id: number;
  keyword: string;
  enabled: boolean;
  isBuiltIn: boolean;
  createdAt: number;
}

export interface CalendarEventUpdate {
  visitId: string;
  calendarEventId: string;
  calendarEventTitle: string;
  calendarEventLocation: string | null;
  calendarEventIsAllDay: boolean;
}

export interface UpdateRestaurantData {
  name?: string;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  googlePlaceId?: string | null;
  cuisine?: string | null;
  priceLevel?: number | null;
  rating?: number | null;
  notes?: string | null;
  latitude?: number;
  longitude?: number;
}

export type VisitWithDetails = VisitRecord & {
  restaurantName: string | null;
  suggestedRestaurantName: string | null;
  suggestedRestaurantAward: string | null;
  previewPhotos: string[];
  // Calendar event fields are inherited from VisitRecord
};

export interface VisitForCalendarExport {
  id: string;
  restaurantName: string;
  startTime: number;
  endTime: number;
  address: string | null;
  notes: string | null;
}

export interface ExportedCalendarEvent {
  visitId: string;
  calendarEventId: string;
  exportedToCalendarId: string;
  restaurantName: string;
  startTime: number;
}

export type RestaurantWithVisits = RestaurantRecord & {
  visitCount: number;
  lastVisit: number;
  lastConfirmedAt: number | null;
  previewPhotos: string[];
  // Current Michelin award (from michelin_restaurants table)
  currentAward: string | null;
  // Award at time of first visit (if different from current)
  visitedAward: string | null;
};

export interface ConfirmedVisitForCalendarFilter {
  visitId: string;
  michelinRestaurantId: string;
  startTime: number;
}

export type SuggestedRestaurantDetail = MichelinRestaurantRecord & {
  distance: number;
};

export interface AggregatedFoodLabel {
  label: string;
  maxConfidence: number;
  photoCount: number;
}

export type PendingVisitForReview = VisitWithDetails & {
  suggestedRestaurantCuisine: string | null;
  suggestedRestaurantAddress: string | null;
  // Multiple suggestions for picker UI
  suggestedRestaurants: SuggestedRestaurantDetail[];
  // Aggregated food labels from photos in this visit
  foodLabels: AggregatedFoodLabel[];
  // True when this visit still has photos that haven't been analyzed for food
  hasUnanalyzedPhotos: boolean;
};

export interface WrappedStats {
  // Available years for filtering (only present when year is null/all-time)
  availableYears: number[];
  // Per-year data (only present when year is null/all-time)
  yearlyStats: Array<{
    year: number;
    totalVisits: number;
    uniqueRestaurants: number;
    topRestaurant: { name: string; visits: number } | null;
  }>;
  // Monthly visits data for chart
  monthlyVisits: Array<{ month: number; year: number; visits: number }>;
  // Michelin stars breakdown
  michelinStats: {
    threeStars: number; // total visits to 3-star restaurants
    twoStars: number; // total visits to 2-star restaurants
    oneStars: number; // total visits to 1-star restaurants
    bibGourmand: number; // total visits to Bib Gourmand restaurants
    selected: number; // total visits to Selected restaurants
    distinctThreeStars: number; // unique 3-star restaurants visited
    distinctTwoStars: number; // unique 2-star restaurants visited
    distinctOneStars: number; // unique 1-star restaurants visited
    distinctBibGourmand: number; // unique Bib Gourmand restaurants visited
    distinctSelected: number; // unique Selected restaurants visited
    totalStarredVisits: number;
    distinctStarredRestaurants: number; // unique starred restaurants visited
    totalAccumulatedStars: number; // sum of stars across all visits (2 visits to 3-star = 6)
    distinctStars: number; // sum of star rating across distinct starred restaurants (5 visits to 3-star = 3)
    greenStarVisits: number; // eco-conscious Green Star restaurant visits
  };
  // Cuisine breakdown (top 5)
  topCuisines: Array<{ cuisine: string; count: number }>;
  // Time patterns
  busiestMonth: { month: number; year: number; visits: number } | null;
  busiestDayOfWeek: { day: number; visits: number } | null;
  // Overall stats
  totalUniqueRestaurants: number;
  totalConfirmedVisits: number;
  firstVisitDate: number | null;
  longestStreak: { days: number; startDate: number; endDate: number } | null;
  // Fun facts
  mostRevisitedRestaurant: { name: string; visits: number } | null;
  averageVisitsPerMonth: number;
  // Geographic stats - parsed from michelin_restaurants.location
  topLocations: Array<{ location: string; country: string; city: string; visits: number }>;
  uniqueCountries: number;
  uniqueCities: number;
  // Dining time patterns
  mealTimeBreakdown: {
    breakfast: number; // 6-10am
    lunch: number; // 11am-2pm
    dinner: number; // 5-9pm
    lateNight: number; // 9pm+
  };
  weekendVsWeekday: {
    weekend: number;
    weekday: number;
  };
  peakDiningHour: { hour: number; visits: number } | null;
  // Photo stats
  photoStats: {
    totalPhotos: number;
    averagePerVisit: number;
    mostPhotographedVisit: { restaurantName: string; photoCount: number } | null;
  };
  // Dining style / loyalty
  diningStyle: {
    newRestaurants: number; // restaurants visited only once
    returningVisits: number; // visits to restaurants visited more than once
    explorerRatio: number; // percentage of unique restaurants vs total visits (0-1)
  };
}

export interface ReclassifyProgress {
  total: number;
  processed: number;
  updated: number;
  isComplete: boolean;
}

export interface MovePhotosResult {
  movedCount: number;
  fromVisitIds: string[];
}

export interface RemovePhotosResult {
  removedCount: number;
}

export interface MergeableVisitGroup {
  restaurantId: string;
  restaurantName: string;
  /** All visits in this group, sorted by startTime ascending */
  visits: Array<{
    id: string;
    startTime: number;
    endTime: number;
    photoCount: number;
  }>;
  /** Total photos across all visits in the group */
  totalPhotos: number;
}

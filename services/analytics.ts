import analytics from "@react-native-firebase/analytics";

/**
 * Firebase Analytics service for tracking events and screen views
 */

/**
 * Log a screen view event
 * @param screenName - The name of the screen being viewed
 * @param screenClass - Optional class name of the screen
 */
export const logScreenView = async (screenName: string, screenClass?: string) => {
  try {
    await analytics().logScreenView({
      screen_name: screenName,
      screen_class: screenClass ?? screenName,
    });
  } catch (error) {
    if (__DEV__) {
      console.warn("Analytics screen view error:", error);
    }
  }
};

/**
 * Log a custom event
 * @param eventName - The name of the event (max 40 characters)
 * @param params - Optional parameters for the event
 */
const logEvent = async (eventName: string, params?: Record<string, string | number | boolean>) => {
  try {
    await analytics().logEvent(eventName, params);
  } catch (error) {
    if (__DEV__) {
      console.warn("Analytics event error:", error);
    }
  }
};

/**
 * Set user property for segmentation
 * @param name - Property name
 * @param value - Property value
 */
const setUserProperty = async (name: string, value: string | null) => {
  try {
    await analytics().setUserProperty(name, value);
  } catch (error) {
    if (__DEV__) {
      console.warn("Analytics user property error:", error);
    }
  }
};

/**
 * Set user ID for cross-device tracking
 * @param userId - Unique user identifier
 */
const setUserId = async (userId: string | null) => {
  try {
    await analytics().setUserId(userId);
  } catch (error) {
    if (__DEV__) {
      console.warn("Analytics user ID error:", error);
    }
  }
};

// Pre-defined event helpers for common actions

export const logVisitViewed = (visitId: number) => {
  return logEvent("visit_viewed", { visit_id: visitId });
};

export const logRestaurantViewed = (restaurantId: number, restaurantName?: string) => {
  return logEvent("restaurant_viewed", {
    restaurant_id: restaurantId,
    ...(restaurantName && { restaurant_name: restaurantName }),
  });
};

export const logVisitConfirmed = (visitId: number) => {
  return logEvent("visit_confirmed", { visit_id: visitId });
};

export const logVisitRejected = (visitId: number) => {
  return logEvent("visit_rejected", { visit_id: visitId });
};

export const logScanStarted = () => {
  return logEvent("scan_started");
};

export const logScanCompleted = (photoCount: number, visitCount: number) => {
  return logEvent("scan_completed", {
    photo_count: photoCount,
    visit_count: visitCount,
  });
};

export const logExportStarted = (format: string) => {
  return logEvent("export_started", { format });
};

export const logCalendarImported = (eventCount: number) => {
  return logEvent("calendar_imported", { event_count: eventCount });
};

export const logWrappedViewed = (year: number) => {
  return logEvent("wrapped_viewed", { year });
};

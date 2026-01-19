import { useEffect, useRef } from "react";
import { usePathname, useSegments } from "expo-router";
import { logScreenView } from "@/services/analytics";

/**
 * Maps route segments to readable screen names
 */
const getScreenName = (pathname: string, segments: string[]): string => {
  // Handle dynamic routes
  if (pathname.startsWith("/visit/")) {
    return "Visit Details";
  }
  if (pathname.startsWith("/restaurant/")) {
    return "Restaurant Details";
  }

  // Handle tab routes
  const screenMap: Record<string, string> = {
    "/": "Home",
    "/review": "Review",
    "/stats": "Stats",
    "/settings": "Settings",
    "/visits": "All Visits",
    "/scan": "Scan",
    "/rescan": "Rescan",
    "/quick-actions": "Quick Actions",
    "/calendar-import": "Calendar Import",
  };

  return (screenMap[pathname] ?? segments.join("/")) || "Unknown";
};

/**
 * Hook to automatically track screen views when navigation changes
 * Should be used in the root layout component
 */
export const useAnalyticsScreenTracking = () => {
  const pathname = usePathname();
  const segments = useSegments();
  const previousPathname = useRef<string | null>(null);

  useEffect(() => {
    // Skip if pathname hasn't changed (prevents duplicate logs)
    if (previousPathname.current === pathname) {
      return;
    }
    previousPathname.current = pathname;

    const screenName = getScreenName(pathname, segments);
    logScreenView(screenName, pathname);
  }, [pathname, segments]);
};

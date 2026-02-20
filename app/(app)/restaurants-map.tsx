import { MichelinRestaurantCard } from "@/components/restaurants/michelin-restaurant-card";
import { ThemedText } from "@/components/themed-text";
import { FilterPills } from "@/components/ui";
import { useConfirmedRestaurants, useMichelinRestaurants } from "@/hooks/queries";
import type { MichelinRestaurantRecord } from "@/utils/db";
import { FlashList } from "@shopify/flash-list";
import { AppleMaps, GoogleMaps, type CameraPosition } from "expo-maps";
import { Stack, router } from "expo-router";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const MAX_RESTAURANTS_IN_VIEW = 500;
const CURRENT_AWARD_LOOKBACK_YEARS = 2;
const DEFAULT_CAMERA: CameraPosition = {
  coordinates: { latitude: 20, longitude: 0 },
  zoom: 2.5,
};

interface CameraSnapshot {
  latitude: number;
  longitude: number;
  zoom: number;
}

type VisitStatusFilter = "visited" | "unvisited" | "all";
type QuickAwardFilter = "all" | "1star" | "2star" | "3star" | "bib" | "selected" | "green";
type ViewMode = "map" | "list";

interface ViewportBounds {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
  wrapsDateLine: boolean;
}

type MapRestaurantPoint = MichelinRestaurantRecord & {
  visited: boolean;
};

function clampLatitude(latitude: number) {
  return Math.max(-85.05112878, Math.min(85.05112878, latitude));
}

function normalizeLongitude(longitude: number) {
  let normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
  if (normalized === -180) {
    normalized = 180;
  }
  return normalized;
}

function mercatorScale(zoom: number) {
  return 256 * Math.pow(2, Math.max(0, zoom));
}

function longitudeToPixelX(longitude: number, zoom: number) {
  const scale = mercatorScale(zoom);
  return ((normalizeLongitude(longitude) + 180) / 360) * scale;
}

function latitudeToPixelY(latitude: number, zoom: number) {
  const scale = mercatorScale(zoom);
  const clamped = clampLatitude(latitude);
  const sin = Math.sin((clamped * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return y * scale;
}

function pixelXToLongitude(pixelX: number, zoom: number) {
  const scale = mercatorScale(zoom);
  return normalizeLongitude((pixelX / scale) * 360 - 180);
}

function pixelYToLatitude(pixelY: number, zoom: number) {
  const scale = mercatorScale(zoom);
  const n = Math.PI - (2 * Math.PI * pixelY) / scale;
  return clampLatitude((180 / Math.PI) * Math.atan(Math.sinh(n)));
}

function getViewportBounds(camera: CameraSnapshot, width: number, height: number): ViewportBounds | null {
  if (!width || !height) {
    return null;
  }

  const zoom = Math.max(0, camera.zoom);
  const centerX = longitudeToPixelX(camera.longitude, zoom);
  const centerY = latitudeToPixelY(camera.latitude, zoom);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const scale = mercatorScale(zoom);

  const minX = centerX - halfWidth;
  const maxX = centerX + halfWidth;
  const minY = centerY - halfHeight;
  const maxY = centerY + halfHeight;

  const latitudeCoversWholeWorld = height >= scale;
  const longitudeCoversWholeWorld = width >= scale;

  const minLatitude = latitudeCoversWholeWorld
    ? -85.05112878
    : pixelYToLatitude(Math.min(scale, Math.max(0, maxY)), zoom);
  const maxLatitude = latitudeCoversWholeWorld
    ? 85.05112878
    : pixelYToLatitude(Math.min(scale, Math.max(0, minY)), zoom);
  const minLongitude = longitudeCoversWholeWorld ? -180 : pixelXToLongitude(minX, zoom);
  const maxLongitude = longitudeCoversWholeWorld ? 180 : pixelXToLongitude(maxX, zoom);

  return {
    minLatitude: Math.min(minLatitude, maxLatitude),
    maxLatitude: Math.max(minLatitude, maxLatitude),
    minLongitude,
    maxLongitude,
    wrapsDateLine: !longitudeCoversWholeWorld && minLongitude > maxLongitude,
  };
}

function isRestaurantInBounds(restaurant: MichelinRestaurantRecord, bounds: ViewportBounds) {
  const latitudeInRange = restaurant.latitude >= bounds.minLatitude && restaurant.latitude <= bounds.maxLatitude;
  if (!latitudeInRange) {
    return false;
  }

  if (!bounds.wrapsDateLine) {
    return restaurant.longitude >= bounds.minLongitude && restaurant.longitude <= bounds.maxLongitude;
  }

  return restaurant.longitude >= bounds.minLongitude || restaurant.longitude <= bounds.maxLongitude;
}

function getCenterDistanceScore(restaurant: MichelinRestaurantRecord, camera: CameraSnapshot) {
  const zoom = Math.max(0, camera.zoom);
  const scale = mercatorScale(zoom);

  const centerX = longitudeToPixelX(camera.longitude, zoom);
  const centerY = latitudeToPixelY(camera.latitude, zoom);
  const restaurantX = longitudeToPixelX(restaurant.longitude, zoom);
  const restaurantY = latitudeToPixelY(restaurant.latitude, zoom);

  let deltaX = Math.abs(restaurantX - centerX);
  deltaX = Math.min(deltaX, scale - deltaX);
  const deltaY = restaurantY - centerY;

  return deltaX * deltaX + deltaY * deltaY;
}

function awardIncludesBib(award: string) {
  return award.toLowerCase().includes("bib gourmand");
}

function awardIncludesGreenStar(award: string) {
  return award.toLowerCase().includes("green star");
}

function getAwardStarCount(award: string) {
  const lower = award.toLowerCase();
  if (lower.includes("3 stars") || lower.includes("3 star")) {
    return 3;
  }
  if (lower.includes("2 stars") || lower.includes("2 star")) {
    return 2;
  }
  if (lower.includes("1 star")) {
    return 1;
  }
  return 0;
}

function awardMatchesQuickFilter(award: string, filter: QuickAwardFilter) {
  if (filter === "all") {
    return true;
  }

  switch (filter) {
    case "1star":
      return getAwardStarCount(award) === 1;
    case "2star":
      return getAwardStarCount(award) === 2;
    case "3star":
      return getAwardStarCount(award) === 3;
    case "bib":
      return awardIncludesBib(award);
    case "selected":
      return award.toLowerCase().includes("selected");
    case "green":
      return awardIncludesGreenStar(award);
    default:
      return true;
  }
}

function getAwardPriority(award: string) {
  const lower = award.toLowerCase();
  let score = 0;

  if (lower.includes("3 stars") || lower.includes("3 star")) {
    score += 300;
  } else if (lower.includes("2 stars") || lower.includes("2 star")) {
    score += 200;
  } else if (lower.includes("1 star")) {
    score += 100;
  } else if (lower.includes("bib gourmand")) {
    score += 60;
  } else if (lower.includes("selected")) {
    score += 30;
  }

  if (lower.includes("green star")) {
    score += 10;
  }

  return score;
}

function getMinimumCurrentAwardYear(referenceDate: Date = new Date()) {
  return referenceDate.getFullYear() - (CURRENT_AWARD_LOOKBACK_YEARS - 1);
}

function hasRecentAwardYear(awardYear: number | null, minimumYear: number) {
  return typeof awardYear === "number" && awardYear >= minimumYear;
}

function normalizeCameraEvent(
  event: { coordinates?: { latitude?: number; longitude?: number }; zoom?: number },
  fallback: CameraSnapshot,
): CameraSnapshot {
  const latitude = event.coordinates?.latitude ?? fallback.latitude;
  const longitude = event.coordinates?.longitude ?? fallback.longitude;
  const zoom = event.zoom ?? fallback.zoom;

  return {
    latitude: clampLatitude(latitude),
    longitude: normalizeLongitude(longitude),
    zoom: Math.max(0, zoom),
  };
}

export default function RestaurantsMapScreen() {
  const insets = useSafeAreaInsets();
  const { data: michelinRestaurants = [], isLoading: michelinLoading } = useMichelinRestaurants();
  const { data: confirmedRestaurants = [] } = useConfirmedRestaurants();
  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [visitStatusFilter, setVisitStatusFilter] = useState<VisitStatusFilter>("visited");
  const [quickAwardFilter, setQuickAwardFilter] = useState<QuickAwardFilter>("all");
  const [camera, setCamera] = useState<CameraSnapshot>({
    latitude: DEFAULT_CAMERA.coordinates?.latitude ?? 20,
    longitude: DEFAULT_CAMERA.coordinates?.longitude ?? 0,
    zoom: DEFAULT_CAMERA.zoom ?? 2.5,
  });
  const [mapSize, setMapSize] = useState({ width: 0, height: 0 });

  const pendingCameraRef = useRef<CameraSnapshot | null>(null);
  const cameraDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minimumCurrentAwardYear = useMemo(() => getMinimumCurrentAwardYear(), []);

  useEffect(() => {
    return () => {
      if (cameraDebounceRef.current) {
        clearTimeout(cameraDebounceRef.current);
      }
    };
  }, []);

  const visitedRestaurantIds = useMemo(() => {
    return new Set(confirmedRestaurants.map((restaurant) => restaurant.id));
  }, [confirmedRestaurants]);

  const visitFilterOptions = useMemo(() => {
    return [
      { value: "visited" as const, label: "Visited" },
      { value: "unvisited" as const, label: "Not Visited" },
      { value: "all" as const, label: "All" },
    ];
  }, []);

  const viewModeOptions = useMemo(() => {
    return [
      { value: "map" as const, label: "Map" },
      { value: "list" as const, label: "List" },
    ];
  }, []);

  const quickAwardFilterOptions = useMemo(() => {
    return [
      { value: "all" as const, label: "All Awards" },
      { value: "1star" as const, label: "⭐" },
      { value: "2star" as const, label: "⭐⭐" },
      { value: "3star" as const, label: "⭐⭐⭐" },
      { value: "bib" as const, label: "Bib" },
      { value: "selected" as const, label: "Selected" },
      { value: "green" as const, label: "Green" },
    ];
  }, []);

  const filteredRestaurants = useMemo(() => {
    return michelinRestaurants.filter((restaurant) => {
      const isVisited = visitedRestaurantIds.has(restaurant.id);

      if (visitStatusFilter === "visited" && !isVisited) {
        return false;
      }
      if (visitStatusFilter === "unvisited" && isVisited) {
        return false;
      }

      if (!hasRecentAwardYear(restaurant.latestAwardYear, minimumCurrentAwardYear)) {
        return false;
      }

      if (!awardMatchesQuickFilter(restaurant.award, quickAwardFilter)) {
        return false;
      }

      return true;
    });
  }, [michelinRestaurants, minimumCurrentAwardYear, quickAwardFilter, visitStatusFilter, visitedRestaurantIds]);

  const viewportBounds = useMemo(() => {
    return getViewportBounds(camera, mapSize.width, mapSize.height);
  }, [camera, mapSize.height, mapSize.width]);

  const { restaurantsInView, totalInView } = useMemo(() => {
    if (!viewportBounds) {
      return {
        restaurantsInView: [] as MapRestaurantPoint[],
        totalInView: 0,
      };
    }

    const candidates: Array<{ restaurant: MichelinRestaurantRecord; centerDistanceScore: number }> = [];
    for (const restaurant of filteredRestaurants) {
      if (isRestaurantInBounds(restaurant, viewportBounds)) {
        candidates.push({
          restaurant,
          centerDistanceScore: getCenterDistanceScore(restaurant, camera),
        });
      }
    }

    candidates.sort((a, b) => {
      const distanceDiff = a.centerDistanceScore - b.centerDistanceScore;
      if (distanceDiff !== 0) {
        return distanceDiff;
      }

      const awardPriorityDiff = getAwardPriority(b.restaurant.award) - getAwardPriority(a.restaurant.award);
      if (awardPriorityDiff !== 0) {
        return awardPriorityDiff;
      }

      const visitedDiff =
        Number(visitedRestaurantIds.has(b.restaurant.id)) - Number(visitedRestaurantIds.has(a.restaurant.id));
      if (visitedDiff !== 0) {
        return visitedDiff;
      }

      return a.restaurant.name.localeCompare(b.restaurant.name);
    });

    const visible = candidates.slice(0, MAX_RESTAURANTS_IN_VIEW).map(({ restaurant }) => ({
      ...restaurant,
      visited: visitedRestaurantIds.has(restaurant.id),
    }));

    return {
      restaurantsInView: visible,
      totalInView: candidates.length,
    };
  }, [camera, filteredRestaurants, viewportBounds, visitedRestaurantIds]);

  const handleMapLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setMapSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);

  const flushCameraUpdate = useCallback(() => {
    cameraDebounceRef.current = null;
    if (pendingCameraRef.current) {
      setCamera((previous) => normalizeCameraEvent(pendingCameraRef.current ?? previous, previous));
      pendingCameraRef.current = null;
    }
  }, []);

  const handleCameraMove = useCallback(
    (event: { coordinates?: { latitude?: number; longitude?: number }; zoom?: number }) => {
      if (Platform.OS === "ios") {
        if (cameraDebounceRef.current) {
          clearTimeout(cameraDebounceRef.current);
          cameraDebounceRef.current = null;
        }
        pendingCameraRef.current = null;
        setCamera((previous) => normalizeCameraEvent(event, previous));
        return;
      }

      pendingCameraRef.current = normalizeCameraEvent(event, pendingCameraRef.current ?? camera);

      if (!cameraDebounceRef.current) {
        cameraDebounceRef.current = setTimeout(flushCameraUpdate, 120);
      }
    },
    [camera, flushCameraUpdate],
  );

  const openRestaurant = useCallback((restaurantId: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/restaurant/${restaurantId}`);
  }, []);

  const handleMarkerPress = useCallback(
    (event: { id?: string }) => {
      if (!event.id) {
        return;
      }
      openRestaurant(event.id);
    },
    [openRestaurant],
  );

  const appleMarkers = useMemo<AppleMaps.Marker[]>(() => {
    return restaurantsInView.map((restaurant) => ({
      id: restaurant.id,
      coordinates: {
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
      },
      title: restaurant.name,
      systemImage: restaurant.visited ? "checkmark.circle.fill" : "fork.knife.circle.fill",
      tintColor: restaurant.visited ? "#22C55E" : "#F59E0B",
    }));
  }, [restaurantsInView]);

  const googleMarkers = useMemo<GoogleMaps.Marker[]>(() => {
    return restaurantsInView.map((restaurant) => ({
      id: restaurant.id,
      coordinates: {
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
      },
      title: restaurant.name,
      snippet: `${restaurant.visited ? "Visited" : "Not visited"}${restaurant.award ? ` • ${restaurant.award}` : ""}`,
      zIndex: restaurant.visited ? 2 : 1,
    }));
  }, [restaurantsInView]);

  const appleCircles = useMemo<NonNullable<React.ComponentProps<typeof AppleMaps.View>["circles"]>>(() => {
    return restaurantsInView.map((restaurant) => ({
      id: `circle-${restaurant.id}`,
      center: {
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
      },
      radius: 35,
      color: restaurant.visited ? "rgba(34,197,94,0.16)" : "rgba(245,158,11,0.14)",
      lineColor: restaurant.visited ? "rgba(34,197,94,0.75)" : "rgba(245,158,11,0.75)",
      lineWidth: 1,
    }));
  }, [restaurantsInView]);

  const googleCircles = useMemo<NonNullable<React.ComponentProps<typeof GoogleMaps.View>["circles"]>>(() => {
    return restaurantsInView.map((restaurant) => ({
      id: `circle-${restaurant.id}`,
      center: {
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
      },
      radius: 35,
      color: restaurant.visited ? "rgba(34,197,94,0.16)" : "rgba(245,158,11,0.14)",
      lineColor: restaurant.visited ? "rgba(34,197,94,0.75)" : "rgba(245,158,11,0.75)",
      lineWidth: 1,
    }));
  }, [restaurantsInView]);

  const isUnsupportedPlatform = Platform.OS !== "ios" && Platform.OS !== "android";
  const isMapLoading = michelinLoading;
  const handleToggleFilters = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFiltersExpanded((previous) => !previous);
  }, []);

  const handleViewModeChange = useCallback((value: ViewMode) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setViewMode(value);
  }, []);

  const renderInViewRestaurant = useCallback(({ item, index }: { item: MapRestaurantPoint; index: number }) => {
    return <MichelinRestaurantCard restaurant={item} visited={item.visited} index={index < 8 ? index : undefined} />;
  }, []);

  const inViewSeparator = useCallback(() => <View style={{ height: 12 }} />, []);

  return (
    <View className={"flex-1 bg-background"}>
      <Stack.Screen
        options={{
          title: "Michelin Map",
          headerLargeTitle: false,
          headerTransparent: false,
        }}
      />

      <View className={"flex-1 px-3 pt-3 gap-3"} style={{ paddingBottom: insets.bottom + 12 }}>
        <View
          className={"rounded-2xl border border-border bg-background/90 overflow-hidden"}
          style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.28)" }}
        >
          <View className={"px-3 py-2 gap-2"}>
            <View className={"flex-row items-center justify-between gap-3"}>
              <View className={"flex-1"}>
                <ThemedText variant={"footnote"} className={"font-semibold"} numberOfLines={1}>
                  {totalInView > restaurantsInView.length
                    ? `Showing ${restaurantsInView.length.toLocaleString()} of ${totalInView.toLocaleString()} restaurants on the map`
                    : `${restaurantsInView.length.toLocaleString()} restaurants on the map`}
                </ThemedText>
              </View>
              <View className={"flex-row items-center gap-2"}>
                {isMapLoading ? <ActivityIndicator color={"#0A84FF"} /> : null}
                <Pressable
                  onPress={handleToggleFilters}
                  className={"h-8 px-2.5 rounded-full border border-border bg-secondary/70 items-center justify-center"}
                >
                  <ThemedText variant={"caption1"} className={"font-semibold"}>
                    {filtersExpanded ? "Hide" : "Filters"}
                  </ThemedText>
                </Pressable>
              </View>
            </View>

            <FilterPills options={viewModeOptions} value={viewMode} onChange={handleViewModeChange} />
          </View>

          {filtersExpanded ? (
            <View className={"gap-2 pb-3 px-3 border-t border-border pt-2.5"}>
              <ThemedText variant={"caption1"} color={"tertiary"} className={"uppercase font-semibold tracking-wide"}>
                Visited
              </ThemedText>
              <FilterPills options={visitFilterOptions} value={visitStatusFilter} onChange={setVisitStatusFilter} />

              <ThemedText variant={"caption1"} color={"tertiary"} className={"uppercase font-semibold tracking-wide"}>
                Awards
              </ThemedText>
              <FilterPills options={quickAwardFilterOptions} value={quickAwardFilter} onChange={setQuickAwardFilter} />
            </View>
          ) : null}
        </View>

        <View
          className={"flex-1 rounded-2xl border border-border bg-background/90 overflow-hidden"}
          style={{
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
          {viewMode === "list" ? (
            <FlashList
              data={restaurantsInView}
              renderItem={renderInViewRestaurant}
              keyExtractor={(item) => item.id}
              ItemSeparatorComponent={inViewSeparator}
              contentContainerStyle={{
                padding: 12,
                paddingBottom: 20,
              }}
              ListEmptyComponent={
                <View className={"flex-1 items-center justify-center px-6 py-10"}>
                  <ThemedText variant={"footnote"} color={"tertiary"} className={"text-center"}>
                    Move the map or change filters to see restaurants here.
                  </ThemedText>
                </View>
              }
            />
          ) : (
            <View className={"flex-1"} onLayout={handleMapLayout}>
              {isUnsupportedPlatform ? (
                <View className={"flex-1 items-center justify-center px-6"}>
                  <ThemedText variant={"title3"} className={"font-semibold text-center"}>
                    Map is unavailable on this platform
                  </ThemedText>
                  <ThemedText variant={"footnote"} color={"tertiary"} className={"text-center mt-2"}>
                    Switch to List to browse restaurants.
                  </ThemedText>
                </View>
              ) : Platform.OS === "ios" ? (
                <AppleMaps.View
                  style={{ flex: 1 }}
                  cameraPosition={DEFAULT_CAMERA}
                  markers={appleMarkers}
                  circles={appleCircles}
                  uiSettings={{
                    compassEnabled: true,
                    myLocationButtonEnabled: false,
                    scaleBarEnabled: true,
                  }}
                  properties={{
                    selectionEnabled: false,
                  }}
                  onCameraMove={handleCameraMove}
                  onMarkerClick={handleMarkerPress}
                />
              ) : (
                <GoogleMaps.View
                  style={{ flex: 1 }}
                  cameraPosition={DEFAULT_CAMERA}
                  markers={googleMarkers}
                  circles={googleCircles}
                  uiSettings={{
                    compassEnabled: true,
                    myLocationButtonEnabled: false,
                    zoomControlsEnabled: false,
                    mapToolbarEnabled: false,
                  }}
                  properties={{
                    selectionEnabled: false,
                  }}
                  onCameraMove={handleCameraMove}
                  onMarkerClick={handleMarkerPress}
                />
              )}
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

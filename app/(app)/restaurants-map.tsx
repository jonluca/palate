import { ThemedText } from "@/components/themed-text";
import { FilterPills } from "@/components/ui";
import { useConfirmedRestaurants, useMichelinRestaurants } from "@/hooks/queries";
import type { MichelinRestaurantRecord } from "@/utils/db";
import { AppleMaps, GoogleMaps, type CameraPosition } from "expo-maps";
import { Stack, router } from "expo-router";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const MAX_RESTAURANTS_IN_VIEW = 500;
const DEFAULT_CAMERA: CameraPosition = {
  coordinates: { latitude: 20, longitude: 0 },
  zoom: 2.5,
};

interface CameraSnapshot {
  latitude: number;
  longitude: number;
  zoom: number;
}

type AwardFilterValue = string;

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

function normalizeAwardValue(award: string | null | undefined) {
  return (award ?? "").trim();
}

function awardIncludesStars(award: string) {
  return /\b(?:1\s*star|2\s*stars?|3\s*stars?)\b/i.test(award);
}

function awardIncludesBib(award: string) {
  return award.toLowerCase().includes("bib gourmand");
}

function awardMatchesFilter(award: string, filter: AwardFilterValue) {
  if (filter === "all") {
    return true;
  }
  if (filter === "stars") {
    return awardIncludesStars(award);
  }
  if (filter === "bib") {
    return awardIncludesBib(award);
  }
  if (filter.startsWith("award:")) {
    return normalizeAwardValue(award) === filter.slice("award:".length);
  }
  return true;
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

function formatAwardFilterLabel(award: string) {
  return award.replace("Selected Restaurants", "Selected").replace(", Green Star", " + Green");
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
  const [awardFilter, setAwardFilter] = useState<AwardFilterValue>("all");
  const [camera, setCamera] = useState<CameraSnapshot>({
    latitude: DEFAULT_CAMERA.coordinates?.latitude ?? 20,
    longitude: DEFAULT_CAMERA.coordinates?.longitude ?? 0,
    zoom: DEFAULT_CAMERA.zoom ?? 2.5,
  });
  const [mapSize, setMapSize] = useState({ width: 0, height: 0 });

  const pendingCameraRef = useRef<CameraSnapshot | null>(null);
  const cameraDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const awardFilterOptions = useMemo(() => {
    const awardCounts = new Map<string, number>();
    let starredCount = 0;
    let bibCount = 0;

    for (const restaurant of michelinRestaurants) {
      const award = normalizeAwardValue(restaurant.award);
      if (!award) {
        continue;
      }
      awardCounts.set(award, (awardCounts.get(award) ?? 0) + 1);

      if (awardIncludesStars(award)) {
        starredCount += 1;
      }
      if (awardIncludesBib(award)) {
        bibCount += 1;
      }
    }

    const exactAwardOptions = [...awardCounts.entries()]
      .sort((a, b) => {
        const priorityDiff = getAwardPriority(b[0]) - getAwardPriority(a[0]);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }
        return a[0].localeCompare(b[0]);
      })
      .map(([award, count]) => ({
        value: `award:${award}`,
        label: formatAwardFilterLabel(award),
        count,
      }));

    return [
      { value: "all", label: "All", count: michelinRestaurants.length },
      { value: "stars", label: "Stars", count: starredCount },
      { value: "bib", label: "Bib Gourmand", count: bibCount },
      ...exactAwardOptions,
    ];
  }, [michelinRestaurants]);

  const awardFilteredRestaurants = useMemo(() => {
    return michelinRestaurants.filter((restaurant) => awardMatchesFilter(restaurant.award, awardFilter));
  }, [michelinRestaurants, awardFilter]);

  const viewportBounds = useMemo(() => {
    return getViewportBounds(camera, mapSize.width, mapSize.height);
  }, [camera, mapSize.height, mapSize.width]);

  const { restaurantsInView, totalInView, visibleVisitedCount } = useMemo(() => {
    if (!viewportBounds) {
      return {
        restaurantsInView: [] as MapRestaurantPoint[],
        totalInView: 0,
        visibleVisitedCount: 0,
      };
    }

    const candidates: MichelinRestaurantRecord[] = [];
    for (const restaurant of awardFilteredRestaurants) {
      if (isRestaurantInBounds(restaurant, viewportBounds)) {
        candidates.push(restaurant);
      }
    }

    candidates.sort((a, b) => {
      const awardPriorityDiff = getAwardPriority(b.award) - getAwardPriority(a.award);
      if (awardPriorityDiff !== 0) {
        return awardPriorityDiff;
      }

      const visitedDiff = Number(visitedRestaurantIds.has(b.id)) - Number(visitedRestaurantIds.has(a.id));
      if (visitedDiff !== 0) {
        return visitedDiff;
      }

      return a.name.localeCompare(b.name);
    });

    const visible = candidates.slice(0, MAX_RESTAURANTS_IN_VIEW).map((restaurant) => ({
      ...restaurant,
      visited: visitedRestaurantIds.has(restaurant.id),
    }));

    const visibleVisited = visible.reduce((count, restaurant) => count + (restaurant.visited ? 1 : 0), 0);

    return {
      restaurantsInView: visible,
      totalInView: candidates.length,
      visibleVisitedCount: visibleVisited,
    };
  }, [awardFilteredRestaurants, viewportBounds, visitedRestaurantIds]);

  const visibleUnvisitedCount = restaurantsInView.length - visibleVisitedCount;

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
      pendingCameraRef.current = normalizeCameraEvent(event, pendingCameraRef.current ?? camera);

      if (!cameraDebounceRef.current) {
        cameraDebounceRef.current = setTimeout(flushCameraUpdate, 120);
      }
    },
    [camera, flushCameraUpdate],
  );

  const handleMarkerPress = useCallback((event: { id?: string }) => {
    if (!event.id) {
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/restaurant/${event.id}`);
  }, []);

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

  return (
    <View className={"flex-1 bg-background"} onLayout={handleMapLayout}>
      <Stack.Screen
        options={{
          title: "Michelin Map",
          headerLargeTitle: false,
          headerTransparent: false,
        }}
      />

      {isUnsupportedPlatform ? (
        <View className={"flex-1 items-center justify-center px-6"}>
          <ThemedText variant={"title3"} className={"font-semibold text-center"}>
            Map is unavailable on this platform
          </ThemedText>
          <ThemedText variant={"footnote"} color={"tertiary"} className={"text-center mt-2"}>
            Open this screen on iOS or Android to browse Michelin restaurants on the map.
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

      <View
        pointerEvents={"box-none"}
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          right: 12,
        }}
      >
        <View
          className={"rounded-2xl border border-border bg-background/90 overflow-hidden"}
          style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.28)" }}
        >
          <View className={"px-4 pt-3 pb-2 gap-2"}>
            <View className={"flex-row items-center justify-between gap-3"}>
              <View className={"flex-1"}>
                <ThemedText variant={"subhead"} className={"font-semibold"}>
                  Top {MAX_RESTAURANTS_IN_VIEW.toLocaleString()} in view
                </ThemedText>
                <ThemedText variant={"caption1"} color={"tertiary"}>
                  {totalInView.toLocaleString()} matching restaurants in viewport
                </ThemedText>
              </View>
              {michelinLoading ? <ActivityIndicator color={"#0A84FF"} /> : null}
            </View>

            <View className={"flex-row items-center gap-3"}>
              <View className={"flex-row items-center gap-1.5"}>
                <View className={"w-2.5 h-2.5 rounded-full bg-green-500"} />
                <ThemedText variant={"caption1"} color={"secondary"}>
                  Visited {visibleVisitedCount.toLocaleString()}
                </ThemedText>
              </View>
              <View className={"flex-row items-center gap-1.5"}>
                <View className={"w-2.5 h-2.5 rounded-full bg-amber-400"} />
                <ThemedText variant={"caption1"} color={"secondary"}>
                  Not visited {visibleUnvisitedCount.toLocaleString()}
                </ThemedText>
              </View>
            </View>
          </View>

          <FilterPills options={awardFilterOptions} value={awardFilter} onChange={setAwardFilter} />
        </View>
      </View>

      <View
        pointerEvents={"box-none"}
        style={{
          position: "absolute",
          left: 12,
          right: 12,
          bottom: insets.bottom + 12,
        }}
      >
        <View
          className={
            "rounded-2xl border border-border bg-background/90 px-4 py-3 flex-row items-center justify-between gap-3"
          }
          style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.28)" }}
        >
          <View className={"flex-1"}>
            <ThemedText variant={"footnote"} color={"tertiary"}>
              Tap a pin to open the restaurant page
            </ThemedText>
          </View>
          <Pressable
            onPress={() => router.back()}
            className={"h-9 px-3 rounded-full border border-border bg-secondary/70 items-center justify-center"}
          >
            <ThemedText variant={"footnote"} className={"font-semibold"}>
              Close
            </ThemedText>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

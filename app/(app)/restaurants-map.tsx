import { MichelinRestaurantCard } from "@/components/restaurants/michelin-restaurant-card";
import { ThemedText } from "@/components/themed-text";
import { FilterPills } from "@/components/ui";
import { useConfirmedRestaurants, useMichelinMapViewport } from "@/hooks/queries";
import type { MichelinMapAwardFilter, MichelinMapViewportRestaurant, MichelinMapVisitStatusFilter } from "@/utils/db";
import { clampRestaurantMapLatitude, normalizeRestaurantMapLongitude } from "@/utils/restaurant-viewport-index";
import { FlashList } from "@shopify/flash-list";
import { AppleMaps, GoogleMaps, type CameraPosition } from "expo-maps";
import { Stack, router } from "expo-router";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, PanResponder, Platform, Pressable, View, type LayoutChangeEvent } from "react-native";

const CURRENT_AWARD_LOOKBACK_YEARS = 2;
const DEFAULT_CAMERA: CameraPosition = {
  coordinates: { latitude: 20, longitude: 0 },
  zoom: 2.5,
};
const INITIAL_RECENT_PIN_ZOOM = 8;
const IOS_BACK_SWIPE_EDGE_WIDTH = 26;
const CAMERA_QUERY_DEBOUNCE_MILLISECONDS = 120;

interface CameraSnapshot {
  latitude: number;
  longitude: number;
  zoom: number;
}

type ViewMode = "map" | "list";

function getMinimumCurrentAwardYear(referenceDate: Date = new Date()) {
  return referenceDate.getFullYear() - (CURRENT_AWARD_LOOKBACK_YEARS - 1);
}

function normalizeCameraEvent(
  event: { coordinates?: { latitude?: number; longitude?: number }; zoom?: number },
  fallback: CameraSnapshot,
): CameraSnapshot {
  const latitude = event.coordinates?.latitude ?? fallback.latitude;
  const longitude = event.coordinates?.longitude ?? fallback.longitude;
  const zoom = event.zoom ?? fallback.zoom;

  return {
    latitude: clampRestaurantMapLatitude(latitude),
    longitude: normalizeRestaurantMapLongitude(longitude),
    zoom: Math.max(0, zoom),
  };
}

export default function RestaurantsMapScreen() {
  const isMapPlatformSupported = Platform.OS === "ios" || Platform.OS === "android";
  const { data: confirmedRestaurants = [], isLoading: confirmedRestaurantsLoading } = useConfirmedRestaurants();
  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [visitStatusFilter, setVisitStatusFilter] = useState<MichelinMapVisitStatusFilter>("visited");
  const [quickAwardFilter, setQuickAwardFilter] = useState<MichelinMapAwardFilter>("all");
  const [hasUserMovedMapCamera, setHasUserMovedMapCamera] = useState(false);
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

  const mostRecentConfirmedPin = useMemo(() => {
    let latestRestaurant: (typeof confirmedRestaurants)[number] | null = null;
    let latestTimestamp = Number.NEGATIVE_INFINITY;

    for (const restaurant of confirmedRestaurants) {
      const timestamp = restaurant.lastConfirmedAt ?? restaurant.lastVisit;
      if (timestamp > latestTimestamp) {
        latestRestaurant = restaurant;
        latestTimestamp = timestamp;
      }
    }

    return latestRestaurant;
  }, [confirmedRestaurants]);

  const initialMapCamera = useMemo<CameraPosition>(() => {
    if (!mostRecentConfirmedPin) {
      return DEFAULT_CAMERA;
    }

    return {
      coordinates: {
        latitude: clampRestaurantMapLatitude(mostRecentConfirmedPin.latitude),
        longitude: normalizeRestaurantMapLongitude(mostRecentConfirmedPin.longitude),
      },
      zoom: INITIAL_RECENT_PIN_ZOOM,
    };
  }, [mostRecentConfirmedPin]);

  const initialViewportCamera = useMemo<CameraSnapshot>(() => {
    return {
      latitude: initialMapCamera.coordinates?.latitude ?? DEFAULT_CAMERA.coordinates?.latitude ?? 20,
      longitude: initialMapCamera.coordinates?.longitude ?? DEFAULT_CAMERA.coordinates?.longitude ?? 0,
      zoom: initialMapCamera.zoom ?? DEFAULT_CAMERA.zoom ?? 2.5,
    };
  }, [initialMapCamera]);

  const viewportCamera = hasUserMovedMapCamera ? camera : initialViewportCamera;
  const viewportRequest = useMemo(
    () => ({
      camera: viewportCamera,
      width: mapSize.width,
      height: mapSize.height,
      minimumAwardYear: minimumCurrentAwardYear,
      visitStatusFilter,
      awardFilter: quickAwardFilter,
    }),
    [mapSize.height, mapSize.width, minimumCurrentAwardYear, quickAwardFilter, viewportCamera, visitStatusFilter],
  );
  const {
    data: viewportSelection,
    isLoading: viewportLoading,
    isFetching: viewportFetching,
  } = useMichelinMapViewport(
    viewportRequest,
    (isMapPlatformSupported || viewMode === "list") && !confirmedRestaurantsLoading,
  );
  const restaurantsInView = useMemo<MichelinMapViewportRestaurant[]>(
    () => viewportSelection?.restaurants ?? [],
    [viewportSelection?.restaurants],
  );

  const handleMapLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setMapSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);

  const flushCameraUpdate = useCallback(() => {
    cameraDebounceRef.current = null;
    const pendingCamera = pendingCameraRef.current;
    if (!pendingCamera) {
      return;
    }
    pendingCameraRef.current = null;
    setCamera((previous) => normalizeCameraEvent(pendingCamera, previous));
    setHasUserMovedMapCamera(true);
  }, []);

  const handleCameraMove = useCallback(
    (event: { coordinates?: { latitude?: number; longitude?: number }; zoom?: number }) => {
      pendingCameraRef.current = normalizeCameraEvent(event, pendingCameraRef.current ?? camera);
      if (cameraDebounceRef.current) {
        clearTimeout(cameraDebounceRef.current);
      }
      cameraDebounceRef.current = setTimeout(flushCameraUpdate, CAMERA_QUERY_DEBOUNCE_MILLISECONDS);
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
    if (Platform.OS !== "ios") {
      return [];
    }
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
    if (Platform.OS !== "android") {
      return [];
    }
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
    if (Platform.OS !== "ios") {
      return [];
    }
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
    if (Platform.OS !== "android") {
      return [];
    }
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

  const isUnsupportedPlatform = !isMapPlatformSupported;
  const isMapLoading = confirmedRestaurantsLoading || viewportLoading || viewportFetching;
  const iosBackSwipePanResponder = useMemo(() => {
    if (Platform.OS !== "ios") {
      return null;
    }

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dx > 40 && Math.abs(gestureState.dy) < 60) {
          router.back();
        }
      },
      onPanResponderTerminate: () => undefined,
      onPanResponderTerminationRequest: () => true,
    });
  }, []);

  const handleToggleFilters = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFiltersExpanded((previous) => !previous);
  }, []);

  const handleViewModeChange = useCallback((value: ViewMode) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setViewMode(value);
  }, []);

  const renderInViewRestaurant = useCallback(
    ({ item, index }: { item: MichelinMapViewportRestaurant; index: number }) => {
      return <MichelinRestaurantCard restaurant={item} visited={item.visited} index={index < 8 ? index : undefined} />;
    },
    [],
  );

  const inViewSeparator = useCallback(() => <View style={{ height: 12 }} />, []);

  return (
    <View className={"flex-1 bg-background"}>
      <Stack.Screen
        options={{
          title: "Michelin Map",
          headerLargeTitle: false,
          headerTransparent: false,
          gestureEnabled: true,
          gestureResponseDistance: {
            start: 40,
          },
        }}
      />

      <View className={"flex-1 gap-3"}>
        <View className={"px-3"}>
          <View
            className={"rounded-2xl border border-border bg-background/90 overflow-hidden"}
            style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.28)" }}
          >
            <View className={"px-3 py-2"}>
              <View className={"flex-row items-center gap-2"}>
                <View className={"flex-1"}>
                  <FilterPills options={viewModeOptions} value={viewMode} onChange={handleViewModeChange} />
                </View>
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

            {filtersExpanded ? (
              <View className={"gap-2 pb-3 px-3 border-t border-border pt-2.5"}>
                <ThemedText variant={"caption1"} color={"tertiary"} className={"uppercase font-semibold tracking-wide"}>
                  Visited
                </ThemedText>
                <FilterPills options={visitFilterOptions} value={visitStatusFilter} onChange={setVisitStatusFilter} />

                <ThemedText variant={"caption1"} color={"tertiary"} className={"uppercase font-semibold tracking-wide"}>
                  Awards
                </ThemedText>
                <FilterPills
                  options={quickAwardFilterOptions}
                  value={quickAwardFilter}
                  onChange={setQuickAwardFilter}
                />
              </View>
            ) : null}
          </View>
        </View>

        <View
          className={"flex-1 overflow-hidden"}
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
                  key={`apple-${confirmedRestaurantsLoading ? "loading" : (mostRecentConfirmedPin?.id ?? "default")}`}
                  style={{ flex: 1 }}
                  cameraPosition={initialMapCamera}
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
                  key={`google-${confirmedRestaurantsLoading ? "loading" : (mostRecentConfirmedPin?.id ?? "default")}`}
                  style={{ flex: 1 }}
                  cameraPosition={initialMapCamera}
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
              {iosBackSwipePanResponder ? (
                <View
                  {...iosBackSwipePanResponder.panHandlers}
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: 0,
                    width: IOS_BACK_SWIPE_EDGE_WIDTH,
                    zIndex: 20,
                  }}
                />
              ) : null}
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

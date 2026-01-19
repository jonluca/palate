import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { Button, Card } from "@/components/ui";
import { IconSymbol } from "@/components/icon-symbol";
import { RestaurantEditModal } from "@/components/restaurant-edit-modal";
import {
  useRestaurantVisits,
  useRestaurantDetail,
  useUpdateRestaurant,
  useVisitPhotos,
  useMichelinRestaurantDetails,
  type VisitRecord,
  type MichelinAward,
  type MichelinRestaurantDetails,
  useCreateManualVisit,
} from "@/hooks/queries";
import type { RestaurantRecord, UpdateRestaurantData } from "@/utils/db";
import { logRestaurantViewed } from "@/services/analytics";
import { FlashList } from "@shopify/flash-list";
import { useHeaderHeight } from "@react-navigation/elements";
import { useLocalSearchParams, router, Stack } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { View, Pressable, Platform, type LayoutChangeEvent, ScrollView, Modal, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function VisitHistoryCard({ visit }: { visit: VisitRecord }) {
  const { data: photos = [] } = useVisitPhotos(visit.id);
  const [previewCount, setPreviewCount] = useState(3);

  const handlePreviewLayout = useCallback((e: LayoutChangeEvent) => {
    const width = e.nativeEvent.layout.width;
    if (!Number.isFinite(width) || width <= 0) {
      return;
    }

    // Choose a count that fills the row nicely on narrow and wide screens.
    const minThumbWidth = 110;
    const nextCount = clamp(Math.floor(width / minThumbWidth), 2, 4);
    setPreviewCount((prev) => (prev === nextCount ? prev : nextCount));
  }, []);

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/visit/${visit.id}`);
  };

  return (
    <View>
      <Pressable onPress={handlePress}>
        <Card animated={false}>
          {/* Preview Photos */}
          {photos.length > 0 && (
            <View className={"flex-row h-24"} onLayout={handlePreviewLayout}>
              {photos.slice(0, previewCount).map((photo, i) => (
                <View key={i} className={"flex-1"}>
                  <Image
                    source={{ uri: photo.uri }}
                    recyclingKey={photo.id}
                    style={{ width: "100%", height: "100%" }}
                    contentFit={"cover"}
                    transition={300}
                  />
                </View>
              ))}
            </View>
          )}

          <View className={"p-4 gap-2"}>
            <View className={"flex-row items-center justify-between"}>
              <View className={"gap-1"}>
                <ThemedText variant={"subhead"} className={"font-medium"}>
                  {formatDate(visit.startTime)}
                </ThemedText>
                <ThemedText variant={"footnote"} color={"tertiary"}>
                  at {formatTime(visit.startTime)}
                </ThemedText>
              </View>
              <View className={"flex-row items-center gap-2"}>
                <View className={"flex-row items-center gap-1"}>
                  <IconSymbol name={"photo"} size={14} color={"gray"} />
                  <ThemedText variant={"footnote"} color={"tertiary"}>
                    {visit.photoCount.toLocaleString()} photos
                  </ThemedText>
                </View>
                <IconSymbol name={"chevron.right"} size={16} color={"gray"} />
              </View>
            </View>
          </View>
        </Card>
      </Pressable>
    </View>
  );
}

function formatPriceLevel(level: number | null | undefined): string | null {
  if (level === null || level === undefined) {
    return null;
  }
  return "$".repeat(level);
}

function RestaurantInfoCard({ restaurant, onEdit }: { restaurant: RestaurantRecord; onEdit: () => void }) {
  const handleOpenMaps = () => {
    const mapsUrl = Platform.select({
      ios: `maps:?q=${encodeURIComponent(restaurant.name)}&ll=${restaurant.latitude},${restaurant.longitude}`,
      android: `geo:${restaurant.latitude},${restaurant.longitude}?q=${encodeURIComponent(restaurant.name)}`,
      default: `https://www.google.com/maps/search/?api=1&query=${restaurant.latitude},${restaurant.longitude}`,
    });
    if (mapsUrl) {
      Linking.openURL(mapsUrl);
    }
  };

  const handleCall = () => {
    if (restaurant.phone) {
      Linking.openURL(`tel:${restaurant.phone}`);
    }
  };

  const handleOpenWebsite = () => {
    if (restaurant.website) {
      const url = restaurant.website.startsWith("http") ? restaurant.website : `https://${restaurant.website}`;
      Linking.openURL(url);
    }
  };

  const hasDetails =
    restaurant.address ||
    restaurant.cuisine ||
    restaurant.priceLevel ||
    restaurant.phone ||
    restaurant.website ||
    restaurant.notes;

  return (
    <View>
      <Card animated={false}>
        <View className={"p-4 gap-4"}>
          {/* Header with edit button */}
          <View className={"flex-row items-start justify-between"}>
            <View className={"flex-1 gap-1"}>
              <ThemedText variant={"largeTitle"} className={"font-bold"}>
                {restaurant.name}
              </ThemedText>
              {restaurant.cuisine && (
                <View className={"flex-row items-center gap-2"}>
                  <ThemedText variant={"subhead"} color={"secondary"}>
                    {restaurant.cuisine}
                  </ThemedText>
                  {restaurant.priceLevel && (
                    <ThemedText variant={"subhead"} color={"tertiary"}>
                      · {formatPriceLevel(restaurant.priceLevel)}
                    </ThemedText>
                  )}
                </View>
              )}
            </View>
          </View>

          {/* Details */}
          {hasDetails && (
            <View className={"gap-3"}>
              {restaurant.address && (
                <Pressable onPress={handleOpenMaps} className={"flex-row items-center gap-3"}>
                  <View className={"w-8 h-8 rounded-full bg-blue-500/15 items-center justify-center"}>
                    <IconSymbol name={"location.fill"} size={14} color={"#3b82f6"} />
                  </View>
                  <View className={"flex-1"}>
                    <ThemedText variant={"footnote"} color={"tertiary"}>
                      Address
                    </ThemedText>
                    <ThemedText variant={"subhead"} className={"text-blue-400"}>
                      {restaurant.address}
                    </ThemedText>
                  </View>
                </Pressable>
              )}

              {restaurant.phone && (
                <Pressable onPress={handleCall} className={"flex-row items-center gap-3"}>
                  <View className={"w-8 h-8 rounded-full bg-green-500/15 items-center justify-center"}>
                    <IconSymbol name={"phone.fill"} size={14} color={"#22c55e"} />
                  </View>
                  <View className={"flex-1"}>
                    <ThemedText variant={"footnote"} color={"tertiary"}>
                      Phone
                    </ThemedText>
                    <ThemedText variant={"subhead"} className={"text-green-400"}>
                      {restaurant.phone}
                    </ThemedText>
                  </View>
                </Pressable>
              )}

              {restaurant.website && (
                <Pressable onPress={handleOpenWebsite} className={"flex-row items-center gap-3"}>
                  <View className={"w-8 h-8 rounded-full bg-purple-500/15 items-center justify-center"}>
                    <IconSymbol name={"globe"} size={14} color={"#a855f7"} />
                  </View>
                  <View className={"flex-1"}>
                    <ThemedText variant={"footnote"} color={"tertiary"}>
                      Website
                    </ThemedText>
                    <ThemedText variant={"subhead"} className={"text-purple-400"} numberOfLines={1}>
                      {restaurant.website.replace(/^https?:\/\//, "")}
                    </ThemedText>
                  </View>
                </Pressable>
              )}

              {restaurant.notes && (
                <View className={"flex-row items-start gap-3 pt-2 border-t border-white/5"}>
                  <View className={"w-8 h-8 rounded-full bg-amber-500/15 items-center justify-center"}>
                    <IconSymbol name={"note.text"} size={14} color={"#f59e0b"} />
                  </View>
                  <View className={"flex-1"}>
                    <ThemedText variant={"footnote"} color={"tertiary"}>
                      Notes
                    </ThemedText>
                    <ThemedText variant={"body"} color={"secondary"}>
                      {restaurant.notes}
                    </ThemedText>
                  </View>
                </View>
              )}
            </View>
          )}

          {/* Empty state for no details */}
          {!hasDetails && (
            <Pressable onPress={onEdit} className={"py-4 items-center gap-2 bg-secondary/50 rounded-lg"}>
              <IconSymbol name={"plus.circle"} size={24} color={"#6b7280"} />
              <ThemedText variant={"footnote"} color={"tertiary"}>
                Add restaurant details
              </ThemedText>
            </Pressable>
          )}
        </View>
      </Card>
    </View>
  );
}

function getAwardIcon(distinction: string): { name: string; color: string } {
  const d = distinction.toLowerCase();
  if (d.includes("3 star")) {
    return { name: "star.fill", color: "#fbbf24" }; // Gold
  }
  if (d.includes("2 star")) {
    return { name: "star.fill", color: "#a3a3a3" }; // Silver
  }
  if (d.includes("1 star")) {
    return { name: "star.fill", color: "#b45309" }; // Bronze
  }
  if (d.includes("bib")) {
    return { name: "face.smiling.fill", color: "#ef4444" }; // Red for Bib Gourmand
  }
  return { name: "checkmark.seal.fill", color: "#3b82f6" }; // Blue for Selected/other
}

function MichelinAwardHistoryCard({ awards }: { awards: MichelinAward[] }) {
  if (awards.length === 0) {
    return null;
  }

  return (
    <View>
      <Card animated={false}>
        <View className={"p-4 gap-4"}>
          {/* Header */}
          <View className={"flex-row items-center gap-2"}>
            <View className={"w-8 h-8 rounded-full bg-red-500/15 items-center justify-center"}>
              <IconSymbol name={"star.circle.fill"} size={18} color={"#ef4444"} />
            </View>
            <View className={"flex-1"}>
              <ThemedText variant={"heading"} className={"font-semibold"}>
                Michelin Guide History
              </ThemedText>
              <ThemedText variant={"footnote"} color={"tertiary"}>
                {awards.length} {awards.length === 1 ? "year" : "years"} of recognition
              </ThemedText>
            </View>
          </View>

          {/* Awards Timeline */}
          <View className={"gap-3"}>
            {awards.map((award, index) => {
              const icon = getAwardIcon(award.distinction);
              const isFirst = index === 0;

              return (
                <View key={award.year} className={"flex-row items-center gap-3"}>
                  {/* Timeline connector */}
                  <View className={"items-center"}>
                    <View
                      className={`w-8 h-8 rounded-full items-center justify-center ${
                        isFirst ? "bg-yellow-500/20" : "bg-secondary"
                      }`}
                    >
                      <IconSymbol
                        name={icon.name as "star.fill"}
                        size={isFirst ? 16 : 14}
                        color={isFirst ? icon.color : "#6b7280"}
                      />
                    </View>
                    {index < awards.length - 1 && <View className={"w-0.5 h-4 bg-white/10 mt-1"} />}
                  </View>

                  {/* Award details */}
                  <View className={"flex-1 flex-row items-center justify-between"}>
                    <View className={"flex-1"}>
                      <View className={"flex-row items-center gap-2"}>
                        <ThemedText
                          variant={isFirst ? "subhead" : "footnote"}
                          className={isFirst ? "font-semibold" : ""}
                        >
                          {award.distinction}
                        </ThemedText>
                        {award.greenStar && (
                          <View className={"bg-green-500/20 px-1.5 py-0.5 rounded"}>
                            <ThemedText variant={"caption2"} className={"text-green-400 font-medium"}>
                              🌿 Green
                            </ThemedText>
                          </View>
                        )}
                      </View>
                      {award.price && (
                        <ThemedText variant={"caption1"} color={"tertiary"}>
                          {award.price}
                        </ThemedText>
                      )}
                    </View>
                    <ThemedText
                      variant={isFirst ? "subhead" : "footnote"}
                      color={isFirst ? "primary" : "tertiary"}
                      className={isFirst ? "font-semibold" : ""}
                    >
                      {award.year}
                    </ThemedText>
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      </Card>
    </View>
  );
}

// Quick date option for the add visit modal
interface DateOption {
  label: string;
  getDate: () => Date;
}

const DATE_OPTIONS: DateOption[] = [
  { label: "Today", getDate: () => new Date() },
  {
    label: "Yesterday",
    getDate: () => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d;
    },
  },
  {
    label: "2 days ago",
    getDate: () => {
      const d = new Date();
      d.setDate(d.getDate() - 2);
      return d;
    },
  },
  {
    label: "Last week",
    getDate: () => {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      return d;
    },
  },
];

function AddVisitModal({
  visible,
  onClose,
  onSave,
  restaurantName,
  isLoading,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: (date: Date, notes?: string) => Promise<void>;
  restaurantName: string;
  isLoading: boolean;
}) {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [notes, setNotes] = useState("");
  const [customDateStr, setCustomDateStr] = useState("");
  const [showCustomDate, setShowCustomDate] = useState(false);

  const handleSelectQuickDate = (option: DateOption) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const date = option.getDate();
    setSelectedDate(date);
    setShowCustomDate(false);
    setCustomDateStr("");
  };

  const handleCustomDateChange = (text: string) => {
    setCustomDateStr(text);
    // Try to parse date in format YYYY-MM-DD or MM/DD/YYYY
    const parsed = new Date(text);
    if (!isNaN(parsed.getTime()) && parsed <= new Date()) {
      setSelectedDate(parsed);
    }
  };

  const handleSave = async () => {
    await onSave(selectedDate, notes.trim() || undefined);
    setNotes("");
    setCustomDateStr("");
    setShowCustomDate(false);
    setSelectedDate(new Date());
  };

  const formatSelectedDate = (date: Date) => {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return "Today";
    }
    if (date.toDateString() === yesterday.toDateString()) {
      return "Yesterday";
    }
    return date.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
    });
  };

  return (
    <Modal visible={visible} animationType={"slide"} presentationStyle={"pageSheet"}>
      <View className={"flex-1 bg-background"}>
        {/* Header */}
        <View className={"flex-row items-center justify-between p-4 border-b border-white/10"}>
          <Pressable onPress={onClose} hitSlop={12}>
            <ThemedText variant={"body"} className={"text-primary"}>
              Cancel
            </ThemedText>
          </Pressable>
          <ThemedText variant={"subhead"} className={"font-semibold"}>
            Add Visit
          </ThemedText>
          <View style={{ width: 50 }} />
        </View>

        <ScrollView className={"flex-1"} contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
          <View className={"gap-6"}>
            {/* Restaurant Name */}
            <View className={"gap-2"}>
              <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase font-semibold tracking-wide"}>
                Restaurant
              </ThemedText>
              <View className={"bg-secondary rounded-xl p-4 flex-row items-center gap-3"}>
                <View className={"w-10 h-10 rounded-full bg-primary/20 items-center justify-center"}>
                  <IconSymbol name={"fork.knife"} size={18} color={"#3b82f6"} />
                </View>
                <ThemedText variant={"body"} className={"font-medium flex-1"} numberOfLines={2}>
                  {restaurantName}
                </ThemedText>
              </View>
            </View>

            {/* Date Selection */}
            <View className={"gap-3"}>
              <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase font-semibold tracking-wide"}>
                When did you visit?
              </ThemedText>

              {/* Quick date options */}
              <View className={"flex-row flex-wrap gap-2"}>
                {DATE_OPTIONS.map((option) => {
                  const optionDate = option.getDate();
                  const isSelected = selectedDate.toDateString() === optionDate.toDateString() && !showCustomDate;
                  return (
                    <Pressable
                      key={option.label}
                      onPress={() => handleSelectQuickDate(option)}
                      className={`px-4 py-2.5 rounded-full ${isSelected ? "bg-primary" : "bg-secondary"}`}
                    >
                      <ThemedText
                        variant={"subhead"}
                        className={isSelected ? "text-primary-foreground font-semibold" : ""}
                      >
                        {option.label}
                      </ThemedText>
                    </Pressable>
                  );
                })}
                <Pressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setShowCustomDate(true);
                  }}
                  className={`px-4 py-2.5 rounded-full ${showCustomDate ? "bg-primary" : "bg-secondary"}`}
                >
                  <ThemedText
                    variant={"subhead"}
                    className={showCustomDate ? "text-primary-foreground font-semibold" : ""}
                  >
                    Other...
                  </ThemedText>
                </Pressable>
              </View>

              {/* Custom date input */}
              {showCustomDate && (
                <View className={"gap-2"}>
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    Enter date (YYYY-MM-DD)
                  </ThemedText>
                  <TextInput
                    value={customDateStr}
                    onChangeText={handleCustomDateChange}
                    placeholder={"2024-01-15"}
                    placeholderTextColor={"#6b7280"}
                    keyboardType={"numbers-and-punctuation"}
                    className={"bg-secondary rounded-lg px-4 py-3 text-foreground"}
                  />
                </View>
              )}

              {/* Selected date display */}
              <View className={"bg-green-500/10 rounded-xl p-4 flex-row items-center gap-3"}>
                <View className={"w-10 h-10 rounded-full bg-green-500/20 items-center justify-center"}>
                  <IconSymbol name={"calendar"} size={18} color={"#22c55e"} />
                </View>
                <View className={"flex-1"}>
                  <ThemedText variant={"footnote"} color={"tertiary"}>
                    Visit date
                  </ThemedText>
                  <ThemedText variant={"body"} className={"font-medium text-green-400"}>
                    {formatSelectedDate(selectedDate)}
                  </ThemedText>
                </View>
              </View>
            </View>

            {/* Notes */}
            <View className={"gap-2"}>
              <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase font-semibold tracking-wide"}>
                Notes (optional)
              </ThemedText>
              <TextInput
                value={notes}
                onChangeText={setNotes}
                placeholder={"What did you have? How was it?"}
                placeholderTextColor={"#6b7280"}
                multiline
                numberOfLines={3}
                className={"bg-secondary rounded-lg px-4 py-3 text-foreground"}
                style={{ minHeight: 80, textAlignVertical: "top" }}
              />
            </View>

            {/* Save Button */}
            <Button onPress={handleSave} loading={isLoading} className={"mt-4"}>
              <ThemedText variant={"body"} className={"text-primary-foreground font-semibold"}>
                Add Visit
              </ThemedText>
            </Button>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function MichelinDetailsCard({ details }: { details: MichelinRestaurantDetails }) {
  const hasContent = details.description || details.facilitiesAndServices || details.url;

  if (!hasContent) {
    return null;
  }

  const handleOpenMichelinGuide = () => {
    if (details.url) {
      Linking.openURL(details.url);
    }
  };

  // Parse facilities string into an array
  const facilities = details.facilitiesAndServices
    ? details.facilitiesAndServices
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
    : [];

  return (
    <View>
      <Card animated={false}>
        <View className={"p-4 gap-4"}>
          {/* Header */}
          <View className={"flex-row items-center gap-2"}>
            <View className={"w-8 h-8 rounded-full bg-red-500/15 items-center justify-center"}>
              <IconSymbol name={"book.fill"} size={16} color={"#ef4444"} />
            </View>
            <ThemedText variant={"heading"} className={"font-semibold"}>
              Michelin Guide
            </ThemedText>
          </View>

          {/* Description */}
          {details.description && (
            <View className={"gap-1"}>
              <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase tracking-wide"}>
                Inspector's Notes
              </ThemedText>
              <ScrollView
                style={{ maxHeight: 120 }}
                showsVerticalScrollIndicator
                nestedScrollEnabled
                className={"bg-secondary/30 rounded-lg p-2 -mx-1"}
              >
                <ThemedText variant={"body"} color={"secondary"} className={"leading-relaxed"}>
                  {details.description}
                </ThemedText>
              </ScrollView>
            </View>
          )}

          {/* Facilities & Services */}
          {facilities.length > 0 && (
            <View className={"gap-2"}>
              <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase tracking-wide"}>
                Facilities & Services
              </ThemedText>
              <View className={"flex-row flex-wrap gap-2"}>
                {facilities.map((facility, index) => (
                  <View key={index} className={"bg-secondary px-2.5 py-1.5 rounded-full"}>
                    <ThemedText variant={"caption1"} color={"secondary"}>
                      {facility}
                    </ThemedText>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Michelin Guide Link */}
          {details.url && (
            <Pressable
              onPress={handleOpenMichelinGuide}
              className={"flex-row items-center justify-between bg-red-500/10 p-3 rounded-xl mt-1"}
            >
              <View className={"flex-row items-center gap-3"}>
                <IconSymbol name={"link"} size={16} color={"#ef4444"} />
                <ThemedText variant={"subhead"} className={"text-red-400 font-medium"}>
                  View on Michelin Guide
                </ThemedText>
              </View>
              <IconSymbol name={"arrow.up.right"} size={14} color={"#ef4444"} />
            </Pressable>
          )}
        </View>
      </Card>
    </View>
  );
}

export default function RestaurantDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [addVisitModalVisible, setAddVisitModalVisible] = useState(false);

  const { data: restaurant } = useRestaurantDetail(id);
  const { data: visits = [] } = useRestaurantVisits(id);
  const updateRestaurantMutation = useUpdateRestaurant(id);
  const createManualVisitMutation = useCreateManualVisit();

  // Track restaurant view
  useEffect(() => {
    if (id && restaurant?.name) {
      logRestaurantViewed(parseInt(id.replace(/\D/g, ""), 10) || 0, restaurant.name);
    }
  }, [id, restaurant?.name]);

  // Check if this is a Michelin restaurant and fetch award history
  const isMichelinRestaurant = id?.startsWith("michelin-") ?? false;
  const { data: michelinDetails } = useMichelinRestaurantDetails(isMichelinRestaurant ? id : undefined);

  const restaurantName = restaurant?.name ?? "Restaurant";

  const handleSaveRestaurant = async (data: UpdateRestaurantData) => {
    await updateRestaurantMutation.mutateAsync(data);
  };

  const handleAddVisit = async (date: Date, notes?: string) => {
    if (!restaurant || !id) {
      return;
    }

    try {
      await createManualVisitMutation.mutateAsync({
        restaurantId: id,
        restaurantName: restaurant.name,
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
        visitDate: date.getTime(),
        notes: notes ?? null,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setAddVisitModalVisible(false);
    } catch (error) {
      console.error("Error creating manual visit:", error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const renderItem = useCallback(({ item }: { item: VisitRecord }) => <VisitHistoryCard visit={item} />, []);

  const ListHeader = useCallback(
    () => (
      <View className={"gap-6"}>
        {restaurant && <RestaurantInfoCard restaurant={restaurant} onEdit={() => setEditModalVisible(true)} />}

        {/* Michelin Details */}
        {michelinDetails && <MichelinDetailsCard details={michelinDetails} />}

        {/* Michelin Award History */}
        {michelinDetails?.awards && michelinDetails.awards.length > 0 && (
          <MichelinAwardHistoryCard awards={michelinDetails.awards} />
        )}

        {/* Visit History Header with Add Button */}
        <View className={"flex-row items-center justify-between"}>
          <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase font-semibold tracking-wide px-1"}>
            Visit History
          </ThemedText>
          <View className={"flex-row items-center gap-3"}>
            <ThemedText variant={"footnote"} color={"tertiary"}>
              {visits.length.toLocaleString()} {visits.length === 1 ? "visit" : "visits"}
            </ThemedText>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setAddVisitModalVisible(true);
              }}
              className={"bg-primary/20 rounded-full p-1.5"}
              hitSlop={8}
            >
              <IconSymbol name={"plus"} size={14} color={"#3b82f6"} />
            </Pressable>
          </View>
        </View>
      </View>
    ),
    [restaurant, visits.length, michelinDetails],
  );

  const ItemSeparator = useCallback(() => <View style={{ height: 16 }} />, []);

  return (
    <>
      <Stack.Screen
        options={{
          title: restaurantName,
          headerRight: () => (
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setEditModalVisible(true);
              }}
              hitSlop={12}
            >
              <IconSymbol name={"pencil"} size={20} color={"#3b82f6"} />
            </Pressable>
          ),
        }}
        key={restaurant?.id}
      />
      <ScreenLayout scrollable={false} className={"p-0"} style={{ paddingTop: 0, paddingBottom: 0 }}>
        <FlashList
          data={visits}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{
            paddingTop: headerHeight + 16,
            paddingBottom: insets.bottom + 32,
            paddingHorizontal: 16,
          }}
          ListHeaderComponent={ListHeader}
          ListHeaderComponentStyle={{ marginBottom: 16 }}
          ItemSeparatorComponent={ItemSeparator}
        />
      </ScreenLayout>

      {/* Edit Modal */}
      {restaurant && (
        <RestaurantEditModal
          visible={editModalVisible}
          key={restaurant.id}
          onClose={() => setEditModalVisible(false)}
          onSave={handleSaveRestaurant}
          restaurant={restaurant}
        />
      )}

      {/* Add Visit Modal */}
      <AddVisitModal
        visible={addVisitModalVisible}
        onClose={() => setAddVisitModalVisible(false)}
        onSave={handleAddVisit}
        restaurantName={restaurantName}
        key={restaurant ? `${restaurant.id}-add-visit-modal` : undefined}
        isLoading={createManualVisitMutation.isPending}
      />
    </>
  );
}

import React, { useCallback, useMemo, useState } from "react";
import { View, Alert, RefreshControl, ScrollView, Pressable, Linking, TextInput, Modal, FlatList } from "react-native";
import { useToast } from "@/components/ui/toast";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { ExportButton, StatsCard } from "@/components/home";
import { IconSymbol } from "@/components/icon-symbol";
import type { SymbolViewProps } from "expo-symbols";
import { nukeDatabase } from "@/utils/db";
import {
  useAppStore,
  useFastAnimations,
  useHideUndoBar,
  useGoogleMapsApiKey,
  useSetFastAnimations,
  useSetHideUndoBar,
  useSetGoogleMapsApiKey,
  useSelectedCalendarIds,
  useSetSelectedCalendarIds,
} from "@/store";

import {
  useStats,
  useIgnoredLocations,
  useRemoveIgnoredLocation,
  useWritableCalendars,
  useSyncableCalendars,
  useVisitsWithoutCalendarEvents,
  useCreateCalendarEventsForVisits,
  useExportedCalendarEvents,
  useDeleteExportedCalendarEvents,
  useFoodKeywords,
  useAddFoodKeyword,
  useRemoveFoodKeyword,
  useToggleFoodKeyword,
  useResetFoodKeywords,
  useReclassifyPhotos,
  usePhotosWithLabelsCount,
  useRecomputeSuggestedRestaurants,
  useMergeableSameRestaurantVisits,
  useBatchMergeSameRestaurantVisits,
  useDeepScan,
  type IgnoredLocationRecord,
  type WritableCalendar,
  type FoodKeywordRecord,
  type ReclassifyProgress,
  type DeepScanProgress,
  type MergeableVisitGroup,
} from "@/hooks/queries";
import Animated, { FadeInDown } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { hasCalendarPermission, requestCalendarPermission } from "@/services/calendar";

// ─────────────────────────────────────────────────────────────────────────────
// Section Header Component
// ─────────────────────────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: string }) {
  return (
    <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase font-semibold tracking-wide px-1 mb-3"}>
      {children}
    </ThemedText>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Card Icon Component
// ─────────────────────────────────────────────────────────────────────────────

function CardIcon({ name, color, bgColor }: { name: SymbolViewProps["name"]; color: string; bgColor: string }) {
  return (
    <View className={`w-10 h-10 rounded-full items-center justify-center ${bgColor}`}>
      <IconSymbol name={name} size={20} color={color} />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Maps API Key Card
// ─────────────────────────────────────────────────────────────────────────────

function GoogleMapsApiKeyCard() {
  const { showToast } = useToast();
  const googleMapsApiKey = useGoogleMapsApiKey();
  const setGoogleMapsApiKey = useSetGoogleMapsApiKey();
  const [apiKeyInput, setApiKeyInput] = useState(googleMapsApiKey ?? "");
  const [isApiKeyVisible, setIsApiKeyVisible] = useState(false);

  const handleSaveApiKey = useCallback(() => {
    const trimmedKey = apiKeyInput.trim();
    setGoogleMapsApiKey(trimmedKey || null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    showToast({
      type: "success",
      message: trimmedKey ? "Google Maps API key saved" : "Google Maps API key removed",
    });
  }, [apiKeyInput, setGoogleMapsApiKey, showToast]);

  return (
    <Card animated={false}>
      <View className={"p-4 gap-4"}>
        <View className={"flex-row items-center gap-3"}>
          <CardIcon name={"map.fill"} color={"#22c55e"} bgColor={"bg-green-500/15"} />
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Google Maps API Key
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Required for restaurant search and nearby places
            </ThemedText>
          </View>
          {googleMapsApiKey && (
            <View className={"bg-green-500/15 px-2 py-1 rounded-full"}>
              <ThemedText variant={"caption2"} className={"text-green-500 font-medium"}>
                Active
              </ThemedText>
            </View>
          )}
        </View>
        <View className={"gap-2"}>
          <View className={"flex-row items-center gap-2"}>
            <View className={"flex-1 bg-background/50 rounded-xl overflow-hidden"}>
              <TextInput
                className={"px-4 py-3 text-foreground"}
                placeholder={"Enter your API key"}
                placeholderTextColor={"#9ca3af"}
                value={apiKeyInput}
                onChangeText={setApiKeyInput}
                secureTextEntry={!isApiKeyVisible}
                autoCapitalize={"none"}
                autoCorrect={false}
              />
            </View>
            <Pressable
              onPress={() => setIsApiKeyVisible(!isApiKeyVisible)}
              className={"p-3 bg-background/50 rounded-xl"}
              hitSlop={8}
            >
              <IconSymbol name={isApiKeyVisible ? "eye.slash.fill" : "eye.fill"} size={18} color={"#9ca3af"} />
            </Pressable>
          </View>
          <Button
            variant={"secondary"}
            onPress={handleSaveApiKey}
            disabled={apiKeyInput.trim() === (googleMapsApiKey ?? "")}
          >
            <ButtonText variant={"secondary"}>{apiKeyInput.trim() ? "Save API Key" : "Remove API Key"}</ButtonText>
          </Button>
        </View>
        <Pressable
          onPress={() => Linking.openURL("https://console.cloud.google.com/apis/credentials")}
          className={"flex-row items-center gap-2"}
        >
          <IconSymbol name={"questionmark.circle"} size={14} color={"#3b82f6"} />
          <ThemedText variant={"caption1"} className={"text-blue-500"}>
            Get an API key from Google Cloud Console
          </ThemedText>
        </Pressable>
      </View>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar Section - All calendar-related settings in one place
// ─────────────────────────────────────────────────────────────────────────────

function CalendarSection() {
  const { showToast } = useToast();

  // Section collapsed state
  const [isExpanded, setIsExpanded] = useState(false);

  // Calendar Sync state
  const {
    data: syncableCalendars = [],
    isLoading: isLoadingSyncable,
    refetch: refetchSyncable,
  } = useSyncableCalendars();
  const selectedCalendarIds = useSelectedCalendarIds();
  const setSelectedCalendarIds = useSetSelectedCalendarIds();
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isSourcesExpanded, setIsSourcesExpanded] = useState(false);

  // Calendar Export state
  const [isExportModalVisible, setIsExportModalVisible] = useState(false);
  const [selectedExportCalendar, setSelectedExportCalendar] = useState<WritableCalendar | null>(null);
  const {
    data: writableCalendars = [],
    isLoading: _isLoadingWritable,
    refetch: refetchWritable,
  } = useWritableCalendars();
  const { data: visitsWithoutEvents = [], isLoading: isLoadingVisits } = useVisitsWithoutCalendarEvents();
  const createEventsMutation = useCreateCalendarEventsForVisits();

  // Delete exported events state
  const { data: exportedEvents = [], isLoading: isLoadingExported } = useExportedCalendarEvents();
  const deleteEventsMutation = useDeleteExportedCalendarEvents();

  const visitCount = visitsWithoutEvents.length;
  const eventCount = exportedEvents.length;
  const selectedCount = selectedCalendarIds === null ? syncableCalendars.length : selectedCalendarIds.length;
  const isAllSelected = selectedCalendarIds === null;

  // Check permission on mount
  React.useEffect(() => {
    hasCalendarPermission().then(setHasPermission).catch(console.error);
  }, []);

  const handleRequestPermission = useCallback(async () => {
    const granted = await requestCalendarPermission();
    setHasPermission(granted);
    if (granted) {
      refetchSyncable();
      refetchWritable();
      showToast({ type: "success", message: "Calendar access granted" });
    } else {
      showToast({ type: "error", message: "Calendar access denied" });
    }
  }, [refetchSyncable, refetchWritable, showToast]);

  // Calendar sync handlers
  const handleToggleCalendar = useCallback(
    (calendarId: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      if (selectedCalendarIds === null) {
        setSelectedCalendarIds(syncableCalendars.map((c) => c.id).filter((id) => id !== calendarId));
      } else {
        const isCurrentlySelected = selectedCalendarIds.includes(calendarId);
        if (isCurrentlySelected) {
          const newIds = selectedCalendarIds.filter((id) => id !== calendarId);
          setSelectedCalendarIds(newIds.length === 0 ? null : newIds);
        } else {
          setSelectedCalendarIds([...selectedCalendarIds, calendarId]);
        }
      }
    },
    [selectedCalendarIds, setSelectedCalendarIds, syncableCalendars],
  );

  const handleSelectAll = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedCalendarIds(null);
    showToast({ type: "success", message: "Syncing from all calendars" });
  }, [setSelectedCalendarIds, showToast]);

  const isCalendarSelected = useCallback(
    (calendarId: string) => {
      if (selectedCalendarIds === null) {
        return true;
      }
      return selectedCalendarIds.includes(calendarId);
    },
    [selectedCalendarIds],
  );

  // Export handlers
  const handleOpenExportModal = useCallback(() => {
    if (hasPermission === false) {
      handleRequestPermission();
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsExportModalVisible(true);
  }, [hasPermission, handleRequestPermission]);

  const handleSelectExportCalendar = useCallback((calendar: WritableCalendar) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedExportCalendar(calendar);
  }, []);

  const handleCreateEvents = useCallback(async () => {
    if (!selectedExportCalendar || visitCount === 0) {
      return;
    }

    setIsExportModalVisible(false);

    Alert.alert(
      "Create Calendar Events",
      `This will create ${visitCount.toLocaleString()} calendar event${visitCount === 1 ? "" : "s"} in "${selectedExportCalendar.title}" for your confirmed restaurant visits.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Create Events",
          style: "default",
          onPress: async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              const result = await createEventsMutation.mutateAsync({
                visits: visitsWithoutEvents,
                calendarId: selectedExportCalendar.id,
              });

              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              if (result.failed > 0) {
                showToast({
                  type: "success",
                  message: `Created ${result.created.toLocaleString()} events (${result.failed} failed)`,
                });
              } else {
                showToast({
                  type: "success",
                  message: `Created ${result.created.toLocaleString()} calendar event${result.created === 1 ? "" : "s"}`,
                });
              }
            } catch (error) {
              console.error("Error creating calendar events:", error);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              showToast({ type: "error", message: "Failed to create calendar events" });
            }
          },
        },
      ],
    );
  }, [selectedExportCalendar, visitCount, visitsWithoutEvents, createEventsMutation, showToast]);

  // Delete exported events handler
  const handleDeleteAllEvents = useCallback(() => {
    if (eventCount === 0) {
      return;
    }

    Alert.alert(
      "Delete Exported Calendar Events",
      `This will delete ${eventCount.toLocaleString()} calendar event${eventCount === 1 ? "" : "s"} that were created by this app. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete All",
          style: "destructive",
          onPress: async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              const result = await deleteEventsMutation.mutateAsync(exportedEvents);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              if (result.failed > 0) {
                showToast({
                  type: "success",
                  message: `Deleted ${result.deleted.toLocaleString()} events (${result.failed} failed)`,
                });
              } else {
                showToast({
                  type: "success",
                  message: `Deleted ${result.deleted.toLocaleString()} calendar event${result.deleted === 1 ? "" : "s"}`,
                });
              }
            } catch (error) {
              console.error("Error deleting calendar events:", error);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              showToast({ type: "error", message: "Failed to delete calendar events" });
            }
          },
        },
      ],
    );
  }, [eventCount, exportedEvents, deleteEventsMutation, showToast]);

  // If no permission, show the permission request card
  if (hasPermission === false) {
    return (
      <Card animated={false}>
        <View className={"p-4 gap-4"}>
          <View className={"flex-row items-center gap-3"}>
            <CardIcon name={"calendar"} color={"#3b82f6"} bgColor={"bg-blue-500/15"} />
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-medium"}>
                Calendar Integration
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Grant access to sync and export calendar events
              </ThemedText>
            </View>
          </View>
          <Button variant={"secondary"} onPress={handleRequestPermission}>
            <IconSymbol name={"calendar"} size={16} color={"#3b82f6"} />
            <ButtonText variant={"secondary"} className={"ml-2"}>
              Grant Calendar Access
            </ButtonText>
          </Button>
        </View>
      </Card>
    );
  }

  return (
    <>
      <Card animated={false}>
        {/* Header - Collapsible Toggle */}
        <Pressable onPress={() => setIsExpanded(!isExpanded)}>
          <View className={"p-4 flex-row items-center gap-3"}>
            <CardIcon name={"calendar"} color={"#3b82f6"} bgColor={"bg-blue-500/15"} />
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-medium"}>
                Calendar Integration
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Import reservations and export visits
              </ThemedText>
            </View>
            <IconSymbol name={isExpanded ? "chevron.up" : "chevron.down"} size={16} color={"#9ca3af"} />
          </View>
        </Pressable>

        {isExpanded && (
          <View className={"px-4 pb-4 gap-4"}>
            {/* Calendar Sources - Expandable */}
            <View className={"bg-background/30 rounded-xl overflow-hidden"}>
              <Pressable
                onPress={() => setIsSourcesExpanded(!isSourcesExpanded)}
                className={"p-3 flex-row items-center justify-between"}
              >
                <View className={"flex-row items-center gap-3"}>
                  <IconSymbol name={"list.bullet"} size={18} color={"#3b82f6"} />
                  <View>
                    <ThemedText variant={"subhead"} className={"font-medium"}>
                      Calendar Sources
                    </ThemedText>
                    <ThemedText variant={"caption1"} color={"tertiary"}>
                      {isLoadingSyncable
                        ? "Loading..."
                        : isAllSelected
                          ? `All ${syncableCalendars.length} calendar${syncableCalendars.length === 1 ? "" : "s"}`
                          : `${selectedCount} of ${syncableCalendars.length} selected`}
                    </ThemedText>
                  </View>
                </View>
                <IconSymbol name={isSourcesExpanded ? "chevron.up" : "chevron.down"} size={16} color={"#9ca3af"} />
              </Pressable>

              {isSourcesExpanded && (
                <View className={"px-3 pb-3 gap-2"}>
                  {/* Select All */}
                  {syncableCalendars.length > 1 && (
                    <Pressable
                      onPress={handleSelectAll}
                      className={"flex-row items-center justify-between py-2 px-3 bg-background/50 rounded-xl"}
                    >
                      <View className={"flex-row items-center gap-3"}>
                        <IconSymbol
                          name={isAllSelected ? "checkmark.circle.fill" : "circle"}
                          size={22}
                          color={isAllSelected ? "#3b82f6" : "#6b7280"}
                        />
                        <ThemedText variant={"subhead"} className={"font-medium"}>
                          All Calendars
                        </ThemedText>
                      </View>
                      {isAllSelected && (
                        <View className={"bg-blue-500/15 px-2 py-1 rounded-full"}>
                          <ThemedText variant={"caption2"} className={"text-blue-500 font-medium"}>
                            Active
                          </ThemedText>
                        </View>
                      )}
                    </Pressable>
                  )}

                  {/* Calendar List */}
                  {syncableCalendars.map((calendar) => {
                    const isSelected = isCalendarSelected(calendar.id);
                    return (
                      <Pressable
                        key={calendar.id}
                        onPress={() => handleToggleCalendar(calendar.id)}
                        className={"flex-row items-center gap-3 py-2 px-3 bg-background/50 rounded-xl"}
                      >
                        <View className={"w-4 h-4 rounded-full"} style={{ backgroundColor: calendar.color }} />
                        <View className={"flex-1"}>
                          <ThemedText variant={"subhead"} className={"font-medium"} numberOfLines={1}>
                            {calendar.title}
                          </ThemedText>
                          <ThemedText variant={"caption2"} color={"tertiary"}>
                            {calendar.source}
                          </ThemedText>
                        </View>
                        <IconSymbol
                          name={isSelected ? "checkmark.circle.fill" : "circle"}
                          size={22}
                          color={isSelected ? "#3b82f6" : "#6b7280"}
                        />
                      </Pressable>
                    );
                  })}

                  {syncableCalendars.length === 0 && !isLoadingSyncable && (
                    <View className={"items-center py-4"}>
                      <ThemedText variant={"footnote"} color={"tertiary"}>
                        No calendars found
                      </ThemedText>
                    </View>
                  )}
                </View>
              )}
            </View>

            {/* Import from Calendar */}
            <Pressable
              onPress={() => router.push("/calendar-import")}
              className={"bg-background/30 rounded-xl p-3 flex-row items-center justify-between"}
            >
              <View className={"flex-row items-center gap-3"}>
                <IconSymbol name={"calendar.badge.checkmark"} size={18} color={"#22c55e"} />
                <View>
                  <ThemedText variant={"subhead"} className={"font-medium"}>
                    Import Reservations
                  </ThemedText>
                  <ThemedText variant={"caption1"} color={"tertiary"}>
                    Match calendar events with visits
                  </ThemedText>
                </View>
              </View>
              <IconSymbol name={"chevron.right"} size={16} color={"#9ca3af"} />
            </Pressable>

            {/* Export to Calendar */}
            {(isLoadingVisits || visitCount > 0) && (
              <View className={"bg-background/30 rounded-xl p-3 gap-3"}>
                <View className={"flex-row items-center gap-3"}>
                  <IconSymbol name={"calendar.badge.plus"} size={18} color={"#8b5cf6"} />
                  <View className={"flex-1"}>
                    <ThemedText variant={"subhead"} className={"font-medium"}>
                      Export to Calendar
                    </ThemedText>
                    <ThemedText variant={"caption1"} color={"tertiary"}>
                      {isLoadingVisits
                        ? "Loading..."
                        : `${visitCount.toLocaleString()} visit${visitCount === 1 ? "" : "s"} without events`}
                    </ThemedText>
                  </View>
                </View>
                <Button
                  variant={"secondary"}
                  size={"sm"}
                  onPress={handleOpenExportModal}
                  disabled={isLoadingVisits || visitCount === 0}
                  loading={createEventsMutation.isPending}
                >
                  <IconSymbol name={"calendar.badge.plus"} size={14} color={"#8b5cf6"} />
                  <ButtonText variant={"secondary"} className={"ml-2"}>
                    Choose Calendar
                  </ButtonText>
                </Button>
              </View>
            )}

            {/* Delete Exported Events */}
            {(isLoadingExported || eventCount > 0) && (
              <View className={"bg-background/30 rounded-xl p-3 gap-3"}>
                <View className={"flex-row items-center gap-3"}>
                  <IconSymbol name={"calendar.badge.minus"} size={18} color={"#ef4444"} />
                  <View className={"flex-1"}>
                    <ThemedText variant={"subhead"} className={"font-medium"}>
                      Exported Events
                    </ThemedText>
                    <ThemedText variant={"caption1"} color={"tertiary"}>
                      {isLoadingExported
                        ? "Loading..."
                        : `${eventCount.toLocaleString()} event${eventCount === 1 ? "" : "s"} created by this app`}
                    </ThemedText>
                  </View>
                </View>
                <Button
                  variant={"destructive"}
                  size={"sm"}
                  onPress={handleDeleteAllEvents}
                  disabled={isLoadingExported || eventCount === 0}
                  loading={deleteEventsMutation.isPending}
                >
                  <IconSymbol name={"trash"} size={14} color={"#fff"} />
                  <ButtonText variant={"destructive"} className={"ml-2"}>
                    Delete All
                  </ButtonText>
                </Button>
              </View>
            )}

            {/* Info */}
            <View className={"flex-row items-center gap-2"}>
              <IconSymbol name={"info.circle"} size={14} color={"#9ca3af"} />
              <ThemedText variant={"caption1"} color={"tertiary"}>
                Calendar events help match reservations with photo visits
              </ThemedText>
            </View>
          </View>
        )}
      </Card>

      {/* Calendar Export Selection Modal */}
      <Modal
        visible={isExportModalVisible}
        animationType={"slide"}
        presentationStyle={"pageSheet"}
        onRequestClose={() => setIsExportModalVisible(false)}
      >
        <View className={"flex-1 bg-background"}>
          {/* Modal Header */}
          <View className={"flex-row items-center justify-between px-4 py-4 border-b border-white/10"}>
            <Pressable onPress={() => setIsExportModalVisible(false)} hitSlop={8}>
              <ThemedText variant={"body"} className={"text-blue-500"}>
                Cancel
              </ThemedText>
            </Pressable>
            <ThemedText variant={"subhead"} className={"font-semibold"}>
              Select Calendar
            </ThemedText>
            <Pressable onPress={handleCreateEvents} disabled={!selectedExportCalendar} hitSlop={8}>
              <ThemedText
                variant={"body"}
                className={selectedExportCalendar ? "text-blue-500 font-semibold" : "text-gray-500"}
              >
                Done
              </ThemedText>
            </Pressable>
          </View>

          {/* Info Banner */}
          <View className={"px-4 py-3 bg-violet-500/10"}>
            <ThemedText variant={"footnote"} className={"text-violet-400"}>
              Select which calendar to add {visitCount.toLocaleString()} event{visitCount === 1 ? "" : "s"} to
            </ThemedText>
          </View>

          {/* Calendar List */}
          <FlatList<WritableCalendar>
            data={writableCalendars}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: 16 }}
            ItemSeparatorComponent={() => <View className={"h-2"} />}
            renderItem={({ item: calendar }) => {
              const isSelected = selectedExportCalendar?.id === calendar.id;
              return (
                <Pressable onPress={() => handleSelectExportCalendar(calendar)}>
                  <View
                    className={`p-4 rounded-xl border ${
                      isSelected ? "border-violet-500 bg-violet-500/10" : "border-white/10 bg-white/5"
                    }`}
                  >
                    <View className={"flex-row items-center gap-3"}>
                      <View className={"w-4 h-4 rounded-full"} style={{ backgroundColor: calendar.color }} />
                      <View className={"flex-1"}>
                        <ThemedText variant={"subhead"} className={"font-medium"}>
                          {calendar.title}
                        </ThemedText>
                        <ThemedText variant={"caption1"} color={"tertiary"}>
                          {calendar.source}
                          {calendar.isPrimary && " • Primary"}
                        </ThemedText>
                      </View>
                      {isSelected && <IconSymbol name={"checkmark.circle.fill"} size={22} color={"#8b5cf6"} />}
                    </View>
                  </View>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <View className={"items-center justify-center py-12"}>
                <IconSymbol name={"calendar.badge.exclamationmark"} size={48} color={"#6b7280"} />
                <ThemedText variant={"body"} color={"secondary"} className={"mt-4 text-center"}>
                  No writable calendars found
                </ThemedText>
                <ThemedText variant={"footnote"} color={"tertiary"} className={"mt-1 text-center"}>
                  Make sure you have calendar access enabled
                </ThemedText>
              </View>
            }
          />
        </View>
      </Modal>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// All Visits Card
// ─────────────────────────────────────────────────────────────────────────────

function AllVisitsCard() {
  return (
    <Pressable onPress={() => router.push("/visits")}>
      <Card animated={false}>
        <View className={"p-4 flex-row items-center justify-between"}>
          <View className={"flex-row items-center gap-3 flex-1"}>
            <CardIcon name={"photo.stack"} color={"#8b5cf6"} bgColor={"bg-violet-500/15"} />
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-medium"}>
                All Visits
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Browse and filter all your restaurant visits
              </ThemedText>
            </View>
          </View>
          <IconSymbol name={"chevron.right"} size={16} color={"#9ca3af"} />
        </View>
      </Card>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick Actions Card
// ─────────────────────────────────────────────────────────────────────────────

function QuickActionsCard() {
  return (
    <Pressable onPress={() => router.push("/quick-actions")}>
      <Card animated={false}>
        <View className={"p-4 flex-row items-center justify-between"}>
          <View className={"flex-row items-center gap-3 flex-1"}>
            <CardIcon name={"bolt.fill"} color={"#f59e0b"} bgColor={"bg-amber-500/15"} />
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-medium"}>
                Bulk Review Actions
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Skip visits by photo count, food detection, and matches
              </ThemedText>
            </View>
          </View>
          <IconSymbol name={"chevron.right"} size={16} color={"#9ca3af"} />
        </View>
      </Card>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Undo Bar Card
// ─────────────────────────────────────────────────────────────────────────────

function UndoBarCard() {
  const hideUndoBar = useHideUndoBar();
  const setHideUndoBar = useSetHideUndoBar();

  const handleToggle = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setHideUndoBar(!hideUndoBar);
  }, [hideUndoBar, setHideUndoBar]);

  return (
    <Pressable onPress={handleToggle}>
      <Card animated={false}>
        <View className={"p-4 flex-row items-center gap-3"}>
          <CardIcon name={"arrow.uturn.backward.circle.fill"} color={"#14b8a6"} bgColor={"bg-teal-500/15"} />
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Undo Bar
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Show the undo banner after review actions
            </ThemedText>
          </View>
          <View className={`px-2 py-1 rounded-full ${hideUndoBar ? "bg-red-500/15" : "bg-green-500/15"}`}>
            <ThemedText
              variant={"caption2"}
              className={`font-semibold ${hideUndoBar ? "text-red-400" : "text-green-400"}`}
            >
              {hideUndoBar ? "Hidden" : "Shown"}
            </ThemedText>
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fast Animations Card
// ─────────────────────────────────────────────────────────────────────────────

function FastAnimationsCard() {
  const fastAnimations = useFastAnimations();
  const setFastAnimations = useSetFastAnimations();

  const handleToggle = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFastAnimations(!fastAnimations);
  }, [fastAnimations, setFastAnimations]);

  return (
    <Pressable onPress={handleToggle}>
      <Card animated={false}>
        <View className={"p-4 flex-row items-center gap-3"}>
          <CardIcon name={"bolt.fill"} color={"#f59e0b"} bgColor={"bg-amber-500/15"} />
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Fast Animations
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Make UI animations instant
            </ThemedText>
          </View>
          <View className={`px-2 py-1 rounded-full ${fastAnimations ? "bg-green-500/15" : "bg-gray-500/15"}`}>
            <ThemedText
              variant={"caption2"}
              className={`font-semibold ${fastAnimations ? "text-green-400" : "text-gray-400"}`}
            >
              {fastAnimations ? "On" : "Off"}
            </ThemedText>
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge Duplicates Section
// ─────────────────────────────────────────────────────────────────────────────

function MergeDuplicatesSection() {
  const { showToast } = useToast();
  const { data: mergeableGroups = [] } = useMergeableSameRestaurantVisits();
  const batchMergeMutation = useBatchMergeSameRestaurantVisits();
  const [isProcessing, setIsProcessing] = useState(false);

  const totalMergeableVisits = useMemo(() => {
    return mergeableGroups.reduce((sum: number, group) => sum + group.visits.length, 0);
  }, [mergeableGroups]);

  const visitsAfterMerge = mergeableGroups.length;
  const visitsToMerge = totalMergeableVisits - visitsAfterMerge;

  const handleMergeSameRestaurantVisits = useCallback(async () => {
    if (mergeableGroups.length === 0) {
      return;
    }

    Alert.alert(
      "Merge Same-Restaurant Visits",
      `This will merge ${visitsToMerge.toLocaleString()} visit${visitsToMerge === 1 ? "" : "s"} into ${mergeableGroups.length.toLocaleString()} visit${mergeableGroups.length === 1 ? "" : "s"}. This action cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Merge All",
          style: "default",
          onPress: async () => {
            setIsProcessing(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              const { mergeCount } = await batchMergeMutation.mutateAsync(mergeableGroups);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Merged ${mergeCount.toLocaleString()} visit${mergeCount === 1 ? "" : "s"}.`,
              });
            } catch (error) {
              console.error("Error merging visits:", error);
              showToast({ type: "error", message: "Failed to merge visits. Please try again." });
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ],
    );
  }, [mergeableGroups, visitsToMerge, batchMergeMutation, showToast]);

  if (mergeableGroups.length === 0) {
    return null;
  }

  return (
    <Animated.View entering={FadeInDown.delay(220).duration(300)} className={"mb-6"}>
      <SectionHeader>Cleanup</SectionHeader>
      <Card animated={false}>
        <View className={"p-4 gap-4"}>
          <View className={"flex-row items-center gap-3"}>
            <CardIcon name={"arrow.triangle.merge"} color={"#3b82f6"} bgColor={"bg-blue-500/15"} />
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-medium"}>
                Merge Duplicate Visits
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Combine visits that occurred at the same time
              </ThemedText>
            </View>
          </View>

          <View className={"gap-2"}>
            {mergeableGroups.slice(0, 3).map((group: MergeableVisitGroup) => (
              <View
                key={group.restaurantId}
                className={"flex-row items-center gap-2 bg-background/50 rounded-lg px-3 py-2"}
              >
                <IconSymbol name={"arrow.triangle.merge"} size={14} color={"#3b82f6"} />
                <ThemedText variant={"caption1"} className={"flex-1"} numberOfLines={1}>
                  {group.restaurantName}
                </ThemedText>
                <ThemedText variant={"caption2"} color={"tertiary"}>
                  {group.visits.length} visits → 1
                </ThemedText>
              </View>
            ))}
            {mergeableGroups.length > 3 && (
              <ThemedText variant={"caption2"} color={"tertiary"} className={"px-1"}>
                +{mergeableGroups.length - 3} more group{mergeableGroups.length - 3 === 1 ? "" : "s"}
              </ThemedText>
            )}
          </View>

          <View className={"bg-background/50 rounded-xl p-3"}>
            <View className={"flex-row items-center justify-between"}>
              <View className={"flex-1"}>
                <ThemedText variant={"subhead"} className={"font-medium"}>
                  {visitsToMerge.toLocaleString()} visit{visitsToMerge === 1 ? "" : "s"} to merge
                </ThemedText>
                <ThemedText variant={"caption2"} color={"tertiary"}>
                  Into {mergeableGroups.length.toLocaleString()} combined visit
                  {mergeableGroups.length === 1 ? "" : "s"}
                </ThemedText>
              </View>
              <Button
                variant={"default"}
                size={"sm"}
                onPress={handleMergeSameRestaurantVisits}
                loading={isProcessing}
                disabled={isProcessing}
              >
                <ButtonText>Merge All</ButtonText>
              </Button>
            </View>
          </View>
        </View>
      </Card>
    </Animated.View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rescan Card
// ─────────────────────────────────────────────────────────────────────────────

function RescanCard() {
  const handleRescan = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push("/rescan");
  }, []);

  return (
    <Card animated={false}>
      <View className={"p-4 flex-row items-center justify-between"}>
        <View className={"flex-row items-center gap-3 flex-1"}>
          <CardIcon name={"camera.viewfinder"} color={"#f97316"} bgColor={"bg-orange-500/15"} />
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Rescan Photos
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Find new restaurant visits
            </ThemedText>
          </View>
        </View>
        <Button variant={"secondary"} size={"sm"} onPress={handleRescan}>
          <ButtonText variant={"secondary"}>Scan</ButtonText>
        </Button>
      </View>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Deep Scan Card
// ─────────────────────────────────────────────────────────────────────────────

function DeepScanCard() {
  const { showToast } = useToast();
  const [progress, setProgress] = useState<DeepScanProgress | null>(null);
  const deepScanMutation = useDeepScan((p) => setProgress(p));

  const handleDeepScan = useCallback(() => {
    Alert.alert(
      "Deep Scan Photos",
      "This will analyze ALL photos in your library for food. This may take a while but will find food photos that the quick scan missed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Start Deep Scan",
          onPress: async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              setProgress({
                totalPhotos: 0,
                processedPhotos: 0,
                foodPhotosFound: 0,
                isComplete: false,
                elapsedMs: 0,
                photosPerSecond: 0,
                etaMs: null,
              });
              const result = await deepScanMutation.mutateAsync();
              setProgress(null);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Found ${result.foodPhotosFound.toLocaleString()} food photo${result.foodPhotosFound === 1 ? "" : "s"} in ${result.processedPhotos.toLocaleString()} photos`,
              });
            } catch (error) {
              console.error("Deep scan error:", error);
              setProgress(null);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              showToast({ type: "error", message: "Deep scan failed" });
            }
          },
        },
      ],
    );
  }, [deepScanMutation, showToast]);

  const isScanning = deepScanMutation.isPending;
  const progressPercent =
    progress && progress.totalPhotos > 0 ? (progress.processedPhotos / progress.totalPhotos) * 100 : 0;

  return (
    <Card animated={false}>
      <View className={"p-4 gap-4"}>
        <View className={"flex-row items-center gap-3"}>
          <CardIcon name={"eye.fill"} color={"#ec4899"} bgColor={"bg-pink-500/15"} />
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Deep Scan for Food
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Analyze all photos with ML food detection
            </ThemedText>
          </View>
        </View>

        {/* Progress indicator */}
        {isScanning && progress && (
          <View className={"gap-2"}>
            <View className={"h-2 bg-pink-500/20 rounded-full overflow-hidden"}>
              <View className={"h-full bg-pink-500 rounded-full"} style={{ width: `${progressPercent}%` }} />
            </View>
            <View className={"flex-row justify-between"}>
              <ThemedText variant={"caption1"} color={"tertiary"}>
                {progress.processedPhotos.toLocaleString()} / {progress.totalPhotos.toLocaleString()} photos
              </ThemedText>
              {progress.photosPerSecond > 0 && (
                <ThemedText variant={"caption1"} color={"tertiary"}>
                  {progress.photosPerSecond.toFixed(0)}/s
                </ThemedText>
              )}
            </View>
          </View>
        )}

        <Button variant={"secondary"} onPress={handleDeepScan} loading={isScanning} disabled={isScanning}>
          <IconSymbol name={"eye.fill"} size={16} color={"#ec4899"} />
          <ButtonText variant={"secondary"} className={"ml-2"}>
            {isScanning ? "Scanning..." : "Deep Scan All Photos"}
          </ButtonText>
        </Button>
      </View>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Recompute Suggestions Card
// ─────────────────────────────────────────────────────────────────────────────

function RecomputeSuggestionsCard() {
  const { showToast } = useToast();
  const recomputeMutation = useRecomputeSuggestedRestaurants();

  const handleRecompute = useCallback(() => {
    Alert.alert(
      "Recompute Suggestions",
      "This will recalculate nearby restaurant suggestions for all pending visits based on their location. This may take a moment.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Recompute",
          onPress: async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              const updatedCount = await recomputeMutation.mutateAsync();
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Updated suggestions for ${updatedCount.toLocaleString()} visit${updatedCount === 1 ? "" : "s"}`,
              });
            } catch (error) {
              console.error("Error recomputing suggestions:", error);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              showToast({ type: "error", message: "Failed to recompute suggestions" });
            }
          },
        },
      ],
    );
  }, [recomputeMutation, showToast]);

  return (
    <Card animated={false}>
      <View className={"p-4 gap-4"}>
        <View className={"flex-row items-center gap-3"}>
          <CardIcon name={"arrow.triangle.2.circlepath"} color={"#8b5cf6"} bgColor={"bg-violet-500/15"} />
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Recompute Suggestions
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Recalculate nearby restaurants for pending visits
            </ThemedText>
          </View>
        </View>
        <Button
          variant={"secondary"}
          onPress={handleRecompute}
          loading={recomputeMutation.isPending}
          disabled={recomputeMutation.isPending}
        >
          <IconSymbol name={"arrow.triangle.2.circlepath"} size={16} color={"#8b5cf6"} />
          <ButtonText variant={"secondary"} className={"ml-2"}>
            Recompute Suggestions
          </ButtonText>
        </Button>
        <View className={"flex-row items-center gap-2"}>
          <IconSymbol name={"info.circle"} size={14} color={"#9ca3af"} />
          <ThemedText variant={"caption1"} color={"tertiary"}>
            Uses current Michelin data to find nearby restaurants
          </ThemedText>
        </View>
      </View>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ignored Locations Card
// ─────────────────────────────────────────────────────────────────────────────

function IgnoredLocationsCard({
  locations,
  onRemove,
}: {
  locations: IgnoredLocationRecord[];
  onRemove: (location: IgnoredLocationRecord) => void;
}) {
  return (
    <Card animated={false}>
      <View className={"p-4 gap-3"}>
        <View className={"flex-row items-center gap-3"}>
          <CardIcon name={"location.slash"} color={"#6b7280"} bgColor={"bg-gray-500/15"} />
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              {locations.length} Location{locations.length === 1 ? "" : "s"} Ignored
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Visits at these locations are automatically skipped
            </ThemedText>
          </View>
        </View>
        <ScrollView className={"gap-2 max-h-[200px] overflow-y-auto"}>
          {locations.map((location) => (
            <View key={location.id} className={"flex-row items-center justify-between bg-background/50 rounded-xl p-3"}>
              <View className={"flex-1"}>
                <ThemedText variant={"subhead"} className={"font-medium"} numberOfLines={1}>
                  {location.name ?? "Unnamed Location"}
                </ThemedText>
                <ThemedText variant={"caption2"} color={"tertiary"}>
                  {location.latitude.toFixed(4)}, {location.longitude.toFixed(4)} • {location.radius}m radius
                </ThemedText>
              </View>
              <Pressable onPress={() => onRemove(location)} className={"p-2"} hitSlop={8}>
                <IconSymbol name={"xmark.circle.fill"} size={20} color={"#9ca3af"} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      </View>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Danger Zone Card
// ─────────────────────────────────────────────────────────────────────────────

function DangerZoneCard() {
  const queryClient = useQueryClient();
  const resetAllState = useAppStore((state) => state.resetAllState);
  const [isResetting, setIsResetting] = useState(false);
  const { showToast } = useToast();

  const handleResetAllData = useCallback(() => {
    Alert.alert(
      "Reset All Data",
      "This will delete all your scanned photos, visits, and restaurant data. This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset Everything",
          style: "destructive",
          onPress: async () => {
            setIsResetting(true);
            try {
              await nukeDatabase();
              queryClient.clear();
              resetAllState();
              showToast({ type: "success", message: "All data has been reset. You can start fresh now." });
            } catch (error) {
              console.error("Reset error:", error);
              showToast({ type: "error", message: "Failed to reset data. Please try again." });
            } finally {
              setIsResetting(false);
            }
          },
        },
      ],
    );
  }, [queryClient, resetAllState, showToast]);

  return (
    <Card animated={false}>
      <View className={"p-4 gap-4"}>
        <View className={"flex-row items-center gap-3"}>
          <CardIcon name={"trash"} color={"#ef4444"} bgColor={"bg-red-500/15"} />
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Reset All Data
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Delete all photos, visits, and restaurants
            </ThemedText>
          </View>
        </View>
        <Button variant={"destructive"} onPress={handleResetAllData} loading={isResetting}>
          <ButtonText variant={"destructive"}>Reset Everything</ButtonText>
        </Button>
      </View>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Food Keywords Card
// ─────────────────────────────────────────────────────────────────────────────

function FoodKeywordsCard() {
  const { showToast } = useToast();
  const { data: keywords = [], isLoading } = useFoodKeywords();
  const { data: photosWithLabelsCount = 0 } = usePhotosWithLabelsCount();
  const addKeywordMutation = useAddFoodKeyword();
  const removeKeywordMutation = useRemoveFoodKeyword();
  const toggleKeywordMutation = useToggleFoodKeyword();
  const resetKeywordsMutation = useResetFoodKeywords();

  const [isExpanded, setIsExpanded] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");
  const [reclassifyProgress, setReclassifyProgress] = useState<ReclassifyProgress | null>(null);

  const reclassifyMutation = useReclassifyPhotos((progress) => {
    setReclassifyProgress(progress);
  });

  const enabledCount = keywords.filter((k) => k.enabled).length;
  const userAddedCount = keywords.filter((k) => !k.isBuiltIn).length;

  const handleAddKeyword = useCallback(async () => {
    const trimmed = newKeyword.trim().toLowerCase();
    if (!trimmed) {
      return;
    }

    // Check if already exists
    if (keywords.some((k) => k.keyword === trimmed)) {
      showToast({ type: "error", message: "Keyword already exists" });
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await addKeywordMutation.mutateAsync(trimmed);
      setNewKeyword("");
      showToast({ type: "success", message: `Added "${trimmed}"` });
    } catch {
      showToast({ type: "error", message: "Failed to add keyword" });
    }
  }, [newKeyword, keywords, addKeywordMutation, showToast]);

  const handleToggleKeyword = useCallback(
    (keyword: FoodKeywordRecord) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      toggleKeywordMutation.mutate({ id: keyword.id, enabled: !keyword.enabled });
    },
    [toggleKeywordMutation],
  );

  const handleRemoveKeyword = useCallback(
    (keyword: FoodKeywordRecord) => {
      if (keyword.isBuiltIn) {
        showToast({ type: "error", message: "Cannot remove built-in keywords" });
        return;
      }

      Alert.alert("Remove Keyword", `Remove "${keyword.keyword}" from food detection?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            removeKeywordMutation.mutate(keyword.id, {
              onSuccess: () => showToast({ type: "success", message: `Removed "${keyword.keyword}"` }),
              onError: () => showToast({ type: "error", message: "Failed to remove keyword" }),
            });
          },
        },
      ]);
    },
    [removeKeywordMutation, showToast],
  );

  const handleResetToDefaults = useCallback(() => {
    Alert.alert(
      "Reset to Defaults",
      "This will re-enable all built-in keywords and remove any custom keywords you added.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            resetKeywordsMutation.mutate(undefined, {
              onSuccess: () => showToast({ type: "success", message: "Keywords reset to defaults" }),
              onError: () => showToast({ type: "error", message: "Failed to reset keywords" }),
            });
          },
        },
      ],
    );
  }, [resetKeywordsMutation, showToast]);

  const handleReclassify = useCallback(() => {
    if (photosWithLabelsCount === 0) {
      showToast({ type: "info", message: "No photos to reclassify. Run a scan first." });
      return;
    }

    Alert.alert(
      "Reclassify Photos",
      `This will re-evaluate ${photosWithLabelsCount.toLocaleString()} photos with the current keyword settings. This may take a while.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reclassify",
          onPress: () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            setReclassifyProgress({ total: photosWithLabelsCount, processed: 0, updated: 0, isComplete: false });
            reclassifyMutation.mutate(undefined, {
              onSuccess: (result) => {
                setReclassifyProgress(null);
                showToast({
                  type: "success",
                  message: `Reclassified ${result.total.toLocaleString()} photos`,
                });
              },
              onError: () => {
                setReclassifyProgress(null);
                showToast({ type: "error", message: "Failed to reclassify photos" });
              },
            });
          },
        },
      ],
    );
  }, [photosWithLabelsCount, reclassifyMutation, showToast]);

  // Group keywords: enabled first, then disabled
  const sortedKeywords = useMemo(() => {
    return [...keywords].sort((a, b) => {
      if (a.enabled !== b.enabled) {
        return a.enabled ? -1 : 1;
      }
      return a.keyword.localeCompare(b.keyword);
    });
  }, [keywords]);

  return (
    <Card animated={false}>
      <Pressable onPress={() => setIsExpanded(!isExpanded)}>
        <View className={"p-4"}>
          <View className={"flex-row items-center gap-3"}>
            <CardIcon name={"fork.knife"} color={"#f97316"} bgColor={"bg-orange-500/15"} />
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-medium"}>
                Food Detection Keywords
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                {isLoading
                  ? "Loading..."
                  : `${enabledCount} of ${keywords.length} keywords enabled${userAddedCount > 0 ? ` (${userAddedCount} custom)` : ""}`}
              </ThemedText>
            </View>
            <IconSymbol name={isExpanded ? "chevron.up" : "chevron.down"} size={16} color={"#9ca3af"} />
          </View>
        </View>
      </Pressable>

      {isExpanded && (
        <View className={"px-4 pb-4 gap-4"}>
          {/* Reclassify Progress */}
          {reclassifyProgress && !reclassifyProgress.isComplete && (
            <View className={"bg-orange-500/10 rounded-xl p-3"}>
              <View className={"flex-row items-center justify-between mb-2"}>
                <ThemedText variant={"footnote"} className={"text-orange-400"}>
                  Reclassifying photos...
                </ThemedText>
                <ThemedText variant={"caption2"} className={"text-orange-400"}>
                  {reclassifyProgress.processed.toLocaleString()} / {reclassifyProgress.total.toLocaleString()}
                </ThemedText>
              </View>
              <View className={"h-1.5 bg-orange-500/20 rounded-full overflow-hidden"}>
                <View
                  className={"h-full bg-orange-500 rounded-full"}
                  style={{
                    width: `${reclassifyProgress.total > 0 ? (reclassifyProgress.processed / reclassifyProgress.total) * 100 : 0}%`,
                  }}
                />
              </View>
            </View>
          )}

          {/* Add new keyword */}
          <View className={"flex-row gap-2"}>
            <View className={"flex-1 bg-background/50 rounded-xl overflow-hidden"}>
              <TextInput
                className={"px-4 py-3 text-foreground"}
                placeholder={"Add custom keyword..."}
                placeholderTextColor={"#9ca3af"}
                value={newKeyword}
                onChangeText={setNewKeyword}
                autoCapitalize={"none"}
                autoCorrect={false}
                returnKeyType={"done"}
                onSubmitEditing={handleAddKeyword}
              />
            </View>
            <Pressable
              onPress={handleAddKeyword}
              disabled={!newKeyword.trim() || addKeywordMutation.isPending}
              className={`px-4 py-3 rounded-xl ${newKeyword.trim() ? "bg-orange-500" : "bg-gray-600"}`}
            >
              <IconSymbol name={"plus"} size={20} color={"#fff"} />
            </Pressable>
          </View>

          {/* Keywords list */}
          <View className={"gap-2 max-h-64"}>
            <ScrollView showsVerticalScrollIndicator={false} nestedScrollEnabled>
              <View className={"flex-row flex-wrap gap-2"}>
                {sortedKeywords.map((keyword) => (
                  <Pressable
                    key={keyword.id}
                    onPress={() => handleToggleKeyword(keyword)}
                    onLongPress={() => handleRemoveKeyword(keyword)}
                    className={`flex-row items-center gap-1.5 px-3 py-2 rounded-full ${
                      keyword.enabled
                        ? "bg-orange-500/20 border border-orange-500/40"
                        : "bg-background/50 border border-white/10"
                    }`}
                  >
                    <ThemedText variant={"footnote"} className={keyword.enabled ? "text-orange-400" : "text-gray-500"}>
                      {keyword.keyword}
                    </ThemedText>
                    {!keyword.isBuiltIn && <View className={"w-1.5 h-1.5 rounded-full bg-blue-500"} />}
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          </View>

          {/* Actions */}
          <View className={"flex-row gap-2"}>
            <View className={"flex-1"}>
              <Button
                variant={"secondary"}
                size={"sm"}
                onPress={handleReclassify}
                disabled={reclassifyMutation.isPending || photosWithLabelsCount === 0}
                loading={reclassifyMutation.isPending}
              >
                <IconSymbol name={"arrow.triangle.2.circlepath"} size={14} color={"#f97316"} />
                <ButtonText variant={"secondary"} className={"ml-1.5"}>
                  Reclassify
                </ButtonText>
              </Button>
            </View>
            <View className={"flex-1"}>
              <Button
                variant={"secondary"}
                size={"sm"}
                onPress={handleResetToDefaults}
                disabled={resetKeywordsMutation.isPending}
              >
                <IconSymbol name={"arrow.counterclockwise"} size={14} color={"#9ca3af"} />
                <ButtonText variant={"secondary"} className={"ml-1.5"}>
                  Reset
                </ButtonText>
              </Button>
            </View>
          </View>

          {/* Info */}
          <View className={"gap-1"}>
            <View className={"flex-row items-center gap-2"}>
              <IconSymbol name={"info.circle"} size={12} color={"#9ca3af"} />
              <ThemedText variant={"caption2"} color={"tertiary"}>
                Tap to toggle, long-press custom keywords to remove
              </ThemedText>
            </View>
            <View className={"flex-row items-center gap-2"}>
              <View className={"w-1.5 h-1.5 rounded-full bg-blue-500"} />
              <ThemedText variant={"caption2"} color={"tertiary"}>
                Blue dot = custom keyword
              </ThemedText>
            </View>
          </View>
        </View>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Export Visits Card
// ─────────────────────────────────────────────────────────────────────────────

function ExportVisitsCard() {
  return (
    <Card animated={false}>
      <View className={"p-4 flex-row items-center justify-between"}>
        <View className={"flex-row items-center gap-3 flex-1"}>
          <CardIcon name={"square.and.arrow.up"} color={"#0ea5e9"} bgColor={"bg-sky-500/15"} />
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Export Visits
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Download confirmed visits as CSV or JSON
            </ThemedText>
          </View>
        </View>
        <ExportButton label={"Export"} variant={"secondary"} size={"sm"} textVariant={"secondary"} />
      </View>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// About Card
// ─────────────────────────────────────────────────────────────────────────────

function AboutCard() {
  return (
    <Card animated={false}>
      <View className={"p-4 gap-4"}>
        <View className={"flex-row items-center gap-3"}>
          <CardIcon name={"person.fill"} color={"#3b82f6"} bgColor={"bg-blue-500/15"} />
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Created by JonLuca
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Organize your food memories
            </ThemedText>
          </View>
        </View>
        <Pressable
          onPress={() => Linking.openURL("https://github.com/jonluca/photo-foodie")}
          className={"flex-row items-center gap-3 bg-background/50 rounded-xl p-3"}
        >
          <IconSymbol name={"link"} size={18} color={"#3b82f6"} />
          <ThemedText variant={"subhead"} color={"secondary"} className={"flex-1"}>
            View on GitHub
          </ThemedText>
          <IconSymbol name={"chevron.right"} size={14} color={"#9ca3af"} />
        </Pressable>
      </View>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Settings Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const { showToast } = useToast();
  const { data: stats } = useStats();
  const { data: ignoredLocations = [] } = useIgnoredLocations();
  const removeIgnoredLocationMutation = useRemoveIgnoredLocation();

  const handleRemoveIgnoredLocation = useCallback(
    (location: IgnoredLocationRecord) => {
      Alert.alert(
        "Remove Ignored Location",
        `Stop ignoring ${location.name ?? "this location"}? Existing rejected visits won't be restored automatically.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            onPress: () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              removeIgnoredLocationMutation.mutate(location.id, {
                onSuccess: () => showToast({ type: "success", message: "Location removed from ignored list" }),
                onError: () => showToast({ type: "error", message: "Failed to remove location" }),
              });
            },
          },
        ],
      );
    },
    [removeIgnoredLocationMutation, showToast],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries();
    setRefreshing(false);
  }, [queryClient]);

  const hasIgnoredLocations = ignoredLocations.length > 0;

  return (
    <ScrollView
      className={"flex-1 bg-background"}
      contentContainerStyle={{
        paddingTop: 0,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: 16,
      }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Header */}
      <View className={"gap-2 mb-6"}>
        <ThemedText variant={"largeTitle"} className={"font-bold"}>
          Settings
        </ThemedText>
        <ThemedText variant={"body"} color={"secondary"}>
          Manage your data and view stats
        </ThemedText>
      </View>

      {/* Stats Section */}
      {stats && (
        <Animated.View entering={FadeInDown.delay(100).duration(300)} className={"mb-6"}>
          <SectionHeader>Statistics</SectionHeader>
          <StatsCard stats={stats} />
        </Animated.View>
      )}

      {/* Browse Section */}
      <Animated.View entering={FadeInDown.delay(150).duration(300)} className={"mb-6"}>
        <SectionHeader>Browse</SectionHeader>
        <AllVisitsCard />
      </Animated.View>

      {/* Review Actions */}
      <Animated.View entering={FadeInDown.delay(200).duration(300)} className={"mb-6"}>
        <SectionHeader>Review</SectionHeader>
        <QuickActionsCard />
      </Animated.View>

      {/* Preferences */}
      <Animated.View entering={FadeInDown.delay(250).duration(300)} className={"mb-6"}>
        <SectionHeader>Preferences</SectionHeader>
        <View className={"gap-3"}>
          <UndoBarCard />
          <FastAnimationsCard />
        </View>
      </Animated.View>

      <MergeDuplicatesSection />

      {/* Scan Section */}
      <Animated.View entering={FadeInDown.delay(300).duration(300)} className={"mb-6"}>
        <SectionHeader>Scanning</SectionHeader>
        <View className={"gap-3"}>
          <RescanCard />
          <DeepScanCard />
          <RecomputeSuggestionsCard />
        </View>
      </Animated.View>

      {/* Food Detection Section */}
      <Animated.View entering={FadeInDown.delay(350).duration(300)} className={"mb-6"}>
        <SectionHeader>Food Detection</SectionHeader>
        <FoodKeywordsCard />
      </Animated.View>

      {/* Calendar Section */}
      <Animated.View entering={FadeInDown.delay(400).duration(300)} className={"mb-6"}>
        <SectionHeader>Calendar</SectionHeader>
        <CalendarSection />
      </Animated.View>

      {/* Google Maps API Key Section */}
      <Animated.View entering={FadeInDown.delay(450).duration(300)} className={"mb-6"}>
        <SectionHeader>Integrations</SectionHeader>
        <GoogleMapsApiKeyCard />
      </Animated.View>

      {/* Ignored Locations */}
      {hasIgnoredLocations && (
        <Animated.View entering={FadeInDown.delay(500).duration(300)} className={"mb-6"}>
          <SectionHeader>Locations</SectionHeader>
          <IgnoredLocationsCard locations={ignoredLocations} onRemove={handleRemoveIgnoredLocation} />
        </Animated.View>
      )}

      {/* Export Section */}
      {stats && stats.confirmedVisits > 0 && (
        <Animated.View entering={FadeInDown.delay(550).duration(300)} className={"mb-6"}>
          <SectionHeader>Export</SectionHeader>
          <ExportVisitsCard />
        </Animated.View>
      )}

      {/* Danger Zone */}
      <Animated.View entering={FadeInDown.delay(hasIgnoredLocations ? 650 : 600).duration(300)} className={"mb-6"}>
        <SectionHeader>Danger Zone</SectionHeader>
        <DangerZoneCard />
      </Animated.View>

      {/* About Section */}
      <Animated.View entering={FadeInDown.delay(hasIgnoredLocations ? 750 : 650).duration(300)}>
        <SectionHeader>About</SectionHeader>
        <AboutCard />
      </Animated.View>
    </ScrollView>
  );
}

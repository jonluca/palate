import React, { useCallback, useState } from "react";
import { View, Alert, RefreshControl, ScrollView, Pressable, Linking, TextInput, Modal, FlatList } from "react-native";
import { useToast } from "@/components/ui/toast";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { ExportButton, StatsCard, WrappedCard } from "@/components/home";
import { IconSymbol } from "@/components/icon-symbol";
import type { SymbolViewProps } from "expo-symbols";
import { nukeDatabase } from "@/utils/db";
import {
  useAppStore,
  useGoogleMapsApiKey,
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
  type IgnoredLocationRecord,
  type WritableCalendar,
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
// Calendar Imports Card
// ─────────────────────────────────────────────────────────────────────────────

function CalendarImportsCard() {
  return (
    <Pressable onPress={() => router.push("/calendar-import")}>
      <Card animated={false}>
        <View className={"p-4 flex-row items-center justify-between"}>
          <View className={"flex-row items-center gap-3 flex-1"}>
            <CardIcon name={"calendar.badge.checkmark"} color={"#3b82f6"} bgColor={"bg-blue-500/15"} />
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-medium"}>
                Calendar Imports
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Import restaurant reservations from calendar
              </ThemedText>
            </View>
          </View>
          <View className={"flex-row items-center gap-2"}>
            <IconSymbol name={"chevron.right"} size={16} color={"#9ca3af"} />
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar Sync Selection Card - Choose which calendars to sync from
// ─────────────────────────────────────────────────────────────────────────────

function CalendarSyncCard() {
  const { showToast } = useToast();
  const { data: calendars = [], isLoading, refetch } = useSyncableCalendars();
  const selectedCalendarIds = useSelectedCalendarIds();
  const setSelectedCalendarIds = useSetSelectedCalendarIds();
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // Check permission on mount
  React.useEffect(() => {
    hasCalendarPermission().then(setHasPermission).catch(console.error);
  }, []);

  const handleRequestPermission = useCallback(async () => {
    const granted = await requestCalendarPermission();
    setHasPermission(granted);
    if (granted) {
      refetch();
      showToast({ type: "success", message: "Calendar access granted" });
    } else {
      showToast({ type: "error", message: "Calendar access denied" });
    }
  }, [refetch, showToast]);

  const handleToggleCalendar = useCallback(
    (calendarId: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      if (selectedCalendarIds === null) {
        // Currently syncing all - switch to only this calendar
        setSelectedCalendarIds([calendarId]);
      } else {
        const isCurrentlySelected = selectedCalendarIds.includes(calendarId);
        if (isCurrentlySelected) {
          // Remove from selection
          const newIds = selectedCalendarIds.filter((id) => id !== calendarId);
          setSelectedCalendarIds(newIds.length === 0 ? null : newIds);
        } else {
          // Add to selection
          setSelectedCalendarIds([...selectedCalendarIds, calendarId]);
        }
      }
    },
    [selectedCalendarIds, setSelectedCalendarIds],
  );

  const handleSelectAll = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedCalendarIds(null);
    showToast({ type: "success", message: "Syncing from all calendars" });
  }, [setSelectedCalendarIds, showToast]);

  const isCalendarSelected = useCallback(
    (calendarId: string) => {
      if (selectedCalendarIds === null) {
        return true; // All calendars selected
      }
      return selectedCalendarIds.includes(calendarId);
    },
    [selectedCalendarIds],
  );

  const selectedCount = selectedCalendarIds === null ? calendars.length : selectedCalendarIds.length;
  const isAllSelected = selectedCalendarIds === null;

  if (hasPermission === false) {
    return (
      <Card animated={false}>
        <View className={"p-4 gap-4"}>
          <View className={"flex-row items-center gap-3"}>
            <CardIcon name={"calendar"} color={"#3b82f6"} bgColor={"bg-blue-500/15"} />
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-medium"}>
                Calendar Sources
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Grant access to choose which calendars to sync
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
    <Card animated={false}>
      <Pressable onPress={() => setIsExpanded(!isExpanded)}>
        <View className={"p-4"}>
          <View className={"flex-row items-center gap-3"}>
            <CardIcon name={"calendar"} color={"#3b82f6"} bgColor={"bg-blue-500/15"} />
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-medium"}>
                Calendar Sources
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                {isLoading
                  ? "Loading..."
                  : isAllSelected
                    ? `Syncing from all ${calendars.length} calendar${calendars.length === 1 ? "" : "s"}`
                    : `Syncing from ${selectedCount} of ${calendars.length} calendar${calendars.length === 1 ? "" : "s"}`}
              </ThemedText>
            </View>
            <IconSymbol name={isExpanded ? "chevron.up" : "chevron.down"} size={16} color={"#9ca3af"} />
          </View>
        </View>
      </Pressable>

      {isExpanded && (
        <View className={"px-4 pb-4 gap-3"}>
          {/* Select All / Deselect All */}
          {calendars.length > 1 && (
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
          {calendars.map((calendar) => {
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

          {calendars.length === 0 && !isLoading && (
            <View className={"items-center py-4"}>
              <ThemedText variant={"footnote"} color={"tertiary"}>
                No calendars found
              </ThemedText>
            </View>
          )}

          {/* Info Text */}
          <View className={"flex-row items-center gap-2 pt-2"}>
            <IconSymbol name={"info.circle"} size={14} color={"#9ca3af"} />
            <ThemedText variant={"caption1"} color={"tertiary"}>
              Selected calendars are used to match events with visits
            </ThemedText>
          </View>
        </View>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar Export Card - Create calendar events for confirmed visits
// ─────────────────────────────────────────────────────────────────────────────

function CalendarExportCard() {
  const { showToast } = useToast();
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [selectedCalendar, setSelectedCalendar] = useState<WritableCalendar | null>(null);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);

  const { data: calendars = [], isLoading: isLoadingCalendars, refetch: refetchCalendars } = useWritableCalendars();
  const { data: visitsWithoutEvents = [], isLoading: isLoadingVisits } = useVisitsWithoutCalendarEvents();
  const createEventsMutation = useCreateCalendarEventsForVisits();

  const visitCount = visitsWithoutEvents.length;
  const isLoading = isLoadingCalendars || isLoadingVisits;

  // Check permission on mount
  React.useEffect(() => {
    hasCalendarPermission().then(setHasPermission).catch(console.error);
  }, []);

  const handleRequestPermission = useCallback(async () => {
    const granted = await requestCalendarPermission();
    setHasPermission(granted);
    if (granted) {
      refetchCalendars();
      showToast({ type: "success", message: "Calendar access granted" });
    } else {
      showToast({ type: "error", message: "Calendar access denied" });
    }
  }, [refetchCalendars, showToast]);

  const handleOpenModal = useCallback(() => {
    if (hasPermission === false) {
      handleRequestPermission();
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsModalVisible(true);
  }, [hasPermission, handleRequestPermission]);

  const handleSelectCalendar = useCallback((calendar: WritableCalendar) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedCalendar(calendar);
  }, []);

  const handleCreateEvents = useCallback(async () => {
    if (!selectedCalendar || visitCount === 0) {
      return;
    }

    setIsModalVisible(false);

    Alert.alert(
      "Create Calendar Events",
      `This will create ${visitCount.toLocaleString()} calendar event${visitCount === 1 ? "" : "s"} in "${selectedCalendar.title}" for your confirmed restaurant visits.`,
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
                calendarId: selectedCalendar.id,
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
  }, [selectedCalendar, visitCount, visitsWithoutEvents, createEventsMutation, showToast]);

  // Don't show if no visits without events
  if (!isLoading && visitCount === 0) {
    return null;
  }

  return (
    <>
      <Card animated={false}>
        <View className={"p-4 gap-4"}>
          <View className={"flex-row items-center gap-3"}>
            <CardIcon name={"calendar.badge.plus"} color={"#8b5cf6"} bgColor={"bg-violet-500/15"} />
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-medium"}>
                Export to Calendar
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                {isLoading
                  ? "Loading..."
                  : `${visitCount.toLocaleString()} confirmed visit${visitCount === 1 ? "" : "s"} without calendar events`}
              </ThemedText>
            </View>
          </View>

          {hasPermission === false ? (
            <Button variant={"secondary"} onPress={handleRequestPermission}>
              <IconSymbol name={"calendar"} size={16} color={"#8b5cf6"} />
              <ButtonText variant={"secondary"} className={"ml-2"}>
                Grant Calendar Access
              </ButtonText>
            </Button>
          ) : (
            <Button
              variant={"secondary"}
              onPress={handleOpenModal}
              disabled={isLoading || visitCount === 0}
              loading={createEventsMutation.isPending}
            >
              <IconSymbol name={"calendar.badge.plus"} size={16} color={"#8b5cf6"} />
              <ButtonText variant={"secondary"} className={"ml-2"}>
                Choose Calendar
              </ButtonText>
            </Button>
          )}
        </View>
      </Card>

      {/* Calendar Selection Modal */}
      <Modal
        visible={isModalVisible}
        animationType={"slide"}
        presentationStyle={"pageSheet"}
        onRequestClose={() => setIsModalVisible(false)}
      >
        <View className={"flex-1 bg-background"}>
          {/* Modal Header */}
          <View className={"flex-row items-center justify-between px-4 py-4 border-b border-white/10"}>
            <Pressable onPress={() => setIsModalVisible(false)} hitSlop={8}>
              <ThemedText variant={"body"} className={"text-blue-500"}>
                Cancel
              </ThemedText>
            </Pressable>
            <ThemedText variant={"subhead"} className={"font-semibold"}>
              Select Calendar
            </ThemedText>
            <Pressable onPress={handleCreateEvents} disabled={!selectedCalendar} hitSlop={8}>
              <ThemedText
                variant={"body"}
                className={selectedCalendar ? "text-blue-500 font-semibold" : "text-gray-500"}
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
            data={calendars}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: 16 }}
            ItemSeparatorComponent={() => <View className={"h-2"} />}
            renderItem={({ item: calendar }) => {
              const isSelected = selectedCalendar?.id === calendar.id;
              return (
                <Pressable onPress={() => handleSelectCalendar(calendar)}>
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
// Delete Exported Calendar Events Card
// ─────────────────────────────────────────────────────────────────────────────

function DeleteExportedCalendarEventsCard() {
  const { showToast } = useToast();
  const { data: exportedEvents = [], isLoading } = useExportedCalendarEvents();
  const deleteEventsMutation = useDeleteExportedCalendarEvents();

  const eventCount = exportedEvents.length;

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

  // Don't show if no exported events
  if (!isLoading && eventCount === 0) {
    return null;
  }

  return (
    <Card animated={false}>
      <View className={"p-4 gap-4"}>
        <View className={"flex-row items-center gap-3"}>
          <CardIcon name={"calendar.badge.minus"} color={"#ef4444"} bgColor={"bg-red-500/15"} />
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Exported Calendar Events
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              {isLoading
                ? "Loading..."
                : `${eventCount.toLocaleString()} event${eventCount === 1 ? "" : "s"} created by this app`}
            </ThemedText>
          </View>
        </View>

        <Button
          variant={"destructive"}
          onPress={handleDeleteAllEvents}
          disabled={isLoading || eventCount === 0}
          loading={deleteEventsMutation.isPending}
        >
          <IconSymbol name={"trash"} size={16} color={"#fff"} />
          <ButtonText variant={"destructive"} className={"ml-2"}>
            Delete All Exported Events
          </ButtonText>
        </Button>

        <View className={"flex-row items-center gap-2"}>
          <IconSymbol name={"info.circle"} size={14} color={"#9ca3af"} />
          <ThemedText variant={"caption1"} color={"tertiary"}>
            Events are identified by metadata added during export
          </ThemedText>
        </View>
      </View>
    </Card>
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
                Bulk Operations
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Skip visits by photo count, food detection & more
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
        <View className={"gap-2"}>
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
        </View>
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

      {/* Wrapped Card */}
      <View className={"mb-6"}>
        <WrappedCard />
      </View>

      {/* Export Section */}
      {stats && stats.confirmedVisits > 0 && (
        <Animated.View entering={FadeInDown.delay(250).duration(300)} className={"mb-6"}>
          <SectionHeader>Export</SectionHeader>
          <ExportButton />
        </Animated.View>
      )}

      {/* Calendar & Quick Actions Section */}
      <Animated.View entering={FadeInDown.delay(350).duration(300)} className={"mb-6"}>
        <SectionHeader>Calendar</SectionHeader>
        <View className={"gap-3"}>
          <CalendarSyncCard />
          <CalendarImportsCard />
          <CalendarExportCard />
          <DeleteExportedCalendarEventsCard />
        </View>
      </Animated.View>

      {/* Quick Actions Section */}
      <Animated.View entering={FadeInDown.delay(400).duration(300)} className={"mb-6"}>
        <SectionHeader>Actions</SectionHeader>
        <QuickActionsCard />
      </Animated.View>

      {/* Scan Section */}
      <Animated.View entering={FadeInDown.delay(450).duration(300)} className={"mb-6"}>
        <SectionHeader>Scanning</SectionHeader>
        <RescanCard />
      </Animated.View>

      {/* Ignored Locations */}
      {hasIgnoredLocations && (
        <Animated.View entering={FadeInDown.delay(550).duration(300)} className={"mb-6"}>
          <SectionHeader>Ignored Locations</SectionHeader>
          <IgnoredLocationsCard locations={ignoredLocations} onRemove={handleRemoveIgnoredLocation} />
        </Animated.View>
      )}

      {/* Google Maps API Key Section */}
      <Animated.View entering={FadeInDown.delay(150).duration(300)} className={"mb-6"}>
        <SectionHeader>Integrations</SectionHeader>
        <GoogleMapsApiKeyCard />
      </Animated.View>

      {/* Danger Zone */}
      <Animated.View entering={FadeInDown.delay(hasIgnoredLocations ? 650 : 550).duration(300)} className={"mb-6"}>
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

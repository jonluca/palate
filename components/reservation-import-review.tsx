import React, { useCallback, useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import * as Haptics from "expo-haptics";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { AllCaughtUpEmpty, Button, ButtonText } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import type { ImportableReservation, ReservationImportResult } from "@/services/reservation-import";

interface ReservationImportMutation {
  isPending: boolean;
  mutateAsync: (reservations: ImportableReservation[]) => Promise<ReservationImportResult>;
}

interface UseReservationImportReviewOptions {
  displayName: string;
  importMutation: ReservationImportMutation;
}

type ReservationReviewListItem =
  | { type: "month"; id: string; label: string }
  | { type: "reservation"; id: string; reservation: ImportableReservation };

interface ReservationImportReviewListProps {
  reservations: ImportableReservation[];
  brandColor: string;
  displayName: string;
  importingReservationIds: Set<string>;
  dismissingReservationIds: Set<string>;
  onImport: (reservation: ImportableReservation) => void;
  onDismiss: (reservation: ImportableReservation) => void;
  contentTopPadding?: number;
  contentBottomPadding?: number;
}

function getReservationId(reservation: ImportableReservation): string {
  return reservation.sourceEventId || reservation.id;
}

function getMonthLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", { year: "numeric", month: "long" });
}

function formatReservationDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: new Date(timestamp).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

function formatReservationTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function getReservationImportSummary(result: ReservationImportResult): string {
  const importedPart = `Added ${result.importedCount.toLocaleString()} visit${result.importedCount === 1 ? "" : "s"}`;
  const updatedPart =
    result.linkedExistingCount > 0
      ? `updated ${result.linkedExistingCount.toLocaleString()} existing visit${result.linkedExistingCount === 1 ? "" : "s"}`
      : null;
  const michelinPart =
    result.matchedMichelinCount > 0
      ? `${result.matchedMichelinCount.toLocaleString()} Michelin match${result.matchedMichelinCount === 1 ? "" : "es"}`
      : null;
  const mergedPart =
    result.mergedDuplicateCount > 0
      ? `merged ${result.mergedDuplicateCount.toLocaleString()} duplicate visit${result.mergedDuplicateCount === 1 ? "" : "s"}`
      : null;
  const duplicatePart =
    result.skippedDuplicateCount > 0
      ? `skipped ${result.skippedDuplicateCount.toLocaleString()} duplicate reservation${result.skippedDuplicateCount === 1 ? "" : "s"}`
      : null;
  const unreadablePart =
    result.skippedInvalidCount > 0
      ? `skipped ${result.skippedInvalidCount.toLocaleString()} unreadable reservation${result.skippedInvalidCount === 1 ? "" : "s"}`
      : null;
  const conflictPart =
    result.skippedConflictCount > 0
      ? `skipped ${result.skippedConflictCount.toLocaleString()} conflicting reservation${result.skippedConflictCount === 1 ? "" : "s"}`
      : null;

  return (
    [importedPart, updatedPart, michelinPart, mergedPart, duplicatePart, unreadablePart, conflictPart]
      .filter(Boolean)
      .join(", ") + "."
  );
}

export function useReservationImportReview({ displayName, importMutation }: UseReservationImportReviewOptions) {
  const { showToast } = useToast();
  const [reservations, setReservations] = useState<ImportableReservation[]>([]);
  const [dismissedReservationIds, setDismissedReservationIds] = useState<Set<string>>(new Set());
  const [completedReservationIds, setCompletedReservationIds] = useState<Set<string>>(new Set());
  const [importingReservationIds, setImportingReservationIds] = useState<Set<string>>(new Set());
  const [dismissingReservationIds, setDismissingReservationIds] = useState<Set<string>>(new Set());
  const [lastResult, setLastResult] = useState<ReservationImportResult | null>(null);

  const pendingReservations = useMemo(
    () =>
      reservations.filter((reservation) => {
        const reservationId = getReservationId(reservation);
        return !dismissedReservationIds.has(reservationId) && !completedReservationIds.has(reservationId);
      }),
    [completedReservationIds, dismissedReservationIds, reservations],
  );

  const reviewStats = useMemo(
    () => ({
      capturedCount: reservations.length,
      pendingCount: pendingReservations.length,
      dismissedCount: dismissedReservationIds.size,
      completedCount: completedReservationIds.size,
    }),
    [completedReservationIds.size, dismissedReservationIds.size, pendingReservations.length, reservations.length],
  );

  const loadReservations = useCallback((nextReservations: ImportableReservation[]) => {
    const nextIds = new Set(nextReservations.map(getReservationId));
    setReservations(nextReservations);
    setDismissedReservationIds((previous) => new Set([...previous].filter((id) => nextIds.has(id))));
    setCompletedReservationIds((previous) => new Set([...previous].filter((id) => nextIds.has(id))));
    setLastResult(null);
  }, []);

  const resetReview = useCallback(() => {
    setReservations([]);
    setDismissedReservationIds(new Set());
    setCompletedReservationIds(new Set());
    setImportingReservationIds(new Set());
    setDismissingReservationIds(new Set());
    setLastResult(null);
  }, []);

  const importReservations = useCallback(
    async (reservationsToImport: ImportableReservation[]) => {
      if (reservationsToImport.length === 0 || importMutation.isPending) {
        return null;
      }

      const reservationIds = reservationsToImport.map(getReservationId);
      setLastResult(null);
      setImportingReservationIds((previous) => new Set([...previous, ...reservationIds]));
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      try {
        const result = await importMutation.mutateAsync(reservationsToImport);
        setLastResult(result);
        setCompletedReservationIds((previous) => new Set([...previous, ...reservationIds]));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast({ type: "success", message: getReservationImportSummary(result) });
        return result;
      } catch (error) {
        console.error(`Error importing ${displayName} reservations:`, error);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        showToast({ type: "error", message: `Failed to import ${displayName} reservations.` });
        return null;
      } finally {
        setImportingReservationIds((previous) => {
          const next = new Set(previous);
          for (const reservationId of reservationIds) {
            next.delete(reservationId);
          }
          return next;
        });
      }
    },
    [displayName, importMutation, showToast],
  );

  const importReservation = useCallback(
    (reservation: ImportableReservation) => {
      importReservations([reservation]);
    },
    [importReservations],
  );

  const importAllPendingReservations = useCallback(() => {
    if (pendingReservations.length === 0) {
      return;
    }

    Alert.alert(
      `Approve All ${displayName} Reservations`,
      `This will import ${pendingReservations.length.toLocaleString()} approved ${displayName} reservation${pendingReservations.length === 1 ? "" : "s"} as confirmed visits. Existing imports and overlapping visits will be deduped.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve All",
          style: "default",
          onPress: () => {
            importReservations(pendingReservations);
          },
        },
      ],
    );
  }, [displayName, importReservations, pendingReservations]);

  const dismissReservation = useCallback((reservation: ImportableReservation) => {
    const reservationId = getReservationId(reservation);
    setDismissingReservationIds((previous) => new Set(previous).add(reservationId));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDismissedReservationIds((previous) => new Set(previous).add(reservationId));
    setDismissingReservationIds((previous) => {
      const next = new Set(previous);
      next.delete(reservationId);
      return next;
    });
  }, []);

  const isImportingAll =
    pendingReservations.length > 0 &&
    pendingReservations.every((reservation) => importingReservationIds.has(getReservationId(reservation)));

  return {
    reservations,
    pendingReservations,
    reviewStats,
    lastResult,
    importingReservationIds,
    dismissingReservationIds,
    isImportingAll,
    loadReservations,
    resetReview,
    importReservation,
    importAllPendingReservations,
    dismissReservation,
  };
}

function ReservationReviewCard({
  reservation,
  brandColor,
  isImporting,
  isDismissing,
  onImport,
  onDismiss,
}: {
  reservation: ImportableReservation;
  brandColor: string;
  isImporting: boolean;
  isDismissing: boolean;
  onImport: () => void;
  onDismiss: () => void;
}) {
  const partyText = reservation.partySize
    ? `${reservation.partySize.toLocaleString()} guest${reservation.partySize === 1 ? "" : "s"}`
    : null;

  return (
    <View className={"bg-card rounded-2xl p-4 gap-3 mb-4"}>
      <View className={"flex-row items-start gap-3"}>
        <View
          className={"w-10 h-10 rounded-full items-center justify-center"}
          style={{ backgroundColor: `${brandColor}20` }}
        >
          <IconSymbol name={"fork.knife"} size={19} color={brandColor} />
        </View>
        <View className={"flex-1 gap-1"}>
          <ThemedText className={"font-semibold text-base"} numberOfLines={2}>
            {reservation.restaurantName}
          </ThemedText>
          <ThemedText variant={"caption1"} color={"secondary"}>
            {formatReservationDate(reservation.startTime)} at {formatReservationTime(reservation.startTime)}
          </ThemedText>
          {reservation.address && (
            <View className={"flex-row items-center gap-1"}>
              <IconSymbol name={"mappin"} size={12} color={"#9ca3af"} />
              <ThemedText variant={"caption1"} color={"tertiary"} numberOfLines={1} className={"flex-1"}>
                {reservation.address}
              </ThemedText>
            </View>
          )}
        </View>
      </View>

      <View className={"flex-row flex-wrap gap-2"}>
        <View className={"px-2.5 py-1 rounded-full bg-background/70"}>
          <ThemedText variant={"caption2"} color={"secondary"} className={"font-semibold uppercase"}>
            {reservation.sourceName}
          </ThemedText>
        </View>
        {partyText && (
          <View className={"px-2.5 py-1 rounded-full bg-background/70"}>
            <ThemedText variant={"caption2"} color={"secondary"}>
              {partyText}
            </ThemedText>
          </View>
        )}
      </View>

      <View className={"flex-row gap-2"}>
        <Button
          size={"sm"}
          variant={"secondary"}
          onPress={onDismiss}
          loading={isDismissing}
          disabled={isImporting || isDismissing}
          className={"flex-1"}
        >
          <IconSymbol name={"xmark.circle.fill"} size={18} color={"#9ca3af"} />
          <ButtonText className={"ml-2 text-gray-400"}>Dismiss</ButtonText>
        </Button>
        <Button
          size={"sm"}
          variant={"default"}
          onPress={onImport}
          loading={isImporting}
          disabled={isImporting || isDismissing}
          className={"flex-1"}
        >
          <IconSymbol name={"plus.circle.fill"} size={18} color={"#fff"} />
          <ButtonText className={"ml-2"}>Approve</ButtonText>
        </Button>
      </View>
    </View>
  );
}

export function ReservationImportReviewList({
  reservations,
  brandColor,
  displayName,
  importingReservationIds,
  dismissingReservationIds,
  onImport,
  onDismiss,
  contentTopPadding = 0,
  contentBottomPadding = 0,
}: ReservationImportReviewListProps) {
  const listData = useMemo<ReservationReviewListItem[]>(() => {
    const groups = new Map<string, ImportableReservation[]>();
    for (const reservation of reservations) {
      const monthLabel = getMonthLabel(reservation.startTime);
      groups.set(monthLabel, [...(groups.get(monthLabel) ?? []), reservation]);
    }

    const items: ReservationReviewListItem[] = [];
    for (const [monthLabel, monthReservations] of Array.from(groups.entries()).sort(([a], [b]) => {
      return new Date(b).getTime() - new Date(a).getTime();
    })) {
      items.push({ type: "month", id: `month:${monthLabel}`, label: monthLabel });
      for (const reservation of monthReservations.sort((a, b) => b.startTime - a.startTime)) {
        items.push({
          type: "reservation",
          id: `reservation:${getReservationId(reservation)}`,
          reservation,
        });
      }
    }
    return items;
  }, [reservations]);

  const renderItem = useCallback(
    ({ item }: { item: ReservationReviewListItem }) => {
      if (item.type === "month") {
        return (
          <View className={"mt-6"}>
            <ThemedText
              variant={"footnote"}
              color={"tertiary"}
              className={"uppercase font-semibold tracking-wide px-1 mb-3"}
            >
              {item.label}
            </ThemedText>
          </View>
        );
      }

      const reservationId = getReservationId(item.reservation);
      return (
        <ReservationReviewCard
          reservation={item.reservation}
          brandColor={brandColor}
          isImporting={importingReservationIds.has(reservationId)}
          isDismissing={dismissingReservationIds.has(reservationId)}
          onImport={() => onImport(item.reservation)}
          onDismiss={() => onDismiss(item.reservation)}
        />
      );
    },
    [brandColor, dismissingReservationIds, importingReservationIds, onDismiss, onImport],
  );

  const ListEmpty = useCallback(() => {
    return (
      <View>
        <AllCaughtUpEmpty />
        <View className={"mt-6 bg-blue-500/10 rounded-xl p-4 flex-row gap-3"}>
          <IconSymbol name={"lightbulb.fill"} size={18} color={"#3b82f6"} />
          <View className={"flex-1"}>
            <ThemedText variant={"footnote"} className={"text-blue-400"}>
              All captured {displayName} reservations have been imported or dismissed. Reload the provider page to
              review them again.
            </ThemedText>
          </View>
        </View>
      </View>
    );
  }, [displayName]);

  return (
    <FlashList
      data={listData}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      ListEmptyComponent={ListEmpty}
      contentContainerStyle={{
        paddingTop: contentTopPadding,
        paddingBottom: contentBottomPadding,
      }}
    />
  );
}

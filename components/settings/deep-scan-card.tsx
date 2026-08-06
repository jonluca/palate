import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import * as Haptics from "expo-haptics";
import type { SymbolViewProps } from "expo-symbols";
import { useQueryClient } from "@tanstack/react-query";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { Button, ButtonText, Card } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { queryKeys, useDeepScan, useUnanalyzedPhotoCount, type DeepScanProgress } from "@/hooks/queries";
import { formatEta } from "@/services/scanner";
import { getUnanalyzedPhotoIds } from "@/utils/db";
import {
  allowsAutomaticDeepScanFollowup,
  getResolvedVisitFoodDetectionStrategy,
  isVisionVisitFoodValidationModeEnabled,
} from "@/modules/batch-asset-info";

interface DeepScanCardProps {
  autoStart?: boolean;
}

function createInitialProgress(): DeepScanProgress {
  return {
    totalPhotos: 0,
    processedPhotos: 0,
    foodPhotosFound: 0,
    retryableFailures: 0,
    isComplete: false,
    elapsedMs: 0,
    photosPerSecond: 0,
    etaMs: null,
  };
}

async function runDeepScan({
  source,
  mutateAsync,
  setProgress,
  showToast,
}: {
  source: "auto" | "manual";
  mutateAsync: () => Promise<DeepScanProgress>;
  setProgress: React.Dispatch<React.SetStateAction<DeepScanProgress | null>>;
  showToast: ReturnType<typeof useToast>["showToast"];
}) {
  if (source === "manual") {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }

  try {
    setProgress(createInitialProgress());
    const result = await mutateAsync();
    setProgress(null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    showToast({
      type: result.retryableFailures > 0 ? "info" : "success",
      message: `Found ${result.foodPhotosFound.toLocaleString()} food photo${result.foodPhotosFound === 1 ? "" : "s"} in ${result.processedPhotos.toLocaleString()} photos${result.retryableFailures > 0 ? `; ${result.retryableFailures.toLocaleString()} will retry` : ""}`,
    });
  } catch (error) {
    console.error("Deep scan error:", error);
    setProgress(null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    showToast({ type: "error", message: "Deep scan failed" });
  }
}

function CardIcon({ name, color, bgColor }: { name: SymbolViewProps["name"]; color: string; bgColor: string }) {
  return (
    <View className={`w-10 h-10 rounded-full items-center justify-center ${bgColor}`}>
      <IconSymbol name={name} size={20} color={color} />
    </View>
  );
}

export function DeepScanCard({ autoStart = false }: DeepScanCardProps) {
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { data: unanalyzedPhotoCount } = useUnanalyzedPhotoCount();
  const [progress, setProgress] = useState<DeepScanProgress | null>(null);
  const { isPending: isScanning, mutateAsync: mutateDeepScan } = useDeepScan((p) => setProgress(p));
  const [isPreparing, setIsPreparing] = useState(false);
  const [hasAutoStartFinished, setHasAutoStartFinished] = useState(false);
  const isWorking = isPreparing || isScanning;
  const isAutoStartQueued = autoStart && !hasAutoStartFinished && !isWorking && (unanalyzedPhotoCount ?? 0) > 0;
  const isBusy = isWorking || isAutoStartQueued;
  const hasAutoStartedRef = useRef(false);
  const isStartingRef = useRef(false);

  const startDeepScan = useCallback(
    async (source: "auto" | "manual") => {
      if (
        source === "auto" &&
        !allowsAutomaticDeepScanFollowup(
          getResolvedVisitFoodDetectionStrategy(),
          isVisionVisitFoodValidationModeEnabled(),
        )
      ) {
        setHasAutoStartFinished(true);
        return;
      }
      if (isStartingRef.current) {
        return;
      }

      isStartingRef.current = true;
      setIsPreparing(true);

      try {
        const photosToScan = await getUnanalyzedPhotoIds();

        if (photosToScan.length === 0) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.unanalyzedPhotoCount });
          if (source === "manual") {
            showToast({ type: "info", message: "No photos left to deep scan" });
          }
        } else {
          await runDeepScan({
            source,
            mutateAsync: () => mutateDeepScan(photosToScan),
            setProgress,
            showToast,
          });
        }
      } catch (error) {
        console.error("Failed to prepare deep scan:", error);
        setProgress(null);
        showToast({ type: "error", message: "Deep scan failed" });
      }

      setIsPreparing(false);
      isStartingRef.current = false;
      if (source === "auto") {
        setHasAutoStartFinished(true);
      }
    },
    [mutateDeepScan, queryClient, showToast],
  );

  const handleDeepScan = () => {
    Alert.alert(
      "Deep Scan Photos",
      "This will thoroughly check every remaining photo for food. It may take a while, but it can find photos the quick scan missed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Start Deep Scan",
          onPress: async () => {
            await startDeepScan("manual");
          },
        },
      ],
    );
  };

  useEffect(() => {
    if (!autoStart || hasAutoStartedRef.current || isWorking || (unanalyzedPhotoCount ?? 0) === 0) {
      return;
    }

    hasAutoStartedRef.current = true;
    void startDeepScan("auto");
  }, [autoStart, isWorking, startDeepScan, unanalyzedPhotoCount]);

  const progressPercent =
    progress && progress.totalPhotos > 0 ? (progress.processedPhotos / progress.totalPhotos) * 100 : 0;
  const hasProgress = isScanning && progress !== null && progress.totalPhotos > 0;

  if (!isBusy && (unanalyzedPhotoCount ?? 0) === 0) {
    return null;
  }

  return (
    <Card animated={false}>
      <View className={"p-4 gap-4"}>
        <View className={"flex-row items-center gap-3"}>
          <CardIcon name={"eye.fill"} color={"#ec4899"} bgColor={"bg-pink-500/15"} />
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Deep Scan Photos
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              {autoStart && isBusy
                ? "Automatically checking the rest of your library for missed food photos"
                : "Thoroughly check remaining photos for missed food"}
            </ThemedText>
          </View>
        </View>

        {isBusy && !hasProgress && (
          <View
            className={"flex-row items-center gap-3 rounded-xl bg-pink-500/10 p-3"}
            accessible={true}
            accessibilityRole={"progressbar"}
            accessibilityLabel={"Preparing photos for deep scan"}
            accessibilityLiveRegion={"polite"}
          >
            <ActivityIndicator color={"#ec4899"} />
            <View className={"flex-1 gap-0.5"}>
              <ThemedText variant={"footnote"} className={"font-medium"}>
                {isPreparing && !isScanning ? "Preparing photos…" : "Starting deep scan…"}
              </ThemedText>
              <ThemedText variant={"caption1"} color={"tertiary"}>
                This can take a moment for a large library.
              </ThemedText>
            </View>
          </View>
        )}

        {hasProgress && progress && (
          <View
            className={"gap-2"}
            accessible={true}
            accessibilityRole={"progressbar"}
            accessibilityLabel={"Deep scan progress"}
            accessibilityValue={{
              min: 0,
              max: progress.totalPhotos,
              now: progress.processedPhotos,
              text: `${progress.processedPhotos.toLocaleString()} of ${progress.totalPhotos.toLocaleString()} photos`,
            }}
            accessibilityLiveRegion={"polite"}
          >
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
            <ThemedText variant={"caption1"} color={"tertiary"}>
              ETA {formatEta(progress.etaMs)}
            </ThemedText>
          </View>
        )}

        {!isBusy && (
          <Button
            variant={"secondary"}
            onPress={handleDeepScan}
            accessibilityRole={"button"}
            accessibilityLabel={"Deep Scan All Photos"}
            accessibilityHint={"Analyzes the remaining photos in your library for food"}
          >
            <IconSymbol name={"eye.fill"} size={16} color={"#ec4899"} />
            <ButtonText variant={"secondary"}>Deep Scan All Photos</ButtonText>
          </Button>
        )}
      </View>
    </Card>
  );
}

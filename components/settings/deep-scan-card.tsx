import React, { useCallback, useState } from "react";
import { Alert, View } from "react-native";
import * as Haptics from "expo-haptics";
import type { SymbolViewProps } from "expo-symbols";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { Button, ButtonText, Card } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { useDeepScan, type DeepScanProgress } from "@/hooks/queries";

function CardIcon({ name, color, bgColor }: { name: SymbolViewProps["name"]; color: string; bgColor: string }) {
  return (
    <View className={`w-10 h-10 rounded-full items-center justify-center ${bgColor}`}>
      <IconSymbol name={name} size={20} color={color} />
    </View>
  );
}

export function DeepScanCard() {
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
              Deep Scan Photos
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Slower full-library scan to find missed food photos
            </ThemedText>
          </View>
        </View>

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

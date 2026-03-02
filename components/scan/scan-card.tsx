import React from "react";
import { View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { Card, AnimatedProgressCard, Button, ButtonText } from "@/components/ui";
import { PhotoCountDisplay } from "./photo-count-display";
import type { ProgressSharedValues } from "@/hooks/use-progress";

interface ScanCardProps {
  cameraRollCount: number | null | undefined;
  isScanning: boolean;
  isDeepScanning: boolean;
  onScan: () => void;
  onDeepScan?: () => void;
  sharedValues: ProgressSharedValues;
  scanButtonText?: string;
  deepScanButtonText?: string;
  showDeepScan?: boolean;
  animationDelay?: number;
  primaryAction?: "scan" | "deep-scan";
}

export function ScanCard({
  cameraRollCount,
  isScanning,
  isDeepScanning,
  onScan,
  onDeepScan,
  sharedValues,
  scanButtonText = "Start Scanning",
  deepScanButtonText = "Deep Scan for Food",
  showDeepScan = false,
  animationDelay = 100,
  primaryAction = "scan",
}: ScanCardProps) {
  const isInProgress = isScanning || isDeepScanning;
  const scanVariant = primaryAction === "scan" ? "default" : "outline";
  const deepScanVariant = primaryAction === "deep-scan" ? "default" : "outline";
  const deepScanTextVariant = primaryAction === "deep-scan" ? "default" : "outline";

  return (
    <Animated.View entering={FadeInDown.delay(animationDelay).duration(300)}>
      <Card className={"mb-6"}>
        <View className={"p-5 gap-4"}>
          {/* Photo Count */}
          {cameraRollCount !== null && cameraRollCount !== undefined && (
            <PhotoCountDisplay label={isScanning ? "Scanning..." : "Ready to scan"} count={cameraRollCount} />
          )}

          {/* Scan Button */}
          {!isInProgress && (
            <Button onPress={onScan} size={"lg"} variant={scanVariant}>
              <ButtonText variant={scanVariant}>{scanButtonText}</ButtonText>
            </Button>
          )}

          {/* Deep Scan Button */}
          {showDeepScan && !isInProgress && onDeepScan && (
            <Button onPress={onDeepScan} variant={deepScanVariant} size={"lg"}>
              <ButtonText variant={deepScanTextVariant}>{deepScanButtonText}</ButtonText>
            </Button>
          )}

          {/* Progress */}
          <AnimatedProgressCard sharedValues={sharedValues} />
        </View>
      </Card>
    </Animated.View>
  );
}

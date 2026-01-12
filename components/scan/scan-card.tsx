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
}: ScanCardProps) {
  const isInProgress = isScanning || isDeepScanning;

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
            <Button onPress={onScan} size={"lg"}>
              <ButtonText>{scanButtonText}</ButtonText>
            </Button>
          )}

          {/* Deep Scan Button */}
          {showDeepScan && !isInProgress && onDeepScan && (
            <Button onPress={onDeepScan} variant={"outline"} size={"lg"}>
              <ButtonText variant={"outline"}>{deepScanButtonText}</ButtonText>
            </Button>
          )}

          {/* Progress */}
          <AnimatedProgressCard sharedValues={sharedValues} />
        </View>
      </Card>
    </Animated.View>
  );
}

import React, { useLayoutEffect } from "react";
import { ScrollView } from "react-native";
import { router } from "expo-router";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useScan, useUnanalyzedPhotoCount } from "@/hooks";
import { ScanHeader, PermissionCard, ScanCard } from "@/components/scan";
import { Button, ButtonText } from "@/components/ui";
import { useResetScan } from "@/store";

const RESCAN_AUTO_DEEP_SCAN_REMAINING_PHOTO_THRESHOLD = 10_000;

/**
 * Rescan screen - for users who have already completed initial setup.
 * Allows rescanning and deep scanning for new photos.
 */
export default function RescanScreen() {
  const resetScan = useResetScan();

  const {
    hasPermission,
    cameraRollCount,
    requestPermission,
    isRequestingPermission,
    isScanning,
    isComplete,
    isDeepScanning,
    scan,
    deepScan,
    sharedValues,
  } = useScan({ autoDeepScanRemainingPhotoThreshold: RESCAN_AUTO_DEEP_SCAN_REMAINING_PHOTO_THRESHOLD });
  const { data: unanalyzedPhotoCount } = useUnanalyzedPhotoCount();

  useLayoutEffect(() => {
    resetScan();
  }, [resetScan]);

  const handleGoBack = () => {
    router.back();
  };

  const handleContinue = () => {
    router.replace("/review");
  };

  const isInProgress = isScanning || isDeepScanning;
  const shouldShowDeepScan = (unanalyzedPhotoCount ?? 0) > 0;

  return (
    <ScrollView
      className={"flex-1"}
      contentInsetAdjustmentBehavior={"automatic"}
      contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingHorizontal: 24, paddingVertical: 24 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <ScanHeader
        title={"Rescan Photos"}
        description={"Scan again to find any new photos from restaurant visits."}
        iconName={"arrow.triangle.2.circlepath"}
      />

      {/* Permission Card */}
      {hasPermission === false && (
        <PermissionCard onRequestPermission={requestPermission} isRequestingPermission={isRequestingPermission} />
      )}

      {/* Scan Card */}
      {hasPermission !== false && (
        <ScanCard
          cameraRollCount={cameraRollCount}
          isScanning={isScanning}
          isDeepScanning={isDeepScanning}
          isComplete={isComplete}
          onScan={scan}
          onDeepScan={deepScan}
          sharedValues={sharedValues}
          scanButtonText={"Rescan Now"}
          deepScanButtonText={"Deep Scan All Photos"}
          showDeepScan={shouldShowDeepScan}
        />
      )}

      {/* Continue Button (only show after scan completes) */}
      {isComplete && (
        <Animated.View entering={FadeInDown.delay(200).duration(300)}>
          <Button onPress={handleContinue} size={"lg"}>
            <ButtonText>Continue to Restaurants</ButtonText>
          </Button>
        </Animated.View>
      )}

      {/* Back button when not scanning */}
      {!isInProgress && !isComplete && (
        <Animated.View entering={FadeIn.delay(300).duration(200)} className={"mt-4"}>
          <Button variant={"ghost"} onPress={handleGoBack}>
            <ButtonText variant={"ghost"}>Go Back</ButtonText>
          </Button>
        </Animated.View>
      )}
    </ScrollView>
  );
}

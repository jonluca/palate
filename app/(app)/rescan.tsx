import React from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useScan } from "@/hooks";
import { ScanHeader, PermissionCard, ScanCard } from "@/components/scan";
import { Button, ButtonText } from "@/components/ui";

/**
 * Rescan screen - for users who have already completed initial setup.
 * Allows rescanning and deep scanning for new photos.
 */
export default function RescanScreen() {
  const insets = useSafeAreaInsets();

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
  } = useScan();

  const handleGoBack = () => {
    router.back();
  };

  const handleContinue = () => {
    router.replace("/review");
  };

  const isInProgress = isScanning || isDeepScanning;

  return (
    <View className={"flex-1"} style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}>
      <View className={"flex-1 px-6 justify-center"}>
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
            onScan={scan}
            onDeepScan={deepScan}
            sharedValues={sharedValues}
            scanButtonText={"Rescan Now"}
            showDeepScan={true}
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
      </View>
    </View>
  );
}

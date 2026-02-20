import React, { useCallback } from "react";
import { StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useScan } from "@/hooks";
import { useHasCompletedOnboarding, useSetHasCompletedInitialScan, useSetHasCompletedOnboarding } from "@/store";
import { OnboardingFlow } from "@/components/onboarding";
import { ScanHeader, PermissionCard, ScanCard } from "@/components/scan";
import { Button, ButtonText } from "@/components/ui";

/**
 * Initial scan screen - shown only during onboarding for new users.
 * For rescanning, use the rescan page at /(app)/rescan
 */
export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const setHasCompletedInitialScan = useSetHasCompletedInitialScan();
  const setHasCompletedOnboarding = useSetHasCompletedOnboarding();
  const hasCompletedOnboarding = useHasCompletedOnboarding();

  const {
    hasPermission,
    cameraRollCount,
    requestPermission,
    isRequestingPermission,
    isScanning,
    isComplete,
    isDeepScanning,
    scan,
    sharedValues,
  } = useScan();

  const handleOnboardingComplete = useCallback(() => {
    setHasCompletedOnboarding(true);
  }, [setHasCompletedOnboarding]);

  const handleContinue = () => {
    setHasCompletedInitialScan(true);
    router.replace("/review");
  };

  // Show onboarding flow if not completed
  if (!hasCompletedOnboarding) {
    return <OnboardingFlow onComplete={handleOnboardingComplete} />;
  }

  return (
    <View className={"flex-1 bg-background"} style={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 20 }}>
      <LinearGradient colors={["#0B0D11", "#12171F"]} style={StyleSheet.absoluteFill} />
      <View className={"flex-1 px-6"}>
        <View className={"items-center gap-2 mt-6 mb-8"}>
          <ScanHeader
            title={"Scan Your Photos"}
            description={"We'll scan your library for restaurant moments and organize them automatically."}
            iconName={"camera.viewfinder"}
            iconColor={"#3B82F6"}
            iconBackgroundColor={"bg-blue-500/15"}
          />
        </View>

        <View className={"gap-4"}>
          {/* Permission Card */}
          {hasPermission === false && (
            <PermissionCard onRequestPermission={requestPermission} isRequestingPermission={isRequestingPermission} />
          )}

          {/* Scan Card */}
          {!isComplete && hasPermission !== false && (
            <ScanCard
              cameraRollCount={cameraRollCount}
              isScanning={isScanning}
              isDeepScanning={isDeepScanning}
              onScan={scan}
              sharedValues={sharedValues}
              scanButtonText={"Start Scanning"}
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
        </View>
      </View>
    </View>
  );
}

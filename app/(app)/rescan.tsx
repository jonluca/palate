import React from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useScan } from "@/hooks";
import { ScanHeader, PermissionCard, ScanCard } from "@/components/scan";
import { Button, ButtonText, Card } from "@/components/ui";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";

/**
 * Rescan screen - for users who have already completed initial setup.
 * Allows rescanning and deep scanning for new photos.
 */
export default function RescanScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ intent?: string }>();
  const emphasizeDeepScan = params.intent === "deep-scan";

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
          title={emphasizeDeepScan ? "Deep Scan Photos" : "Rescan Photos"}
          description={
            emphasizeDeepScan
              ? "Run a slower full-library scan to catch food photos the quick scan may have missed."
              : "Scan again to find any new photos from restaurant visits."
          }
          iconName={emphasizeDeepScan ? "eye.fill" : "arrow.triangle.2.circlepath"}
        />

        {emphasizeDeepScan && !isInProgress && !isComplete && (
          <Animated.View entering={FadeIn.delay(150).duration(250)} className={"mb-4"}>
            <Card animated={false}>
              <View className={"p-4 flex-row items-center gap-3"}>
                <View className={"w-10 h-10 rounded-2xl bg-pink-500/15 items-center justify-center"}>
                  <IconSymbol name={"eye.fill"} size={18} color={"#EC4899"} />
                </View>
                <View className={"flex-1"}>
                  <ThemedText variant={"subhead"} className={"font-semibold"}>
                    Deep scan highlighted
                  </ThemedText>
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    This checks your whole library more thoroughly, but it takes longer than a regular rescan.
                  </ThemedText>
                </View>
              </View>
            </Card>
          </Animated.View>
        )}

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
            deepScanButtonText={emphasizeDeepScan ? "Start Deep Scan" : "Deep Scan for Food"}
            showDeepScan={true}
            primaryAction={emphasizeDeepScan ? "deep-scan" : "scan"}
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

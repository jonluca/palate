import React, { useRef, useCallback } from "react";
import { View, FlatList, Pressable, type ViewToken } from "react-native";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { FadeIn, FadeInUp, useSharedValue } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText } from "@/components/ui";
import { DotIndicator } from "./dot-indicator";
import { SlideItem } from "./slide-item";
import { ONBOARDING_SLIDES } from "./slides";
import type { PermissionType } from "./types";
import { useRequestPermission, useRequestCalendarPermission } from "@/hooks";

interface OnboardingFlowProps {
  onComplete: () => void;
}

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [isPagerScrollEnabled, setIsPagerScrollEnabled] = React.useState(true);
  const flatListRef = useRef<FlatList>(null);
  const scrollX = useSharedValue(0);

  const requestMediaPermission = useRequestPermission();
  const requestCalendarPermissionMutation = useRequestCalendarPermission();

  const isRequestingPermission = requestMediaPermission.isPending || requestCalendarPermissionMutation.isPending;

  const requestPermission = useCallback(
    async (type: PermissionType) => {
      switch (type) {
        case "photos":
          return requestMediaPermission.mutateAsync();
        case "calendar":
          return requestCalendarPermissionMutation.mutateAsync();
      }
    },
    [requestMediaPermission, requestCalendarPermissionMutation],
  );

  const isLastSlide = currentIndex === ONBOARDING_SLIDES.length - 1;
  const currentSlide = ONBOARDING_SLIDES[currentIndex];
  const goToNextSlide = useCallback(() => {
    if (isLastSlide) {
      onComplete();
    } else {
      flatListRef.current?.scrollToIndex({
        index: currentIndex + 1,
        animated: true,
      });
    }
  }, [currentIndex, isLastSlide, onComplete]);

  const handleNext = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // If this slide has a permission, request it before proceeding
    if (currentSlide.permission) {
      await requestPermission(currentSlide.permission);
      // Proceed regardless of whether permission was granted
      // User can always grant it later in settings
    }

    goToNextSlide();
  }, [currentSlide.permission, goToNextSlide, requestPermission]);

  const handleSkip = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onComplete();
  }, [onComplete]);

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    if (viewableItems.length > 0 && viewableItems[0].index !== null) {
      setCurrentIndex(viewableItems[0].index);
    }
  }, []);

  const viewabilityConfig = { itemVisiblePercentThreshold: 50 };

  return (
    <View style={{ flex: 1 }}>
      {/* iOS-like layered background */}
      <LinearGradient
        colors={["#06080d", "#0a0e15", "#101723"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.85, y: 1 }}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />
      {/* Skip Button */}
      {__DEV__ && !isLastSlide && (
        <Animated.View
          entering={FadeIn.delay(300).duration(400)}
          style={{
            position: "absolute",
            right: 16,
            zIndex: 10,
            top: insets.top + 10,
          }}
        >
          <BlurView
            intensity={24}
            tint={"dark"}
            style={{
              borderRadius: 999,
              overflow: "hidden",
              borderCurve: "continuous",
              boxShadow: "0 10px 24px rgba(0,0,0,0.20)",
            }}
          >
            <Pressable
              onPress={handleSkip}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 9,
                backgroundColor: "rgba(18, 22, 30, 0.34)",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.10)",
              }}
            >
              <ThemedText variant={"subhead"} style={{ color: "rgba(255,255,255,0.82)", fontWeight: "600" }}>
                Skip
              </ThemedText>
            </Pressable>
          </BlurView>
        </Animated.View>
      )}

      {/* Slides */}
      <FlatList
        ref={flatListRef}
        data={ONBOARDING_SLIDES}
        horizontal
        pagingEnabled
        scrollEnabled={isPagerScrollEnabled}
        showsHorizontalScrollIndicator={false}
        bounces={false}
        directionalLockEnabled
        nestedScrollEnabled
        onScroll={(e) => {
          scrollX.value = e.nativeEvent.contentOffset.x;
        }}
        scrollEventThrottle={16}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        renderItem={({ item, index }) => (
          <SlideItem
            currentIndex={currentIndex}
            slide={item}
            index={index}
            scrollX={scrollX}
            setParentScrollEnabled={setIsPagerScrollEnabled}
          />
        )}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{
          paddingTop: insets.top + 92,
          paddingBottom: 250,
        }}
      />

      {/* Bottom Controls */}
      <Animated.View
        entering={FadeInUp.delay(200).duration(400)}
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + 12,
        }}
      >
        <BlurView
          intensity={42}
          tint={"dark"}
          className={"overflow-hidden rounded-2xl"}
          style={{
            borderRadius: 28,
            borderCurve: "continuous",
            boxShadow: "0 22px 50px rgba(0,0,0,0.28)",
          }}
        >
          <View
            style={{
              padding: 16,
              gap: 14,
              backgroundColor: "rgba(12, 16, 24, 0.48)",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <View style={{ gap: 2 }}>
                <ThemedText
                  variant={"caption1"}
                  style={{
                    color: "rgba(255,255,255,0.64)",
                    textTransform: "uppercase",
                    letterSpacing: 0.8,
                    fontWeight: "700",
                  }}
                >
                  {`Step ${currentIndex + 1} of ${ONBOARDING_SLIDES.length}`}
                </ThemedText>
              </View>

              <View
                style={{
                  borderRadius: 999,
                  borderCurve: "continuous",
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  backgroundColor: "rgba(255,255,255,0.06)",
                  borderWidth: 1,
                  borderColor: "rgba(255,255,255,0.08)",
                }}
              >
                <DotIndicator currentIndex={currentIndex} total={ONBOARDING_SLIDES.length} />
              </View>
            </View>

            <Button
              onPress={handleNext}
              haptic={false}
              size={"lg"}
              loading={isRequestingPermission}
              className={"bg-[#0A84FF]"}
              style={{
                height: 54,
                borderRadius: 18,
              }}
            >
              <ButtonText size={"lg"} className={"text-white font-semibold"}>
                {isLastSlide ? "Get Started" : currentSlide.buttonText ? currentSlide.buttonText : "Continue"}
              </ButtonText>
            </Button>
          </View>
        </BlurView>
      </Animated.View>
    </View>
  );
}

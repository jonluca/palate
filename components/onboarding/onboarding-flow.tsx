import React, { useRef, useCallback } from "react";
import { View, FlatList, type ViewToken } from "react-native";
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
      {/* Animated Background Gradient */}
      <LinearGradient
        colors={currentSlide.gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />

      {/* Decorative Elements */}
      <View className={"absolute inset-0 overflow-hidden"} pointerEvents={"none"}>
        <View className={"absolute top-[10%] -right-20 w-64 h-64 rounded-full bg-white/[0.02]"} />
        <View className={"absolute top-[30%] -left-32 w-80 h-80 rounded-full bg-white/[0.02]"} />
        <View className={"absolute bottom-[20%] -right-40 w-96 h-96 rounded-full bg-white/[0.02]"} />
      </View>

      {/* Skip Button */}
      {__DEV__ && !isLastSlide && (
        <Animated.View
          entering={FadeIn.delay(300).duration(400)}
          className={"absolute right-6 z-10"}
          style={{ top: insets.top + 12 }}
        >
          <Button variant={"ghost"} onPress={handleSkip} size={"sm"}>
            <ThemedText variant={"subhead"} className={"text-white/60"}>
              Skip
            </ThemedText>
          </Button>
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
          <SlideItem slide={item} index={index} scrollX={scrollX} setParentScrollEnabled={setIsPagerScrollEnabled} />
        )}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{
          paddingTop: insets.top + 80,
          paddingBottom: 200,
        }}
      />

      {/* Bottom Controls */}
      <Animated.View
        entering={FadeInUp.delay(200).duration(400)}
        className={"absolute bottom-0 left-0 right-0 px-6"}
        style={{ paddingBottom: insets.bottom + 32 }}
      >
        {/* Dot Indicator */}
        <View className={"mb-8"}>
          <DotIndicator currentIndex={currentIndex} total={ONBOARDING_SLIDES.length} />
        </View>

        {/* Action Button */}
        <Button onPress={handleNext} size={"lg"} className={"bg-white"} loading={isRequestingPermission}>
          <ButtonText className={"text-black font-semibold"}>
            {isLastSlide ? "Get Started" : currentSlide.buttonText ? currentSlide.buttonText : "Continue"}
          </ButtonText>
        </Button>
      </Animated.View>
    </View>
  );
}

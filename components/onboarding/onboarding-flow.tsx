import React, { useRef, useCallback } from "react";
import { View, FlatList, Pressable, type ViewToken, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  const { width, height } = useWindowDimensions();
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
  const footerBottom = insets.bottom + 20;
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

  const renderSlide = useCallback(
    ({ item, index }: { item: (typeof ONBOARDING_SLIDES)[number]; index: number }) => (
      <SlideItem
        currentIndex={currentIndex}
        slide={item}
        index={index}
        scrollX={scrollX}
        screenWidth={width}
        screenHeight={height}
        setParentScrollEnabled={setIsPagerScrollEnabled}
      />
    ),
    [currentIndex, height, scrollX, width],
  );

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    if (viewableItems.length > 0 && viewableItems[0].index !== null) {
      setCurrentIndex(viewableItems[0].index);
    }
  }, []);

  const viewabilityConfig = { itemVisiblePercentThreshold: 50 };

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
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
          <Pressable
            onPress={handleSkip}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 8,
              backgroundColor: "rgba(10,10,10,0.62)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.12)",
              borderRadius: 999,
            }}
          >
            <ThemedText variant={"footnote"} style={{ color: "rgba(255,255,255,0.82)", fontWeight: "600" }}>
              Skip
            </ThemedText>
          </Pressable>
        </Animated.View>
      )}

      <Animated.View
        entering={FadeIn.delay(200).duration(400)}
        style={{
          position: "absolute",
          top: insets.top + 14,
          left: 0,
          right: 0,
          zIndex: 10,
          alignItems: "center",
        }}
      >
        <View
          style={{
            borderRadius: 18,
            paddingHorizontal: 18,
            paddingVertical: 10,
            backgroundColor: "rgba(10,10,10,0.6)",
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.12)",
          }}
        >
          <ThemedText variant={"title3"} className={"text-white font-semibold"}>
            Palate
          </ThemedText>
        </View>
      </Animated.View>

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
        renderItem={renderSlide}
        keyExtractor={(item) => item.id}
        extraData={{ width, height }}
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
      />

      <Animated.View
        entering={FadeInUp.delay(200).duration(400)}
        style={{
          position: "absolute",
          bottom: footerBottom,
          left: 0,
          right: 0,
          paddingHorizontal: 24,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <View
            style={{
              flex: 1,
              paddingHorizontal: 14,
              paddingVertical: 12,
              borderRadius: 999,
              backgroundColor: "rgba(10,10,10,0.48)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.10)",
            }}
          >
            <DotIndicator currentIndex={currentIndex} total={ONBOARDING_SLIDES.length} />
          </View>

          <Button
            onPress={handleNext}
            haptic={false}
            size={"lg"}
            loading={isRequestingPermission}
            style={{
              minWidth: 146,
              height: 52,
              borderRadius: 999,
            }}
          >
            <ButtonText size={"sm"} className={"text-white font-semibold"}>
              {isLastSlide ? "Get Started" : currentSlide.buttonText ? currentSlide.buttonText : "Next"}
            </ButtonText>
          </Button>
        </View>
      </Animated.View>
    </View>
  );
}

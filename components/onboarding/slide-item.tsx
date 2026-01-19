import React from "react";
import { View, Dimensions } from "react-native";
import Animated, { useAnimatedStyle, interpolate, Extrapolation, type SharedValue } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import type { OnboardingSlide } from "./types";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

interface SlideItemProps {
  currentIndex: number;
  slide: OnboardingSlide;
  index: number;
  scrollX: SharedValue<number>;
  setParentScrollEnabled?: (enabled: boolean) => void;
}

export function SlideItem({ currentIndex, slide, index, scrollX, setParentScrollEnabled }: SlideItemProps) {
  const inputRange = [(index - 1) * SCREEN_WIDTH, index * SCREEN_WIDTH, (index + 1) * SCREEN_WIDTH];

  const animatedIconStyle = useAnimatedStyle(() => {
    const scale = interpolate(scrollX.value, inputRange, [0.5, 1, 0.5], Extrapolation.CLAMP);
    const opacity = interpolate(scrollX.value, inputRange, [0, 1, 0], Extrapolation.CLAMP);
    const translateY = interpolate(scrollX.value, inputRange, [50, 0, 50], Extrapolation.CLAMP);

    return {
      transform: [{ scale }, { translateY }],
      opacity,
    };
  });

  const animatedTextStyle = useAnimatedStyle(() => {
    const opacity = interpolate(scrollX.value, inputRange, [0, 1, 0], Extrapolation.CLAMP);
    const translateY = interpolate(scrollX.value, inputRange, [30, 0, 30], Extrapolation.CLAMP);

    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  const hasCustomContent = !!slide.CustomContent;

  return (
    <View
      style={{ width: SCREEN_WIDTH, justifyContent: hasCustomContent ? "flex-start" : "center" }}
      className={"flex-1 items-center px-8"}
    >
      {/* Icon - smaller when there's custom content */}
      <Animated.View
        style={animatedIconStyle}
        className={`${hasCustomContent ? "w-24 h-24 mt-8" : "w-32 h-32"} rounded-full ${slide.iconBg} items-center justify-center mb-6`}
      >
        <IconSymbol name={slide.icon} size={hasCustomContent ? 48 : 64} color={slide.iconColor} />
      </Animated.View>

      {/* Text Content */}
      <Animated.View style={animatedTextStyle} className={"items-center gap-3"}>
        <ThemedText
          variant={hasCustomContent ? "title1" : "largeTitle"}
          className={"text-white font-bold text-center"}
          style={{ lineHeight: hasCustomContent ? 36 : 44 }}
        >
          {slide.title}
        </ThemedText>

        <View className={"bg-white/10 rounded-full px-4 py-2"}>
          <ThemedText variant={"subhead"} className={"text-white/80 font-medium"}>
            {slide.subtitle}
          </ThemedText>
        </View>

        <ThemedText
          variant={hasCustomContent ? "footnote" : "body"}
          className={"text-white/60 text-center max-w-xs mt-1"}
          style={{ lineHeight: hasCustomContent ? 20 : 24 }}
        >
          {slide.description}
        </ThemedText>
      </Animated.View>

      {/* Custom Content */}
      {slide.CustomContent && (
        <slide.CustomContent
          key={currentIndex}
          scrollX={scrollX}
          index={index}
          setParentScrollEnabled={setParentScrollEnabled}
        />
      )}
    </View>
  );
}

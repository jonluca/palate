import React from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { useAnimatedStyle, interpolate, Extrapolation, type SharedValue } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import type { OnboardingSlide } from "./types";

interface SlideItemProps {
  currentIndex: number;
  slide: OnboardingSlide;
  index: number;
  scrollX: SharedValue<number>;
  screenWidth: number;
  screenHeight: number;
  setParentScrollEnabled?: (enabled: boolean) => void;
}

export function SlideItem({
  currentIndex,
  slide,
  index,
  scrollX,
  screenWidth,
  screenHeight,
  setParentScrollEnabled,
}: SlideItemProps) {
  const inputRange = [(index - 1) * screenWidth, index * screenWidth, (index + 1) * screenWidth];
  const hasCustomContent = !!slide.CustomContent;
  const heroHeight = Math.max(screenHeight * 0.54, 320);
  const contentBottomPadding = hasCustomContent ? 140 : 156;

  const animatedIconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollX.value, inputRange, [0, 1, 0], Extrapolation.CLAMP),
  }));

  const animatedTextStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollX.value, inputRange, [0, 1, 0], Extrapolation.CLAMP),
  }));

  return (
    <View style={{ width: screenWidth, height: screenHeight }} className={"bg-background"}>
      <View style={{ height: heroHeight }} className={"overflow-hidden"}>
        <Image
          source={slide.heroImage}
          style={{ width: "100%", height: "100%" }}
          contentFit={"cover"}
          transition={300}
        />
        <LinearGradient
          colors={["rgba(0,0,0,0.1)", "rgba(0,0,0,0.38)", "#000000"]}
          locations={[0, 0.54, 1]}
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <LinearGradient
          colors={[`${slide.gradient[1]}00`, `${slide.gradient[2]}88`, `${slide.gradient[3]}D6`]}
          locations={[0, 0.64, 1]}
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        />
      </View>

      <View
        style={{
          flex: 1,
          marginTop: -32,
          paddingHorizontal: 24,
          paddingTop: 20,
          paddingBottom: contentBottomPadding,
        }}
      >
        <Animated.View style={animatedTextStyle} className={"gap-4"}>
          <Animated.View style={animatedIconStyle}>
            <View className={"w-11 h-11 rounded-2xl border border-white/10 items-center justify-center bg-black/20"}>
              <View className={`w-full h-full rounded-2xl ${slide.iconBg} items-center justify-center`}>
                <IconSymbol name={slide.icon} size={20} color={slide.iconColor} />
              </View>
            </View>
          </Animated.View>

          <View className={"gap-2"}>
            <ThemedText variant={hasCustomContent ? "title1" : "largeTitle"} className={"text-white font-bold"}>
              {slide.title}
            </ThemedText>
            <ThemedText variant={"subhead"} className={"text-white/80 font-medium"}>
              {slide.subtitle}
            </ThemedText>
            {slide.description ? (
              <ThemedText
                variant={hasCustomContent ? "footnote" : "body"}
                className={"text-white/62"}
                style={{ lineHeight: hasCustomContent ? 19 : 24 }}
              >
                {slide.description}
              </ThemedText>
            ) : null}
          </View>
        </Animated.View>

        {slide.CustomContent ? (
          <View className={"pt-6"}>
            <slide.CustomContent
              scrollX={scrollX}
              index={index}
              currentIndex={currentIndex}
              setParentScrollEnabled={setParentScrollEnabled}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

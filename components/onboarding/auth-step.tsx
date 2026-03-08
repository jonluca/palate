import React from "react";
import { useWindowDimensions } from "react-native";
import Animated, { Extrapolation, interpolate, type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { AppleSignInPanel } from "@/components/auth/apple-sign-in-panel";

interface AuthStepContentProps {
  scrollX: SharedValue<number>;
  index: number;
  currentIndex: number;
  setParentScrollEnabled?: (enabled: boolean) => void;
}

export function AuthStepContent({ scrollX, index }: AuthStepContentProps) {
  const { width } = useWindowDimensions();
  const inputRange = [(index - 1) * width, index * width, (index + 1) * width];

  const animatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(scrollX.value, inputRange, [0, 1, 0], Extrapolation.CLAMP);
    const translateY = interpolate(scrollX.value, inputRange, [30, 0, 30], Extrapolation.CLAMP);

    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  return (
    <Animated.View style={animatedStyle} className={"mt-6 w-full px-4"}>
      <AppleSignInPanel loadingMessage={"Checking whether Apple sign-in is available on this device..."} />
    </Animated.View>
  );
}

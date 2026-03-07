import React from "react";
import { View, useWindowDimensions } from "react-native";
import Animated, { Extrapolation, interpolate, type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { AppleSignInPanel } from "@/components/auth/apple-sign-in-panel";
import { ThemedText } from "@/components/themed-text";

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
      <View className={"gap-3 rounded-3xl border border-white/10 bg-white/10 p-4"}>
        <AppleSignInPanel
          variant={"compact"}
          signedInTitle={"Apple sign-in connected"}
          signedInMessage={"You can keep onboarding. Confirmed visits will sync once you start using Palate."}
          loadingMessage={"Checking whether Apple sign-in is available on this device..."}
          submittingMessage={"Connecting your Palate account..."}
        />
        <ThemedText variant={"caption1"} className={"text-center text-white/55"}>
          Skip this step and continue locally. You can connect Apple later from Account or Social.
        </ThemedText>
      </View>
    </Animated.View>
  );
}

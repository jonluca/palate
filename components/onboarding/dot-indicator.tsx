import React from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";

interface DotIndicatorProps {
  currentIndex: number;
  total: number;
}

export function DotIndicator({ currentIndex, total }: DotIndicatorProps) {
  return (
    <View className={"flex-row gap-2 items-center justify-center"}>
      {Array.from({ length: total }).map((_, index) => (
        <Animated.View
          key={index}
          className={`h-2 rounded-full ${index === currentIndex ? "w-6 bg-primary" : "w-2 bg-white/20"}`}
          style={{
            transform: [{ scale: index === currentIndex ? 1 : 0.8 }],
          }}
        />
      ))}
    </View>
  );
}

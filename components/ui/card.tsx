import { cn } from "@/utils/cn";
import React from "react";
import { View, type ViewProps } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

type CardProps = ViewProps & {
  animated?: boolean;
  delay?: number;
};

export function Card({ children, className, animated = true, delay = 0, ...props }: CardProps) {
  if (animated) {
    return (
      <Animated.View
        entering={FadeIn.delay(delay).duration(300)}
        exiting={FadeOut.duration(200)}
        className={cn("rounded-xl bg-card overflow-hidden", className)}
        style={{ borderCurve: "continuous" }}
        {...props}
      >
        {children}
      </Animated.View>
    );
  }

  return (
    <View
      className={cn("rounded-xl bg-card overflow-hidden", className)}
      style={{ borderCurve: "continuous" }}
      {...props}
    >
      {children}
    </View>
  );
}

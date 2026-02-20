import { cn } from "@/utils/cn";
import React from "react";
import { View, type ViewProps } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

type CardProps = ViewProps & {
  animated?: boolean;
  delay?: number;
};

export function Card({ children, className, animated = true, delay = 0, ...props }: CardProps) {
  const { style, ...rest } = props;
  const cardStyle = {
    borderCurve: "continuous" as const,
    boxShadow: "0 1px 0 rgba(255, 255, 255, 0.05), 0 10px 24px rgba(0, 0, 0, 0.28)",
  };

  if (animated) {
    return (
      <Animated.View
        entering={FadeIn.delay(delay).duration(300)}
        exiting={FadeOut.duration(200)}
        className={cn("rounded-2xl border border-border bg-card overflow-hidden", className)}
        style={[cardStyle, style]}
        {...rest}
      >
        {children}
      </Animated.View>
    );
  }

  return (
    <View
      className={cn("rounded-2xl border border-border bg-card overflow-hidden", className)}
      style={[cardStyle, style]}
      {...rest}
    >
      {children}
    </View>
  );
}

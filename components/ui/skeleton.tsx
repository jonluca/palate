import React, { useEffect } from "react";
import { View, type ViewProps } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  interpolate,
  Easing,
} from "react-native-reanimated";
import { cn } from "@/utils/cn";

interface SkeletonProps extends ViewProps {
  width?: number | `${number}%`;
  height?: number;
  borderRadius?: number;
  variant?: "rect" | "circle" | "text";
}

function Skeleton({
  width = "100%",
  height = 20,
  borderRadius = 8,
  variant = "rect",
  className,
  style,
  ...props
}: SkeletonProps) {
  "use no memo";

  const shimmerProgress = useSharedValue(0);

  useEffect(() => {
    shimmerProgress.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.linear }), -1, false);
  }, [shimmerProgress]);

  const animatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(shimmerProgress.value, [0, 0.5, 1], [0.3, 0.6, 0.3]);
    return { opacity };
  });

  const circleSize = typeof width === "number" ? width : height;

  return (
    <Animated.View
      style={[
        {
          width: variant === "circle" ? circleSize : width,
          height: variant === "circle" ? circleSize : height,
          borderRadius: variant === "circle" ? circleSize / 2 : borderRadius,
        },
        animatedStyle,
        style,
      ]}
      className={cn("bg-muted", className)}
      {...props}
    />
  );
}

export function SkeletonVisitCard({ className }: { className?: string }) {
  return (
    <View className={cn("bg-card border border-border rounded-2xl overflow-hidden", className)}>
      {/* Photo preview */}
      <View className={"flex-row h-28"}>
        <Skeleton height={112} width={"33.33%"} borderRadius={0} />
        <Skeleton height={112} width={"33.33%"} borderRadius={0} />
        <Skeleton height={112} width={"33.33%"} borderRadius={0} />
      </View>

      {/* Content */}
      <View className={"p-4 gap-3"}>
        <View className={"flex-row items-start justify-between"}>
          <View className={"flex-1 gap-2"}>
            <Skeleton height={18} width={"60%"} />
            <Skeleton height={14} width={"40%"} />
          </View>
          <Skeleton height={20} width={70} borderRadius={10} />
        </View>

        <View className={"flex-row items-center justify-between"}>
          <Skeleton height={14} width={"30%"} />
          <View className={"flex-row gap-2"}>
            <Skeleton height={36} width={36} variant={"circle"} />
            <Skeleton height={36} width={36} variant={"circle"} />
          </View>
        </View>
      </View>
    </View>
  );
}

export function SkeletonRestaurantCard({ className }: { className?: string }) {
  return (
    <View className={cn("bg-card border border-border rounded-2xl p-4 gap-2", className)}>
      <View className={"flex-row items-start justify-between"}>
        <View className={"flex-1 gap-2"}>
          <Skeleton height={18} width={"70%"} />
          <Skeleton height={14} width={"40%"} />
        </View>
        <View className={"flex-row items-center gap-2"}>
          <Skeleton height={16} width={40} />
        </View>
      </View>
      <View className={"flex-row justify-end mt-1"}>
        <Skeleton height={16} width={16} borderRadius={4} />
      </View>
    </View>
  );
}

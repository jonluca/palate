import React, { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  Easing,
  FadeInUp,
} from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { Button, ButtonText } from "./button";

interface EmptyStateProps {
  icon: string;
  iconColor?: string;
  title: string;
  description: string;
  action?: {
    label: string;
    onPress: () => void;
    variant?: "default" | "secondary" | "outline";
  };
  variant?: "default" | "success" | "info";
}

function AnimatedIcon({ icon, color, variant }: { icon: string; color: string; variant: string }) {
  "use no memo";

  const scale = useSharedValue(0.92);
  const opacity = useSharedValue(0);

  useEffect(() => {
    scale.value = withDelay(60, withTiming(1, { duration: 280, easing: Easing.out(Easing.cubic) }));
    opacity.value = withTiming(1, { duration: 220 });
  }, [opacity, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const bgColor =
    variant === "success"
      ? "bg-green-500/15 border border-green-500/20"
      : variant === "info"
        ? "bg-blue-500/15 border border-blue-500/20"
        : "bg-primary/10 border border-primary/20";

  return (
    <Animated.View style={animatedStyle} className={`w-20 h-20 rounded-3xl ${bgColor} items-center justify-center`}>
      <IconSymbol name={icon as never} size={40} color={color} />
    </Animated.View>
  );
}

function EmptyState({ icon, iconColor = "#f97316", title, description, action, variant = "default" }: EmptyStateProps) {
  return (
    <View className={"py-10 px-4 items-center gap-5"}>
      <AnimatedIcon icon={icon} color={iconColor} variant={variant} />

      <Animated.View entering={FadeInUp.delay(200).duration(500)} className={"gap-2 items-center"}>
        <ThemedText variant={"title2"} className={"font-semibold text-center"}>
          {title}
        </ThemedText>
        <ThemedText variant={"body"} color={"secondary"} className={"text-center max-w-xs leading-relaxed"}>
          {description}
        </ThemedText>
      </Animated.View>

      {action && (
        <Animated.View entering={FadeInUp.delay(400).duration(500)}>
          <Button onPress={action.onPress} variant={action.variant ?? "default"} size={"lg"}>
            <ButtonText variant={action.variant ?? "default"}>{action.label}</ButtonText>
          </Button>
        </Animated.View>
      )}
    </View>
  );
}

// Pre-built empty states
export function NoRestaurantsEmpty({ onPress }: { onPress?: () => void }) {
  return (
    <EmptyState
      icon={"fork.knife"}
      iconColor={"#f97316"}
      title={"No Restaurants Yet"}
      description={
        "Scan your camera roll to discover photos from restaurant visits, then confirm them to build your dining history."
      }
      action={
        onPress
          ? {
              label: "Start Review",
              onPress,
            }
          : undefined
      }
    />
  );
}

export function NoVisitsEmpty({ onScan }: { onScan?: () => void }) {
  return (
    <EmptyState
      icon={"photo.stack"}
      iconColor={"#6b7280"}
      title={"No Visits Found"}
      description={
        "Scan your camera roll from the Restaurants tab to find photos taken at restaurants and organize them by visit."
      }
      action={
        onScan
          ? {
              label: "Scan Photos",
              onPress: onScan,
            }
          : undefined
      }
    />
  );
}

export function AllCaughtUpEmpty() {
  return (
    <EmptyState
      icon={"checkmark.circle.fill"}
      iconColor={"#22c55e"}
      title={"All Caught Up!"}
      description={"You've reviewed all pending visits. Scan your camera roll again to find new restaurant photos."}
      variant={"success"}
    />
  );
}

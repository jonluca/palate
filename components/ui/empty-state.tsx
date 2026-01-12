import React, { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
  Easing,
  FadeIn,
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

// Animated floating icon with bounce
function AnimatedIcon({ icon, color, variant }: { icon: string; color: string; variant: string }) {
  const translateY = useSharedValue(0);
  const scale = useSharedValue(0.8);
  const rotate = useSharedValue(0);

  useEffect(() => {
    // Bounce animation
    translateY.value = withRepeat(
      withSequence(
        withTiming(-8, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      true,
    );

    // Scale in
    scale.value = withDelay(100, withTiming(1, { duration: 500, easing: Easing.out(Easing.back(1.5)) }));

    // Subtle rotation
    rotate.value = withRepeat(
      withSequence(
        withTiming(-5, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        withTiming(5, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      true,
    );
  }, [translateY, scale, rotate]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { scale: scale.value }, { rotate: `${rotate.value}deg` }],
  }));

  const bgColor =
    variant === "success" ? "bg-green-500/15" : variant === "info" ? "bg-blue-500/15" : "bg-orange-500/15";

  return (
    <Animated.View style={animatedStyle} className={`w-24 h-24 rounded-3xl ${bgColor} items-center justify-center`}>
      <IconSymbol name={icon as never} size={48} color={color} />
    </Animated.View>
  );
}

// Decorative dots
function DecorativeDots() {
  return (
    <View className={"absolute inset-0"} pointerEvents={"none"}>
      <Animated.View
        entering={FadeIn.delay(500).duration(800)}
        className={"absolute top-4 left-8 w-2 h-2 rounded-full bg-orange-500/20"}
      />
      <Animated.View
        entering={FadeIn.delay(600).duration(800)}
        className={"absolute top-12 right-10 w-3 h-3 rounded-full bg-blue-500/20"}
      />
      <Animated.View
        entering={FadeIn.delay(700).duration(800)}
        className={"absolute bottom-8 left-16 w-2 h-2 rounded-full bg-green-500/20"}
      />
      <Animated.View
        entering={FadeIn.delay(800).duration(800)}
        className={"absolute bottom-4 right-8 w-2 h-2 rounded-full bg-amber-500/20"}
      />
    </View>
  );
}

function EmptyState({ icon, iconColor = "#f97316", title, description, action, variant = "default" }: EmptyStateProps) {
  return (
    <View className={"py-12 px-6 items-center gap-6 relative"}>
      <DecorativeDots />

      <AnimatedIcon icon={icon} color={iconColor} variant={variant} />

      <Animated.View entering={FadeInUp.delay(200).duration(500)} className={"gap-2 items-center"}>
        <ThemedText variant={"title2"} className={"font-bold text-center"}>
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

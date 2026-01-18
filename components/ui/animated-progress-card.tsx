import React, { useEffect } from "react";
import { View, StyleSheet } from "react-native";
import Animated, {
  useAnimatedStyle,
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedReaction,
  runOnJS,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
  type SharedValue,
} from "react-native-reanimated";
import { ThemedText } from "../themed-text";
import { Card } from "./card";
import { IconSymbol } from "../icon-symbol";
import type { ProgressSharedValues } from "@/hooks/use-progress";

interface AnimatedProgressCardProps {
  sharedValues: ProgressSharedValues;
}

// Pulsing activity indicator with animation
function PulsingIndicator() {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(0.6);

  useEffect(() => {
    scale.value = withRepeat(
      withSequence(
        withTiming(1.2, { duration: 600, easing: Easing.ease }),
        withTiming(1, { duration: 600, easing: Easing.ease }),
      ),
      -1,
      false,
    );
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 600, easing: Easing.ease }),
        withTiming(0.6, { duration: 600, easing: Easing.ease }),
      ),
      -1,
      false,
    );
  }, [scale, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={animatedStyle}>
      <View className={"w-6 h-6 rounded-full bg-orange-500/30 items-center justify-center"}>
        <View className={"w-3 h-3 rounded-full bg-orange-500"} />
      </View>
    </Animated.View>
  );
}

// Animated text component that reads from shared value
function AnimatedStatusText({ value }: { value: SharedValue<string> }) {
  const [text, setText] = React.useState("");

  useAnimatedReaction(
    () => value.value,
    (current, previous) => {
      if (current !== previous) {
        runOnJS(setText)(current);
      }
    },
    [value],
  );

  if (!text) {
    return null;
  }

  return (
    <ThemedText variant={"subhead"} color={"secondary"} className={"flex-1 font-medium"} numberOfLines={1}>
      {text}
    </ThemedText>
  );
}

// Animated speed display
function AnimatedSpeedText({ value }: { value: SharedValue<number> }) {
  const [speed, setSpeed] = React.useState(0);

  useAnimatedReaction(
    () => value.value,
    (current, previous) => {
      if (current !== previous) {
        runOnJS(setSpeed)(current);
      }
    },
    [value],
  );

  if (speed <= 0) {
    return null;
  }

  return (
    <View className={"flex-row items-center gap-1.5 bg-green-500/10 px-2.5 py-1 rounded-full"}>
      <IconSymbol name={"bolt.fill"} size={12} color={"#22c55e"} />
      <ThemedText variant={"caption1"} className={"text-green-500 font-semibold"}>
        {Math.round(speed).toLocaleString()}/s
      </ThemedText>
    </View>
  );
}

// Animated ETA display
function AnimatedEtaText({ value }: { value: SharedValue<string> }) {
  const [eta, setEta] = React.useState("");

  useAnimatedReaction(
    () => value.value,
    (current, previous) => {
      if (current !== previous) {
        runOnJS(setEta)(current);
      }
    },
    [value],
  );

  if (!eta) {
    return null;
  }

  return (
    <View className={"flex-row items-center gap-1.5 bg-blue-500/10 px-2.5 py-1 rounded-full"}>
      <IconSymbol name={"clock.fill"} size={12} color={"#3b82f6"} />
      <ThemedText variant={"caption1"} className={"text-blue-500 font-semibold"}>
        {eta}
      </ThemedText>
    </View>
  );
}

// Enhanced animated progress bar with gradient effect
function AnimatedProgressBar({ progress }: { progress: SharedValue<number> }) {
  const shimmerProgress = useSharedValue(0);

  useEffect(() => {
    shimmerProgress.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.linear }), -1, false);
  }, [shimmerProgress]);

  const barStyle = useAnimatedStyle(() => ({
    width: `${Math.max(progress.value * 100, 2)}%`,
  }));

  const shimmerStyle = useAnimatedStyle(() => {
    const translateX = shimmerProgress.value * 200 - 100;
    return {
      transform: [{ translateX }],
      opacity: 0.4,
    };
  });

  return (
    <View className={"h-2 bg-muted/50 rounded-full overflow-hidden"}>
      <Animated.View style={[styles.progressBar, barStyle]} className={"bg-orange-500 h-full relative overflow-hidden"}>
        <Animated.View
          style={[shimmerStyle, styles.shimmer]}
          className={"absolute inset-y-0 w-24 bg-gradient-to-r from-transparent via-white to-transparent"}
        />
      </Animated.View>
    </View>
  );
}

// Completion checkmark with animation
function CompletionBadge() {
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      className={"w-6 h-6 rounded-full bg-green-500 items-center justify-center"}
    >
      <IconSymbol name={"checkmark"} size={14} color={"white"} />
    </Animated.View>
  );
}

export function AnimatedProgressCard({ sharedValues }: AnimatedProgressCardProps) {
  const { status, speed, eta, progress, isActive } = sharedValues;
  const [visible, setVisible] = React.useState(false);
  const [showStats, setShowStats] = React.useState(false);
  const [isComplete, setIsComplete] = React.useState(false);

  // Track visibility based on status
  useAnimatedReaction(
    () => status.value,
    (current) => {
      runOnJS(setVisible)(current.length > 0);
      // Check if message indicates completion
      runOnJS(setIsComplete)(current.toLowerCase().includes("done"));
    },
    [status],
  );

  // Track if we should show speed/eta
  useAnimatedReaction(
    () => isActive.value,
    (current) => {
      runOnJS(setShowStats)(current);
    },
    [isActive],
  );

  if (!visible) {
    return null;
  }

  return (
    <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)} layout={LinearTransition}>
      <Card className={isComplete ? "bg-green-500/10 p-4" : "bg-muted/30 p-4"}>
        <View className={"gap-3"}>
          {/* Status Row */}
          <View className={"flex-row items-center gap-3"}>
            {showStats && !isComplete && <PulsingIndicator />}
            {isComplete && <CompletionBadge />}
            <AnimatedStatusText value={status} />
          </View>

          {/* Progress Bar */}
          {showStats && <AnimatedProgressBar progress={progress} />}

          {/* Stats Row */}
          {showStats && (
            <Animated.View
              entering={FadeIn.delay(100).duration(200)}
              layout={LinearTransition}
              className={"flex-row gap-2 flex-wrap"}
            >
              <AnimatedSpeedText value={speed} />
              <AnimatedEtaText value={eta} />
            </Animated.View>
          )}
        </View>
      </Card>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  progressBar: {
    borderRadius: 4,
  },
  shimmer: {
    width: 100,
  },
});

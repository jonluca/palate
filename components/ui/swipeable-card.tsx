import React, { useCallback, useRef, useState, useEffect } from "react";
import { View, Dimensions, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
} from "react-native-reanimated";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import * as Haptics from "expo-haptics";

interface SwipeableCardProps {
  children: React.ReactNode;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  leftLabel?: string;
  rightLabel?: string;
  leftColor?: string;
  rightColor?: string;
  leftIcon?: string;
  rightIcon?: string;
  threshold?: number;
  enabled?: boolean;
  /** Unique identifier for the card - resets swipe position when this changes */
  cardKey?: string;
}

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const DEFAULT_THRESHOLD = SCREEN_WIDTH * 0.25;

export function SwipeableCard({
  children,
  onSwipeLeft,
  onSwipeRight,
  leftLabel = "Skip",
  rightLabel = "Confirm",
  leftColor = "#ef4444",
  rightColor = "#22c55e",
  leftIcon = "xmark",
  rightIcon = "checkmark",
  threshold = DEFAULT_THRESHOLD,
  enabled = true,
  cardKey,
}: SwipeableCardProps) {
  const translateX = useSharedValue(0);
  const contextX = useSharedValue(0);
  const hasTriggeredHaptic = useRef(false);
  const [cardHeight, setCardHeight] = useState(0);

  // Reset position when cardKey changes (handles FlashList recycling)
  useEffect(() => {
    translateX.value = 0;
    contextX.value = 0;
    hasTriggeredHaptic.current = false;
  }, [cardKey, translateX, contextX]);

  const handleSwipeComplete = useCallback(
    (direction: "left" | "right") => {
      if (direction === "left" && onSwipeLeft) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        onSwipeLeft();
      } else if (direction === "right" && onSwipeRight) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onSwipeRight();
      }
    },
    [onSwipeLeft, onSwipeRight],
  );

  const handleThresholdReached = useCallback(() => {
    if (!hasTriggeredHaptic.current) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      hasTriggeredHaptic.current = true;
    }
  }, []);

  const resetHaptic = useCallback(() => {
    hasTriggeredHaptic.current = false;
  }, []);

  const panGesture = Gesture.Pan()
    .enabled(enabled)
    .activeOffsetX([-10, 10]) // Only activate after 10px horizontal movement
    .failOffsetY([-10, 10]) // Fail gesture if user moves 10px vertically first (allows scroll)
    .onStart(() => {
      contextX.value = translateX.value;
    })
    .onUpdate((event) => {
      const newX = contextX.value + event.translationX;

      // Only allow swiping in directions that have handlers
      if (newX > 0 && !onSwipeRight) {
        return;
      }
      if (newX < 0 && !onSwipeLeft) {
        return;
      }

      translateX.value = newX;

      // Trigger haptic when threshold is reached
      if (Math.abs(newX) >= threshold) {
        runOnJS(handleThresholdReached)();
      } else {
        runOnJS(resetHaptic)();
      }
    })
    .onEnd(() => {
      const shouldTriggerLeft = translateX.value < -threshold && onSwipeLeft;
      const shouldTriggerRight = translateX.value > threshold && onSwipeRight;

      if (shouldTriggerLeft) {
        translateX.value = withTiming(-SCREEN_WIDTH, { duration: 100 }, () => {
          runOnJS(handleSwipeComplete)("left");
        });
      } else if (shouldTriggerRight) {
        translateX.value = withTiming(SCREEN_WIDTH, { duration: 100 }, () => {
          runOnJS(handleSwipeComplete)("right");
        });
      } else {
        translateX.value = withTiming(0, { duration: 100 });
      }

      runOnJS(resetHaptic)();
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const leftActionStyle = useAnimatedStyle(() => {
    const opacity = interpolate(translateX.value, [0, -threshold / 2, -threshold], [0, 0.5, 1], Extrapolation.CLAMP);
    const scale = interpolate(translateX.value, [0, -threshold / 2, -threshold], [0.8, 0.9, 1], Extrapolation.CLAMP);
    return { opacity, transform: [{ scale }] };
  });

  const rightActionStyle = useAnimatedStyle(() => {
    const opacity = interpolate(translateX.value, [0, threshold / 2, threshold], [0, 0.5, 1], Extrapolation.CLAMP);
    const scale = interpolate(translateX.value, [0, threshold / 2, threshold], [0.8, 0.9, 1], Extrapolation.CLAMP);
    return { opacity, transform: [{ scale }] };
  });

  const onLayout = (event: LayoutChangeEvent) => {
    setCardHeight(event.nativeEvent.layout.height);
  };

  return (
    <View className={"relative"}>
      {/* Background Actions */}
      <View
        className={"absolute inset-0 flex-row justify-between items-center px-6"}
        style={{ height: cardHeight > 0 ? cardHeight : undefined }}
      >
        {/* Right swipe action (confirm) */}
        {onSwipeRight && (
          <Animated.View style={[rightActionStyle]} className={"flex-row items-center gap-2"}>
            <View
              className={"w-12 h-12 rounded-full items-center justify-center"}
              style={{ backgroundColor: rightColor }}
            >
              <IconSymbol name={rightIcon as never} size={24} color={"white"} />
            </View>
            <ThemedText variant={"subhead"} className={"font-semibold"} style={{ color: rightColor }}>
              {rightLabel}
            </ThemedText>
          </Animated.View>
        )}

        {/* Spacer */}
        <View className={"flex-1"} />

        {/* Left swipe action (skip/reject) */}
        {onSwipeLeft && (
          <Animated.View style={[leftActionStyle]} className={"flex-row items-center gap-2"}>
            <ThemedText variant={"subhead"} className={"font-semibold"} style={{ color: leftColor }}>
              {leftLabel}
            </ThemedText>
            <View
              className={"w-12 h-12 rounded-full items-center justify-center"}
              style={{ backgroundColor: leftColor }}
            >
              <IconSymbol name={leftIcon as never} size={24} color={"white"} />
            </View>
          </Animated.View>
        )}
      </View>

      {/* Swipeable Card */}
      <GestureDetector gesture={panGesture}>
        <Animated.View style={cardStyle} onLayout={onLayout}>
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

import { ThemedText } from "@/components/themed-text";
import { cn } from "@/utils/cn";
import * as Haptics from "expo-haptics";
import { Pressable } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface TabButtonProps {
  label: string;
  count: number;
  isSelected: boolean;
  onPress: () => void;
}

export function TabButton({ label, count, isSelected, onPress }: TabButtonProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withTiming(0.95, { duration: 100 });
  };

  const handlePressOut = () => {
    scale.value = withTiming(1, { duration: 100 });
  };

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <AnimatedPressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      style={animatedStyle}
      className={cn("flex-1 py-2.5 rounded-xl items-center justify-center", isSelected ? "bg-primary" : "bg-card")}
    >
      <ThemedText className={cn("text-sm font-semibold", isSelected ? "text-primary-foreground" : "text-foreground")}>
        {label} ({count.toLocaleString()})
      </ThemedText>
    </AnimatedPressable>
  );
}

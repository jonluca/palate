import { cn } from "@/utils/cn";
import * as Haptics from "expo-haptics";
import React from "react";
import { Platform, Pressable, ScrollView } from "react-native";
import Animated, { LinearTransition, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { ThemedText } from "../themed-text";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface FilterOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

interface FilterPillsProps<T extends string> {
  options: FilterOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

function FilterPill<T extends string>({
  option,
  isSelected,
  onPress,
}: {
  option: FilterOption<T>;
  isSelected: boolean;
  onPress: () => void;
}) {
  "use no memo";

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
    if (Platform.OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onPress();
  };

  const label = option.count !== undefined ? `${option.label} (${option.count.toLocaleString()})` : option.label;

  return (
    <AnimatedPressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      layout={LinearTransition.duration(200)}
      style={animatedStyle}
      className={cn(
        "h-9 px-3.5 rounded-full border items-center justify-center",
        isSelected ? "bg-primary/15 border-primary/30" : "bg-secondary/70 border-border",
      )}
    >
      <ThemedText
        variant={"footnote"}
        className={cn(isSelected ? "text-primary font-semibold" : "text-secondary-foreground")}
      >
        {label}
      </ThemedText>
    </AnimatedPressable>
  );
}

export function FilterPills<T extends string>({ options, value, onChange }: FilterPillsProps<T>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName={"gap-2 px-4 py-0.5"}
      className={"-mx-4"}
    >
      {options.map((option) => (
        <FilterPill
          key={option.value}
          option={option}
          isSelected={value === option.value}
          onPress={() => onChange(option.value)}
        />
      ))}
    </ScrollView>
  );
}

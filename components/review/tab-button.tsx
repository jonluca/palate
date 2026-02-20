import { ThemedText } from "@/components/themed-text";
import { cn } from "@/utils/cn";
import * as Haptics from "expo-haptics";
import { Platform, Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface TabButtonProps {
  label: string;
  count: number;
  isSelected: boolean;
  onPress: () => void;
}

export function TabButton({ label, count, isSelected, onPress }: TabButtonProps) {
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

  return (
    <AnimatedPressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      style={animatedStyle}
      className={cn(
        "flex-1 h-9 rounded-xl items-center justify-center border",
        isSelected ? "bg-card border-border" : "bg-transparent border-transparent",
      )}
    >
      <View className={"flex-row items-center gap-1.5"}>
        <ThemedText
          variant={"footnote"}
          className={cn("font-semibold", isSelected ? "text-foreground" : "text-secondary-foreground")}
        >
          {label}
        </ThemedText>
        <View className={cn("px-1.5 py-0.5 rounded-full", isSelected ? "bg-primary/15" : "bg-secondary/80")}>
          <ThemedText
            variant={"caption2"}
            className={cn("font-semibold", isSelected ? "text-primary" : "text-muted-foreground")}
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {count.toLocaleString()}
          </ThemedText>
        </View>
      </View>
    </AnimatedPressable>
  );
}

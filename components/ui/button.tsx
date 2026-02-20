import { cn } from "@/utils/cn";
import { cva, type VariantProps } from "class-variance-authority";
import * as Haptics from "expo-haptics";
import React from "react";
import { ActivityIndicator, Platform, type GestureResponderEvent, Pressable, type PressableProps } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const buttonVariants = cva("flex-row items-center justify-center gap-2 rounded-2xl", {
  variants: {
    variant: {
      default: "bg-primary",
      secondary: "bg-secondary ",
      destructive: "bg-red-500/15",
      success: "bg-green-600/90",
      outline: " bg-transparent",
      ghost: "bg-transparent",
      muted: "bg-card ",
    },
    size: {
      default: "h-11 px-5",
      sm: "h-9 px-4",
      lg: "h-12 px-6",
      icon: "h-10 w-10",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

const textVariants = cva("font-semibold", {
  variants: {
    variant: {
      default: "text-primary-foreground",
      secondary: "text-secondary-foreground",
      destructive: "text-red-400",
      success: "text-white",
      outline: "text-primary",
      ghost: "text-primary",
      muted: "text-foreground",
    },
    size: {
      default: "text-[16px]",
      sm: "text-[15px]",
      lg: "text-[17px]",
      icon: "text-[16px]",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

type ButtonProps = PressableProps &
  VariantProps<typeof buttonVariants> & {
    loading?: boolean;
    haptic?: boolean;
    children: React.ReactNode;
  };

export function Button({
  variant,
  size,
  loading,
  haptic = true,
  disabled,
  onPress,
  children,
  className,
  style,
  ...props
}: ButtonProps) {
  "use no memo";

  const resolvedVariant = variant ?? "default";
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withTiming(0.97, { duration: 100 });
  };

  const handlePressOut = () => {
    scale.value = withTiming(1, { duration: 100 });
  };

  const handlePress = (e: GestureResponderEvent) => {
    if (haptic && Platform.OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onPress?.(e);
  };

  return (
    <AnimatedPressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      disabled={disabled || loading}
      style={[animatedStyle, style]}
      className={cn(buttonVariants({ variant: resolvedVariant, size }), disabled && "opacity-50", className)}
      {...props}
    >
      {loading ? (
        <ActivityIndicator
          color={
            resolvedVariant === "success" || resolvedVariant === "default"
              ? "#FFFFFF"
              : resolvedVariant === "destructive"
                ? "#FF453A"
                : undefined
          }
        />
      ) : (
        children
      )}
    </AnimatedPressable>
  );
}

export function ButtonText({
  variant = "default",
  size = "default",
  className,
  children,
}: {
  variant?: VariantProps<typeof textVariants>["variant"];
  size?: VariantProps<typeof textVariants>["size"];
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Animated.Text className={cn(textVariants({ variant, size }), className)} allowFontScaling={false}>
      {children}
    </Animated.Text>
  );
}

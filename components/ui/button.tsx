import { cn } from "@/utils/cn";
import { cva, type VariantProps } from "class-variance-authority";
import * as Haptics from "expo-haptics";
import React from "react";
import { ActivityIndicator, type GestureResponderEvent, Pressable, type PressableProps } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const buttonVariants = cva("flex-row items-center justify-center rounded-full", {
  variants: {
    variant: {
      default: "bg-primary",
      secondary: "bg-secondary",
      destructive: "bg-red-500/10",
      success: "bg-green-500/25",
      outline: "border border-border bg-transparent",
      ghost: "bg-transparent",
      muted: "bg-muted",
    },
    size: {
      default: "py-4 px-6",
      sm: "py-2 px-4",
      lg: "py-5 px-8",
      icon: "p-3",
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
      destructive: "text-red-500",
      success: "text-white",
      outline: "text-foreground",
      ghost: "text-foreground",
      muted: "text-muted-foreground",
    },
    size: {
      default: "text-base",
      sm: "text-sm",
      lg: "text-lg",
      icon: "text-base",
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
  ...props
}: ButtonProps) {
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
    if (haptic) {
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
      style={animatedStyle}
      className={cn(buttonVariants({ variant, size }), disabled && "opacity-50", className)}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={variant === "success" || variant === "default" ? "white" : undefined} />
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

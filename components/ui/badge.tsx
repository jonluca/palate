import { cn } from "@/utils/cn";
import { cva, type VariantProps } from "class-variance-authority";
import React from "react";
import { View, type ViewProps } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { ThemedText } from "../themed-text";

const badgeVariants = cva("px-3 py-1 rounded-full", {
  variants: {
    variant: {
      default: "bg-primary/10",
      success: "bg-green-500/15",
      warning: "bg-orange-500/15",
      destructive: "bg-red-500/15",
      muted: "bg-muted",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

const textVariants = cva("text-xs font-semibold uppercase tracking-wide", {
  variants: {
    variant: {
      default: "text-primary",
      success: "text-green-500",
      warning: "text-orange-500",
      destructive: "text-red-500",
      muted: "text-muted-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

type BadgeProps = ViewProps &
  VariantProps<typeof badgeVariants> & {
    label: string;
    animated?: boolean;
  };

export function Badge({ variant, label, animated = true, className, ...props }: BadgeProps) {
  const content = (
    <View className={cn(badgeVariants({ variant }), className)} {...props}>
      <ThemedText className={textVariants({ variant })}>{label}</ThemedText>
    </View>
  );

  if (animated) {
    return (
      <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
        {content}
      </Animated.View>
    );
  }

  return content;
}

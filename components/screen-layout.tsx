import { cn } from "@/utils/cn";
import { useHeaderHeight } from "@react-navigation/elements";
import React from "react";
import { Platform, RefreshControl, ScrollView, View, type ViewProps } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type ScreenLayoutProps = ViewProps & {
  scrollable?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  contentClassName?: string;
  headerOffset?: boolean;
};

export function ScreenLayout({
  children,
  scrollable = true,
  refreshing,
  onRefresh,
  className,
  contentClassName,
  headerOffset = true,
  ...props
}: ScreenLayoutProps) {
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();

  const contentStyle = {
    paddingTop: Platform.select({
      ios: headerOffset ? headerHeight : 16,
      android: 16,
    }),
    paddingBottom: insets.bottom + 32,
    gap: 12,
  };

  if (scrollable) {
    return (
      <ScrollView
        className={cn("flex-1 bg-background", className)}
        contentContainerClassName={cn("p-4", contentClassName)}
        contentContainerStyle={contentStyle}
        contentInsetAdjustmentBehavior={"never"}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps={"handled"}
        refreshControl={
          onRefresh ? <RefreshControl refreshing={refreshing ?? false} onRefresh={onRefresh} /> : undefined
        }
        {...props}
      >
        <Animated.View entering={FadeIn.duration(400)} className={"gap-3"}>
          {children}
        </Animated.View>
      </ScrollView>
    );
  }

  return (
    <View className={cn("flex-1 bg-background p-4", className)} style={contentStyle} {...props}>
      <Animated.View entering={FadeIn.duration(400)} className={"flex-1 gap-3"}>
        {children}
      </Animated.View>
    </View>
  );
}

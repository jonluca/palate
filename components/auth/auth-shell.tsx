import React from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui/card";

interface AuthShellProps {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function AuthShell({ eyebrow, title, subtitle, children, footer }: AuthShellProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  return (
    <ScrollView
      className={"flex-1 bg-background"}
      contentInsetAdjustmentBehavior={"automatic"}
      contentContainerStyle={{
        minHeight: Math.max(height - insets.top - insets.bottom, 0),
        paddingTop: insets.top + 28,
        paddingBottom: insets.bottom + 28,
        paddingHorizontal: 24,
      }}
      keyboardShouldPersistTaps={"handled"}
    >
      <View className={"flex-1 justify-center gap-4"}>
        <View className={"gap-2 px-1"}>
          <ThemedText variant={"caption1"} className={"font-semibold uppercase tracking-[1.6px] text-primary"}>
            {eyebrow}
          </ThemedText>
          <ThemedText variant={"title2"} className={"font-semibold"}>
            {title}
          </ThemedText>
          <ThemedText variant={"footnote"} color={"secondary"}>
            {subtitle}
          </ThemedText>
        </View>

        <Card animated={false} className={"border border-white/10"}>
          <View className={"p-5 gap-4"}>
            {children}
            {footer ? <View className={"gap-1 border-t border-white/10 pt-4"}>{footer}</View> : null}
          </View>
        </Card>
      </View>
    </ScrollView>
  );
}

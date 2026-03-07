import { LinearGradient } from "expo-linear-gradient";
import React from "react";
import { ScrollView, View } from "react-native";
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

  return (
    <ScrollView
      className={"flex-1 bg-background"}
      contentInsetAdjustmentBehavior={"automatic"}
      contentContainerStyle={{
        paddingTop: insets.top + 20,
        paddingBottom: insets.bottom + 28,
        paddingHorizontal: 20,
      }}
      keyboardShouldPersistTaps={"handled"}
    >
      <View className={"gap-5"}>
        <LinearGradient
          colors={["rgba(10,132,255,0.28)", "rgba(38,38,38,0.9)", "rgba(0,0,0,1)"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          className={"overflow-hidden rounded-[32px] px-6 py-7"}
        >
          <View className={"gap-3"}>
            <View className={"self-start rounded-full border border-white/10 bg-white/8 px-3 py-1.5"}>
              <ThemedText variant={"caption1"} className={"uppercase tracking-[1.6px]"}>
                {eyebrow}
              </ThemedText>
            </View>
            <ThemedText variant={"largeTitle"} className={"font-bold"}>
              {title}
            </ThemedText>
            <ThemedText variant={"body"} color={"secondary"}>
              {subtitle}
            </ThemedText>
          </View>
        </LinearGradient>

        <Card animated={false} className={"gap-4 p-5"}>
          {children}
        </Card>

        {footer}
      </View>
    </ScrollView>
  );
}

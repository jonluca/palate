import React, { useCallback, useState } from "react";
import { Alert, Linking, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import Animated, { FadeInDown } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol, type IconSymbolName } from "@/components/icon-symbol";
import { CalendarSection } from "@/components/settings";
import { ExportButton } from "@/components/home";
import { useStats } from "@/hooks/queries";
import { useToast } from "@/components/ui/toast";
import { useAppStore } from "@/store";
import { nukeDatabase } from "@/utils/db";

function SectionTitle({ children }: { children: string }) {
  return (
    <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase font-semibold tracking-wide px-1 mb-2"}>
      {children}
    </ThemedText>
  );
}

function SettingsGroup({ children }: { children: React.ReactNode }) {
  return <View className={"rounded-[24px] border border-white/8 bg-card overflow-hidden px-4"}>{children}</View>;
}

function Divider() {
  return <View className={"h-px bg-white/8"} />;
}

function SettingRow({
  icon,
  iconColor,
  iconBackground,
  label,
  sublabel,
  onPress,
  trailing,
  danger = false,
}: {
  icon: IconSymbolName;
  iconColor: string;
  iconBackground: string;
  label: string;
  sublabel?: string;
  onPress?: () => void;
  trailing?: React.ReactNode;
  danger?: boolean;
}) {
  const content = (
    <View className={"flex-row items-center gap-3 py-3"}>
      <View className={`w-9 h-9 rounded-xl items-center justify-center ${iconBackground}`}>
        <IconSymbol name={icon} size={18} color={iconColor} />
      </View>
      <View className={"flex-1 min-w-0"}>
        <ThemedText variant={"subhead"} className={danger ? "text-red-400 font-medium" : "font-medium"}>
          {label}
        </ThemedText>
        {sublabel ? (
          <ThemedText variant={"caption1"} color={"secondary"} numberOfLines={2}>
            {sublabel}
          </ThemedText>
        ) : null}
      </View>
      {trailing ?? <IconSymbol name={"chevron.right"} size={16} color={"#8E8E93"} />}
    </View>
  );

  if (!onPress) {
    return content;
  }

  return (
    <Pressable
      onPress={() => {
        onPress();
      }}
    >
      {content}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const resetAllState = useAppStore((state) => state.resetAllState);
  const { data: stats } = useStats();
  const [refreshing, setRefreshing] = useState(false);
  const [calendarExpanded, setCalendarExpanded] = useState(false);

  const version = Constants.expoConfig?.version ?? "1.0.0";
  const canExport = (stats?.confirmedVisits ?? 0) > 0;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries();
    setRefreshing(false);
  }, [queryClient]);

  const handleResetAllData = useCallback(() => {
    Alert.alert(
      "Reset All Data",
      "This will delete all your scanned photos, visits, and restaurant data. This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset Everything",
          style: "destructive",
          onPress: async () => {
            try {
              await nukeDatabase();
              queryClient.clear();
              resetAllState();
              showToast({ type: "success", message: "All data has been reset. You can start fresh now." });
            } catch (error) {
              console.error("Reset error:", error);
              showToast({ type: "error", message: "Failed to reset data. Please try again." });
            }
          },
        },
      ],
    );
  }, [queryClient, resetAllState, showToast]);

  return (
    <ScrollView
      className={"flex-1 bg-background"}
      contentInsetAdjustmentBehavior={"automatic"}
      contentContainerStyle={{
        paddingTop: 12,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 16,
      }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View className={"gap-1 mb-6"}>
        <ThemedText variant={"largeTitle"} className={"font-bold"}>
          Settings
        </ThemedText>
      </View>

      <Animated.View entering={FadeInDown.delay(120).duration(250)} className={"mb-6"}>
        <SectionTitle>History</SectionTitle>
        <SettingsGroup>
          <SettingRow
            icon={"photo.stack"}
            iconColor={"#0A84FF"}
            iconBackground={"bg-primary/15"}
            label={"All Visits"}
            sublabel={"View and filter your complete visit history"}
            onPress={() => router.push("/visits")}
          />
          <Divider />
          <SettingRow
            icon={"bolt.fill"}
            iconColor={"#F59E0B"}
            iconBackground={"bg-amber-500/15"}
            label={"Quick Actions"}
            sublabel={"Bulk review pending visits"}
            onPress={() => router.push("/quick-actions")}
          />
        </SettingsGroup>
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(160).duration(250)} className={"mb-6"}>
        <SectionTitle>Scanning</SectionTitle>
        <SettingsGroup>
          <SettingRow
            icon={"arrow.triangle.2.circlepath"}
            iconColor={"#34D399"}
            iconBackground={"bg-emerald-500/15"}
            label={"Rescan Photos"}
            sublabel={"Scan for new or recently missed restaurant photos"}
            onPress={() => router.push("/rescan")}
          />
          <Divider />
          <SettingRow
            icon={"eye.fill"}
            iconColor={"#EC4899"}
            iconBackground={"bg-pink-500/15"}
            label={"Deep Scan"}
            sublabel={"Run a slower full-library scan to catch missed food photos"}
            onPress={() => router.push({ pathname: "/rescan", params: { intent: "deep-scan" } })}
          />
        </SettingsGroup>
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(200).duration(250)} className={"mb-6"}>
        <SectionTitle>Integrations</SectionTitle>
        <SettingsGroup>
          <SettingRow
            icon={"calendar"}
            iconColor={"#3B82F6"}
            iconBackground={"bg-blue-500/15"}
            label={"Calendar Integration"}
            sublabel={"Import reservations, choose sources, and export visits to your calendar"}
            onPress={() => setCalendarExpanded((prev) => !prev)}
            trailing={
              <IconSymbol name={calendarExpanded ? "chevron.up" : "chevron.down"} size={16} color={"#8E8E93"} />
            }
          />
          <Divider />
          <SettingRow
            icon={"map.fill"}
            iconColor={"#FBBF24"}
            iconBackground={"bg-amber-500/15"}
            label={"Michelin Map"}
            sublabel={"Browse nearby Michelin restaurants on the map"}
            onPress={() => router.push("/restaurants-map")}
          />
        </SettingsGroup>

        {calendarExpanded ? (
          <View className={"mt-3"}>
            <CalendarSection showHeader={false} />
          </View>
        ) : null}
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(240).duration(250)} className={"mb-6"}>
        <SectionTitle>Data</SectionTitle>
        <SettingsGroup>
          <SettingRow
            icon={"square.and.arrow.up"}
            iconColor={"#38BDF8"}
            iconBackground={"bg-sky-500/15"}
            label={"Export Visits"}
            sublabel={
              canExport ? "Download confirmed visits as CSV or JSON" : "No confirmed visits are available to export yet"
            }
            trailing={
              canExport ? (
                <ExportButton label={"Export"} variant={"secondary"} size={"sm"} textVariant={"secondary"} />
              ) : (
                <ThemedText variant={"caption1"} color={"tertiary"}>
                  No visits
                </ThemedText>
              )
            }
          />
          <Divider />
          <SettingRow
            icon={"slider.horizontal.3"}
            iconColor={"#A855F7"}
            iconBackground={"bg-purple-500/15"}
            label={"Advanced Settings"}
            sublabel={"Power-user tools, cleanup, and matching controls"}
            onPress={() => router.push("/settings-advanced")}
          />
        </SettingsGroup>
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(280).duration(250)}>
        <SectionTitle>App</SectionTitle>
        <SettingsGroup>
          <SettingRow
            icon={"info.circle"}
            iconColor={"#60A5FA"}
            iconBackground={"bg-blue-500/15"}
            label={"About Palate"}
            sublabel={`Version ${version} · Created by JonLuca`}
            onPress={() => Linking.openURL("https://github.com/jonluca/photo-foodie")}
          />
          <Divider />
          <SettingRow
            icon={"trash"}
            iconColor={"#F87171"}
            iconBackground={"bg-red-500/15"}
            label={"Reset All Data"}
            sublabel={"Delete scans, visits, and restaurant matches"}
            onPress={handleResetAllData}
            danger
            trailing={<IconSymbol name={"chevron.right"} size={16} color={"#F87171"} />}
          />
        </SettingsGroup>
      </Animated.View>
    </ScrollView>
  );
}

import "@/globals.css";
import { Redirect, Stack } from "expo-router";
import React from "react";
import { Platform, View, ActivityIndicator } from "react-native";
import { useHasCompletedInitialScan, useHasHydrated } from "@/store";
import { DarkTheme } from "@react-navigation/native";

export default function RootLayoutNav() {
  const navigationTheme = DarkTheme;
  const hasHydrated = useHasHydrated();
  const hasCompletedInitialScan = useHasCompletedInitialScan();

  // Wait for store to hydrate before making routing decisions
  if (!hasHydrated) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#000" }}>
        <ActivityIndicator size={"large"} color={"#f97316"} />
      </View>
    );
  }

  if (!hasCompletedInitialScan) {
    return <Redirect href={"/scan"} />;
  }

  return (
    <Stack
      initialRouteName={hasCompletedInitialScan ? "(tabs)" : "scan"}
      screenOptions={{
        headerBackButtonDisplayMode: "minimal",
        headerTransparent: Platform.select({
          ios: true,
          android: false,
        }),
        headerStyle: {
          backgroundColor: Platform.select({
            ios: "rgba(0, 0, 0, 0.85)",
            android: navigationTheme.colors.background,
          }),
        },
        headerTintColor: navigationTheme.colors.text,
        headerTitleStyle: {
          color: navigationTheme.colors.text,
          fontWeight: "600",
        },
        headerLargeTitleStyle: {
          fontWeight: "700",
        },
        headerTitle: "",
        animation: "slide_from_right",
        animationDuration: 250,
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
        contentStyle: {
          backgroundColor: "transparent",
        },
      }}
    >
      <Stack.Screen
        name={"(tabs)"}
        options={{
          headerShown: false,
          contentStyle: {
            backgroundColor: "transparent",
          },
        }}
      />
      <Stack.Screen
        name={"visit/[id]"}
        options={{
          title: "Visit Details",
          headerLargeTitle: false,
        }}
      />
      <Stack.Screen
        name={"restaurant/[id]"}
        options={{
          title: "Restaurant",
          headerLargeTitle: false,
        }}
      />
      <Stack.Screen
        name={"rescan"}
        options={{
          headerShown: false,
          presentation: "modal",
        }}
      />
      <Stack.Screen
        name={"quick-actions"}
        options={{
          title: "Quick Actions",
          headerLargeTitle: false,
        }}
      />
    </Stack>
  );
}

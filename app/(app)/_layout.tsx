import "@/globals.css";
import { Redirect, Stack } from "expo-router";
import React from "react";
import { Platform } from "react-native";
import { syncConfirmedVisitsSnapshot } from "@/lib/cloud-sync";
import { useHasCompletedInitialScan } from "@/store";
import { DarkTheme } from "@react-navigation/native";
import { useSession } from "@/lib/auth-client";

export default function RootLayoutNav() {
  const navigationTheme = {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      primary: "#0A84FF",
      background: "#000000",
      card: "#000000",
      text: "#FFFFFF",
      border: "transparent",
    },
  };
  const hasCompletedInitialScan = useHasCompletedInitialScan();
  const { data: session } = useSession();
  const syncUserId = session?.user?.id;

  React.useEffect(() => {
    if (!syncUserId || !hasCompletedInitialScan) {
      return;
    }

    void syncConfirmedVisitsSnapshot().catch((error) => {
      console.error("Error syncing confirmed visits on app open:", error);
    });
  }, [hasCompletedInitialScan, syncUserId]);

  if (!hasCompletedInitialScan) {
    return <Redirect href={"/scan"} />;
  }

  return (
    <Stack
      initialRouteName={hasCompletedInitialScan ? "(tabs)" : "scan"}
      screenOptions={{
        headerBackButtonDisplayMode: "minimal",
        headerShadowVisible: false,
        headerTransparent: Platform.select({
          ios: true,
          android: false,
        }),
        headerBlurEffect: Platform.OS === "ios" ? "systemUltraThinMaterialDark" : undefined,
        headerStyle: {
          backgroundColor: Platform.select({
            ios: "rgba(0, 0, 0, 0.85)",
            android: navigationTheme.colors.background,
          }),
        },
        headerTintColor: navigationTheme.colors.primary,
        headerTitleStyle: {
          color: navigationTheme.colors.text,
          fontWeight: "600",
        },
        headerLargeTitleStyle: {
          fontWeight: "700",
        },
        animation: "slide_from_right",
        animationDuration: 250,
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
        contentStyle: {
          backgroundColor: navigationTheme.colors.background,
        },
      }}
    >
      <Stack.Screen
        name={"(tabs)"}
        options={{
          headerShown: false,
          contentStyle: {
            backgroundColor: navigationTheme.colors.background,
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
      <Stack.Screen
        name={"account"}
        options={{
          title: "Profile",
          headerLargeTitle: false,
        }}
      />
      <Stack.Screen
        name={"preferences"}
        options={{
          title: "Settings",
          headerLargeTitle: false,
        }}
      />
      <Stack.Screen
        name={"social"}
        options={{
          title: "Social",
          headerLargeTitle: false,
        }}
      />
      <Stack.Screen
        name={"people/[id]"}
        options={{
          title: "Profile",
          headerLargeTitle: false,
        }}
      />
    </Stack>
  );
}

import "@/globals.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { Uniwind } from "uniwind";
import { ToastProvider } from "@/components/ui/toast";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Slot } from "expo-router";
import { AppState, Platform } from "react-native";
import type { AppStateStatus } from "react-native";
import { focusManager } from "@tanstack/react-query";
import { FloatingDevTools } from "@buoy-gg/core";
import { useDrizzleStudioInspector } from "@/hooks";

function onAppStateChange(status: AppStateStatus) {
  if (Platform.OS !== "web") {
    focusManager.setFocused(status === "active");
  }
}
// Always use dark theme
Uniwind.setTheme("dark");

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30, // 30 seconds
      retry: false,
      refetchOnMount: "always",
    },
    mutations: {
      retry: 1, // Retry failed mutations once
    },
  },
});

export default function RootLayout() {
  useDrizzleStudioInspector();

  useEffect(() => {
    const subscription = AppState.addEventListener("change", onAppStateChange);

    return () => subscription.remove();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ToastProvider>
          <Slot />
          {__DEV__ && <FloatingDevTools disableHints />}
        </ToastProvider>
      </GestureHandlerRootView>
      <StatusBar style={"light"} />
    </QueryClientProvider>
  );
}

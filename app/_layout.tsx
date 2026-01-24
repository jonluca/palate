import "@/globals.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { QueryCacheNotifyEvent } from "@tanstack/query-core";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { Uniwind } from "uniwind";
import { ToastProvider } from "@/components/ui/toast";
import { UndoProvider } from "@/components/ui/undo-banner";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Slot } from "expo-router";
import { AppState, Platform } from "react-native";
import type { AppStateStatus } from "react-native";
import { focusManager } from "@tanstack/react-query";
import { useDrizzleStudioInspector, useAnalyticsScreenTracking } from "@/hooks";
import { SafeAreaProvider } from "react-native-safe-area-context";

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
      refetchOnMount: (query) => {
        const queryKey = query.queryKey;
        const isStaticQuery = Array.isArray(queryKey) && queryKey[0] === "static";
        return isStaticQuery ? false : "always";
      },
    },
    mutations: {
      retry: 1, // Retry failed mutations once
    },
  },
});

export default function RootLayout() {
  useDrizzleStudioInspector();
  useAnalyticsScreenTracking();

  useEffect(() => {
    const subscription = AppState.addEventListener("change", onAppStateChange);

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!__DEV__) {
      return;
    }
    const queryCache = queryClient.getQueryCache();
    const fetchStartTimes = new Map<string, number>();
    const lastFetchStatus = new Map<string, string>();
    const unsubscribe = queryCache.subscribe((event?: QueryCacheNotifyEvent) => {
      const query = event?.query;
      if (!query) {
        return;
      }

      const queryHash = query.queryHash;
      const fetchStatus = query.state.fetchStatus;
      const previousFetchStatus = lastFetchStatus.get(queryHash);

      if (fetchStatus === "fetching" && previousFetchStatus !== "fetching") {
        fetchStartTimes.set(queryHash, Date.now());
      }

      if (fetchStatus !== "fetching" && previousFetchStatus === "fetching") {
        const startedAt = fetchStartTimes.get(queryHash);
        if (startedAt !== undefined) {
          const durationMs = Date.now() - startedAt;
          const queryLabel = JSON.stringify(query.queryKey);
          console.info(`[ReactQuery] ${queryLabel} ${query.state.status} in ${durationMs}ms`);
          fetchStartTimes.delete(queryHash);
        }
      }

      lastFetchStatus.set(queryHash, fetchStatus);
    });

    return () => unsubscribe();
  }, []);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <ToastProvider>
            <UndoProvider>
              <Slot />
              {/* {__DEV__ && <FloatingDevTools disableHints />} */}
            </UndoProvider>
          </ToastProvider>
        </GestureHandlerRootView>
        <StatusBar style={"light"} />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

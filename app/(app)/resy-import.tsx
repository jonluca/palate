import React, { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import * as Haptics from "expo-haptics";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { IconSymbol } from "@/components/icon-symbol";
import { useImportResyVisitHistory } from "@/hooks/queries";
import type { ResyImportProgress, ResyImportResult } from "@/services/resy";

const RESY_ACCOUNT_URL = "https://resy.com/account/reservations";

const RESY_AUTH_BRIDGE_SCRIPT = `
(function () {
  if (window.__palateResyBridgeInstalled) {
    if (window.__palateResyEmitSession) {
      window.__palateResyEmitSession();
    }
    true;
    return;
  }

  window.__palateResyBridgeInstalled = true;
  window.__palateResyLatestToken = null;

  function normalizeToken(token) {
    return typeof token === "string" && token.length > 8 && token !== "null" && token !== "undefined" ? token : null;
  }

  function readReduxToken() {
    try {
      var angularRef = window.angular && window.angular.element && window.angular.element(document.body);
      var injector = angularRef && angularRef.injector && angularRef.injector();
      var rootScope = injector && injector.get && injector.get("$rootScope");
      var store = rootScope && rootScope.reduxStore;
      var state = store && store.getState && store.getState();
      return state && state.authToken && state.authToken.token;
    } catch (error) {
      return null;
    }
  }

  function captureMessage(data) {
    try {
      var parsed = typeof data === "string" ? JSON.parse(data) : data;
      var token = parsed && parsed.event === "loginSync" ? parsed.token : null;
      if (normalizeToken(token)) {
        window.__palateResyLatestToken = token;
      }
    } catch (error) {}
  }

  var originalPostMessage = window.postMessage;
  window.postMessage = function (message, targetOrigin, transfer) {
    captureMessage(message);
    return originalPostMessage.apply(window, arguments);
  };

  window.addEventListener("message", function (event) {
    captureMessage(event.data);
  });

  function emitSession() {
    var token =
      normalizeToken(window.apiAuthToken) ||
      normalizeToken(window.__palateResyLatestToken) ||
      normalizeToken(readReduxToken());

    if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
      return;
    }

    window.ReactNativeWebView.postMessage(
      JSON.stringify({
        type: "resy-session",
        hasToken: !!token,
        token: token
      })
    );
  }

  window.__palateResyEmitSession = emitSession;
  setInterval(emitSession, 1000);
  setTimeout(emitSession, 250);
  true;
})();
`;

interface ResyBridgeMessage {
  type?: string;
  hasToken?: boolean;
  token?: string | null;
}

function getImportSummary(result: ResyImportResult): string {
  const importedPart = `Added ${result.importedCount.toLocaleString()} visit${result.importedCount === 1 ? "" : "s"}`;
  const updatedPart =
    result.linkedExistingCount > 0
      ? `updated ${result.linkedExistingCount.toLocaleString()} existing visit${result.linkedExistingCount === 1 ? "" : "s"}`
      : null;
  const michelinPart =
    result.matchedMichelinCount > 0
      ? `${result.matchedMichelinCount.toLocaleString()} Michelin match${result.matchedMichelinCount === 1 ? "" : "es"}`
      : null;
  const skipped = result.skippedDuplicateCount + result.skippedInvalidCount + result.skippedConflictCount;
  const skippedPart =
    skipped > 0
      ? `skipped ${skipped.toLocaleString()} duplicate or unreadable reservation${skipped === 1 ? "" : "s"}`
      : null;

  return [importedPart, updatedPart, michelinPart, skippedPart].filter(Boolean).join(", ") + ".";
}

export default function ResyImportScreen() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<React.ElementRef<typeof WebView>>(null);
  const { showToast } = useToast();
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [progress, setProgress] = useState<ResyImportProgress | null>(null);
  const [lastResult, setLastResult] = useState<ResyImportResult | null>(null);
  const webViewSource = useMemo(() => ({ uri: RESY_ACCOUNT_URL }), []);

  const importMutation = useImportResyVisitHistory(
    useCallback((nextProgress: ResyImportProgress) => {
      setProgress(nextProgress);
    }, []),
  );

  const hasSession = Boolean(authToken);
  const totalLabel =
    progress?.totalCount === null || progress?.totalCount === undefined ? "all" : progress.totalCount.toLocaleString();
  const progressRatio =
    progress?.totalCount && progress.totalCount > 0 ? Math.min(progress.fetchedCount / progress.totalCount, 1) : null;

  const statusText = useMemo(() => {
    if (importMutation.isPending) {
      return progress ? `Reading ${progress.fetchedCount.toLocaleString()} of ${totalLabel}` : "Starting import...";
    }

    if (hasSession) {
      return "Signed in. Ready to import your full past reservation history.";
    }

    return "Sign in to Resy below. Palate will detect the session without saving your password.";
  }, [hasSession, importMutation.isPending, progress, totalLabel]);

  const injectBridge = useCallback(() => {
    webViewRef.current?.injectJavaScript(RESY_AUTH_BRIDGE_SCRIPT);
  }, []);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    let message: ResyBridgeMessage | null = null;
    try {
      message = JSON.parse(event.nativeEvent.data) as ResyBridgeMessage;
    } catch {
      return;
    }

    if (message?.type !== "resy-session") {
      return;
    }

    if (message.hasToken && message.token) {
      setAuthToken((previousToken) => (previousToken === message.token ? previousToken : (message.token ?? null)));
    }
  }, []);

  const handleReload = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  const runImport = useCallback(async () => {
    if (!authToken) {
      showToast({ type: "error", message: "Sign in to Resy first." });
      return;
    }

    setLastResult(null);
    setProgress(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const result = await importMutation.mutateAsync(authToken);
      setLastResult(result);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast({ type: "success", message: getImportSummary(result) });
    } catch (error) {
      console.error("Error importing Resy history:", error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : null;
      showToast({
        type: "error",
        message:
          status === 401 || status === 419
            ? "Resy session expired. Sign in again and retry."
            : "Failed to import Resy history.",
      });
    }
  }, [authToken, importMutation, showToast]);

  const handleImportPress = useCallback(() => {
    Alert.alert(
      "Import Resy History",
      "This will import every past Resy reservation as a confirmed visit. Existing Resy imports will be skipped.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Import",
          onPress: runImport,
        },
      ],
    );
  }, [runImport]);

  return (
    <View className={"flex-1 bg-background"}>
      <View
        className={"gap-3 px-4 pb-3"}
        style={{
          paddingTop: insets.top + 60,
        }}
      >
        <Card animated={false}>
          <View className={"p-4 gap-4"}>
            <View className={"flex-row items-center gap-3"}>
              <View className={"w-12 h-12 rounded-full bg-red-500/15 items-center justify-center"}>
                <IconSymbol name={"fork.knife.circle.fill"} size={26} color={"#ff462d"} />
              </View>
              <View className={"flex-1"}>
                <View className={"flex-row items-center gap-2"}>
                  <ThemedText variant={"title4"} className={"font-semibold"}>
                    Resy
                  </ThemedText>
                  <View className={`px-2 py-1 rounded-full ${hasSession ? "bg-green-500/15" : "bg-amber-500/15"}`}>
                    <ThemedText
                      variant={"caption2"}
                      className={`font-semibold ${hasSession ? "text-green-400" : "text-amber-400"}`}
                    >
                      {hasSession ? "Signed in" : "Needs sign-in"}
                    </ThemedText>
                  </View>
                </View>
                <ThemedText variant={"footnote"} color={"secondary"}>
                  {statusText}
                </ThemedText>
              </View>
              <Pressable
                onPress={handleReload}
                className={"w-10 h-10 rounded-full bg-background/60 items-center justify-center"}
                hitSlop={8}
              >
                <IconSymbol name={"arrow.clockwise"} size={18} color={"#9ca3af"} />
              </Pressable>
            </View>

            {progress && (
              <View className={"gap-2"}>
                <View className={"flex-row justify-between"}>
                  <ThemedText variant={"caption1"} color={"secondary"}>
                    Fetching history
                  </ThemedText>
                  <ThemedText variant={"caption1"} color={"secondary"}>
                    {progress.fetchedCount.toLocaleString()} / {totalLabel}
                  </ThemedText>
                </View>
                <View className={"h-1.5 rounded-full bg-red-500/15 overflow-hidden"}>
                  <View
                    className={"h-full rounded-full bg-red-500"}
                    style={{
                      width: `${progressRatio === null ? 35 : progressRatio * 100}%`,
                    }}
                  />
                </View>
              </View>
            )}

            {lastResult && (
              <View className={"bg-green-500/10 rounded-xl p-3 flex-row gap-2"}>
                <IconSymbol name={"checkmark.circle.fill"} size={16} color={"#22c55e"} />
                <ThemedText variant={"footnote"} className={"text-green-400 flex-1"}>
                  {getImportSummary(lastResult)}
                </ThemedText>
              </View>
            )}

            <Button
              onPress={handleImportPress}
              disabled={!hasSession || importMutation.isPending}
              loading={importMutation.isPending}
              className={"w-full"}
            >
              <IconSymbol name={"tray.and.arrow.down.fill"} size={17} color={"#fff"} />
              <ButtonText className={"ml-2"}>{hasSession ? "Import Full History" : "Sign In First"}</ButtonText>
            </Button>
          </View>
        </Card>
      </View>

      <View className={"flex-1 px-4 pb-4"} style={{ paddingBottom: insets.bottom + 16 }}>
        <View className={"flex-1 rounded-2xl overflow-hidden bg-card border border-white/10"}>
          <WebView
            ref={webViewRef}
            source={webViewSource}
            onMessage={handleMessage}
            injectedJavaScriptBeforeContentLoaded={RESY_AUTH_BRIDGE_SCRIPT}
            injectedJavaScript={RESY_AUTH_BRIDGE_SCRIPT}
            onLoadEnd={injectBridge}
            startInLoadingState
            renderLoading={() => (
              <View className={"absolute inset-0 items-center justify-center bg-card"}>
                <ActivityIndicator size={"large"} color={"#ff462d"} />
              </View>
            )}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            originWhitelist={["https://*", "http://*"]}
            style={{ flex: 1, backgroundColor: "#0b0b0f" }}
          />
        </View>
      </View>
    </View>
  );
}

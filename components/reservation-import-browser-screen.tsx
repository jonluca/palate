import React, { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import * as Haptics from "expo-haptics";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { IconSymbol } from "@/components/icon-symbol";
import type { ReservationImportResult } from "@/services/reservation-import";

interface ReservationBrowserImportMutation {
  isPending: boolean;
  mutateAsync: (payload: unknown) => Promise<ReservationImportResult>;
}

interface ReservationBrowserImportScreenProps {
  accountUrl: string;
  bridgeScript: string;
  bridgeMessageType: string;
  displayName: string;
  brandColor: string;
  importMutation: ReservationBrowserImportMutation;
  instructions: string;
}

interface ReservationBridgeMessage {
  type?: string;
  hasSession?: boolean;
  payload?: unknown;
  reservations?: unknown;
  count?: number;
  error?: string | null;
  debugMessage?: string;
  debug?: unknown;
}

function getImportSummary(result: ReservationImportResult): string {
  const importedPart = `Added ${result.importedCount.toLocaleString()} visit${result.importedCount === 1 ? "" : "s"}`;
  const updatedPart =
    result.linkedExistingCount > 0
      ? `updated ${result.linkedExistingCount.toLocaleString()} existing visit${result.linkedExistingCount === 1 ? "" : "s"}`
      : null;
  const michelinPart =
    result.matchedMichelinCount > 0
      ? `${result.matchedMichelinCount.toLocaleString()} Michelin match${result.matchedMichelinCount === 1 ? "" : "es"}`
      : null;
  const mergedPart =
    result.mergedDuplicateCount > 0
      ? `merged ${result.mergedDuplicateCount.toLocaleString()} duplicate visit${result.mergedDuplicateCount === 1 ? "" : "s"}`
      : null;
  const duplicatePart =
    result.skippedDuplicateCount > 0
      ? `skipped ${result.skippedDuplicateCount.toLocaleString()} duplicate reservation${result.skippedDuplicateCount === 1 ? "" : "s"}`
      : null;
  const unreadablePart =
    result.skippedInvalidCount > 0
      ? `skipped ${result.skippedInvalidCount.toLocaleString()} unreadable reservation${result.skippedInvalidCount === 1 ? "" : "s"}`
      : null;
  const conflictPart =
    result.skippedConflictCount > 0
      ? `skipped ${result.skippedConflictCount.toLocaleString()} conflicting reservation${result.skippedConflictCount === 1 ? "" : "s"}`
      : null;

  return (
    [importedPart, updatedPart, michelinPart, mergedPart, duplicatePart, unreadablePart, conflictPart]
      .filter(Boolean)
      .join(", ") + "."
  );
}

function getPayloadCount(payload: unknown, fallbackCount?: number): number {
  if (typeof fallbackCount === "number" && Number.isFinite(fallbackCount)) {
    return fallbackCount;
  }
  if (Array.isArray(payload)) {
    return payload.length;
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.result)) {
      return record.result.length;
    }
    if (Array.isArray(record.reservations)) {
      return record.reservations.length;
    }
  }
  return 0;
}

function describePayloadForLog(payload: unknown): Record<string, unknown> {
  if (Array.isArray(payload)) {
    return { type: "array", length: payload.length };
  }

  if (!payload || typeof payload !== "object") {
    return { type: payload === null ? "null" : typeof payload };
  }

  const record = payload as Record<string, unknown>;
  return {
    type: "object",
    keys: Object.keys(record).slice(0, 12),
    reservationsLength: Array.isArray(record.reservations) ? record.reservations.length : null,
    resultLength: Array.isArray(record.result) ? record.result.length : null,
    fetchedCount: typeof record.fetchedCount === "number" ? record.fetchedCount : null,
  };
}

function logImportDebug(displayName: string, message: string, details?: unknown): void {
  if (!__DEV__) {
    return;
  }

  if (details === undefined) {
    console.info(`[${displayName}Import] ${message}`);
  } else {
    console.info(`[${displayName}Import] ${message}`, details);
  }
}

export function ReservationImportBrowserScreen({
  accountUrl,
  bridgeScript,
  bridgeMessageType,
  displayName,
  brandColor,
  importMutation,
  instructions,
}: ReservationBrowserImportScreenProps) {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<React.ElementRef<typeof WebView>>(null);
  const { showToast } = useToast();
  const [hasSession, setHasSession] = useState(false);
  const [capturedPayload, setCapturedPayload] = useState<unknown | null>(null);
  const [reservationCount, setReservationCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ReservationImportResult | null>(null);
  const webViewSource = useMemo(() => ({ uri: accountUrl }), [accountUrl]);
  const hasHistory = capturedPayload !== null && reservationCount > 0;

  const statusText = useMemo(() => {
    if (importMutation.isPending) {
      return "Importing captured reservations...";
    }

    if (hasHistory) {
      return `Found ${reservationCount.toLocaleString()} reservation${reservationCount === 1 ? "" : "s"}. Ready to import past visits.`;
    }

    if (lastError) {
      return lastError;
    }

    if (hasSession) {
      return "Signed in. Open your reservation history if reservations are not detected yet.";
    }

    return instructions;
  }, [hasHistory, hasSession, importMutation.isPending, instructions, lastError, reservationCount]);

  const injectBridge = useCallback(() => {
    webViewRef.current?.injectJavaScript(bridgeScript);
  }, [bridgeScript]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: ReservationBridgeMessage | null = null;
      try {
        message = JSON.parse(event.nativeEvent.data) as ReservationBridgeMessage;
      } catch {
        return;
      }

      if (message?.type !== bridgeMessageType) {
        if (message?.type === `${bridgeMessageType}-debug`) {
          logImportDebug(displayName, message.debugMessage ?? "Bridge debug", message.debug);
        }
        return;
      }

      const payload = message.payload ?? message.reservations ?? null;
      const count = getPayloadCount(payload, message.count);
      logImportDebug(displayName, "Bridge message", {
        hasSession: Boolean(message.hasSession || count > 0),
        count,
        hasPayload: payload !== null,
        error: message.error ?? null,
        payload: describePayloadForLog(payload),
      });
      setHasSession(Boolean(message.hasSession || count > 0));
      setLastError(message.error ?? null);

      if (payload && count > 0) {
        setCapturedPayload(payload);
        setReservationCount(count);
      }
    },
    [bridgeMessageType, displayName],
  );

  const handleReload = useCallback(() => {
    setLastError(null);
    webViewRef.current?.reload();
  }, []);

  const runImport = useCallback(async () => {
    if (!capturedPayload) {
      showToast({ type: "error", message: `Open ${displayName} reservation history first.` });
      return;
    }

    setLastResult(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      logImportDebug(displayName, "Starting import", {
        capturedCount: getPayloadCount(capturedPayload, reservationCount),
        payload: describePayloadForLog(capturedPayload),
      });
      const result = await importMutation.mutateAsync(capturedPayload);
      logImportDebug(displayName, "Import result", result);
      setLastResult(result);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast({ type: "success", message: getImportSummary(result) });
    } catch (error) {
      console.error(`Error importing ${displayName} history:`, error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showToast({ type: "error", message: `Failed to import ${displayName} history.` });
    }
  }, [capturedPayload, displayName, importMutation, reservationCount, showToast]);

  const handleImportPress = useCallback(() => {
    Alert.alert(
      `Import ${displayName} History`,
      `This will import captured past ${displayName} reservations as confirmed visits. Existing imports and overlapping visits will be deduped.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Import",
          onPress: runImport,
        },
      ],
    );
  }, [displayName, runImport]);

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
              <View
                className={"w-12 h-12 rounded-full items-center justify-center"}
                style={{ backgroundColor: `${brandColor}24` }}
              >
                <IconSymbol name={"fork.knife.circle.fill"} size={26} color={brandColor} />
              </View>
              <View className={"flex-1"}>
                <View className={"flex-row items-center gap-2"}>
                  <ThemedText variant={"title4"} className={"font-semibold"}>
                    {displayName}
                  </ThemedText>
                  <View className={`px-2 py-1 rounded-full ${hasHistory ? "bg-green-500/15" : "bg-amber-500/15"}`}>
                    <ThemedText
                      variant={"caption2"}
                      className={`font-semibold ${hasHistory ? "text-green-400" : "text-amber-400"}`}
                    >
                      {hasHistory ? "History found" : "Needs history"}
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

            {hasHistory && (
              <View className={"gap-2"}>
                <View className={"flex-row justify-between"}>
                  <ThemedText variant={"caption1"} color={"secondary"}>
                    Captured reservations
                  </ThemedText>
                  <ThemedText variant={"caption1"} color={"secondary"}>
                    {reservationCount.toLocaleString()}
                  </ThemedText>
                </View>
                <View className={"h-1.5 rounded-full overflow-hidden"} style={{ backgroundColor: `${brandColor}24` }}>
                  <View className={"h-full rounded-full"} style={{ width: "100%", backgroundColor: brandColor }} />
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
              disabled={!hasHistory || importMutation.isPending}
              loading={importMutation.isPending}
              className={"w-full"}
            >
              <IconSymbol name={"tray.and.arrow.down.fill"} size={17} color={"#fff"} />
              <ButtonText className={"ml-2"}>
                {hasHistory ? "Import Captured History" : "Open History First"}
              </ButtonText>
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
            injectedJavaScriptBeforeContentLoaded={bridgeScript}
            injectedJavaScript={bridgeScript}
            onLoadEnd={injectBridge}
            startInLoadingState
            renderLoading={() => (
              <View className={"absolute inset-0 items-center justify-center bg-card"}>
                <ActivityIndicator size={"large"} color={brandColor} />
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

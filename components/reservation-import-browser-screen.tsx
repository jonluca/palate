import React, { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { IconSymbol } from "@/components/icon-symbol";
import { ReservationImportReviewList, useReservationImportReview } from "@/components/reservation-import-review";
import { useDismissProviderReservations, useFilterProviderReservationReviewCandidates } from "@/hooks/queries";
import {
  asRecord,
  type JsonNode,
  type JsonValue,
  type ImportableReservation,
  type NormalizedReservationHistory,
  type ReservationImportResult,
} from "@/services/reservation-import";
import {
  beginProviderReservationReplay,
  completeProviderReservationReplay,
  createProviderReservationReplayGateState,
  failProviderReservationReplay,
  resetProviderReservationReplay,
  type ProviderReservationReplayGateState,
} from "@/utils/provider-reservation-replay-gate-core";

interface ReservationBrowserImportMutation {
  isPending: boolean;
  mutateAsync: (reservations: ImportableReservation[]) => Promise<ReservationImportResult>;
}

interface ReservationBrowserImportScreenProps {
  accountUrl: string;
  bridgeScript: string;
  bridgeMessageType: string;
  displayName: string;
  brandColor: string;
  importMutation: ReservationBrowserImportMutation;
  instructions: string;
  normalizePayload: (payload: JsonValue) => NormalizedReservationHistory;
}

interface ReservationBridgeMessage {
  type?: string;
  hasSession?: boolean;
  payload?: JsonValue;
  reservations?: JsonValue;
  count?: number;
  error?: string | null;
  debugMessage?: string;
  debug?: JsonValue;
}

function isFiniteJsonNumber(value: JsonNode): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJsonString(value: JsonNode): value is string {
  return typeof value === "string";
}

function parseReservationBridgeMessage(serializedMessage: string): ReservationBridgeMessage | null {
  const parsed: JsonValue = JSON.parse(serializedMessage);
  const record = asRecord(parsed);
  if (!record) {
    return null;
  }

  return {
    type: isJsonString(record.type) ? record.type : undefined,
    hasSession: record.hasSession === true,
    payload: record.payload,
    reservations: record.reservations,
    count: isFiniteJsonNumber(record.count) ? record.count : undefined,
    error: record.error === null ? null : isJsonString(record.error) ? record.error : undefined,
    debugMessage: isJsonString(record.debugMessage) ? record.debugMessage : undefined,
    debug: record.debug,
  };
}

function getJsonNodeType(value: JsonNode): "array" | "boolean" | "null" | "number" | "object" | "string" | "undefined" {
  if (Array.isArray(value)) {
    return "array";
  }
  if (asRecord(value)) {
    return "object";
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (isFiniteJsonNumber(value)) {
    return "number";
  }
  if (isJsonString(value)) {
    return "string";
  }
  return "boolean";
}

function getPayloadCount(payload: JsonNode, fallbackCount?: number): number {
  if (fallbackCount !== undefined) {
    return fallbackCount;
  }
  if (Array.isArray(payload)) {
    return payload.length;
  }
  const record = asRecord(payload);
  if (record) {
    if (Array.isArray(record.result)) {
      return record.result.length;
    }
    if (Array.isArray(record.reservations)) {
      return record.reservations.length;
    }
    if (Array.isArray(record.purchases)) {
      return record.purchases.length;
    }
  }
  return 0;
}

function describePayloadForLog(payload: JsonNode) {
  if (Array.isArray(payload)) {
    return { type: "array", length: payload.length };
  }

  const record = asRecord(payload);
  if (!record) {
    return { type: getJsonNodeType(payload) };
  }

  return {
    type: "object",
    keys: Object.keys(record).slice(0, 12),
    reservationsLength: Array.isArray(record.reservations) ? record.reservations.length : null,
    purchasesLength: Array.isArray(record.purchases) ? record.purchases.length : null,
    resultLength: Array.isArray(record.result) ? record.result.length : null,
    fetchedCount: isFiniteJsonNumber(record.fetchedCount) ? record.fetchedCount : null,
    totalCount: isFiniteJsonNumber(record.totalCount) ? record.totalCount : null,
  };
}

function logImportDebug<Details>(displayName: string, message: string, details?: Details): void {
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
  normalizePayload,
}: ReservationBrowserImportScreenProps) {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<React.ElementRef<typeof WebView>>(null);
  const replayGateRef = useRef<ProviderReservationReplayGateState | null>(null);
  if (replayGateRef.current === null) {
    replayGateRef.current = createProviderReservationReplayGateState();
  }
  const [hasSession, setHasSession] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [capturedFetchedCount, setCapturedFetchedCount] = useState(0);
  const [capturedInvalidCount, setCapturedInvalidCount] = useState(0);
  const [skippedExistingConfirmedCount, setSkippedExistingConfirmedCount] = useState(0);
  const [skippedDismissedCount, setSkippedDismissedCount] = useState(0);
  const [reviewPrepared, setReviewPrepared] = useState(false);
  const webViewSource = useMemo(() => ({ uri: accountUrl }), [accountUrl]);
  const filterReviewMutation = useFilterProviderReservationReviewCandidates(displayName);
  const dismissMutation = useDismissProviderReservations();
  const review = useReservationImportReview({ displayName, importMutation, dismissMutation });
  const hasHistory = review.reservations.length > 0 || reviewPrepared;
  const pendingCount = review.reviewStats.pendingCount;

  const statusText = useMemo(() => {
    if (filterReviewMutation.isPending) {
      return "Preparing reservations for review...";
    }

    if (hasHistory) {
      if (pendingCount === 0) {
        return `Reviewed ${review.reviewStats.capturedCount.toLocaleString()} captured reservation${review.reviewStats.capturedCount === 1 ? "" : "s"}.`;
      }
      return `Review ${pendingCount.toLocaleString()} captured reservation${pendingCount === 1 ? "" : "s"} before importing.`;
    }

    if (lastError) {
      return lastError;
    }

    if (hasSession) {
      return "Signed in. Open your reservation history if reservations are not detected yet.";
    }

    return instructions;
  }, [
    hasHistory,
    hasSession,
    filterReviewMutation.isPending,
    instructions,
    lastError,
    pendingCount,
    review.reviewStats.capturedCount,
  ]);

  const injectBridge = useCallback(() => {
    webViewRef.current?.injectJavaScript(bridgeScript);
  }, [bridgeScript]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: ReservationBridgeMessage | null = null;
      try {
        message = parseReservationBridgeMessage(event.nativeEvent.data);
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
      if (__DEV__) {
        logImportDebug(displayName, "Bridge message", {
          hasSession: Boolean(message.hasSession || count > 0),
          count,
          hasPayload: payload !== null,
          error: message.error ?? null,
          payload: describePayloadForLog(payload),
        });
      }
      setHasSession(Boolean(message.hasSession || count > 0));
      setLastError(message.error ?? null);

      if (payload && count > 0) {
        const replay = beginProviderReservationReplay(replayGateRef.current!, event.nativeEvent.data);
        replayGateRef.current = replay.state;
        if (!replay.accepted) {
          return;
        }

        let history: NormalizedReservationHistory;
        try {
          history = normalizePayload(payload);
        } catch (error) {
          replayGateRef.current = failProviderReservationReplay(replayGateRef.current!, replay.generation).state;
          console.error(`Error normalizing ${displayName} reservations for review:`, error);
          setLastError(`Failed to read captured ${displayName} reservations.`);
          return;
        }
        setCapturedFetchedCount(history.fetchedCount);
        setCapturedInvalidCount(history.invalidCount);
        setSkippedExistingConfirmedCount(0);
        setSkippedDismissedCount(0);
        setReviewPrepared(false);
        filterReviewMutation
          .mutateAsync(history.reservations)
          .then((filterResult) => {
            const completion = completeProviderReservationReplay(replayGateRef.current!, replay.generation);
            replayGateRef.current = completion.state;
            if (!completion.accepted) {
              return;
            }

            logImportDebug(displayName, "Prepared review reservations", {
              fetchedCount: history.fetchedCount,
              invalidCount: history.invalidCount,
              importableCount: history.reservations.length,
              reviewCount: filterResult.reservations.length,
              skippedExistingConfirmedCount: filterResult.skippedExistingConfirmedCount,
              skippedDismissedCount: filterResult.skippedDismissedCount,
              skippedDuplicateCount: filterResult.skippedDuplicateCount,
            });
            review.loadReservations(filterResult.reservations);
            setSkippedExistingConfirmedCount(filterResult.skippedExistingConfirmedCount);
            setSkippedDismissedCount(filterResult.skippedDismissedCount);
            setReviewPrepared(true);
          })
          .catch((error) => {
            const failure = failProviderReservationReplay(replayGateRef.current!, replay.generation);
            replayGateRef.current = failure.state;
            if (!failure.accepted) {
              return;
            }

            console.error(`Error preparing ${displayName} reservations for review:`, error);
            setLastError(`Failed to prepare ${displayName} reservations for review.`);
          });
      } else if (message.error) {
        replayGateRef.current = resetProviderReservationReplay(replayGateRef.current!);
      }
    },
    [bridgeMessageType, displayName, filterReviewMutation, normalizePayload, review],
  );

  const handleReload = useCallback(() => {
    replayGateRef.current = resetProviderReservationReplay(replayGateRef.current!);
    setLastError(null);
    setCapturedFetchedCount(0);
    setCapturedInvalidCount(0);
    setSkippedExistingConfirmedCount(0);
    setSkippedDismissedCount(0);
    setReviewPrepared(false);
    review.resetReview();
    webViewRef.current?.reload();
  }, [review]);

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
                      {hasHistory ? "Ready to review" : "Needs history"}
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
                    Pending approval
                  </ThemedText>
                  <ThemedText variant={"caption1"} color={"secondary"}>
                    {pendingCount.toLocaleString()} / {review.reviewStats.capturedCount.toLocaleString()}
                  </ThemedText>
                </View>
                <View className={"h-1.5 rounded-full overflow-hidden"} style={{ backgroundColor: `${brandColor}24` }}>
                  <View
                    className={"h-full rounded-full"}
                    style={{
                      width: `${review.reviewStats.capturedCount > 0 ? (pendingCount / review.reviewStats.capturedCount) * 100 : 0}%`,
                      backgroundColor: brandColor,
                    }}
                  />
                </View>
                {capturedInvalidCount > 0 && (
                  <ThemedText variant={"caption1"} color={"tertiary"}>
                    {capturedInvalidCount.toLocaleString()} captured reservation
                    {capturedInvalidCount === 1 ? " was" : "s were"} unreadable.
                  </ThemedText>
                )}
                {skippedExistingConfirmedCount > 0 && (
                  <ThemedText variant={"caption1"} color={"tertiary"}>
                    {skippedExistingConfirmedCount.toLocaleString()} reservation
                    {skippedExistingConfirmedCount === 1 ? " maps" : "s map"} to existing confirmed visits.
                  </ThemedText>
                )}
                {skippedDismissedCount > 0 && (
                  <ThemedText variant={"caption1"} color={"tertiary"}>
                    {skippedDismissedCount.toLocaleString()} previously reviewed reservation
                    {skippedDismissedCount === 1 ? " was" : "s were"} hidden.
                  </ThemedText>
                )}
              </View>
            )}

            <Button
              onPress={hasHistory ? review.importAllPendingReservations : handleReload}
              disabled={
                (hasHistory && pendingCount === 0) || importMutation.isPending || filterReviewMutation.isPending
              }
              loading={review.isImportingAll || filterReviewMutation.isPending}
              className={"w-full"}
            >
              <IconSymbol
                name={hasHistory ? "checkmark.circle.fill" : "list.bullet.rectangle"}
                size={17}
                color={"#fff"}
              />
              <ButtonText className={"ml-2"}>
                {hasHistory
                  ? `Approve All (${pendingCount.toLocaleString()})`
                  : capturedFetchedCount > 0
                    ? "Review Captured History"
                    : "Open History First"}
              </ButtonText>
            </Button>
          </View>
        </Card>
      </View>

      <View className={"flex-1 px-4 pb-4"} style={{ paddingBottom: insets.bottom + 16 }}>
        {hasHistory ? (
          <ReservationImportReviewList
            reservations={review.pendingReservations}
            brandColor={brandColor}
            displayName={displayName}
            importingReservationIds={review.importingReservationIds}
            dismissingReservationIds={review.dismissingReservationIds}
            onImport={review.importReservation}
            onDismiss={review.dismissReservation}
            contentBottomPadding={16}
          />
        ) : (
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
        )}
      </View>
    </View>
  );
}

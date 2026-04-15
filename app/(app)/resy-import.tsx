import React, { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import * as Haptics from "expo-haptics";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { IconSymbol } from "@/components/icon-symbol";
import {
  getReservationImportSummary,
  ReservationImportReviewList,
  useReservationImportReview,
} from "@/components/reservation-import-review";
import {
  useFetchResyVisitHistory,
  useFilterProviderReservationReviewCandidates,
  useImportProviderReservations,
} from "@/hooks/queries";
import type { ResyImportProgress } from "@/services/resy";

const RESY_ACCOUNT_URL = "https://resy.com/account/reservations";
const RESY_BRAND_COLOR = "#ff462d";

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

function getFetchHistoryToast(reservationCount: number): { type: "success" | "error"; message: string } {
  if (reservationCount === 0) {
    return { type: "error", message: "No importable Resy reservations were found." };
  }

  return {
    type: "success",
    message: `Found ${reservationCount.toLocaleString()} Resy reservation${reservationCount === 1 ? "" : "s"} to review.`,
  };
}

function getErrorStatus(error: unknown): number | null {
  return typeof error === "object" && error !== null && "status" in error ? Number(error.status) : null;
}

export default function ResyImportScreen() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<React.ElementRef<typeof WebView>>(null);
  const { showToast } = useToast();
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [progress, setProgress] = useState<ResyImportProgress | null>(null);
  const [invalidCount, setInvalidCount] = useState(0);
  const [skippedExistingConfirmedCount, setSkippedExistingConfirmedCount] = useState(0);
  const [reviewPrepared, setReviewPrepared] = useState(false);
  const webViewSource = useMemo(() => ({ uri: RESY_ACCOUNT_URL }), []);

  const fetchMutation = useFetchResyVisitHistory(
    useCallback((nextProgress: ResyImportProgress) => {
      setProgress(nextProgress);
    }, []),
  );
  const filterReviewMutation = useFilterProviderReservationReviewCandidates("Resy");
  const importMutation = useImportProviderReservations("Resy");
  const review = useReservationImportReview({ displayName: "Resy", importMutation });

  const hasSession = Boolean(authToken);
  const hasReview = review.reservations.length > 0 || reviewPrepared;
  const pendingCount = review.reviewStats.pendingCount;
  const totalLabel =
    progress?.totalCount === null || progress?.totalCount === undefined ? "all" : progress.totalCount.toLocaleString();
  const progressRatio =
    progress?.totalCount && progress.totalCount > 0 ? Math.min(progress.fetchedCount / progress.totalCount, 1) : null;

  const statusText = useMemo(() => {
    if (importMutation.isPending) {
      return "Importing approved reservations...";
    }

    if (fetchMutation.isPending) {
      return progress ? `Reading ${progress.fetchedCount.toLocaleString()} of ${totalLabel}` : "Reading history...";
    }

    if (filterReviewMutation.isPending) {
      return "Preparing reservations for review...";
    }

    if (hasReview) {
      if (pendingCount === 0) {
        return `Reviewed ${review.reviewStats.capturedCount.toLocaleString()} captured reservation${review.reviewStats.capturedCount === 1 ? "" : "s"}.`;
      }
      return `Review ${pendingCount.toLocaleString()} captured reservation${pendingCount === 1 ? "" : "s"} before importing.`;
    }

    if (hasSession) {
      return "Signed in. Fetch your past reservations to review them before importing.";
    }

    return "Sign in to Resy below. Palate will detect the session without saving your password.";
  }, [
    fetchMutation.isPending,
    filterReviewMutation.isPending,
    hasReview,
    hasSession,
    importMutation.isPending,
    pendingCount,
    progress,
    review.reviewStats.capturedCount,
    totalLabel,
  ]);

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
    setProgress(null);
    setInvalidCount(0);
    setSkippedExistingConfirmedCount(0);
    setReviewPrepared(false);
    review.resetReview();
    webViewRef.current?.reload();
  }, [review]);

  const handleFetchHistory = useCallback(async () => {
    if (!authToken) {
      showToast({ type: "error", message: "Sign in to Resy first." });
      return;
    }

    setProgress(null);
    setInvalidCount(0);
    setSkippedExistingConfirmedCount(0);
    setReviewPrepared(false);
    review.resetReview();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const history = await fetchMutation.mutateAsync(authToken);
      const filterResult = await filterReviewMutation.mutateAsync(history.reservations);
      const reservationCount = filterResult.reservations.length;
      review.loadReservations(filterResult.reservations);
      setInvalidCount(history.invalidCount);
      setSkippedExistingConfirmedCount(filterResult.skippedExistingConfirmedCount);
      setReviewPrepared(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(getFetchHistoryToast(reservationCount));
    } catch (error) {
      console.error("Error fetching Resy history:", error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const status = getErrorStatus(error);
      showToast({
        type: "error",
        message:
          status === 401 || status === 419
            ? "Resy session expired. Sign in again and retry."
            : "Failed to fetch Resy history.",
      });
    }
  }, [authToken, fetchMutation, filterReviewMutation, review, showToast]);

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
                <IconSymbol name={"fork.knife.circle.fill"} size={26} color={RESY_BRAND_COLOR} />
              </View>
              <View className={"flex-1"}>
                <View className={"flex-row items-center gap-2"}>
                  <ThemedText variant={"title4"} className={"font-semibold"}>
                    Resy
                  </ThemedText>
                  <View
                    className={`px-2 py-1 rounded-full ${
                      hasReview || hasSession ? "bg-green-500/15" : "bg-amber-500/15"
                    }`}
                  >
                    <ThemedText
                      variant={"caption2"}
                      className={`font-semibold ${hasReview || hasSession ? "text-green-400" : "text-amber-400"}`}
                    >
                      {hasReview ? "Ready to review" : hasSession ? "Signed in" : "Needs sign-in"}
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

            {(fetchMutation.isPending || progress) && !hasReview && (
              <View className={"gap-2"}>
                <View className={"flex-row justify-between"}>
                  <ThemedText variant={"caption1"} color={"secondary"}>
                    Fetching history
                  </ThemedText>
                  <ThemedText variant={"caption1"} color={"secondary"}>
                    {progress?.fetchedCount.toLocaleString() ?? 0} / {totalLabel}
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

            {hasReview && (
              <View className={"gap-2"}>
                <View className={"flex-row justify-between"}>
                  <ThemedText variant={"caption1"} color={"secondary"}>
                    Pending approval
                  </ThemedText>
                  <ThemedText variant={"caption1"} color={"secondary"}>
                    {pendingCount.toLocaleString()} / {review.reviewStats.capturedCount.toLocaleString()}
                  </ThemedText>
                </View>
                <View className={"h-1.5 rounded-full bg-red-500/15 overflow-hidden"}>
                  <View
                    className={"h-full rounded-full bg-red-500"}
                    style={{
                      width: `${
                        review.reviewStats.capturedCount > 0
                          ? (pendingCount / review.reviewStats.capturedCount) * 100
                          : 0
                      }%`,
                    }}
                  />
                </View>
                {invalidCount > 0 && (
                  <ThemedText variant={"caption1"} color={"tertiary"}>
                    {invalidCount.toLocaleString()} captured reservation{invalidCount === 1 ? " was" : "s were"}{" "}
                    unreadable.
                  </ThemedText>
                )}
                {skippedExistingConfirmedCount > 0 && (
                  <ThemedText variant={"caption1"} color={"tertiary"}>
                    {skippedExistingConfirmedCount.toLocaleString()} reservation
                    {skippedExistingConfirmedCount === 1 ? " maps" : "s map"} to existing confirmed visits.
                  </ThemedText>
                )}
              </View>
            )}

            {review.lastResult && (
              <View className={"bg-green-500/10 rounded-xl p-3 flex-row gap-2"}>
                <IconSymbol name={"checkmark.circle.fill"} size={16} color={"#22c55e"} />
                <ThemedText variant={"footnote"} className={"text-green-400 flex-1"}>
                  {getReservationImportSummary(review.lastResult)}
                </ThemedText>
              </View>
            )}

            <Button
              onPress={hasReview ? review.importAllPendingReservations : handleFetchHistory}
              disabled={
                (!hasReview && !hasSession) ||
                fetchMutation.isPending ||
                filterReviewMutation.isPending ||
                importMutation.isPending ||
                (hasReview && pendingCount === 0)
              }
              loading={fetchMutation.isPending || filterReviewMutation.isPending || review.isImportingAll}
              className={"w-full"}
            >
              <IconSymbol
                name={hasReview ? "checkmark.circle.fill" : "list.bullet.rectangle"}
                size={17}
                color={"#fff"}
              />
              <ButtonText className={"ml-2"}>
                {hasReview
                  ? `Approve All (${pendingCount.toLocaleString()})`
                  : hasSession
                    ? "Review Reservation History"
                    : "Sign In First"}
              </ButtonText>
            </Button>
          </View>
        </Card>
      </View>

      <View className={"flex-1 px-4 pb-4"} style={{ paddingBottom: insets.bottom + 16 }}>
        {hasReview ? (
          <ReservationImportReviewList
            reservations={review.pendingReservations}
            brandColor={RESY_BRAND_COLOR}
            displayName={"Resy"}
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
              injectedJavaScriptBeforeContentLoaded={RESY_AUTH_BRIDGE_SCRIPT}
              injectedJavaScript={RESY_AUTH_BRIDGE_SCRIPT}
              onLoadEnd={injectBridge}
              startInLoadingState
              renderLoading={() => (
                <View className={"absolute inset-0 items-center justify-center bg-card"}>
                  <ActivityIndicator size={"large"} color={RESY_BRAND_COLOR} />
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

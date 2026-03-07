import * as AppleAuthentication from "expo-apple-authentication";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { ThemedText } from "@/components/themed-text";
import { isAppleSignInAvailable, isAppleSignInCanceled, signInWithApple, useSession } from "@/lib/auth-client";

interface AppleSignInPanelProps {
  onSuccess?: () => void;
  signedInTitle?: string;
  signedInMessage?: string;
  unavailableMessage?: string;
  loadingMessage?: string;
  submittingMessage?: string;
}

export function AppleSignInPanel({
  onSuccess,
  signedInTitle = "Signed in with Apple",
  signedInMessage = "Cloud sync is ready for confirmed visits and social features.",
  unavailableMessage = "Sign in with Apple is only available on Apple devices with the native auth capability enabled.",
  loadingMessage = "Checking Apple sign-in availability...",
  submittingMessage = "Finishing sign-in...",
}: AppleSignInPanelProps) {
  const { data: session } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAppleAvailable, setIsAppleAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let isMounted = true;

    void isAppleSignInAvailable()
      .then((available) => {
        if (isMounted) {
          setIsAppleAvailable(available);
        }
      })
      .catch(() => {
        if (isMounted) {
          setIsAppleAvailable(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  async function handleAppleSignIn() {
    setIsSubmitting(true);
    setError(null);

    const result = await signInWithApple().then(
      (value) => value,
      (caughtError) => {
        if (!isAppleSignInCanceled(caughtError)) {
          setError(caughtError instanceof Error ? caughtError.message : "Unable to sign in with Apple.");
        }

        return null;
      },
    );

    setIsSubmitting(false);

    if (!result) {
      return;
    }

    if (result.error) {
      setError(
        result.error.status === 404
          ? "Apple sign-in is not configured on the backend yet. Add your Apple provider env vars and restart the server."
          : (result.error.message ?? "Unable to sign in with Apple."),
      );
      return;
    }

    onSuccess?.();
  }

  return (
    <View className={"gap-3"}>
      {session?.user ? (
        <View className={"rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-4"}>
          <ThemedText variant={"subhead"} className={"font-semibold text-emerald-200"}>
            {signedInTitle}
          </ThemedText>
          <ThemedText variant={"footnote"} color={"secondary"} className={"mt-1"} selectable>
            {session.user.email ?? signedInMessage}
          </ThemedText>
          {session.user.email ? (
            <ThemedText variant={"caption1"} color={"tertiary"} className={"mt-2"}>
              {signedInMessage}
            </ThemedText>
          ) : null}
        </View>
      ) : isAppleAvailable === null ? (
        <View className={"items-center rounded-2xl border border-white/10 bg-background px-4 py-5"}>
          <ActivityIndicator color={"#FFFFFF"} />
          <ThemedText variant={"footnote"} color={"secondary"} className={"mt-2 text-center"}>
            {loadingMessage}
          </ThemedText>
        </View>
      ) : isAppleAvailable ? (
        <View className={"gap-3"}>
          <View pointerEvents={isSubmitting ? "none" : "auto"} style={{ opacity: isSubmitting ? 0.6 : 1 }}>
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
              cornerRadius={18}
              onPress={() => {
                void handleAppleSignIn();
              }}
              style={{ width: "100%", height: 52 }}
            />
          </View>

          {isSubmitting ? (
            <ThemedText variant={"footnote"} color={"secondary"} className={"text-center"}>
              {submittingMessage}
            </ThemedText>
          ) : null}
        </View>
      ) : (
        <View className={"rounded-2xl border border-white/10 bg-background px-4 py-4"}>
          <ThemedText variant={"subhead"} className={"font-semibold"}>
            {unavailableMessage}
          </ThemedText>
        </View>
      )}

      {error ? (
        <ThemedText variant={"footnote"} className={"rounded-2xl bg-red-500/10 px-3 py-2 text-red-300"} selectable>
          {error}
        </ThemedText>
      ) : null}
    </View>
  );
}

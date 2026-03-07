import * as AppleAuthentication from "expo-apple-authentication";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { ThemedText } from "@/components/themed-text";
import { isAppleSignInCanceled, signInWithApple, useSession } from "@/lib/auth-client";

type AppleSignInPanelVariant = "default" | "compact";

interface AppleSignInPanelProps {
  onSuccess?: () => void;
  variant?: AppleSignInPanelVariant;
  signedInTitle?: string;
  signedInMessage?: string;
  unavailableMessage?: string;
  loadingMessage?: string;
  submittingMessage?: string;
}

function BenefitRow({ title, description }: { title: string; description: string }) {
  return (
    <View className={"flex-row items-start gap-3"}>
      <View className={"mt-1.5 h-2.5 w-2.5 rounded-full bg-[#34d399]"} />
      <View className={"flex-1 gap-0.5"}>
        <ThemedText variant={"subhead"} className={"font-semibold"}>
          {title}
        </ThemedText>
        <ThemedText variant={"footnote"} color={"secondary"}>
          {description}
        </ThemedText>
      </View>
    </View>
  );
}

export function AppleSignInPanel({
  onSuccess,
  variant = "default",
  signedInTitle = "Signed in with Apple",
  signedInMessage = "Cloud sync is ready for confirmed visits and social features.",
  unavailableMessage = "Apple sign-in is only available in an Apple build of Palate on a supported device.",
  loadingMessage = "Checking whether Apple sign-in is available on this device...",
  submittingMessage = "Finishing sign-in...",
}: AppleSignInPanelProps) {
  const { data: session } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAppleSignInAvailable, setIsAppleSignInAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let isActive = true;

    void AppleAuthentication.isAvailableAsync()
      .then((isAvailable) => {
        if (isActive) {
          setIsAppleSignInAvailable(isAvailable);
        }
      })
      .catch((caughtError) => {
        console.error(caughtError);
        if (isActive) {
          setIsAppleSignInAvailable(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  const benefits =
    variant === "compact"
      ? [
          {
            title: "Sync confirmed visits",
            description: "Back up the restaurants and notes you decide to keep.",
          },
          {
            title: "Unlock profile controls",
            description: "Choose whether your public Palate profile shares confirmed visits.",
          },
        ]
      : [
          {
            title: "Sync confirmed visits",
            description: "Back up the restaurants, ratings, and notes you decide to keep.",
          },
          {
            title: "Turn on profile features",
            description: "Keep your public profile and follows synced across devices when you want social features.",
          },
        ];

  const introTitle = "Optional cloud sync";
  const introMessage =
    variant === "compact"
      ? "Keep using Palate locally, or connect Apple now to sync confirmed visits and profile features."
      : "Palate stays local-first. Connect Apple when you want backup, profile sync, or social features.";
  const headingVariant = variant === "compact" ? "heading" : "subhead";

  async function handleAppleSignIn() {
    setIsSubmitting(true);
    setError(null);

    const result = await signInWithApple().then(
      (value) => value,
      (caughtError) => {
        console.error(caughtError);
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
    <View className={"gap-4"}>
      {session?.user ? (
        <View className={"rounded-[24px] border border-emerald-400/20 bg-emerald-500/10 px-4 py-4"}>
          <ThemedText variant={headingVariant} className={"font-semibold text-emerald-200"}>
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
      ) : (
        <View className={"gap-4"}>
          {variant === "compact" ? (
            <View className={"gap-1"}>
              <ThemedText variant={headingVariant} className={"font-semibold"}>
                {introTitle}
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                {introMessage}
              </ThemedText>
            </View>
          ) : null}

          <View className={"gap-3"}>
            {benefits.map((benefit) => (
              <BenefitRow key={benefit.title} title={benefit.title} description={benefit.description} />
            ))}
          </View>

          {isAppleSignInAvailable === null ? (
            <View
              className={"flex-row items-center gap-3 rounded-2xl border border-white/10 bg-background/70 px-4 py-4"}
            >
              <ActivityIndicator color={"#0A84FF"} />
              <View className={"flex-1 gap-0.5"}>
                <ThemedText variant={"subhead"} className={"font-semibold"}>
                  Checking Apple sign-in
                </ThemedText>
                <ThemedText variant={"footnote"} color={"secondary"}>
                  {loadingMessage}
                </ThemedText>
              </View>
            </View>
          ) : isAppleSignInAvailable ? (
            <View className={"gap-3"}>
              <View pointerEvents={isSubmitting ? "none" : "auto"} style={{ opacity: isSubmitting ? 0.6 : 1 }}>
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                  buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                  cornerRadius={18}
                  onPress={() => {
                    void handleAppleSignIn();
                  }}
                  style={{ width: "100%", height: 54 }}
                />
              </View>

              <ThemedText variant={"caption1"} color={"tertiary"} className={"text-center"}>
                Secure Apple sign-in only. Palate stays local-first until you choose what to sync.
              </ThemedText>

              {isSubmitting ? (
                <View className={"flex-row items-center justify-center gap-2"}>
                  <ActivityIndicator size={"small"} color={"#0A84FF"} />
                  <ThemedText variant={"footnote"} color={"secondary"} className={"text-center"}>
                    {submittingMessage}
                  </ThemedText>
                </View>
              ) : null}
            </View>
          ) : (
            <View className={"rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-4"}>
              <ThemedText variant={"subhead"} className={"font-semibold text-amber-200"}>
                Apple sign-in unavailable
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"} className={"mt-1"} selectable>
                {unavailableMessage}
              </ThemedText>
            </View>
          )}

          {variant === "default" ? (
            <View className={"rounded-2xl bg-background/60 px-4 py-3"}>
              <ThemedText variant={"footnote"} color={"secondary"} className={"text-center"}>
                Already have an account? Apple will sign you back in. New here? The same button creates it.
              </ThemedText>
            </View>
          ) : null}
        </View>
      )}

      {error ? (
        <ThemedText
          variant={"footnote"}
          className={"rounded-[20px] border border-red-400/15 bg-red-500/10 px-3 py-3 text-red-300"}
          selectable
        >
          {error}
        </ThemedText>
      ) : null}
    </View>
  );
}

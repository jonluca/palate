import { router } from "expo-router";
import React from "react";
import { View } from "react-native";
import { AppleSignInPanel } from "@/components/auth/apple-sign-in-panel";
import { AuthShell } from "@/components/auth/auth-shell";
import { ThemedText } from "@/components/themed-text";

export default function SignInScreen() {
  return (
    <AuthShell
      eyebrow={"Palate Cloud"}
      title={"Continue with Apple"}
      subtitle={
        "Sign in with Apple to sync confirmed visits, publish your profile, and unlock Palate's cloud features."
      }
      footer={
        <View className={"items-center px-2"}>
          <ThemedText variant={"footnote"} color={"secondary"}>
            Apple is the only supported sign-in method.
          </ThemedText>
        </View>
      }
    >
      <AppleSignInPanel onSuccess={() => router.replace("/")} />
    </AuthShell>
  );
}

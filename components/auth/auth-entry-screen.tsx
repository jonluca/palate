import { router } from "expo-router";
import React from "react";
import { View } from "react-native";
import { AppleSignInPanel } from "@/components/auth/apple-sign-in-panel";
import { AuthShell } from "@/components/auth/auth-shell";
import { ThemedText } from "@/components/themed-text";

export function AuthEntryScreen() {
  return (
    <AuthShell
      eyebrow={"Optional cloud sync"}
      title={"Continue with Apple"}
      subtitle={
        "Back up confirmed visits, keep your profile in sync, and turn on Palate's social features whenever you want them."
      }
      footer={
        <View className={"gap-1"}>
          <ThemedText variant={"footnote"} color={"secondary"} className={"text-center"}>
            Palate still works locally without an account.
          </ThemedText>
          <ThemedText variant={"caption1"} color={"tertiary"} className={"text-center"}>
            You can connect Apple later from Account or Social.
          </ThemedText>
        </View>
      }
    >
      <AppleSignInPanel onSuccess={() => router.replace("/")} />
    </AuthShell>
  );
}

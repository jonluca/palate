import { useQueryClient } from "@tanstack/react-query";
import { router, type Href } from "expo-router";
import React, { useState } from "react";
import { View } from "react-native";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { signOut, useSession } from "@/lib/auth-client";

export function AuthEntryCard() {
  const { data: session } = useSession();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleLogOut() {
    setIsSigningOut(true);

    try {
      const result = await signOut();

      if (result.error) {
        showToast({ type: "error", message: result.error.message ?? "Unable to sign out" });
        return;
      }

      queryClient.removeQueries({ queryKey: ["cloud"] });
      showToast({ type: "success", message: "Logged out." });
    } catch (error) {
      showToast({ type: "error", message: error instanceof Error ? error.message : "Unable to sign out" });
    } finally {
      setIsSigningOut(false);
    }
  }

  const isSignedIn = Boolean(session?.user);

  return (
    <Card animated={false}>
      <View className={"gap-4 p-4"}>
        <View className={"flex-row items-start gap-3"}>
          <View className={"h-10 w-10 items-center justify-center rounded-full bg-blue-500/15"}>
            <IconSymbol
              name={isSignedIn ? "person.crop.circle.badge.checkmark" : "person.crop.circle.badge.plus"}
              size={20}
              color={"#60a5fa"}
            />
          </View>

          <View className={"flex-1 gap-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              {isSignedIn ? session?.user?.name || "Signed in with Apple" : "Apple sign-in"}
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"} selectable={Boolean(session?.user?.email)}>
              {session?.user?.email ??
                "Log in when you want cloud sync, profile controls, and friends features. Palate still works locally without an account."}
            </ThemedText>
          </View>

          <View
            className={isSignedIn ? "rounded-full bg-green-500/15 px-2 py-1" : "rounded-full bg-blue-500/15 px-2 py-1"}
          >
            <ThemedText
              variant={"caption2"}
              className={isSignedIn ? "font-medium text-green-400" : "font-medium text-blue-400"}
            >
              {isSignedIn ? "Active" : "Optional"}
            </ThemedText>
          </View>
        </View>

        <Button
          variant={isSignedIn ? "secondary" : "default"}
          onPress={isSignedIn ? handleLogOut : () => router.push("/sign-in" as Href)}
          loading={isSigningOut}
        >
          <ButtonText variant={isSignedIn ? "secondary" : "default"}>{isSignedIn ? "Log Out" : "Log In"}</ButtonText>
        </Button>
      </View>
    </Card>
  );
}

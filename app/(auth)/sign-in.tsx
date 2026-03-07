import { Link, router, type Href } from "expo-router";
import React, { useState } from "react";
import { View } from "react-native";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthTextField } from "@/components/auth/auth-text-field";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText } from "@/components/ui";
import { signIn } from "@/lib/auth-client";

export default function SignInScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const result = await signIn.email({
      email: email.trim(),
      password,
    });

    setIsSubmitting(false);

    if (result.error) {
      setError(result.error.message ?? "Unable to sign in.");
      return;
    }

    router.replace("/");
  }

  return (
    <AuthShell
      eyebrow={"Palate Cloud"}
      title={"Sign in to sync Palate"}
      subtitle={
        "Your scans stay local. Your account, preferences, and future backend features live behind Better Auth."
      }
      footer={
        <View className={"items-center px-2"}>
          <ThemedText variant={"footnote"} color={"secondary"}>
            Need an account?{" "}
            <Link href={"/(auth)/sign-up" as Href} style={{ color: "#0A84FF", fontWeight: "600" }}>
              Create one
            </Link>
          </ThemedText>
        </View>
      }
    >
      <AuthTextField
        label={"Email"}
        value={email}
        onChangeText={setEmail}
        keyboardType={"email-address"}
        textContentType={"emailAddress"}
        autoCapitalize={"none"}
        placeholder={"chef@palate.app"}
      />
      <AuthTextField
        label={"Password"}
        value={password}
        onChangeText={setPassword}
        textContentType={"password"}
        secureTextEntry
        autoCapitalize={"none"}
        placeholder={"Minimum 8 characters"}
      />

      {error ? (
        <ThemedText variant={"footnote"} className={"rounded-2xl bg-red-500/10 px-3 py-2 text-red-300"} selectable>
          {error}
        </ThemedText>
      ) : null}

      <Button onPress={handleSubmit} loading={isSubmitting} size={"lg"}>
        <ButtonText size={"lg"}>Sign In</ButtonText>
      </Button>
    </AuthShell>
  );
}

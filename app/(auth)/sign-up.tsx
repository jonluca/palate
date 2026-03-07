import { Link, router, type Href } from "expo-router";
import React, { useState } from "react";
import { View } from "react-native";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthTextField } from "@/components/auth/auth-text-field";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText } from "@/components/ui";
import { signUp } from "@/lib/auth-client";

export default function SignUpScreen() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    if (!name.trim() || !email.trim() || !password) {
      setError("Name, email, and password are all required.");
      return;
    }

    if (password.length < 8) {
      setError("Passwords must be at least 8 characters.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const result = await signUp.email({
      name: name.trim(),
      email: email.trim(),
      password,
    });

    setIsSubmitting(false);

    if (result.error) {
      setError(result.error.message ?? "Unable to create your account.");
      return;
    }

    router.replace("/");
  }

  return (
    <AuthShell
      eyebrow={"Backend Ready"}
      title={"Create your Palate account"}
      subtitle={
        "Set up Better Auth, connect the Expo app to the tRPC backend, and keep a lightweight profile in Postgres."
      }
      footer={
        <View className={"items-center px-2"}>
          <ThemedText variant={"footnote"} color={"secondary"}>
            Already signed up?{" "}
            <Link href={"/(auth)/sign-in" as Href} style={{ color: "#0A84FF", fontWeight: "600" }}>
              Sign in
            </Link>
          </ThemedText>
        </View>
      }
    >
      <AuthTextField
        label={"Display name"}
        value={name}
        onChangeText={setName}
        textContentType={"name"}
        autoCapitalize={"words"}
        placeholder={"Jon L"}
      />
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
        hint={"8+ chars"}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType={"newPassword"}
        autoCapitalize={"none"}
        placeholder={"Create a strong password"}
      />

      {error ? (
        <ThemedText variant={"footnote"} className={"rounded-2xl bg-red-500/10 px-3 py-2 text-red-300"} selectable>
          {error}
        </ThemedText>
      ) : null}

      <Button onPress={handleSubmit} loading={isSubmitting} size={"lg"}>
        <ButtonText size={"lg"}>Create Account</ButtonText>
      </Button>
    </AuthShell>
  );
}

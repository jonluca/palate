import { Redirect, Stack } from "expo-router";
import React from "react";
import { FullScreenLoader } from "@/components/ui/full-screen-loader";
import { useSession } from "@/lib/auth-client";

export default function AuthLayout() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return <FullScreenLoader label={"Checking your account..."} />;
  }

  if (session?.user) {
    return <Redirect href={"/"} />;
  }

  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerTransparent: true,
        headerTintColor: "#0A84FF",
        headerTitleStyle: {
          color: "#FFFFFF",
          fontWeight: "600",
        },
        contentStyle: {
          backgroundColor: "#000000",
        },
      }}
    >
      <Stack.Screen name={"sign-in"} options={{ title: "Sign In" }} />
      <Stack.Screen name={"sign-up"} options={{ title: "Create Account" }} />
    </Stack>
  );
}


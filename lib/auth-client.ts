import { expoClient } from "@better-auth/expo/client";
import * as AppleAuthentication from "expo-apple-authentication";
import * as SecureStore from "expo-secure-store";
import { createAuthClient } from "better-auth/react";
import { getApiBaseUrl } from "@/lib/api-config";

export const authClient = createAuthClient({
  baseURL: getApiBaseUrl(),
  plugins: [
    expoClient({
      scheme: "palate",
      storagePrefix: "palate-auth",
      storage: {
        getItem: (key) => SecureStore.getItem(key) ?? null,
        setItem: (key, value) => {
          void SecureStore.setItemAsync(key, value);
        },
      },
    }),
  ],
});

export const { signIn, signOut, useSession } = authClient;

export async function isAppleSignInAvailable() {
  return AppleAuthentication.isAvailableAsync();
}

export async function signInWithApple() {
  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
  });

  if (!credential.identityToken) {
    throw new Error("Apple did not return an identity token.");
  }

  return signIn.social({
    provider: "apple",
    idToken: {
      token: credential.identityToken,
    },
  });
}

export function isAppleSignInCanceled(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_REQUEST_CANCELED";
}

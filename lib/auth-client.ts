import { expoClient } from "@better-auth/expo/client";
import * as AppleAuthentication from "expo-apple-authentication";
import * as SecureStore from "expo-secure-store";
import { createAuthClient } from "better-auth/react";
import { getCloudBaseUrl } from "@/lib/api-config";

export const authClient = createAuthClient({
  baseURL: getCloudBaseUrl(),
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

export function getAppleSignInErrorMessage(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      status?: number;
      message?: string | null;
    };

    if (candidate.status === 404) {
      return "Apple sign-in is not configured on the backend yet. Add your Apple provider env vars and restart the server.";
    }

    if (candidate.message) {
      return candidate.message;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unable to sign in with Apple.";
}

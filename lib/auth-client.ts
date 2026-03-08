import { expoClient } from "@better-auth/expo/client";
import * as AppleAuthentication from "expo-apple-authentication";
import * as SecureStore from "expo-secure-store";
import { createAuthClient } from "better-auth/react";
import { getCloudBaseUrl } from "@/lib/api-config";

const AUTH_STORAGE_PREFIX = "palate-auth";
const AUTH_SECURE_STORE_KEYS = [
  `${AUTH_STORAGE_PREFIX}_cookie`,
  `${AUTH_STORAGE_PREFIX}_session_data`,
  `${AUTH_STORAGE_PREFIX}_last_login_method`,
];

export const authClient = createAuthClient({
  baseURL: getCloudBaseUrl(),
  plugins: [
    expoClient({
      scheme: "palate",
      storagePrefix: AUTH_STORAGE_PREFIX,
      storage: {
        getItem: (key) => SecureStore.getItem(key) ?? null,
        setItem: (key, value) => {
          SecureStore.setItem(key, value);
        },
      },
    }),
  ],
});

export const { signIn, signOut, useSession } = authClient;

export async function refreshAuthSession() {
  await authClient.$store.atoms.session.get().refetch();
}

export async function clearAuthSecureStore() {
  await Promise.all(AUTH_SECURE_STORE_KEYS.map((key) => SecureStore.deleteItemAsync(key)));
  authClient.$store.atoms.session.set({
    ...authClient.$store.atoms.session.get(),
    data: null,
    error: null,
    isPending: false,
  });
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

  const result = await signIn.social({
    provider: "apple",
    idToken: {
      token: credential.identityToken,
    },
  });

  if (!result.error) {
    await refreshAuthSession();
  }

  return result;
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

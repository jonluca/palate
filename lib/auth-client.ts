import { expoClient } from "@better-auth/expo/client";
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

export const { signIn, signOut, signUp, useSession } = authClient;

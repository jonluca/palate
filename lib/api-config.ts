import { Platform } from "react-native";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function getApiBaseUrl() {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

  if (configuredUrl) {
    return trimTrailingSlash(configuredUrl);
  }

  if (!__DEV__) {
    throw new Error("EXPO_PUBLIC_API_URL is required outside development.");
  }

  return Platform.OS === "android" ? "http://10.0.2.2:3001" : "http://127.0.0.1:3001";
}


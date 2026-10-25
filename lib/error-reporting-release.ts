import Constants from "expo-constants";
import { Platform } from "react-native";

const version = Constants.expoConfig?.version ?? "unknown";
const build =
  Platform.OS === "ios"
    ? (Constants.platform?.ios?.buildNumber ?? Constants.expoConfig?.ios?.buildNumber ?? "unknown")
    : (Constants.platform?.android?.versionCode ?? Constants.expoConfig?.android?.versionCode ?? "unknown");

const appIdentifier =
  Platform.OS === "android"
    ? (Constants.expoConfig?.android?.package ?? "com.jonluca.restaurantmatcher")
    : (Constants.expoConfig?.ios?.bundleIdentifier ?? "com.jonluca.photo-restaurant-matcher");

export const MOBILE_RELEASE = `${appIdentifier}@${version}+${build}`.replace(/[^A-Za-z0-9@.+_-]/gu, "_");
export const HAS_NATIVE_RELEASE = version !== "unknown" && build !== "unknown";

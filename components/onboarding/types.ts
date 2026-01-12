import type { SymbolViewProps } from "expo-symbols";
import type { SharedValue } from "react-native-reanimated";
import type React from "react";

export type PermissionType = "photos" | "calendar";

export interface OnboardingSlide {
  id: string;
  icon: SymbolViewProps["name"];
  iconColor: string;
  iconBg: string;
  title: string;
  subtitle: string;
  description: string;
  gradient: [string, string, string, string];
  /** If set, this slide requests a permission when the user continues */
  permission?: PermissionType;
  /** Custom component to render additional content below the description */
  CustomContent?: React.ComponentType<{ scrollX: SharedValue<number>; index: number }>;
  /** Custom button text override */
  buttonText?: string;
}

import type { ButtonProps as SwiftUIButtonProps } from "@expo/ui/swift-ui";

export interface NativeStatsButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  iconOnly?: boolean;
  prominent?: boolean;
  size?: "small" | "regular" | "large";
  systemImage?: SwiftUIButtonProps["systemImage"];
  tintColor?: string;
}

export interface NativeStatsButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  iconOnly?: boolean;
  prominent?: boolean;
  size?: "small" | "regular" | "large";
  systemImage?: string;
  tintColor?: string;
}

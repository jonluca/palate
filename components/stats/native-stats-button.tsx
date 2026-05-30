import { Button, Host } from "@expo/ui";
import type { NativeStatsButtonProps } from "./native-stats-button.types";

export function NativeStatsButton({
  label,
  onPress,
  disabled,
  prominent = false,
  size = "regular",
}: NativeStatsButtonProps) {
  const padding =
    size === "small"
      ? { paddingHorizontal: 12, paddingVertical: 7 }
      : size === "large"
        ? { paddingHorizontal: 18, paddingVertical: 12 }
        : { paddingHorizontal: 14, paddingVertical: 9 };

  return (
    <Host matchContents>
      <Button
        label={label}
        onPress={onPress}
        disabled={disabled}
        variant={prominent ? "filled" : "outlined"}
        style={padding}
      />
    </Host>
  );
}

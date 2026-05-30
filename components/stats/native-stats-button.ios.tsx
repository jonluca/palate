import { Button, Host, type ButtonProps } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, disabled as disabledModifier, labelStyle, tint } from "@expo/ui/swift-ui/modifiers";
import type { NativeStatsButtonProps } from "./native-stats-button.types";

export function NativeStatsButton({
  label,
  onPress,
  disabled,
  iconOnly = false,
  prominent = false,
  size = "regular",
  systemImage,
  tintColor,
}: NativeStatsButtonProps) {
  const modifiers = [buttonStyle(prominent ? "glassProminent" : "glass"), controlSize(size)];

  if (disabled) {
    modifiers.push(disabledModifier());
  }
  if (iconOnly) {
    modifiers.push(labelStyle("iconOnly"));
  }
  if (tintColor) {
    modifiers.push(tint(tintColor));
  }

  return (
    <Host matchContents>
      <Button
        label={label}
        onPress={onPress}
        systemImage={systemImage as ButtonProps["systemImage"]}
        modifiers={modifiers}
      />
    </Host>
  );
}

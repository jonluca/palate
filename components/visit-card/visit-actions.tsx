import { Pressable, View, ActivityIndicator } from "react-native";
import * as Haptics from "expo-haptics";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText } from "@/components/ui";
import type { VisitActionsProps } from "./types";

export function VisitActions({
  onSkip,
  onConfirm,
  onFindRestaurant,
  onNotThisRestaurant,
  hasSuggestion,
  skipDisabled = false,
  loadingAction = null,
  variant = "pill",
  promptText,
}: VisitActionsProps) {
  // Derive per-button loading states (support both legacy isLoading and new loadingAction)
  const isSkipLoading = loadingAction === "skip";
  const isConfirmLoading = loadingAction === "confirm";
  const isFindLoading = loadingAction === "find";
  const isAnyLoading = loadingAction !== null;
  const isSkipDisabled = isAnyLoading || skipDisabled;

  const handleSkip = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    onSkip();
  };

  const handleConfirm = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onConfirm();
  };

  const handleFindRestaurant = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onFindRestaurant?.();
  };

  const handleNotThisRestaurant = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onNotThisRestaurant?.();
  };

  if (variant === "full") {
    return (
      <View className={"gap-4"}>
        {promptText && (
          <ThemedText variant={"subhead"} color={"secondary"} className={"text-center"}>
            {promptText}
          </ThemedText>
        )}
        <View className={"flex-row gap-3"}>
          <View className={"flex-1"}>
            <Button
              onPress={handleSkip}
              loading={isSkipLoading}
              disabled={isSkipDisabled}
              variant={"destructive"}
              className={"w-full"}
            >
              <ButtonText variant={"destructive"}>Not a Visit</ButtonText>
            </Button>
          </View>
          <View className={"flex-1"}>
            {hasSuggestion ? (
              <Button
                onPress={handleConfirm}
                loading={isConfirmLoading}
                disabled={isAnyLoading}
                variant={"success"}
                className={"w-full"}
              >
                <ButtonText variant={"success"}>Confirm</ButtonText>
              </Button>
            ) : onFindRestaurant ? (
              <Button
                onPress={handleFindRestaurant}
                loading={isFindLoading}
                disabled={isAnyLoading}
                variant={"secondary"}
                className={"w-full"}
              >
                <ButtonText variant={"secondary"}>Find Restaurant</ButtonText>
              </Button>
            ) : (
              <Button
                onPress={handleConfirm}
                loading={isConfirmLoading}
                disabled={isAnyLoading}
                variant={"success"}
                className={"w-full"}
              >
                <ButtonText variant={"success"}>Confirm</ButtonText>
              </Button>
            )}
          </View>
        </View>
      </View>
    );
  }

  // Pill variant (default) - used in review cards
  return (
    <View className={"flex-row items-center gap-3"}>
      <Pressable
        onPress={handleSkip}
        disabled={isSkipDisabled}
        className={`flex-row items-center gap-2 px-4 py-2 rounded-full ${
          isSkipDisabled ? "bg-muted opacity-50" : "bg-red-500/10"
        }`}
      >
        {isSkipLoading ? (
          <ActivityIndicator size={"small"} color={"#ef4444"} />
        ) : (
          <>
            <IconSymbol name={"xmark"} size={16} color={isSkipDisabled ? "#8E8E93" : "#ef4444"} />
            <ThemedText
              variant={"subhead"}
              className={`${isSkipDisabled ? "text-muted-foreground" : "text-red-500"} font-medium`}
            >
              Skip
            </ThemedText>
          </>
        )}
      </Pressable>

      <View className={"flex-1"} />

      <View className={"flex-row items-center gap-2"}>
        {hasSuggestion && onNotThisRestaurant && (
          <Pressable
            onPress={handleNotThisRestaurant}
            disabled={isAnyLoading}
            className={"py-2 rounded-full"}
            hitSlop={8}
          >
            <ThemedText variant={"footnote"} color={"tertiary"} className={"underline"}>
              Search
            </ThemedText>
          </Pressable>
        )}

        {hasSuggestion ? (
          <Pressable
            onPress={handleConfirm}
            disabled={isAnyLoading}
            className={"flex-row items-center gap-2 px-4 py-2 bg-green-500/20 rounded-full"}
          >
            {isConfirmLoading ? (
              <ActivityIndicator size={"small"} color={"#22c55e"} />
            ) : (
              <>
                <IconSymbol name={"checkmark"} size={16} color={"#22c55e"} />
                <ThemedText variant={"subhead"} className={"text-green-500 font-medium"}>
                  Confirm
                </ThemedText>
              </>
            )}
          </Pressable>
        ) : (
          <Pressable
            onPress={handleFindRestaurant}
            disabled={isAnyLoading}
            className={"flex-row items-center gap-2 px-4 py-2 bg-orange-500/20 rounded-full"}
          >
            {isFindLoading ? (
              <ActivityIndicator size={"small"} color={"#f97316"} />
            ) : (
              <>
                <IconSymbol name={"magnifyingglass"} size={16} color={"#f97316"} />
                <ThemedText variant={"subhead"} className={"text-orange-500 font-medium"}>
                  Find Restaurant
                </ThemedText>
              </>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

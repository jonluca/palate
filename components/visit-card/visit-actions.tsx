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
  hasSuggestion,
  isLoading = false,
  variant = "pill",
  promptText,
}: VisitActionsProps) {
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
            <Button onPress={handleSkip} loading={isLoading} variant={"destructive"} className={"w-full"}>
              <ButtonText variant={"destructive"}>Not a Visit</ButtonText>
            </Button>
          </View>
          <View className={"flex-1"}>
            {hasSuggestion ? (
              <Button onPress={handleConfirm} loading={isLoading} variant={"success"} className={"w-full"}>
                <ButtonText variant={"success"}>Confirm</ButtonText>
              </Button>
            ) : onFindRestaurant ? (
              <Button onPress={handleFindRestaurant} loading={isLoading} variant={"secondary"} className={"w-full"}>
                <ButtonText variant={"secondary"}>Find Restaurant</ButtonText>
              </Button>
            ) : (
              <Button onPress={handleConfirm} loading={isLoading} variant={"success"} className={"w-full"}>
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
        disabled={isLoading}
        className={"flex-row items-center gap-2 px-4 py-2 bg-red-500/10 rounded-full"}
      >
        <IconSymbol name={"xmark"} size={16} color={"#ef4444"} />
        <ThemedText variant={"subhead"} className={"text-red-500 font-medium"}>
          Skip
        </ThemedText>
      </Pressable>

      <View className={"flex-1"} />

      {hasSuggestion ? (
        <Pressable
          onPress={handleConfirm}
          disabled={isLoading}
          className={"flex-row items-center gap-2 px-4 py-2 bg-green-500/20 rounded-full"}
        >
          {isLoading ? (
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
          disabled={isLoading}
          className={"flex-row items-center gap-2 px-4 py-2 bg-orange-500/20 rounded-full"}
        >
          <IconSymbol name={"magnifyingglass"} size={16} color={"#f97316"} />
          <ThemedText variant={"subhead"} className={"text-orange-500 font-medium"}>
            Find Restaurant
          </ThemedText>
        </Pressable>
      )}
    </View>
  );
}

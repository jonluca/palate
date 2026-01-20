import React from "react";
import { Pressable, ActivityIndicator, View } from "react-native";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { VisitActions, type LoadingAction } from "@/components/visit-card";
import type { VisitStatus, NearbyRestaurant } from "@/hooks/queries";

/** Minimal restaurant shape needed for confirmation */
type ConfirmableRestaurant = Pick<NearbyRestaurant, "id" | "name" | "latitude" | "longitude">;

interface VisitActionButtonsProps {
  status: VisitStatus;
  /** The restaurant that will be confirmed (from nearby list or suggested) */
  restaurantToConfirm: ConfirmableRestaurant | null;
  /** Which action is currently loading */
  loadingAction: LoadingAction;
  onStatusChange: (status: VisitStatus) => void;
  /** Called when user confirms with a restaurant */
  onConfirmRestaurant: (restaurant: ConfirmableRestaurant) => void;
  onFindRestaurant: () => void;
  onIgnoreLocation: () => void;
}

export function VisitActionButtons({
  status,
  restaurantToConfirm,
  loadingAction,
  onStatusChange,
  onConfirmRestaurant,
  onFindRestaurant,
  onIgnoreLocation,
}: VisitActionButtonsProps) {
  const isAnyLoading = loadingAction !== null;
  const hasRestaurant = restaurantToConfirm !== null;

  const getPromptText = () => {
    if (hasRestaurant) {
      return "Confirm this restaurant?";
    }
    return "Is this a restaurant visit?";
  };

  const handleConfirm = () => {
    if (restaurantToConfirm) {
      onConfirmRestaurant(restaurantToConfirm);
    } else {
      onStatusChange("confirmed");
    }
  };

  if (status !== "pending") {
    return null;
  }
  return (
    <View className={"gap-4 mt-2"}>
      {status === "pending" ? (
        <>
          <VisitActions
            onSkip={() => onStatusChange("rejected")}
            onConfirm={handleConfirm}
            onFindRestaurant={onFindRestaurant}
            hasSuggestion={hasRestaurant}
            loadingAction={loadingAction}
            variant={"full"}
            promptText={getPromptText()}
          />
          <Pressable
            onPress={onIgnoreLocation}
            disabled={isAnyLoading}
            className={"flex-row items-center justify-center gap-2 py-2"}
          >
            {loadingAction === "skip" ? (
              <ActivityIndicator size={"small"} color={"#9ca3af"} />
            ) : (
              <>
                <IconSymbol name={"location.slash"} size={14} color={"#9ca3af"} />
                <ThemedText variant={"footnote"} color={"tertiary"} className={"underline"}>
                  Ignore this location
                </ThemedText>
              </>
            )}
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

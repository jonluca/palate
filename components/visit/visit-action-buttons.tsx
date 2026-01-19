import React from "react";
import { Pressable, ActivityIndicator } from "react-native";
import Animated, { FadeInUp, LinearTransition } from "react-native-reanimated";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText } from "@/components/ui";
import { VisitActions, type LoadingAction } from "@/components/visit-card";
import type { VisitStatus } from "@/hooks/queries";

interface VisitActionButtonsProps {
  status: VisitStatus;
  hasSuggestion: boolean;
  nearbyCount: number;
  /** Which action is currently loading */
  loadingAction: LoadingAction;
  onStatusChange: (status: VisitStatus) => void;
  onConfirmWithSuggestion: () => void;
  onFindRestaurant: () => void;
  onIgnoreLocation: () => void;
}

export function VisitActionButtons({
  status,
  hasSuggestion,
  nearbyCount,
  loadingAction,
  onStatusChange,
  onConfirmWithSuggestion,
  onFindRestaurant,
  onIgnoreLocation,
}: VisitActionButtonsProps) {
  const isAnyLoading = loadingAction !== null;

  const getPromptText = () => {
    if (nearbyCount > 1) {
      return "Select and confirm a restaurant";
    }
    if (hasSuggestion) {
      return "Confirm this restaurant?";
    }
    return "Is this a restaurant visit?";
  };

  return (
    <Animated.View entering={FadeInUp.delay(400).duration(500)} layout={LinearTransition} className={"gap-4 mt-2"}>
      {status === "pending" ? (
        <>
          <VisitActions
            onSkip={() => onStatusChange("rejected")}
            onConfirm={hasSuggestion || nearbyCount > 0 ? onConfirmWithSuggestion : () => onStatusChange("confirmed")}
            onFindRestaurant={onFindRestaurant}
            hasSuggestion={hasSuggestion || nearbyCount > 0}
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
      ) : (
        <Button
          onPress={() => onStatusChange("pending")}
          loading={loadingAction === "skip"}
          disabled={isAnyLoading}
          variant={"muted"}
        >
          <ButtonText variant={"muted"}>Reset to Pending</ButtonText>
        </Button>
      )}
    </Animated.View>
  );
}

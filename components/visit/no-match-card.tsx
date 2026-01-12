import React from "react";
import { View } from "react-native";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Card, Button, ButtonText } from "@/components/ui";

interface NoMatchCardProps {
  onSearchPress: () => void;
}

export function NoMatchCard({ onSearchPress }: NoMatchCardProps) {
  return (
    <Card delay={200}>
      <View className={"p-4 gap-3"}>
        <View className={"flex-row items-center gap-2"}>
          <View className={"w-6 h-6 rounded-full bg-orange-500/20 items-center justify-center"}>
            <IconSymbol name={"magnifyingglass"} size={14} color={"#f97316"} />
          </View>
          <ThemedText variant={"footnote"} color={"secondary"}>
            No Michelin match found
          </ThemedText>
        </View>
        <ThemedText variant={"body"} color={"tertiary"}>
          We couldn't find a Michelin restaurant near this location. You can search for one manually.
        </ThemedText>
        <Button onPress={onSearchPress} variant={"secondary"}>
          <ButtonText variant={"secondary"}>Search Restaurants</ButtonText>
        </Button>
      </View>
    </Card>
  );
}

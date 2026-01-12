import React from "react";
import { View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { Button, ButtonText, Card } from "@/components/ui";

interface PermissionCardProps {
  onRequestPermission: () => void;
  isRequestingPermission: boolean;
  animationDelay?: number;
}

export function PermissionCard({
  onRequestPermission,
  isRequestingPermission,
  animationDelay = 100,
}: PermissionCardProps) {
  return (
    <Animated.View entering={FadeInDown.delay(animationDelay).duration(300)}>
      <Card className={"mb-6"}>
        <View className={"p-5 gap-4"}>
          <View className={"flex-row items-center gap-3"}>
            <View className={"w-10 h-10 rounded-full bg-yellow-500/15 items-center justify-center"}>
              <IconSymbol name={"exclamationmark.triangle"} size={20} color={"#eab308"} />
            </View>
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-semibold"}>
                Permission Required
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Photo library access is needed to scan your photos.
              </ThemedText>
            </View>
          </View>
          <Button onPress={onRequestPermission} loading={isRequestingPermission}>
            <ButtonText>Grant Permission</ButtonText>
          </Button>
        </View>
      </Card>
    </Animated.View>
  );
}

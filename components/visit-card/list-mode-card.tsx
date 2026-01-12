import { cn } from "@/utils/cn";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import * as Haptics from "expo-haptics";
import { Pressable, View } from "react-native";
import Animated, { FadeOut } from "react-native-reanimated";
import { PhotoPreview } from "./photo-preview";
import { FoodBadge, CalendarBadge } from "./badges";
import { formatDate, formatTime } from "./utils";
import { statusColors, type ListModeProps } from "./types";

export function ListModeCard({
  restaurantName,
  status,
  startTime,
  photoCount,
  previewPhotos = [],
  foodProbable = false,
  calendarEventTitle,
  calendarEventIsAllDay,
  onPress,
}: ListModeProps) {
  const colors = statusColors[status];

  const handlePress = (photoIndex?: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.(photoIndex);
  };

  return (
    <Animated.View exiting={FadeOut.duration(200)}>
      <Pressable onPress={() => handlePress()}>
        <View className={"bg-card rounded-2xl overflow-hidden"} style={{ borderCurve: "continuous" }}>
          <PhotoPreview photos={previewPhotos} onPhotoPress={handlePress} />

          <View className={"p-4 gap-2"}>
            <View className={"flex-row items-start justify-between"}>
              <View className={"flex-1 gap-1"}>
                <ThemedText variant={"heading"} className={"font-semibold"} numberOfLines={1}>
                  {restaurantName ?? "Unknown Location"}
                </ThemedText>
                <View className={"flex-row items-center gap-2"}>
                  <ThemedText variant={"footnote"} color={"tertiary"}>
                    {formatDate(startTime)} at {formatTime(startTime)}
                  </ThemedText>
                </View>
              </View>
              <View className={"flex-row items-center gap-1 ml-3"}>
                <View className={cn("w-2 h-2 rounded-full", colors.dot)} />
                <ThemedText variant={"caption2"} className={cn("font-medium uppercase", colors.text)}>
                  {status}
                </ThemedText>
              </View>
            </View>

            <View className={"flex-row items-center justify-between mt-1"}>
              <View className={"flex-row items-center gap-3 flex-1 flex-wrap"}>
                <View className={"flex-row items-center gap-1"}>
                  <IconSymbol name={"photo"} size={14} color={"gray"} />
                  <ThemedText variant={"footnote"} color={"tertiary"}>
                    {photoCount.toLocaleString()} photos
                  </ThemedText>
                </View>
                {Boolean(foodProbable) && <FoodBadge />}
                {calendarEventTitle && (
                  <CalendarBadge title={calendarEventTitle} isAllDay={calendarEventIsAllDay ?? false} />
                )}
              </View>

              {<IconSymbol name={"chevron.right"} size={16} color={"gray"} />}
            </View>
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

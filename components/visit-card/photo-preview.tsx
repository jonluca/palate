import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { ThemedText } from "@/components/themed-text";

interface MediaItem {
  uri: string;
  mediaType?: "photo" | "video";
  duration?: number | null;
}

interface PhotoPreviewProps {
  photos: (string | MediaItem)[];
  onPhotoPress?: (index: number) => void;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function isMediaItem(item: string | MediaItem): item is MediaItem {
  return typeof item === "object";
}

export function PhotoPreview({ photos, onPhotoPress }: PhotoPreviewProps) {
  if (photos.length === 0) {
    return null;
  }

  return (
    <View className={"flex-row h-40"}>
      {photos.slice(0, 3).map((item, i) => {
        const mediaItem = isMediaItem(item) ? item : { uri: item };
        const { uri } = mediaItem;
        const isVideo = mediaItem.mediaType === "video";
        const duration = mediaItem.duration ?? null;

        return (
          <Pressable key={uri} className={"flex-1"} onPress={() => onPhotoPress?.(i)} disabled={!onPhotoPress}>
            <Image
              source={{ uri }}
              recyclingKey={uri}
              cachePolicy={"memory-disk"}
              contentFit={"cover"}
              style={{ width: "100%", height: 160 }}
            />
            {isVideo && (
              <View
                className={"absolute bottom-2 left-2 flex-row items-center gap-1 bg-black/60 px-1.5 py-0.5 rounded"}
              >
                <Ionicons name={"play"} size={12} color={"white"} />
                {duration != null && (
                  <ThemedText variant={"caption2"} style={{ color: "white", fontSize: 10 }}>
                    {formatDuration(duration)}
                  </ThemedText>
                )}
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

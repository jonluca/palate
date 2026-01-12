import { Pressable, View } from "react-native";
import { Image } from "expo-image";

interface PhotoPreviewProps {
  photos: string[];
  onPhotoPress?: (index: number) => void;
}

export function PhotoPreview({ photos, onPhotoPress }: PhotoPreviewProps) {
  if (photos.length === 0) {
    return null;
  }

  return (
    <View className={"flex-row h-40"}>
      {photos.slice(0, 3).map((uri, i) => (
        <Pressable key={i} className={"flex-1"} onPress={() => onPhotoPress?.(i)} disabled={!onPhotoPress}>
          <Image
            recyclingKey={uri}
            source={{ uri }}
            style={{ width: "100%", height: 160 }}
            contentFit={"cover"}
            transition={100}
          />
        </Pressable>
      ))}
    </View>
  );
}

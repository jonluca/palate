import { requireNativeView, requireOptionalNativeModule } from "expo";
import { Image, type ImageProps } from "expo-image";
import type { ComponentType } from "react";
import { Platform, type NativeSyntheticEvent, type ViewProps } from "react-native";

interface ThumbnailCapabilityModule {
  readonly supportsPhotoAssetThumbnailView?: boolean;
}

interface NativeThumbnailLoadEvent {
  readonly uri: string;
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
  readonly isDegraded: boolean;
}

interface NativeThumbnailErrorEvent {
  readonly uri: string;
  readonly code: string;
  readonly message: string;
}

interface NativeThumbnailProps extends Omit<ViewProps, "children" | "style"> {
  readonly uri: string;
  readonly style?: ImageProps["style"];
  readonly onLoad?: (event: NativeSyntheticEvent<NativeThumbnailLoadEvent>) => void;
  readonly onError?: (event: NativeSyntheticEvent<NativeThumbnailErrorEvent>) => void;
}

export interface PhotoAssetThumbnailLoadEvent extends NativeThumbnailLoadEvent {
  readonly native: boolean;
}

export interface PhotoAssetThumbnailErrorEvent extends NativeThumbnailErrorEvent {
  readonly native: boolean;
}

export interface PhotoAssetThumbnailProps extends Omit<ViewProps, "children" | "style"> {
  readonly uri: string;
  readonly style?: ImageProps["style"];
  readonly onLoad?: (event: PhotoAssetThumbnailLoadEvent) => void;
  readonly onError?: (event: PhotoAssetThumbnailErrorEvent) => void;
}

const capabilityModule =
  Platform.OS === "ios" ? requireOptionalNativeModule<ThumbnailCapabilityModule>("BatchAssetInfo") : null;

let NativeThumbnailView: ComponentType<NativeThumbnailProps> | null = null;
if (capabilityModule?.supportsPhotoAssetThumbnailView === true) {
  try {
    NativeThumbnailView = requireNativeView<NativeThumbnailProps>("BatchAssetInfo", "PhotoAssetThumbnailView");
  } catch {
    // Older binaries and development clients can omit this native view.
  }
}

export function PhotoAssetThumbnail({ uri, onLoad, onError, ...viewProps }: PhotoAssetThumbnailProps) {
  const handleNativeLoad = (event: NativeSyntheticEvent<NativeThumbnailLoadEvent>) => {
    onLoad?.({ ...event.nativeEvent, native: true });
  };

  const handleNativeError = (event: NativeSyntheticEvent<NativeThumbnailErrorEvent>) => {
    onError?.({ ...event.nativeEvent, native: true });
  };

  if (NativeThumbnailView && uri.startsWith("ph://") && uri.length > "ph://".length) {
    return (
      <NativeThumbnailView
        {...viewProps}
        uri={uri}
        onLoad={onLoad ? handleNativeLoad : undefined}
        onError={onError ? handleNativeError : undefined}
      />
    );
  }

  return (
    <Image
      {...viewProps}
      source={{ uri }}
      contentFit={"cover"}
      recyclingKey={uri}
      onLoad={(event) => {
        onLoad?.({
          uri,
          assetId: uri.startsWith("ph://") ? uri.slice("ph://".length) : uri,
          width: event.source.width,
          height: event.source.height,
          isDegraded: false,
          native: false,
        });
      }}
      onError={(event) => {
        onError?.({
          uri,
          code: "ERR_THUMBNAIL_FALLBACK",
          message: event.error,
          native: false,
        });
      }}
    />
  );
}

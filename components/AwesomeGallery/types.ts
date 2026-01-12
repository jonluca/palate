import type { ViewStyle } from "react-native";
import type { SharedValue } from "react-native-reanimated";

export interface Dimensions {
  height: number;
  width: number;
}

export interface RenderItemInfo<T> {
  index: number;
  item: T;
  setImageDimensions: (imageDimensions: Dimensions) => void;
}

interface EventsCallbacks {
  onSwipeToClose?: () => void;
  onTap?: () => void;
  onDoubleTap?: (toScale: number) => void;
  onLongPress?: () => void;
  onScaleStart?: (scale: number) => void;
  onScaleEnd?: (scale: number) => void;
  onPanStart?: () => void;
  onTranslationYChange?: (translationY: number, shouldClose: boolean) => void;
}

export type RenderItem<T> = (imageInfo: RenderItemInfo<T>) => React.ReactElement | null;

export interface ItemRef {
  reset: (animated: boolean) => void;
}

interface GalleryRef {
  setIndex: (newIndex: number, animated?: boolean) => void;
  reset: (animated?: boolean) => void;
}

export type GalleryReactRef = React.Ref<GalleryRef>;

export interface ResizableImageProps<T> extends EventsCallbacks {
  item: T;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  translateX: SharedValue<number>;
  currentIndex: SharedValue<number>;
  renderItem: RenderItem<T>;
  width: number;
  height: number;
  length: number;
  emptySpaceWidth: number;
  doubleTapInterval: number;
  doubleTapScale: number;
  maxScale: number;
  pinchEnabled: boolean;
  swipeEnabled: boolean;
  doubleTapEnabled: boolean;
  disableTransitionOnScaledImage: boolean;
  hideAdjacentImagesOnScaledImage: boolean;
  disableVerticalSwipe?: boolean;
  disableSwipeUp?: boolean;
  loop: boolean;
  onScaleChange?: (scale: number) => void;
  onScaleChangeRange?: { start: number; end: number };
  setRef: (index: number, value: ItemRef) => void;
}

export interface GalleryProps<T> extends EventsCallbacks {
  ref?: GalleryReactRef;
  data: T[];
  renderItem?: RenderItem<T>;
  initialIndex?: number;
  onIndexChange?: (index: number) => void;
  numToRender?: number;
  emptySpaceWidth?: number;
  doubleTapScale?: number;
  doubleTapInterval?: number;
  maxScale?: number;
  style?: ViewStyle;
  containerDimensions?: { width: number; height: number };
  pinchEnabled?: boolean;
  swipeEnabled?: boolean;
  doubleTapEnabled?: boolean;
  disableTransitionOnScaledImage?: boolean;
  hideAdjacentImagesOnScaledImage?: boolean;
  disableVerticalSwipe?: boolean;
  disableSwipeUp?: boolean;
  loop?: boolean;
  onScaleChange?: (scale: number) => void;
  onScaleChangeRange?: { start: number; end: number };
}

export interface Vector {
  x: SharedValue<number>;
  y: SharedValue<number>;
}

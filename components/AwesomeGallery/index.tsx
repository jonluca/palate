/* eslint react-compiler/react-compiler: 0 */

import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StyleSheet, useWindowDimensions } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { RTL, SPACE_BETWEEN_IMAGES, DOUBLE_TAP_SCALE, MAX_SCALE, TIMING_CONFIG } from "./constants";
import { ResizableImage, DefaultImage } from "./components";
import type { GalleryProps, GalleryReactRef, ItemRef, RenderItem } from "./types";

export type { RenderItemInfo } from "./types";

const GalleryComponent = <T = string,>(
  {
    data,
    renderItem = DefaultImage as RenderItem<T>,
    initialIndex = 0,
    numToRender = 5,
    emptySpaceWidth = SPACE_BETWEEN_IMAGES,
    doubleTapScale = DOUBLE_TAP_SCALE,
    doubleTapInterval = 500,
    maxScale = MAX_SCALE,
    pinchEnabled = true,
    swipeEnabled = true,
    doubleTapEnabled = true,
    disableTransitionOnScaledImage = false,
    hideAdjacentImagesOnScaledImage = false,
    onIndexChange,
    style,
    containerDimensions,
    disableVerticalSwipe = false,
    disableSwipeUp = false,
    loop = false,
    onScaleChange,
    onScaleChangeRange,
    ...eventsCallbacks
  }: GalleryProps<T>,
  ref: GalleryReactRef,
) => {
  "use no memo"; // opts out this component from being compiled by React Compiler
  const windowDimensions = useWindowDimensions();
  const dimensions = containerDimensions || windowDimensions;

  const isLoop = loop && data?.length > 1;

  const [index, setIndex] = useState(initialIndex);

  const refs = useRef<ItemRef[]>([]);

  const setRef = useCallback((itemIndex: number, value: ItemRef) => {
    refs.current[itemIndex] = value;
  }, []);

  const translateX = useSharedValue(initialIndex * -(dimensions.width + emptySpaceWidth));

  const currentIndex = useSharedValue(initialIndex);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: RTL ? -translateX.value : translateX.value }],
  }));

  const changeIndex = useCallback(
    (newIndex: number) => {
      onIndexChange?.(newIndex);
      setIndex(newIndex);
    },
    [onIndexChange, setIndex],
  );

  useAnimatedReaction(
    () => currentIndex.value,
    (newIndex) => runOnJS(changeIndex)(newIndex),
    [currentIndex, changeIndex],
  );

  useEffect(() => {
    translateX.value = index * -(dimensions.width + emptySpaceWidth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimensions.width]);

  useImperativeHandle(ref, () => ({
    setIndex(newIndex: number, animated?: boolean) {
      refs.current?.[index].reset(false);
      setIndex(newIndex);
      currentIndex.value = newIndex;
      if (animated) {
        translateX.value = withTiming(newIndex * -(dimensions.width + emptySpaceWidth), TIMING_CONFIG);
      } else {
        translateX.value = newIndex * -(dimensions.width + emptySpaceWidth);
      }
    },
    reset(animated = false) {
      refs.current?.forEach((itemRef) => itemRef.reset(animated));
    },
  }));

  useEffect(() => {
    if (index >= data.length) {
      const newIndex = data.length - 1;
      setIndex(newIndex);
      currentIndex.value = newIndex;
      translateX.value = newIndex * -(dimensions.width + emptySpaceWidth);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, data?.length, dimensions.width]);

  return (
    <GestureHandlerRootView style={[styles.container, style]}>
      <Animated.View style={[styles.rowContainer, animatedStyle]}>
        {data.map((item: T, i) => {
          const isFirst = i === 0;

          const outOfLoopRenderRange =
            !isLoop ||
            (Math.abs(i - index) < data.length - (numToRender - 1) / 2 && Math.abs(i - index) > (numToRender - 1) / 2);

          const hidden = Math.abs(i - index) > (numToRender - 1) / 2 && outOfLoopRenderRange;

          if (hidden) {
            return null;
          }

          return (
            <ResizableImage<T>
              key={i}
              translateX={translateX}
              item={item}
              currentIndex={currentIndex}
              index={i}
              isFirst={isFirst}
              isLast={i === data.length - 1}
              length={data.length}
              renderItem={renderItem}
              emptySpaceWidth={emptySpaceWidth}
              doubleTapScale={doubleTapScale}
              doubleTapInterval={doubleTapInterval}
              maxScale={maxScale}
              pinchEnabled={pinchEnabled}
              swipeEnabled={swipeEnabled}
              doubleTapEnabled={doubleTapEnabled}
              disableTransitionOnScaledImage={disableTransitionOnScaledImage}
              hideAdjacentImagesOnScaledImage={hideAdjacentImagesOnScaledImage}
              disableVerticalSwipe={disableVerticalSwipe}
              disableSwipeUp={disableSwipeUp}
              loop={isLoop}
              onScaleChange={onScaleChange}
              onScaleChangeRange={onScaleChangeRange}
              setRef={setRef}
              width={dimensions.width}
              height={dimensions.height}
              {...eventsCallbacks}
            />
          );
        })}
      </Animated.View>
    </GestureHandlerRootView>
  );
};

export const Gallery = React.forwardRef(GalleryComponent) as <T = string>(
  p: GalleryProps<T> & { ref?: GalleryReactRef },
) => React.ReactElement;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "black" },
  rowContainer: { flex: 1 },
});

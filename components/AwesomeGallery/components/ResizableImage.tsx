/* eslint react-compiler/react-compiler: 0 */

import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDecay,
  withTiming,
} from "react-native-reanimated";
import { clamp, snapPoint, withDecaySpring, withRubberBandClamp, resizeImage } from "../utils";
import { useVector } from "../hooks";
import { RTL, TIMING_CONFIG } from "../constants";
import type { ResizableImageProps, RenderItemInfo } from "../types";

export const ResizableImage = <T = string,>({
  item,
  translateX,
  index,
  isFirst,
  isLast,
  currentIndex,
  renderItem,
  width,
  height,
  onSwipeToClose,
  onTap,
  onDoubleTap,
  onLongPress,
  onPanStart,
  onScaleStart,
  onScaleEnd,
  emptySpaceWidth,
  doubleTapScale,
  doubleTapInterval,
  maxScale,
  pinchEnabled,
  swipeEnabled,
  doubleTapEnabled,
  disableTransitionOnScaledImage,
  hideAdjacentImagesOnScaledImage,
  disableVerticalSwipe,
  disableSwipeUp,
  loop,
  length,
  onScaleChange,
  onScaleChangeRange,
  onTranslationYChange,
  setRef,
}: ResizableImageProps<T>) => {
  const CENTER = {
    x: width / 2,
    y: height / 2,
  };

  const offset = useVector(0, 0);
  const scale = useSharedValue(1);
  const translation = useVector(0, 0);
  const origin = useVector(0, 0);
  const adjustedFocal = useVector(0, 0);
  const originalLayout = useVector(width, 0);
  const layout = useVector(width, 0);

  const isActive = useDerivedValue(() => currentIndex.value === index, [currentIndex, index]);

  useAnimatedReaction(
    () => scale.value,
    (scaleReaction) => {
      if (!onScaleChange) {
        return;
      }

      if (!onScaleChangeRange) {
        runOnJS(onScaleChange)(scaleReaction);
        return;
      }

      if (scaleReaction > onScaleChangeRange.start && scaleReaction < onScaleChangeRange.end) {
        runOnJS(onScaleChange)(scaleReaction);
      }
    },
  );

  const setAdjustedFocal = ({ focalX, focalY }: Record<"focalX" | "focalY", number>) => {
    "worklet";
    adjustedFocal.x.value = focalX - (CENTER.x + offset.x.value);
    adjustedFocal.y.value = focalY - (CENTER.y + offset.y.value);
  };

  const resetValues = (animated = true) => {
    "worklet";

    const resetProperty = (prop: SharedValue<number>, target: number) => {
      if (prop.value !== target) {
        prop.value = animated ? withTiming(target) : target;
      }
    };

    resetProperty(scale, 1);
    resetProperty(offset.x, 0);
    resetProperty(offset.y, 0);
    resetProperty(translation.x, 0);
    resetProperty(translation.y, 0);
  };

  const getEdgeX = () => {
    "worklet";
    const newWidth = scale.value * layout.x.value;
    const point = (newWidth - width) / 2;

    if (point < 0 || isNaN(point)) {
      return [-0, 0];
    }

    return [-point, point];
  };

  const clampY = (value: number, newScale: number) => {
    "worklet";
    const newHeight = newScale * layout.y.value;
    const point = (newHeight - height) / 2;

    if (newHeight < height) {
      return 0;
    }
    return clamp(value, -point, point);
  };

  const clampX = (value: number, newScale: number) => {
    "worklet";
    const newWidth = newScale * layout.x.value;
    const point = (newWidth - width) / 2;

    if (newWidth < width) {
      return 0;
    }
    return clamp(value, -point, point);
  };

  const getEdgeY = () => {
    "worklet";
    const newHeight = scale.value * layout.y.value;
    const point = (newHeight - height) / 2;

    if (isNaN(point)) {
      return [-0, 0];
    }

    return [-point, point];
  };

  const onStart = () => {
    "worklet";

    cancelAnimation(translateX);

    offset.x.value = offset.x.value + translation.x.value;
    offset.y.value = offset.y.value + translation.y.value;

    translation.x.value = 0;
    translation.y.value = 0;
  };

  const getPosition = (i?: number) => {
    "worklet";
    return -(width + emptySpaceWidth) * (typeof i !== "undefined" ? i : index);
  };

  const getIndexFromPosition = (position: number) => {
    "worklet";
    return Math.round(position / -(width + emptySpaceWidth));
  };

  useAnimatedReaction(
    () => ({
      i: currentIndex.value,
      translateX: translateX.value,
      currentScale: scale.value,
    }),
    ({ i, translateX: tx, currentScale }) => {
      const translateIndex = tx / -(width + emptySpaceWidth);
      if (loop) {
        let diff = Math.abs((translateIndex % 1) - 0.5);
        if (diff > 0.5) {
          diff = 1 - diff;
        }
        if (diff > 0.48 && Math.abs(i) !== index) {
          resetValues(false);
          return;
        }
      }
      if (Math.abs(i - index) === 2 && currentScale > 1) {
        resetValues(false);
      }
    },
  );

  useEffect(() => {
    setRef(index, {
      reset: (animated: boolean) => resetValues(animated),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const setImageDimensions: RenderItemInfo<T>["setImageDimensions"] = ({ width: w, height: h }) => {
    originalLayout.x.value = w;
    originalLayout.y.value = h;

    const imgLayout = resizeImage({ width: w, height: h }, { width, height });
    layout.x.value = imgLayout.width;
    layout.y.value = imgLayout.height;
  };

  useEffect(() => {
    if (originalLayout.x.value === 0 && originalLayout.y.value === 0) {
      return;
    }
    setImageDimensions({
      width: originalLayout.x.value,
      height: originalLayout.y.value,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  const itemProps: RenderItemInfo<T> = {
    item,
    index,
    setImageDimensions,
  };

  const scaleOffset = useSharedValue(1);

  // Pinch Gesture
  const pinchGesture = Gesture.Pinch()
    .enabled(pinchEnabled)
    .onStart(({ focalX, focalY }) => {
      "worklet";
      if (!isActive.value) {
        return;
      }
      if (onScaleStart) {
        runOnJS(onScaleStart)(scale.value);
      }

      onStart();
      scaleOffset.value = scale.value;
      setAdjustedFocal({ focalX, focalY });
      origin.x.value = adjustedFocal.x.value;
      origin.y.value = adjustedFocal.y.value;
    })
    .onUpdate(({ scale: s, numberOfPointers }) => {
      "worklet";
      if (!isActive.value) {
        return;
      }
      if (numberOfPointers !== 2) {
        return;
      }

      const nextScale = withRubberBandClamp(s * scaleOffset.value, 0.55, maxScale, [1, maxScale]);

      scale.value = nextScale;

      translation.x.value = adjustedFocal.x.value + ((-1 * nextScale) / scaleOffset.value) * origin.x.value;
      translation.y.value = adjustedFocal.y.value + ((-1 * nextScale) / scaleOffset.value) * origin.y.value;
    })
    .onEnd(() => {
      "worklet";
      if (!isActive.value) {
        return;
      }
      if (onScaleEnd) {
        runOnJS(onScaleEnd)(scale.value);
      }
      if (scale.value < 1) {
        resetValues();
      } else {
        const sc = Math.min(scale.value, maxScale);

        const newWidth = sc * layout.x.value;
        const newHeight = sc * layout.y.value;

        const nextTransX =
          scale.value > maxScale
            ? adjustedFocal.x.value + ((-1 * maxScale) / scaleOffset.value) * origin.x.value
            : translation.x.value;

        const nextTransY =
          scale.value > maxScale
            ? adjustedFocal.y.value + ((-1 * maxScale) / scaleOffset.value) * origin.y.value
            : translation.y.value;

        const diffX = nextTransX + offset.x.value - (newWidth - width) / 2;

        if (scale.value > maxScale) {
          scale.value = withTiming(maxScale);
        }

        if (newWidth <= width) {
          translation.x.value = withTiming(0);
        } else {
          let moved;
          if (diffX > 0) {
            translation.x.value = withTiming(nextTransX - diffX);
            moved = true;
          }

          if (newWidth + diffX < width) {
            translation.x.value = withTiming(nextTransX + width - (newWidth + diffX));
            moved = true;
          }
          if (!moved) {
            translation.x.value = withTiming(nextTransX);
          }
        }

        const diffY = nextTransY + offset.y.value - (newHeight - height) / 2;

        if (newHeight <= height) {
          translation.y.value = withTiming(-offset.y.value);
        } else {
          let moved;
          if (diffY > 0) {
            translation.y.value = withTiming(nextTransY - diffY);
            moved = true;
          }

          if (newHeight + diffY < height) {
            translation.y.value = withTiming(nextTransY + height - (newHeight + diffY));
            moved = true;
          }
          if (!moved) {
            translation.y.value = withTiming(nextTransY);
          }
        }
      }
    });

  const isVertical = useSharedValue(false);
  const initialTranslateX = useSharedValue(0);
  const shouldClose = useSharedValue(false);
  const isMoving = useVector(0);

  useAnimatedReaction(
    () => {
      if (!onTranslationYChange) {
        return null;
      }
      return translation.y.value;
    },
    (ty, prevTy) => {
      if (ty === null || (!ty && !prevTy)) {
        return;
      }
      if (onTranslationYChange) {
        onTranslationYChange(Math.abs(ty), shouldClose.value);
      }
    },
  );

  // Pan Gesture
  const panGesture = Gesture.Pan()
    .enabled(swipeEnabled)
    .minDistance(10)
    .maxPointers(1)
    .onBegin(() => {
      "worklet";
      if (!isActive.value) {
        return;
      }
      const newWidth = scale.value * layout.x.value;
      const newHeight = scale.value * layout.y.value;
      if (
        isMoving.x.value &&
        offset.x.value < (newWidth - width) / 2 - translation.x.value &&
        offset.x.value > -(newWidth - width) / 2 - translation.x.value
      ) {
        cancelAnimation(offset.x);
      }

      if (
        isMoving.y.value &&
        offset.y.value < (newHeight - height) / 2 - translation.y.value &&
        offset.y.value > -(newHeight - height) / 2 - translation.y.value
      ) {
        cancelAnimation(offset.y);
      }
    })
    .onStart(({ velocityY, velocityX }) => {
      "worklet";
      if (!isActive.value) {
        return;
      }

      if (onPanStart) {
        runOnJS(onPanStart)();
      }

      onStart();
      isVertical.value = Math.abs(velocityY) > Math.abs(velocityX);
      initialTranslateX.value = translateX.value;
    })
    .onUpdate(({ translationX, translationY, velocityY }) => {
      "worklet";
      if (!isActive.value) {
        return;
      }
      if (disableVerticalSwipe && scale.value === 1 && isVertical.value) {
        return;
      }

      const x = getEdgeX();

      if (!isVertical.value || scale.value > 1) {
        const clampedX = clamp(translationX, x[0] - offset.x.value, x[1] - offset.x.value);

        const transX = RTL
          ? initialTranslateX.value - translationX + clampedX
          : initialTranslateX.value + translationX - clampedX;

        if (hideAdjacentImagesOnScaledImage && disableTransitionOnScaledImage) {
          const disabledTransition = disableTransitionOnScaledImage && scale.value > 1;

          const moveX = withRubberBandClamp(
            transX,
            0.55,
            width,
            disabledTransition ? [getPosition(index), getPosition(index + 1)] : [getPosition(length - 1), 0],
          );

          if (!disabledTransition) {
            translateX.value = moveX;
          }
          if (disabledTransition) {
            translation.x.value = RTL ? clampedX - moveX + translateX.value : clampedX + moveX - translateX.value;
          } else {
            translation.x.value = clampedX;
          }
        } else {
          if (loop) {
            translateX.value = transX;
          } else {
            translateX.value = withRubberBandClamp(
              transX,
              0.55,
              width,
              disableTransitionOnScaledImage && scale.value > 1
                ? [getPosition(index), getPosition(index + 1)]
                : [getPosition(length - 1), 0],
            );
          }
          translation.x.value = clampedX;
        }
      }

      const newHeight = scale.value * layout.y.value;
      const edgeY = getEdgeY();

      if (newHeight > height) {
        translation.y.value = withRubberBandClamp(translationY, 0.55, newHeight, [
          edgeY[0] - offset.y.value,
          edgeY[1] - offset.y.value,
        ]);
      } else if (!(scale.value === 1 && translateX.value !== getPosition()) && (!disableSwipeUp || translationY >= 0)) {
        translation.y.value = translationY;
      }

      if (isVertical.value && newHeight <= height) {
        const destY = translationY + velocityY * 0.2;
        shouldClose.value = disableSwipeUp ? destY > 220 : Math.abs(destY) > 220;
      }
    })
    .onEnd(({ velocityX, velocityY }) => {
      "worklet";
      if (!isActive.value) {
        return;
      }

      const newHeight = scale.value * layout.y.value;
      const edgeX = getEdgeX();

      if (
        Math.abs(translateX.value - getPosition()) >= 0 &&
        edgeX.some((x) => x === translation.x.value + offset.x.value)
      ) {
        let snapPoints = [index - 1, index, index + 1]
          .filter((_, y) => {
            if (loop) {
              return true;
            }
            if (y === 0) {
              return !isFirst;
            }
            if (y === 2) {
              return !isLast;
            }
            return true;
          })
          .map((i) => getPosition(i));

        if (disableTransitionOnScaledImage && scale.value > 1) {
          snapPoints = [getPosition(index)];
        }

        let snapTo = snapPoint(translateX.value, RTL ? -velocityX : velocityX, snapPoints);

        const nextIndex = getIndexFromPosition(snapTo);

        if (currentIndex.value !== nextIndex) {
          if (loop) {
            if (nextIndex === length) {
              currentIndex.value = 0;
              translateX.value = translateX.value - getPosition(length);
              snapTo = 0;
            } else if (nextIndex === -1) {
              currentIndex.value = length - 1;
              translateX.value = translateX.value + getPosition(length);
              snapTo = getPosition(length - 1);
            } else {
              currentIndex.value = nextIndex;
            }
          } else {
            currentIndex.value = nextIndex;
          }
        }

        translateX.value = withTiming(snapTo, TIMING_CONFIG);
      } else {
        const newWidth = scale.value * layout.x.value;

        isMoving.x.value = 1;
        // @ts-expect-error - the types for withDecaySpring are all funky
        offset.x.value = withDecaySpring(
          {
            velocity: velocityX,
            clamp: [-(newWidth - width) / 2 - translation.x.value, (newWidth - width) / 2 - translation.x.value],
          },
          () => {
            "worklet";
            isMoving.x.value = 0;
          },
        );
      }

      if (onSwipeToClose && shouldClose.value) {
        offset.y.value = withDecay({
          velocity: velocityY,
        });
        runOnJS(onSwipeToClose)();
        return;
      }

      shouldClose.value = false;

      if (newHeight > height) {
        isMoving.y.value = 1;
        // @ts-expect-error - the types for withDecaySpring are all funky
        offset.y.value = withDecaySpring(
          {
            velocity: velocityY,
            clamp: [-(newHeight - height) / 2 - translation.y.value, (newHeight - height) / 2 - translation.y.value],
          },
          () => {
            "worklet";
            isMoving.y.value = 0;
          },
        );
      } else {
        const diffY = translation.y.value + offset.y.value - (newHeight - height) / 2;

        if (newHeight <= height && diffY !== height - diffY - newHeight) {
          const moveTo = diffY - (height - newHeight) / 2;
          translation.y.value = withTiming(translation.y.value - moveTo);
        }
      }
    });

  const interruptedScroll = useSharedValue(false);

  // Tap Gesture
  const tapGesture = Gesture.Tap()
    .enabled(!!onTap)
    .numberOfTaps(1)
    .maxDistance(10)
    .onBegin(() => {
      "worklet";
      if (isMoving.x.value || isMoving.y.value) {
        interruptedScroll.value = true;
      }
    })
    .onEnd(() => {
      "worklet";
      if (!isActive.value) {
        return;
      }
      if (onTap && !interruptedScroll.value) {
        runOnJS(onTap)();
      }
      interruptedScroll.value = false;
    });

  // Double Tap Gesture
  const doubleTapGesture = Gesture.Tap()
    .enabled(doubleTapEnabled)
    .numberOfTaps(2)
    .maxDelay(doubleTapInterval)
    .onEnd(({ x, y, numberOfPointers }) => {
      "worklet";
      if (!isActive.value) {
        return;
      }
      if (numberOfPointers !== 1) {
        return;
      }
      if (onTap && interruptedScroll.value) {
        interruptedScroll.value = false;
        if (onTap) {
          runOnJS(onTap)();
        }
        return;
      }
      if (onDoubleTap) {
        runOnJS(onDoubleTap)(scale.value === 1 ? doubleTapScale : 1);
      }

      if (scale.value === 1) {
        scale.value = withTiming(doubleTapScale);

        setAdjustedFocal({ focalX: x, focalY: y });

        offset.x.value = withTiming(
          clampX(adjustedFocal.x.value + -1 * doubleTapScale * adjustedFocal.x.value, doubleTapScale),
        );
        offset.y.value = withTiming(
          clampY(adjustedFocal.y.value + -1 * doubleTapScale * adjustedFocal.y.value, doubleTapScale),
        );
      } else {
        resetValues();
      }
    });

  // Long Press Gesture
  const longPressGesture = Gesture.LongPress()
    .enabled(!!onLongPress)
    .maxDistance(10)
    .onStart(() => {
      "worklet";
      if (interruptedScroll.value) {
        interruptedScroll.value = false;
        return;
      }
      if (onLongPress) {
        runOnJS(onLongPress)();
      }
    });

  const containerAnimatedStyle = useAnimatedStyle(() => ({
    zIndex: index === currentIndex.value ? 1 : 0,
    transform: [
      {
        translateX: getPosition(RTL ? index : -index),
      },
    ],
  }));

  const animatedStyle = useAnimatedStyle(() => {
    const isNextForLast =
      loop && isFirst && currentIndex.value === length - 1 && translateX.value < getPosition(length - 1);
    const isPrevForFirst = loop && isLast && currentIndex.value === 0 && translateX.value > getPosition(0);
    return {
      transform: [
        {
          translateX:
            offset.x.value +
            translation.x.value -
            (isNextForLast ? getPosition(RTL ? -length : length) : 0) +
            (isPrevForFirst ? getPosition(RTL ? -length : length) : 0),
        },
        { translateY: offset.y.value + translation.y.value },
        { scale: scale.value },
      ],
    };
  });

  return (
    <GestureDetector
      gesture={Gesture.Race(
        Gesture.Simultaneous(longPressGesture, Gesture.Race(panGesture, pinchGesture)),
        Gesture.Exclusive(doubleTapGesture, tapGesture),
      )}
    >
      <Animated.View
        renderToHardwareTextureAndroid
        shouldRasterizeIOS
        style={[styles.itemContainer, { width, height }, containerAnimatedStyle]}
      >
        <Animated.View style={[{ width, height }, animatedStyle]}>{renderItem(itemProps)}</Animated.View>
      </Animated.View>
    </GestureDetector>
  );
};

const styles = StyleSheet.create({
  itemContainer: { position: "absolute" },
});

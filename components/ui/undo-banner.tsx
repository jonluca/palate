import React, { createContext, useContext, useCallback, useState, useRef, useEffect } from "react";
import { View, Pressable } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  runOnJS,
  SlideInDown,
  SlideOutDown,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import * as Haptics from "expo-haptics";

type UndoActionType = "confirm" | "reject";

export interface UndoableAction {
  id: string;
  type: UndoActionType;
  visitId: string;
  message: string;
  /** Callback to execute the undo */
  onUndo: () => Promise<void>;
}

interface UndoContextValue {
  /** Show an undo banner for the given action */
  showUndo: (action: Omit<UndoableAction, "id">) => void;
  /** Clear/hide the current undo banner */
  clearUndo: () => void;
  /** Current undoable action, if any */
  currentAction: UndoableAction | null;
  /** Register a callback to be called when undo completes successfully */
  setOnUndoComplete: (callback: ((visitId: string) => void) | null) => void;
}

const UndoContext = createContext<UndoContextValue | null>(null);

export function useUndo() {
  const context = useContext(UndoContext);
  if (!context) {
    throw new Error("useUndo must be used within an UndoProvider");
  }
  return context;
}

const UNDO_DURATION_MS = 5000; // 5 seconds to undo

function UndoBanner({
  action,
  onUndo,
  onDismiss,
}: {
  action: UndoableAction;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const translateY = useSharedValue(0);
  const progress = useSharedValue(1);
  const SWIPE_THRESHOLD = 20; // Lower threshold for easier dismissal
  const VELOCITY_THRESHOLD = 300; // Dismiss if swiping fast enough

  useEffect(() => {
    // Animate the progress bar
    progress.value = withTiming(0, { duration: UNDO_DURATION_MS });

    // Auto dismiss after duration
    const timeout = setTimeout(() => {
      onDismiss();
    }, UNDO_DURATION_MS);

    return () => clearTimeout(timeout);
  }, [onDismiss, progress]);

  const panGesture = Gesture.Pan()
    .activeOffsetY([-10, 10]) // Start recognizing after small movement
    .onUpdate((event) => {
      // Allow downward swipe to dismiss
      translateY.value = event.translationY > 0 ? event.translationY : event.translationY * 0.3;
    })
    .onEnd((event) => {
      // Dismiss if dragged past threshold OR if velocity is high enough (quick flick)
      const shouldDismiss = translateY.value > SWIPE_THRESHOLD || event.velocityY > VELOCITY_THRESHOLD;

      if (shouldDismiss) {
        translateY.value = withTiming(200, { duration: 150 }, () => {
          runOnJS(onDismiss)();
        });
      } else {
        translateY.value = withSpring(0, { damping: 20, stiffness: 300 });
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const progressStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  const handleUndo = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onUndo();
  };

  const isConfirm = action.type === "confirm";

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View entering={SlideInDown.duration(200)} exiting={SlideOutDown.duration(200)} style={animatedStyle}>
        <View
          className={"bg-card border border-border rounded-2xl overflow-hidden shadow-lg"}
          style={{ borderCurve: "continuous" }}
        >
          {/* Progress bar */}
          <Animated.View className={"h-1 bg-primary/30"} style={progressStyle} />

          <View className={"px-4 py-3 flex-row items-center gap-3"}>
            {/* Icon */}
            <View
              className={`w-8 h-8 rounded-full items-center justify-center ${isConfirm ? "bg-green-500/15" : "bg-red-500/15"}`}
            >
              <IconSymbol
                name={isConfirm ? "checkmark.circle.fill" : "xmark.circle.fill"}
                size={18}
                color={isConfirm ? "#22c55e" : "#ef4444"}
              />
            </View>

            {/* Message */}
            <ThemedText variant={"subhead"} className={"flex-1"} numberOfLines={1}>
              {action.message}
            </ThemedText>

            {/* Undo button */}
            <Pressable
              onPress={handleUndo}
              className={"bg-primary px-4 py-2 rounded-xl"}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <ThemedText variant={"subhead"} className={"text-primary-foreground font-semibold"}>
                Undo
              </ThemedText>
            </Pressable>
          </View>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

export function UndoProvider({ children }: { children: React.ReactNode }) {
  const [currentAction, setCurrentAction] = useState<UndoableAction | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);
  const idCounter = useRef(0);
  const onUndoCompleteRef = useRef<((visitId: string) => void) | null>(null);
  const insets = useSafeAreaInsets();

  const showUndo = useCallback((action: Omit<UndoableAction, "id">) => {
    const id = `undo-${++idCounter.current}`;
    setCurrentAction({ ...action, id });
  }, []);

  const clearUndo = useCallback(() => {
    setCurrentAction(null);
  }, []);

  const setOnUndoComplete = useCallback((callback: ((visitId: string) => void) | null) => {
    onUndoCompleteRef.current = callback;
  }, []);

  const handleUndo = useCallback(async () => {
    if (!currentAction || isUndoing) {
      return;
    }

    const visitId = currentAction.visitId;
    setIsUndoing(true);
    try {
      await currentAction.onUndo();
      // Call the completion callback after successful undo
      onUndoCompleteRef.current?.(visitId);
    } finally {
      setIsUndoing(false);
      setCurrentAction(null);
    }
  }, [currentAction, isUndoing]);

  return (
    <UndoContext.Provider value={{ showUndo, clearUndo, currentAction, setOnUndoComplete }}>
      {children}
      {currentAction && (
        <View
          className={"absolute bottom-0 left-0 right-0 px-4 z-50"}
          style={{ paddingBottom: insets.bottom }}
          pointerEvents={"box-none"}
        >
          <UndoBanner key={currentAction.id} action={currentAction} onUndo={handleUndo} onDismiss={clearUndo} />
        </View>
      )}
    </UndoContext.Provider>
  );
}

import React, { createContext, useContext, useCallback, useState, useRef, useEffect } from "react";
import { View, Pressable, Dimensions } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  runOnJS,
  SlideInUp,
  SlideOutUp,
  interpolate,
  Extrapolation,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import * as Haptics from "expo-haptics";

type ToastType = "success" | "error" | "info" | "warning";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
  action?: {
    label: string;
    onPress: () => void;
  };
}

interface ToastContextValue {
  showToast: (toast: Omit<Toast, "id">) => void;
  hideToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

const toastConfig: Record<ToastType, { icon: string; bg: string; iconColor: string }> = {
  success: { icon: "checkmark.circle.fill", bg: "bg-green-500/95", iconColor: "#fff" },
  error: { icon: "xmark.circle.fill", bg: "bg-red-500/95", iconColor: "#fff" },
  info: { icon: "info.circle.fill", bg: "bg-blue-500/95", iconColor: "#fff" },
  warning: { icon: "exclamationmark.triangle.fill", bg: "bg-amber-500/95", iconColor: "#fff" },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const insets = useSafeAreaInsets();
  const config = toastConfig[toast.type];
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const { width } = Dimensions.get("window");
  const SWIPE_THRESHOLD = 80;

  useEffect(() => {
    const timeout = setTimeout(() => {
      onDismiss();
    }, toast.duration ?? 3000);

    return () => clearTimeout(timeout);
  }, [toast.duration, onDismiss]);

  const panGesture = Gesture.Pan()
    .onUpdate((event) => {
      // Allow horizontal swipe in either direction
      translateX.value = event.translationX;
      // Allow upward swipe (negative Y) with resistance for downward
      translateY.value = event.translationY < 0 ? event.translationY : event.translationY * 0.3;
    })
    .onEnd(() => {
      const shouldDismissHorizontally = Math.abs(translateX.value) > SWIPE_THRESHOLD;
      const shouldDismissUp = translateY.value < -SWIPE_THRESHOLD;

      if (shouldDismissHorizontally) {
        // Swipe out horizontally
        const direction = translateX.value > 0 ? 1 : -1;
        translateX.value = withTiming(direction * width, { duration: 200 }, () => {
          runOnJS(onDismiss)();
        });
      } else if (shouldDismissUp) {
        // Swipe up to dismiss
        translateY.value = withTiming(-200, { duration: 200 }, () => {
          runOnJS(onDismiss)();
        });
      } else {
        // Spring back
        translateX.value = withSpring(0, { damping: 20, stiffness: 300 });
        translateY.value = withSpring(0, { damping: 20, stiffness: 300 });
      }
    });

  const tapGesture = Gesture.Tap().onEnd(() => {
    runOnJS(onDismiss)();
  });

  const composedGesture = Gesture.Race(panGesture, tapGesture);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }],
    opacity: interpolate(
      Math.max(Math.abs(translateX.value), Math.abs(translateY.value)),
      [0, SWIPE_THRESHOLD, SWIPE_THRESHOLD * 2],
      [1, 0.8, 0.5],
      Extrapolation.CLAMP,
    ),
  }));

  return (
    <GestureDetector gesture={composedGesture}>
      <Animated.View
        entering={SlideInUp.duration(200)}
        exiting={SlideOutUp.duration(200)}
        style={[animatedStyle, { marginTop: insets.top + 8 }]}
        className={"mx-4"}
      >
        <View
          className={`${config.bg} rounded-2xl px-4 py-3 flex-row items-center gap-3 shadow-lg`}
          style={{ borderCurve: "continuous" }}
        >
          <IconSymbol name={config.icon as never} size={24} color={config.iconColor} />
          <ThemedText variant={"subhead"} className={"flex-1 text-white font-medium"}>
            {toast.message}
          </ThemedText>
          {toast.action && (
            <Pressable
              onPress={() => {
                toast.action?.onPress();
                onDismiss();
              }}
              className={"bg-white/20 px-3 py-1.5 rounded-lg"}
            >
              <ThemedText variant={"caption1"} className={"text-white font-semibold"}>
                {toast.action.label}
              </ThemedText>
            </Pressable>
          )}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idCounter = useRef(0);

  const showToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = `toast-${++idCounter.current}`;
    setToasts((prev) => [...prev, { ...toast, id }]);

    // Haptic feedback based on type
    if (toast.type === "success") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (toast.type === "error") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, []);

  const hideToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, hideToast }}>
      {children}
      <View className={"absolute top-0 left-0 right-0 z-50"} pointerEvents={"box-none"}>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => hideToast(toast.id)} />
        ))}
      </View>
    </ToastContext.Provider>
  );
}

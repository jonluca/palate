import { useCallback } from "react";
import * as Burnt from "burnt";
import * as Haptics from "expo-haptics";

type ToastType = "success" | "error" | "info" | "warning";

interface ToastOptions {
  message: string;
  type: ToastType;
  duration?: number;
  action?: {
    label: string;
    onPress: () => void;
  };
}

interface ToastContextValue {
  showToast: (toast: ToastOptions) => void;
  hideToast: (id: string) => void;
}

/**
 * Hook to show native iOS HUD-style toasts using burnt.
 * This provides a cleaner, more native experience than custom toast implementations.
 */
export function useToast(): ToastContextValue {
  const showToast = useCallback(({ message, type, duration = 3 }: ToastOptions) => {
    // Trigger haptic feedback based on type
    if (type === "success") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (type === "error") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    // Map toast type to burnt preset
    const preset = type === "error" ? "error" : type === "success" ? "done" : "none";

    // Show the native toast
    Burnt.toast({
      title: message,
      preset,
      duration,
      haptic: "none", // We handle haptics manually above for more control
    });
  }, []);

  // hideToast is a no-op with burnt since toasts auto-dismiss
  const hideToast = useCallback((_id: string) => {
    // burnt toasts auto-dismiss, so this is a no-op
    // Kept for API compatibility with existing code
  }, []);

  return { showToast, hideToast };
}

/**
 * ToastProvider is no longer needed with burnt since it uses native iOS HUD.
 * This is kept for backward compatibility - it just renders children.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  return children;
}

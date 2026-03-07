import * as AppleAuthentication from "expo-apple-authentication";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { getAppleSignInErrorMessage, isAppleSignInCanceled, signInWithApple } from "@/lib/auth-client";

interface UseAppleSignInOptions {
  onSuccess?: () => void;
  unavailableMessage?: string;
}

export function useAppleSignIn({
  onSuccess,
  unavailableMessage = "Apple sign-in is only available in an Apple build of Palate on a supported device.",
}: UseAppleSignInOptions = {}) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [isSigningIn, setIsSigningIn] = useState(false);

  const triggerAppleSignIn = useCallback(async () => {
    if (isSigningIn) {
      return false;
    }

    setIsSigningIn(true);

    try {
      const isAvailable = await AppleAuthentication.isAvailableAsync();

      if (!isAvailable) {
        showToast({ type: "error", message: unavailableMessage });
        return false;
      }

      const result = await signInWithApple();

      if (result.error) {
        showToast({ type: "error", message: getAppleSignInErrorMessage(result.error) });
        return false;
      }

      await queryClient.invalidateQueries({ queryKey: ["cloud"] });
      onSuccess?.();
      return true;
    } catch (error) {
      if (!isAppleSignInCanceled(error)) {
        showToast({ type: "error", message: getAppleSignInErrorMessage(error) });
      }

      return false;
    } finally {
      setIsSigningIn(false);
    }
  }, [isSigningIn, onSuccess, queryClient, showToast, unavailableMessage]);

  return {
    isSigningIn,
    triggerAppleSignIn,
  };
}

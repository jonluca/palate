import React from "react";
import { useAppleSignIn } from "@/hooks";
import { Button, ButtonText } from "@/components/ui";

type AppleSignInButtonProps = Omit<React.ComponentProps<typeof Button>, "children" | "loading" | "onPress"> & {
  label?: string;
  onSuccess?: () => void;
};

export function AppleSignInButton({
  label = "Continue with Apple",
  onSuccess,
  variant,
  size,
  ...props
}: AppleSignInButtonProps) {
  const resolvedVariant = variant ?? "default";
  const { isSigningIn, triggerAppleSignIn } = useAppleSignIn({ onSuccess });

  return (
    <Button
      {...props}
      variant={resolvedVariant}
      size={size}
      onPress={() => {
        void triggerAppleSignIn();
      }}
      loading={isSigningIn}
    >
      <ButtonText variant={resolvedVariant} size={size}>
        {label}
      </ButtonText>
    </Button>
  );
}

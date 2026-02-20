import { cn } from "@/utils/cn";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Text as RNText } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";

const textVariants = cva("text-foreground", {
  variants: {
    variant: {
      largeTitle: "text-[34px] leading-10 font-sans",
      title1: "text-[28px] leading-8 font-sans",
      title2: "text-[22px] leading-7 font-sans",
      title3: "text-[20px] leading-6 font-sans",
      title4: "text-[18px] leading-5 font-sans",
      heading: "text-[17px] leading-6 font-semibold font-sans",
      body: "text-[17px] leading-6 font-sans",
      callout: "text-[16px] leading-5 font-sans",
      subhead: "text-[15px] leading-5 font-sans",
      footnote: "text-[13px] leading-4 font-sans",
      caption1: "text-[12px] leading-4 font-sans",
      caption2: "text-[11px] leading-4 font-sans",
    },
    color: {
      primary: "",
      secondary: "text-secondary-foreground/85",
      tertiary: "text-muted-foreground",
      quarternary: "text-muted-foreground/70",
    },
    invert: {
      true: "text-background dark:text-background",
      false: "",
    },
  },
  defaultVariants: {
    variant: "body",
    color: "primary",
    invert: false,
  },
});

const TextClassContext = React.createContext<string | undefined>(undefined);

function ThemedText({
  className,
  variant,
  color,
  invert,
  animated,
  ...props
}: React.ComponentProps<typeof RNText> & VariantProps<typeof textVariants> & { animated?: boolean }) {
  const textClassName = React.useContext(TextClassContext);

  const Comp = animated ? Animated.Text : RNText;

  const classNames = cn(textVariants({ variant, color, invert }), textClassName, className);
  return (
    <Comp className={classNames} layout={animated ? LinearTransition : undefined} allowFontScaling={false} {...props} />
  );
}

export { ThemedText };

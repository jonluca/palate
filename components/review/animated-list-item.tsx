import Animated, { FadeOut, LinearTransition } from "react-native-reanimated";

interface AnimatedListItemProps {
  children: React.ReactNode;
  itemKey: string;
}

/** Animated wrapper for list items with exit and layout transitions */
export function AnimatedListItem({ children, itemKey }: AnimatedListItemProps) {
  return (
    <Animated.View key={itemKey} exiting={FadeOut.duration(100)} layout={LinearTransition.duration(200)}>
      {children}
    </Animated.View>
  );
}

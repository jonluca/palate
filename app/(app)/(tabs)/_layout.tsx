import { NativeTabs, Icon, Label, VectorIcon } from "expo-router/unstable-native-tabs";
import React, { useEffect, useRef } from "react";
import { Platform } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { usePathname } from "expo-router";
import { queryClient } from "@/app/_layout";

export default function TabLayout() {
  const pathname = usePathname();
  const isInitialMount = useRef(true);

  useEffect(() => {
    // Skip the initial mount to avoid unnecessary refetch on app start
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    // Refetch all active queries when tab changes
    queryClient.refetchQueries({ type: "active" });
  }, [pathname]);

  return (
    <NativeTabs minimizeBehavior={"onScrollDown"} tintColor={"#f97316"} backgroundColor={"transparent"}>
      <NativeTabs.Trigger name={"index"}>
        <Label>Restaurants</Label>
        {Platform.select({
          ios: <Icon sf={"fork.knife"} />,
          android: <Icon src={<VectorIcon family={MaterialIcons} name={"restaurant"} />} />,
        })}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name={"review"}>
        <Label>Review</Label>
        {Platform.select({
          ios: <Icon sf={"checkmark.circle"} />,
          android: <Icon src={<VectorIcon family={MaterialIcons} name={"check-circle"} />} />,
        })}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name={"visits"}>
        <Label>All Visits</Label>
        {Platform.select({
          ios: <Icon sf={"photo.stack"} />,
          android: <Icon src={<VectorIcon family={MaterialIcons} name={"photo-library"} />} />,
        })}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name={"settings"}>
        <Label>Settings</Label>
        {Platform.select({
          ios: <Icon sf={"gearshape"} />,
          android: <Icon src={<VectorIcon family={MaterialIcons} name={"settings"} />} />,
        })}
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

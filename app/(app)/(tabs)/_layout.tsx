import { NativeTabs } from "expo-router/unstable-native-tabs";
import React, { useEffect, useRef } from "react";
import { Platform } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { usePathname } from "expo-router";
import { queryClient } from "@/app/_layout";
import { useSession } from "@/lib/auth-client";

export default function TabLayout() {
  const pathname = usePathname();
  const isInitialMount = useRef(true);
  const tabTintColor = "#0A84FF";
  const { data: session } = useSession();
  const isSignedIn = Boolean(session?.user);
  const restaurantsTabLabel = "Restaurants";
  const reviewTabLabel = "Review";
  const statsTabLabel = "Stats";
  const feedTabLabel = "Feed";
  const settingsTabLabel = isSignedIn ? "Profile" : "Settings";

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
    <NativeTabs minimizeBehavior={"onScrollDown"} tintColor={tabTintColor} backgroundColor={"transparent"}>
      <NativeTabs.Trigger name={"index"}>
        <NativeTabs.Trigger.Label>{restaurantsTabLabel}</NativeTabs.Trigger.Label>
        {Platform.select({
          ios: <NativeTabs.Trigger.Icon sf={{ default: "fork.knife", selected: "fork.knife" }} />,
          android: (
            <NativeTabs.Trigger.Icon
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"restaurant"} />}
            />
          ),
        })}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name={"review"}>
        <NativeTabs.Trigger.Label>{reviewTabLabel}</NativeTabs.Trigger.Label>
        {Platform.select({
          ios: <NativeTabs.Trigger.Icon sf={{ default: "checkmark.circle", selected: "checkmark.circle.fill" }} />,
          android: (
            <NativeTabs.Trigger.Icon
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"check-circle"} />}
            />
          ),
        })}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name={"stats"}>
        <NativeTabs.Trigger.Label>{statsTabLabel}</NativeTabs.Trigger.Label>
        {Platform.select({
          ios: <NativeTabs.Trigger.Icon sf={{ default: "chart.bar", selected: "chart.bar.fill" }} />,
          android: (
            <NativeTabs.Trigger.Icon
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"bar-chart"} />}
            />
          ),
        })}
      </NativeTabs.Trigger>

      {isSignedIn ? (
        <NativeTabs.Trigger name={"feed"}>
          <NativeTabs.Trigger.Label>{feedTabLabel}</NativeTabs.Trigger.Label>
          {Platform.select({
            ios: (
              <NativeTabs.Trigger.Icon
                sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }}
              />
            ),
            android: (
              <NativeTabs.Trigger.Icon
                src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"dynamic-feed"} />}
              />
            ),
          })}
        </NativeTabs.Trigger>
      ) : null}

      <NativeTabs.Trigger name={"settings"}>
        <NativeTabs.Trigger.Label>{settingsTabLabel}</NativeTabs.Trigger.Label>
        {Platform.select({
          ios: (
            <NativeTabs.Trigger.Icon
              sf={
                isSignedIn
                  ? { default: "person.crop.circle", selected: "person.crop.circle.fill" }
                  : { default: "gearshape", selected: "gearshape.fill" }
              }
            />
          ),
          android: (
            <NativeTabs.Trigger.Icon
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={isSignedIn ? "person" : "settings"} />}
            />
          ),
        })}
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

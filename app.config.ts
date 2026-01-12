import type { ConfigContext, ExpoConfig } from "expo/config";

const getConfig = ({ config }: ConfigContext): ExpoConfig => {
  return {
    ...config,
    name: "PhotoFoodie",
    slug: "photos-organizer",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/images/icon.jpeg",
    scheme: "photorestaurantmatcher",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    ios: {
      ...config.ios,
      supportsTablet: true,
      bundleIdentifier: "com.jonluca.photo-restaurant-matcher",
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSPhotoLibraryUsageDescription:
          "This app needs access to your photo library to scan photos and match them to restaurant visits.",
      },
      appleTeamId: "F35YQQ5672",
      entitlements: {
        ...config.ios?.entitlements,
        "com.apple.developer.kernel.increased-memory-limit": true,
        "com.apple.developer.kernel.extended-virtual-addressing": true,
      },
      privacyManifests: {
        NSPrivacyCollectedDataTypes: [
          {
            NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeCrashData",
            NSPrivacyCollectedDataTypeLinked: false,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
          },
          {
            NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypePerformanceData",
            NSPrivacyCollectedDataTypeLinked: false,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
          },
          {
            NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeOtherDiagnosticData",
            NSPrivacyCollectedDataTypeLinked: false,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
          },
        ],
        NSPrivacyAccessedAPITypes: [
          {
            NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
            NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
          },
          {
            NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
            NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
          },
          {
            NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
            NSPrivacyAccessedAPITypeReasons: ["C617.1"],
          },
          {
            NSPrivacyAccessedAPITypeReasons: ["7D9E.1", "E174.1"],
            NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
          },
        ],
      },
    },
    android: {
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: "com.jonluca.restaurantmatcher",
      permissions: [
        "READ_EXTERNAL_STORAGE",
        "READ_MEDIA_IMAGES",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
        "android.permission.ACCESS_MEDIA_LOCATION",
        "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_MEDIA_VIDEO",
        "android.permission.READ_MEDIA_AUDIO",
      ],
    },
    plugins: [
      ...(config.plugins ?? []),
      "expo-router",
      [
        "expo-splash-screen",
        {
          image: "./assets/images/splash-icon.jpeg",
          imageWidth: 100,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
        },
      ],
      [
        "expo-media-library",
        {
          photosPermission: "Allow $(PRODUCT_NAME) to access your photos to find restaurant visits.",
          savePhotosPermission: false,
          isAccessMediaLocationEnabled: true,
        },
      ],
      "expo-asset",
      [
        "expo-calendar",
        {
          calendarPermission: "The app needs to access your calendar to cross reference with your restaurant visits.",
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      router: {},
      eas: {
        projectId: "d383062e-5837-4c46-bd3a-6a8cfc5358fb",
      },
    },
    owner: "jonluca",
  } satisfies ExpoConfig;
};

export default getConfig;

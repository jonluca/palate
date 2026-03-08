const PRODUCTION_CLOUD_URL = "https://www.getpalate.io";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function getApiBaseUrl() {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

  if (configuredUrl) {
    return trimTrailingSlash(configuredUrl);
  }

  return PRODUCTION_CLOUD_URL;
}

export function getCloudBaseUrl() {
  const configuredUrl = process.env.EXPO_PUBLIC_CLOUD_URL?.trim();

  if (configuredUrl) {
    return trimTrailingSlash(configuredUrl);
  }

  if (__DEV__) {
    return PRODUCTION_CLOUD_URL;
  }

  return getApiBaseUrl();
}

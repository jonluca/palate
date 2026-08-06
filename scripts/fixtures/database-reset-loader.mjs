let coreModuleUrl;
let resetCoreModuleUrl;

const mockSources = new Map([
  [
    "palate-test:expo-sqlite",
    `export const openDatabaseAsync = (...args) =>
      globalThis.__palateDatabaseLifecycleHarness.openDatabaseAsync(...args);`,
  ],
  ["palate-test:restaurants", "export const calculateDistanceMeters = () => 0;"],
  [
    "palate-test:michelin-index",
    `export const invalidateRestaurantIndex = () => {
      globalThis.__palateDatabaseLifecycleHarness.restaurantIndexInvalidationCount += 1;
    };`,
  ],
  [
    "palate-test:provider-spatial",
    `export const ensureMichelinProviderSpatialIndex = async () => {};
     export const invalidateMichelinProviderSpatialIndex = () => {
       globalThis.__palateDatabaseLifecycleHarness.providerIndexInvalidationCount += 1;
     };
     export const rebuildMichelinProviderSpatialIndex = async () => {};
     export const repairMichelinProviderSpatialIndexIfNeeded = async () => {};`,
  ],
  ["palate-test:food-keywords", "export const syncDefaultFoodKeywords = async () => {};"],
]);

export function initialize(data) {
  coreModuleUrl = data.coreModuleUrl;
  resetCoreModuleUrl = data.resetCoreModuleUrl;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "expo-sqlite") {
    return { url: "palate-test:expo-sqlite", shortCircuit: true };
  }
  if (specifier === "@/data/restaurants") {
    return { url: "palate-test:restaurants", shortCircuit: true };
  }
  if (context.parentURL === coreModuleUrl) {
    if (specifier === "./michelin-index") {
      return { url: "palate-test:michelin-index", shortCircuit: true };
    }
    if (specifier === "./michelin-provider-spatial-core") {
      return { url: "palate-test:provider-spatial", shortCircuit: true };
    }
    if (specifier === "./food-keyword-sync-core") {
      return { url: "palate-test:food-keywords", shortCircuit: true };
    }
    if (specifier === "./reset-core") {
      return { url: resetCoreModuleUrl, shortCircuit: true };
    }
    if (specifier === "./automatic-photo-deep-scan-queue-core") {
      return nextResolve("./automatic-photo-deep-scan-queue-core.ts", context);
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const source = mockSources.get(url);
  if (source !== undefined) {
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}

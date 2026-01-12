// Reexport the native module. On web, it will be resolved to IosBatchAssetsInfoModule.web.ts
// and on native platforms to IosBatchAssetsInfoModule.ts
// Note: Native module only available on iOS. Use isBatchAssetInfoAvailable() to check before calling.
export { isBatchAssetInfoAvailable, detectFoodInImageBatch, getAssetInfoBatch } from "./src/index";

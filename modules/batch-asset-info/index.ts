// Reexport the native module. On web, it will be resolved to IosBatchAssetsInfoModule.web.ts
// and on native platforms to IosBatchAssetsInfoModule.ts
// Note: Native module only available on iOS. Use isBatchAssetInfoAvailable() to check before calling.
export {
  beginAssetScan,
  clearPhotoAssetThumbnailCache,
  detectFoodInImageBatch,
  endAssetScan,
  getAssetInfoBatch,
  getAssetScanPage,
  getVisionResultPageSize,
  isAssetScanAvailable,
  isBatchAssetInfoAvailable,
  isPhotoAssetThumbnailAvailable,
  type AssetScanPage,
  type AssetScanPageOptions,
  type AssetScanRecord,
  type AssetScanSession,
  type BatchAssetInfo,
  type FoodDetectionOptions,
  type FoodDetectionResult,
} from "./src/index";

export {
  PhotoAssetThumbnail,
  type PhotoAssetThumbnailErrorEvent,
  type PhotoAssetThumbnailLoadEvent,
  type PhotoAssetThumbnailProps,
} from "./src/PhotoAssetThumbnail";

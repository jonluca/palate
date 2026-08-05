export interface AlbumAssetLike {
  readonly id: string;
}

/** Resolve requested assets exactly once, preserving request order. */
export async function resolveAlbumAssets<T extends AlbumAssetLike>(
  requestedAssetIds: readonly string[],
  listedAssets: readonly T[],
  loadAsset: (assetId: string) => Promise<T | null | undefined>,
): Promise<T[]> {
  const listedAssetsById = new Map(listedAssets.map((asset) => [asset.id, asset]));
  const seenAssetIds = new Set<string>();
  const resolvedAssets: T[] = [];

  for (const assetId of requestedAssetIds) {
    if (seenAssetIds.has(assetId)) {
      continue;
    }
    seenAssetIds.add(assetId);

    let asset = listedAssetsById.get(assetId);
    if (!asset) {
      try {
        const loadedAsset = await loadAsset(assetId);
        asset = loadedAsset?.id === assetId ? loadedAsset : undefined;
      } catch {
        // The asset may have been deleted or access may have been revoked.
      }
    }

    if (asset) {
      resolvedAssets.push(asset);
    }
  }

  return resolvedAssets;
}

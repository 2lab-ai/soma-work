import { assetPath } from '@soma/common/asset-path';
import { ASSET_ROOT } from './asset-root';

export function extensionAssetPath(...segments: string[]): string {
  return assetPath(ASSET_ROOT, ...segments);
}

/** `@delta/core/media` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_DIM,
  ImageError,
  sniffImageMediaType,
  imageDimensions,
  estimateImageTokens,
  prepareImageFromBase64,
  prepareImageFromFile,
  prepareImages,
  normalizeIncomingImages,
  describeImage,
  type PreparedImage,
} from './images.js';

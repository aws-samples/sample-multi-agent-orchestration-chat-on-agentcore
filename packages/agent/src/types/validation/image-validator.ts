/**
 * Server-side image validation for multimodal input
 */

/**
 * Image data for multimodal input
 */
export interface ImageData {
  base64: string;
  mimeType: string;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Server-side image validation configuration
 */
export const IMAGE_VALIDATION_CONFIG = {
  MAX_FILE_SIZE: 5 * 1024 * 1024, // 5MB
  MAX_IMAGES: 4,
  ALLOWED_MIME_TYPES: ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'],
  // Magic numbers for image format verification
  MAGIC_NUMBERS: {
    'image/png': [0x89, 0x50, 0x4e, 0x47],
    'image/jpeg': [0xff, 0xd8, 0xff],
    'image/jpg': [0xff, 0xd8, 0xff],
    'image/gif': [0x47, 0x49, 0x46],
    'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF header
  } as Record<string, number[]>,
};

/**
 * Validate image data on server-side
 * @param images Array of image data to validate
 * @returns Validation result with error message if invalid
 */
export function validateImageData(images: ImageData[]): ValidationResult {
  // Check image count
  if (images.length > IMAGE_VALIDATION_CONFIG.MAX_IMAGES) {
    return {
      valid: false,
      error: `Maximum ${IMAGE_VALIDATION_CONFIG.MAX_IMAGES} images allowed, received ${images.length}`,
    };
  }

  for (let i = 0; i < images.length; i++) {
    const image = images[i];

    // Check MIME type
    if (!IMAGE_VALIDATION_CONFIG.ALLOWED_MIME_TYPES.includes(image.mimeType)) {
      return {
        valid: false,
        error: `Image ${i + 1}: Invalid MIME type '${image.mimeType}'. Allowed types: ${IMAGE_VALIDATION_CONFIG.ALLOWED_MIME_TYPES.join(', ')}`,
      };
    }

    // Decode base64 and check file size
    let buffer: Buffer;
    try {
      buffer = Buffer.from(image.base64, 'base64');
    } catch {
      return {
        valid: false,
        error: `Image ${i + 1}: Invalid base64 encoding`,
      };
    }

    if (buffer.length >= IMAGE_VALIDATION_CONFIG.MAX_FILE_SIZE) {
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
      return {
        valid: false,
        error: `Image ${i + 1}: File size (${sizeMB}MB) exceeds 5MB limit`,
      };
    }

    // Validate magic number matches declared MIME type
    const magicBytes = IMAGE_VALIDATION_CONFIG.MAGIC_NUMBERS[image.mimeType];
    if (magicBytes) {
      const fileHeader = Array.from(buffer.slice(0, magicBytes.length));
      const isValidMagic = magicBytes.every((byte, idx) => fileHeader[idx] === byte);
      if (!isValidMagic) {
        return {
          valid: false,
          error: `Image ${i + 1}: File content does not match declared MIME type '${image.mimeType}'`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Image to Text Tool - Type Definitions
 */

/**
 * Result of image analysis
 */
export interface ImageToTextResult {
  success: boolean;
  description: string;
  modelId: string;
  imagePath: string;
  error?: string;
}

/**
 * Supported image formats
 */
export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp';

/**
 * Image source type
 */
export interface ImageSource {
  type: 's3' | 'local';
  data: Buffer;
  format: ImageFormat;
}

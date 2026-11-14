/**
 * Image to Text Tool - Type Definitions
 */

/**
 * Input parameters for image analysis
 */
export interface ImageToTextInput {
  imagePath: string;
  prompt?: string;
  modelId?: string;
}

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

export type { ImageFormat, ImageSource } from '../../../libs/utils/image-source.js';

/**
 * Input content builder for multimodal agent input
 */

import { TextBlock, ImageBlock } from '@strands-agents/sdk';
import type { ContentBlock } from '@strands-agents/sdk';
import type { ImageData } from '../../types/index.js';
import { logger } from '../logger/index.js';
/**
 * Build input content blocks for agent (text + images for multimodal)
 * @param prompt Text prompt
 * @param images Optional array of images
 * @returns ContentBlock array if multimodal, or prompt string if text-only
 */
export function buildInputContent(prompt: string, images?: ImageData[]): ContentBlock[] | string {
  // Text-only input (no images)
  if (!images || images.length === 0) {
    return prompt;
  }

  const inputContent: ContentBlock[] = [];

  // Add text content if present
  if (prompt.trim()) {
    inputContent.push(new TextBlock(prompt));
  }

  // Add image content blocks for multimodal input
  for (const image of images) {
    // Convert base64 string to Uint8Array
    const binaryString = Buffer.from(image.base64, 'base64');
    const bytes = new Uint8Array(binaryString);

    // Map mimeType to format (explicit whitelist for security)
    const formatMap: Record<string, 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp'> = {
      'image/png': 'png',
      'image/jpeg': 'jpeg',
      'image/jpg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
    };
    const format = formatMap[image.mimeType];

    // Reject unknown MIME types for security (defense in depth)
    if (!format) {
      throw new Error(
        `Unsupported image MIME type: '${image.mimeType}'. Allowed types: ${Object.keys(formatMap).join(', ')}`
      );
    }

    inputContent.push(
      new ImageBlock({
        format,
        source: { bytes },
      })
    );
  }

  logger.info(`Added ${images.length} image(s) to input`);

  return inputContent;
}

/**
 * View Image Tool - put an image into the model's context as visual input
 */

import { tool, ImageBlock, TextBlock } from '@strands-agents/sdk';
import { viewImageDefinition } from '@moca/tool-definitions';
import { WORKSPACE_DIRECTORY } from '../../../config/index.js';
import { logger } from '../../../libs/logger/index.js';
import { getCurrentContext } from '../../../libs/context/request-context.js';
import { loadImageSource } from '../../../libs/utils/image-source.js';
import { fitImage, type FittedImage } from './fit-image.js';

/** Largest source file read into memory for decoding. */
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The text half of the result. It gives the model what the pixels alone do not:
 * how the delivered image relates to the original, so it can choose a `region`
 * in original-image coordinates. It is also all that remains of the result in
 * later turns.
 */
function describeImage(imagePath: string, image: FittedImage): string {
  const { original, region } = image;
  const lines = [
    `Image: ${imagePath}`,
    `Original: ${original.width}x${original.height} ${original.format} (${formatBytes(original.bytes)})`,
  ];
  if (region) {
    lines.push(`Region: x=${region.x}, y=${region.y}, ${region.width}x${region.height}`);
  }

  const sourceWidth = region?.width ?? original.width;
  const scaled = image.width !== sourceWidth;
  lines.push(
    `Shown: ${image.width}x${image.height} ${image.format}` +
      (scaled ? ` (scaled to ${Math.round((image.width / sourceWidth) * 100)}%)` : '')
  );
  if (scaled) {
    lines.push(
      'Detail was lost in scaling. To inspect part of the image at full resolution, call view_image again with `region` in original-image pixels.'
    );
  }
  return lines.join('\n');
}

export const viewImageTool = tool({
  name: viewImageDefinition.name,
  description: viewImageDefinition.description,
  inputSchema: viewImageDefinition.zodSchema,
  callback: async (input) => {
    const { imagePath, region } = input;
    logger.info(`[VIEW_IMAGE] Viewing image: ${imagePath}`);

    const context = getCurrentContext();
    if (!context?.userId) {
      throw new Error('User authentication information not found. Please log in again.');
    }

    // A file the user just uploaded may still be on its way into the workspace.
    if (context.workspaceSync) {
      await context.workspaceSync.waitForInitialSync();
    }

    const source = await loadImageSource(imagePath, context.userId, {
      maxBytes: MAX_SOURCE_BYTES,
      baseDir: context.workspaceSync?.getActiveWorkingDirectory() || WORKSPACE_DIRECTORY,
    });
    const image = await fitImage(source, region);

    logger.info(
      `[VIEW_IMAGE] Delivering ${image.width}x${image.height} ${image.format}, ${image.bytes.length} bytes`
    );

    return [
      new TextBlock(describeImage(imagePath, image)),
      new ImageBlock({ format: image.format, source: { bytes: new Uint8Array(image.bytes) } }),
    ];
  },
});

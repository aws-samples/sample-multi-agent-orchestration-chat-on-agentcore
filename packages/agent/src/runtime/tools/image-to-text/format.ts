/**
 * Pure result formatting for the image_to_text tool.
 */

import type { ImageToTextResult } from './types.js';

/**
 * Render an {@link ImageToTextResult} into the string surfaced to the model.
 *
 * Both the success and failure shapes are produced here so the wording stays
 * in one place; the failure branch is augmented with troubleshooting guidance
 * by the tool.
 */
export function formatResults(result: ImageToTextResult): string {
  let output = '🖼️ Image Analysis Result\n\n';

  if (result.success) {
    output += `✅ Analysis successful\n`;
    output += `Model: ${result.modelId}\n`;
    output += `Image: ${result.imagePath}\n\n`;
    output += `Description:\n${result.description}`;
  } else {
    output += `❌ Analysis failed\n`;
    output += `Model: ${result.modelId}\n`;
    output += `Image: ${result.imagePath}\n`;
    output += `Error: ${result.error}`;
  }

  return output;
}

import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import type { ToolDefinition } from '../types.js';

const regionSchema = z.object({
  x: z.number().min(0).describe('Left edge of the crop, in pixels of the original image'),
  y: z.number().min(0).describe('Top edge of the crop, in pixels of the original image'),
  width: z.number().min(1).describe('Crop width, in pixels of the original image'),
  height: z.number().min(1).describe('Crop height, in pixels of the original image'),
});

export const viewImageSchema = z.object({
  imagePath: z
    .string()
    .min(1)
    .describe(
      'Image to view, in one of the following formats:\n' +
        '1. Local file path: absolute, or relative to the current working directory\n' +
        '2. S3 URI: s3://bucket-name/path/to/image.png\n' +
        'Presigned URLs and other http(s) URLs are not supported.'
    ),
  region: regionSchema
    .optional()
    .describe(
      'Crop this rectangle out of the original image before it is scaled. ' +
        'Use it to zoom in on small text or detail after viewing the whole image.'
    ),
});

export const viewImageDefinition: ToolDefinition<typeof viewImageSchema> = {
  name: 'view_image',
  description:
    'View an image yourself. The image is added to your context as visual input, so you see the pixels directly instead of reading a text description of them. ' +
    'Supports PNG, JPEG, GIF and WebP from a local file path or an S3 URI. ' +
    'Large images are downscaled to fit the model input size; the result states the original and delivered dimensions. ' +
    'To read small text or inspect detail, call again with `region` to crop the original before scaling. ' +
    'The image is visible during the current turn only: afterwards the conversation history keeps a text note in its place, so view the image again when you need to look at it again.',
  zodSchema: viewImageSchema,
  jsonSchema: zodToJsonSchema(viewImageSchema),
};

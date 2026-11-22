import { TextBlock, type ImageBlock } from '@strands-agents/sdk';

/**
 * Text that takes the place of an image a tool returned once the image itself
 * is dropped. It reads correctly both to the user (tool result in the UI) and
 * to the model on a later turn.
 */
export function toolResultImagePlaceholder(image: ImageBlock): TextBlock {
  const size =
    image.source.type === 'imageSourceBytes' ? `, ${image.source.bytes.byteLength} bytes` : '';
  return new TextBlock(
    `[image: ${image.format}${size}. Already viewed; its pixels were dropped from the conversation to save context. Rely on what you observed then, and view it again only for a specific detail you did not note.]`
  );
}

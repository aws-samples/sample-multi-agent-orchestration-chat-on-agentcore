import { describe, it, expect } from '@jest/globals';
import { formatResults } from '../format.js';
import type { ImageToTextResult } from '../types.js';

describe('formatResults', () => {
  it('renders the success shape with the description', () => {
    const result: ImageToTextResult = {
      success: true,
      description: 'A red apple on a table.',
      modelId: 'global.amazon.nova-2-lite-v1:0',
      imagePath: 's3://bucket/apple.png',
    };

    const output = formatResults(result);

    expect(output).toBe(
      '🖼️ Image Analysis Result\n\n' +
        '✅ Analysis successful\n' +
        'Model: global.amazon.nova-2-lite-v1:0\n' +
        'Image: s3://bucket/apple.png\n\n' +
        'Description:\nA red apple on a table.'
    );
  });

  it('renders the failure shape with the error and no description', () => {
    const result: ImageToTextResult = {
      success: false,
      description: '',
      modelId: 'global.amazon.nova-2-lite-v1:0',
      imagePath: '/tmp/missing.png',
      error: 'Local file processing failed: ENOENT',
    };

    const output = formatResults(result);

    expect(output).toBe(
      '🖼️ Image Analysis Result\n\n' +
        '❌ Analysis failed\n' +
        'Model: global.amazon.nova-2-lite-v1:0\n' +
        'Image: /tmp/missing.png\n' +
        'Error: Local file processing failed: ENOENT'
    );
    expect(output).not.toContain('Description:');
  });
});

/**
 * Unit tests for the view_image tool definition (schema + JSON Schema).
 */

import { viewImageDefinition, viewImageSchema } from '../definitions/view-image';
import { RUNTIME_TOOL_NAMES } from '../tool-names';

describe('view_image tool definition', () => {
  it('is named by the runtime tool name constant', () => {
    expect(viewImageDefinition.name).toBe('view_image');
    expect(RUNTIME_TOOL_NAMES.VIEW_IMAGE).toBe(viewImageDefinition.name);
  });

  describe('input schema', () => {
    it('accepts a path on its own', () => {
      expect(viewImageSchema.parse({ imagePath: '/tmp/ws/shot.png' })).toEqual({
        imagePath: '/tmp/ws/shot.png',
      });
    });

    it('accepts a region, including fractional coordinates', () => {
      const region = { x: 10.5, y: 0, width: 300, height: 200 };

      expect(viewImageSchema.parse({ imagePath: 's3://bucket/shot.png', region }).region).toEqual(
        region
      );
    });

    it.each([
      ['an empty path', { imagePath: '' }],
      ['a negative origin', { imagePath: 'a.png', region: { x: -1, y: 0, width: 10, height: 10 } }],
      ['a zero-width region', { imagePath: 'a.png', region: { x: 0, y: 0, width: 0, height: 10 } }],
      ['an incomplete region', { imagePath: 'a.png', region: { x: 0, y: 0 } }],
    ])('rejects %s', (_label, input) => {
      expect(viewImageSchema.safeParse(input).success).toBe(false);
    });
  });

  describe('JSON Schema (model-facing)', () => {
    const props = viewImageDefinition.jsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;

    it('requires only imagePath', () => {
      expect(viewImageDefinition.jsonSchema.required).toEqual(['imagePath']);
      expect(props.imagePath.type).toBe('string');
    });

    it('describes region as an object of four required numbers', () => {
      expect(props.region.type).toBe('object');
      expect(props.region.required).toEqual(['x', 'y', 'width', 'height']);
      const regionProps = props.region.properties as Record<string, Record<string, unknown>>;
      Object.values(regionProps).forEach((prop) => expect(prop.type).toBe('number'));
    });
  });

  it('is exposed to the backend tool listing', async () => {
    const { allMCPToolDefinitions } = await import('../definitions/index');

    const listed = allMCPToolDefinitions.find((def) => def.name === 'view_image');

    expect(listed?.inputSchema).toEqual(viewImageDefinition.jsonSchema);
  });
});

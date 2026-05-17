/**
 * Unit tests for extractJsonFromOutput
 *
 * Covers the three output formats that CodeInterpreter may return:
 *  1. Raw JSON UI spec string
 *  2. CodeInterpreter content array (response envelope)
 *  3. Mixed text with embedded JSON
 */

import { extractJsonFromOutput } from '../extract-json.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_SPEC = {
  root: 'main',
  elements: {
    main: { type: 'Stack', props: { gap: 4 }, children: ['card'] },
    card: { type: 'MetricCard', props: { title: 'KPI', value: '42' } },
  },
};

// ---------------------------------------------------------------------------
// 1. Raw JSON spec string
// ---------------------------------------------------------------------------

describe('extractJsonFromOutput — raw JSON', () => {
  it('parses a valid UI spec from raw JSON string', () => {
    const output = JSON.stringify(VALID_SPEC);
    expect(extractJsonFromOutput(output)).toEqual(VALID_SPEC);
  });

  it('handles leading/trailing whitespace', () => {
    const output = `  \n  ${JSON.stringify(VALID_SPEC)}  \n  `;
    expect(extractJsonFromOutput(output)).toEqual(VALID_SPEC);
  });

  it('returns parsed JSON even when not a UISpec (caller validates)', () => {
    const nonSpec = { foo: 'bar' };
    const result = extractJsonFromOutput(JSON.stringify(nonSpec));
    expect(result).toEqual(nonSpec);
  });
});

// ---------------------------------------------------------------------------
// 2. CodeInterpreter response envelope (array)
// ---------------------------------------------------------------------------

describe('extractJsonFromOutput — array envelope', () => {
  it('unwraps {type:"text", text:"..."} format', () => {
    const envelope = [{ type: 'text', text: JSON.stringify(VALID_SPEC) }];
    expect(extractJsonFromOutput(JSON.stringify(envelope))).toEqual(VALID_SPEC);
  });

  it('unwraps {resource:{text:"..."}} format', () => {
    const envelope = [{ resource: { text: JSON.stringify(VALID_SPEC) } }];
    expect(extractJsonFromOutput(JSON.stringify(envelope))).toEqual(VALID_SPEC);
  });

  it('returns the first valid UISpec from multiple items', () => {
    const envelope = [
      { type: 'text', text: 'some log output' },
      { type: 'text', text: JSON.stringify(VALID_SPEC) },
    ];
    expect(extractJsonFromOutput(JSON.stringify(envelope))).toEqual(VALID_SPEC);
  });

  it('returns parsed array when no text items contain a UISpec', () => {
    const envelope = [{ type: 'text', text: 'not json' }];
    const result = extractJsonFromOutput(JSON.stringify(envelope));
    // The array itself is returned because it's valid JSON but not a UISpec
    expect(result).toEqual(envelope);
  });

  it('handles deeply nested spec in array items', () => {
    const innerSpec = JSON.stringify(VALID_SPEC);
    const envelope = [{ type: 'text', text: innerSpec }];
    expect(extractJsonFromOutput(JSON.stringify(envelope))).toEqual(VALID_SPEC);
  });
});

// ---------------------------------------------------------------------------
// 3. Mixed text with embedded JSON
// ---------------------------------------------------------------------------

describe('extractJsonFromOutput — mixed text', () => {
  it('extracts a UISpec from text with JSON embedded', () => {
    const output = `Processing data...\nResult:\n${JSON.stringify(VALID_SPEC)}\nDone.`;
    expect(extractJsonFromOutput(output)).toEqual(VALID_SPEC);
  });

  it('returns null when multiple JSON objects cause greedy regex to fail', () => {
    // The regex /\{[\s\S]*\}/g is greedy: it matches from the first { to the last },
    // producing one large invalid JSON string when multiple objects are present.
    const earlyJson = JSON.stringify({ foo: 'bar' });
    const output = `First: ${earlyJson}\nSecond: ${JSON.stringify(VALID_SPEC)}`;
    // This is a known limitation of the greedy regex approach
    expect(extractJsonFromOutput(output)).toBeNull();
  });

  it('returns null when no valid JSON found', () => {
    expect(extractJsonFromOutput('no json here at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractJsonFromOutput('')).toBeNull();
  });

  it('returns null when embedded JSON is not a UISpec', () => {
    const output = `Output: {"key": "value"}`;
    // The regex finds {"key": "value"} but it's not a UISpec, so returns null
    expect(extractJsonFromOutput(output)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('extractJsonFromOutput — edge cases', () => {
  it('returns the inner string for double-stringified spec (no auto-unwrap)', () => {
    // When CodeInterpreter double-stringifies, outer parse yields a string.
    // The function returns that string as-is (caller must handle).
    const doubleStringified = JSON.stringify(JSON.stringify(VALID_SPEC));
    const result = extractJsonFromOutput(doubleStringified);
    expect(typeof result).toBe('string');
  });

  it('handles spec with state field', () => {
    const specWithState = {
      ...VALID_SPEC,
      state: { activeTab: 'overview' },
    };
    expect(extractJsonFromOutput(JSON.stringify(specWithState))).toEqual(specWithState);
  });

  it('handles very large output with spec at the end', () => {
    const padding = 'x'.repeat(10000);
    const output = `${padding}\n${JSON.stringify(VALID_SPEC)}`;
    expect(extractJsonFromOutput(output)).toEqual(VALID_SPEC);
  });

  it('handles malformed JSON gracefully (no crash)', () => {
    expect(extractJsonFromOutput('{broken json')).toBeNull();
  });

  it('handles output with only whitespace', () => {
    expect(extractJsonFromOutput('   \n\t  ')).toBeNull();
  });
});

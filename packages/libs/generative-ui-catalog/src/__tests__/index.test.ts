/**
 * Unit tests for generative-ui-catalog shared library
 */

import { isUISpec, isUISpecOutput, COMPONENT_NAMES, generateComponentPrompt } from '../index';
import type { UISpec, UISpecOutput } from '../index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_SPEC: UISpec = {
  root: 'main',
  elements: {
    main: { type: 'Stack', props: { gap: 4 }, children: ['card'] },
    card: { type: 'MetricCard', props: { title: 'Revenue', value: '$1M' } },
  },
};

const VALID_SPEC_WITH_STATE: UISpec = {
  root: 'main',
  elements: {
    main: { type: 'Stack', props: { gap: 2 } },
  },
  state: { activeTab: 'overview' },
};

const VALID_OUTPUT: UISpecOutput = {
  __generative_ui_spec: true,
  spec: VALID_SPEC,
};

// ---------------------------------------------------------------------------
// isUISpec
// ---------------------------------------------------------------------------

describe('isUISpec', () => {
  it('returns true for a valid UISpec', () => {
    expect(isUISpec(VALID_SPEC)).toBe(true);
  });

  it('returns true for a spec with state', () => {
    expect(isUISpec(VALID_SPEC_WITH_STATE)).toBe(true);
  });

  it('returns true for minimal spec (empty elements)', () => {
    expect(isUISpec({ root: 'r', elements: {} })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isUISpec(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isUISpec(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isUISpec('not a spec')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isUISpec(42)).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isUISpec([{ root: 'r', elements: {} }])).toBe(false);
  });

  it('returns false when root is missing', () => {
    expect(isUISpec({ elements: {} })).toBe(false);
  });

  it('returns false when root is not a string', () => {
    expect(isUISpec({ root: 123, elements: {} })).toBe(false);
  });

  it('returns false when elements is missing', () => {
    expect(isUISpec({ root: 'main' })).toBe(false);
  });

  it('returns false when elements is null', () => {
    expect(isUISpec({ root: 'main', elements: null })).toBe(false);
  });

  it('returns false when elements is a string', () => {
    expect(isUISpec({ root: 'main', elements: 'not-an-object' })).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isUISpec({})).toBe(false);
  });

  it('ignores extra properties (still valid)', () => {
    expect(isUISpec({ root: 'r', elements: {}, extra: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isUISpecOutput
// ---------------------------------------------------------------------------

describe('isUISpecOutput', () => {
  it('returns true for a valid UISpecOutput', () => {
    expect(isUISpecOutput(VALID_OUTPUT)).toBe(true);
  });

  it('returns false when __generative_ui_spec is missing', () => {
    expect(isUISpecOutput({ spec: VALID_SPEC })).toBe(false);
  });

  it('returns false when __generative_ui_spec is false', () => {
    expect(isUISpecOutput({ __generative_ui_spec: false, spec: VALID_SPEC })).toBe(false);
  });

  it('returns false when __generative_ui_spec is a string', () => {
    expect(isUISpecOutput({ __generative_ui_spec: 'true', spec: VALID_SPEC })).toBe(false);
  });

  it('returns false when spec is invalid (missing root)', () => {
    expect(isUISpecOutput({ __generative_ui_spec: true, spec: { elements: {} } })).toBe(false);
  });

  it('returns false when spec is null', () => {
    expect(isUISpecOutput({ __generative_ui_spec: true, spec: null })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isUISpecOutput(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isUISpecOutput(undefined)).toBe(false);
  });

  it('returns false for a plain UISpec (no wrapper)', () => {
    expect(isUISpecOutput(VALID_SPEC)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// COMPONENT_NAMES
// ---------------------------------------------------------------------------

describe('COMPONENT_NAMES', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(COMPONENT_NAMES)).toBe(true);
    expect(COMPONENT_NAMES.length).toBeGreaterThan(0);
  });

  const expectedComponents = [
    'Stack',
    'Grid',
    'DataTable',
    'MetricCard',
    'BarChart',
    'LineChart',
    'PieChart',
  ];

  it.each(expectedComponents)('includes "%s"', (name) => {
    expect(COMPONENT_NAMES).toContain(name);
  });

  it('has exactly the expected number of components', () => {
    expect(COMPONENT_NAMES.length).toBe(expectedComponents.length);
  });
});

// ---------------------------------------------------------------------------
// generateComponentPrompt
// ---------------------------------------------------------------------------

describe('generateComponentPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = generateComponentPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('includes component names in the prompt', () => {
    const prompt = generateComponentPrompt();
    for (const name of COMPONENT_NAMES) {
      expect(prompt).toContain(name);
    }
  });

  it('accepts customRules option', () => {
    const customRule = 'Do not use BarChart for single values.';
    const prompt = generateComponentPrompt({ customRules: [customRule] });
    expect(prompt).toContain(customRule);
  });
});

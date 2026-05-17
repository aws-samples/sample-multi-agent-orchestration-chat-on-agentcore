/**
 * Unit tests for validateUISpec (generate-ui catalog validation)
 */

import { validateUISpec } from '../catalog.js';

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
// Valid specs
// ---------------------------------------------------------------------------

describe('validateUISpec — valid specs', () => {
  it('accepts a valid spec with known components', () => {
    const result = validateUISpec(VALID_SPEC);
    expect(result.spec).not.toBeNull();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a spec with state field', () => {
    const specWithState = {
      ...VALID_SPEC,
      state: { activeTab: 'overview' },
    };
    const result = validateUISpec(specWithState);
    expect(result.spec).not.toBeNull();
    expect(result.spec!.state).toEqual({ activeTab: 'overview' });
  });

  it('ignores non-object state field', () => {
    const specWithBadState = { ...VALID_SPEC, state: 'not-an-object' };
    const result = validateUISpec(specWithBadState);
    expect(result.spec).not.toBeNull();
    expect(result.spec!.state).toBeUndefined();
  });

  it('accepts all known component types', () => {
    const spec = {
      root: 'stack',
      elements: {
        stack: { type: 'Stack', children: ['grid', 'table', 'metric', 'bar', 'line', 'pie'] },
        grid: { type: 'Grid' },
        table: { type: 'DataTable', props: { columns: ['A'], rows: [['1']] } },
        metric: { type: 'MetricCard', props: { title: 'T', value: 'V' } },
        bar: { type: 'BarChart', props: { data: [], xKey: 'x' } },
        line: { type: 'LineChart', props: { data: [], xKey: 'x' } },
        pie: { type: 'PieChart', props: { data: [] } },
      },
    };
    const result = validateUISpec(spec);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rejection cases (spec: null)
// ---------------------------------------------------------------------------

describe('validateUISpec — rejection (returns spec: null)', () => {
  it('rejects null input', () => {
    const result = validateUISpec(null);
    expect(result.spec).toBeNull();
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Spec must be an object');
  });

  it('rejects undefined input', () => {
    const result = validateUISpec(undefined);
    expect(result.spec).toBeNull();
    expect(result.valid).toBe(false);
  });

  it('rejects a string', () => {
    const result = validateUISpec('not-a-spec');
    expect(result.spec).toBeNull();
    expect(result.valid).toBe(false);
  });

  it('rejects a number', () => {
    const result = validateUISpec(42);
    expect(result.spec).toBeNull();
    expect(result.valid).toBe(false);
  });

  it('rejects when root is not a string', () => {
    const result = validateUISpec({ root: 123, elements: {} });
    expect(result.spec).toBeNull();
    expect(result.errors).toContain('Spec must have a "root" string key');
  });

  it('rejects when elements is missing', () => {
    const result = validateUISpec({ root: 'main' });
    expect(result.spec).toBeNull();
    expect(result.errors).toContain('Spec must have an "elements" object');
  });

  it('rejects when elements is null', () => {
    const result = validateUISpec({ root: 'main', elements: null });
    expect(result.spec).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Validation warnings (spec returned with errors)
// ---------------------------------------------------------------------------

describe('validateUISpec — warnings', () => {
  it('reports unknown component type', () => {
    const spec = {
      root: 'main',
      elements: {
        main: { type: 'UnknownWidget', props: {} },
      },
    };
    const result = validateUISpec(spec);
    expect(result.spec).not.toBeNull();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Unknown component type "UnknownWidget"'))).toBe(
      true
    );
  });

  it('reports missing root element in elements map', () => {
    const spec = {
      root: 'missing',
      elements: {
        other: { type: 'Stack' },
      },
    };
    const result = validateUISpec(spec);
    expect(result.spec).not.toBeNull();
    expect(result.errors.some((e) => e.includes('Root element "missing" not found'))).toBe(true);
  });

  it('reports unknown child reference', () => {
    const spec = {
      root: 'main',
      elements: {
        main: { type: 'Stack', children: ['ghost'] },
      },
    };
    const result = validateUISpec(spec);
    expect(result.spec).not.toBeNull();
    expect(result.errors.some((e) => e.includes('references unknown child "ghost"'))).toBe(true);
  });

  it('collects multiple errors', () => {
    const spec = {
      root: 'main',
      elements: {
        main: { type: 'FakeType', children: ['child1', 'child2'] },
      },
    };
    const result = validateUISpec(spec);
    // Unknown type + 2 missing children
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Event binding sanitization
// ---------------------------------------------------------------------------

describe('validateUISpec — event binding sanitization', () => {
  it('strips "on" from non-interactive components (e.g. Stack)', () => {
    const spec = {
      root: 'main',
      elements: {
        main: { type: 'Stack', on: { press: { action: 'doSomething' } } },
      },
    };
    const result = validateUISpec(spec);
    expect(result.spec).not.toBeNull();
    // The "on" property should be deleted
    expect((result.spec!.elements.main as any).on).toBeUndefined();
    expect(result.errors.some((e) => e.includes('Stripped "on"'))).toBe(true);
  });

  it('preserves "on" on interactive components (MetricCard)', () => {
    const spec = {
      root: 'main',
      elements: {
        main: { type: 'MetricCard', props: { title: 'T', value: 'V' }, on: { press: {} } },
      },
    };
    const result = validateUISpec(spec);
    expect((result.spec!.elements.main as any).on).toBeDefined();
    expect(result.errors.some((e) => e.includes('Stripped "on"'))).toBe(false);
  });

  it('strips "on" from chart components', () => {
    const spec = {
      root: 'chart',
      elements: {
        chart: {
          type: 'BarChart',
          props: { data: [], xKey: 'x', yKey: 'y' },
          on: { click: {} },
        },
      },
    };
    const result = validateUISpec(spec);
    expect((result.spec!.elements.chart as any).on).toBeUndefined();
  });

  it('strips "on" from DataTable', () => {
    const spec = {
      root: 'table',
      elements: {
        table: {
          type: 'DataTable',
          props: { columns: ['A'], rows: [['1']] },
          on: { rowClick: {} },
        },
      },
    };
    const result = validateUISpec(spec);
    expect((result.spec!.elements.table as any).on).toBeUndefined();
  });
});

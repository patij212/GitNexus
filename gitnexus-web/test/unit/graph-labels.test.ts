import { describe, it, expect } from 'vitest';
import { labelImportance, selectLabelIndices, truncateLabel } from '../../src/lib/graph-labels';

describe('labelImportance', () => {
  it('ranks architectural containers above leaf symbols', () => {
    expect(labelImportance('Project', 0)).toBeGreaterThan(labelImportance('File', 0));
    expect(labelImportance('File', 0)).toBeGreaterThan(labelImportance('Function', 0));
    expect(labelImportance('Function', 0)).toBeGreaterThan(labelImportance('Variable', 0));
  });

  it('amplifies with graph degree so hubs surface', () => {
    expect(labelImportance('Function', 50)).toBeGreaterThan(labelImportance('Function', 0));
  });

  it('falls back to a sane default for unmapped kinds', () => {
    const def = labelImportance('Process', 0);
    expect(def).toBeGreaterThan(0);
    expect(def).toBeLessThan(labelImportance('Project', 0));
  });
});

describe('selectLabelIndices', () => {
  it('returns the most important nodes up to the cap', () => {
    const candidates = [
      { index: 0, importance: 100, distanceSq: 100 },
      { index: 1, importance: 10, distanceSq: 100 },
      { index: 2, importance: 50, distanceSq: 100 },
    ];
    expect(selectLabelIndices(candidates, 2)).toEqual([0, 2]);
  });

  it('prefers the closer node when importance is equal (LOD)', () => {
    const near = { index: 1, importance: 20, distanceSq: 25 };
    const far = { index: 0, importance: 20, distanceSq: 10000 };
    expect(selectLabelIndices([far, near], 1)).toEqual([1]);
  });

  it('respects maxLabels and empties', () => {
    const candidates = [{ index: 0, importance: 1, distanceSq: 1 }];
    expect(selectLabelIndices(candidates, 0)).toEqual([]);
    expect(selectLabelIndices([], 10)).toEqual([]);
  });

  it('breaks ties by index for a flicker-free stable set', () => {
    const a = { index: 5, importance: 10, distanceSq: 100 };
    const b = { index: 2, importance: 10, distanceSq: 100 };
    expect(selectLabelIndices([a, b], 2)).toEqual([2, 5]);
  });
});

describe('truncateLabel', () => {
  it('leaves short names untouched and ellipsizes long ones', () => {
    expect(truncateLabel('shortName')).toBe('shortName');
    const long = 'aVeryLongSymbolNameThatExceedsTheDisplayBudgetByALot';
    const out = truncateLabel(long, 28);
    expect(out).toHaveLength(28);
    expect(out.endsWith('…')).toBe(true);
  });
});

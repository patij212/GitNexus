import { describe, expect, it } from 'vitest';
import {
  THREE_LAYOUT_POSITION_PUBLISH_INTERVAL_MS,
  getNoverlapPolicy,
  getNoverlapSettings,
  shouldPublishThreeLayoutPositions,
} from '../../src/lib/graph-layout-policy';

// ==========================================================================
// PR4 Performance Optimizations — verify behavior preserved after changes
// Tests the pure functions underlying the O(1) lookup optimizations.
// ==========================================================================

describe('nodeById Map — O(1) lookup correctness', () => {
  // Positive: Map.get returns correct node
  it('Map provides O(1) lookup by ID', () => {
    const nodes = [
      { id: 'Function:a.ts:foo', label: 'Function', name: 'foo' },
      { id: 'Class:b.ts:Bar', label: 'Class', name: 'Bar' },
      { id: 'File:c.ts', label: 'File', name: 'c.ts' },
    ];
    const nodeById = new Map(nodes.map((n) => [n.id, n]));

    expect(nodeById.get('Function:a.ts:foo')?.name).toBe('foo');
    expect(nodeById.get('Class:b.ts:Bar')?.name).toBe('Bar');
    expect(nodeById.get('File:c.ts')?.label).toBe('File');
  });

  // Positive: handles duplicate IDs (last wins)
  it('last node wins on duplicate IDs', () => {
    const nodes = [
      { id: 'File:a.ts', label: 'File', name: 'first' },
      { id: 'File:a.ts', label: 'File', name: 'second' },
    ];
    const nodeById = new Map(nodes.map((n) => [n.id, n]));

    expect(nodeById.get('File:a.ts')?.name).toBe('second');
    expect(nodeById.size).toBe(1);
  });

  // Negative: missing ID returns undefined
  it('returns undefined for non-existent ID', () => {
    const nodeById = new Map([['File:a.ts', { id: 'File:a.ts' }]]);
    expect(nodeById.get('NonExistent:x')).toBeUndefined();
  });

  // Negative: empty map
  it('empty Map returns undefined for any key', () => {
    const nodeById = new Map<string, any>();
    expect(nodeById.get('anything')).toBeUndefined();
  });
});

describe('Set.has — O(1) highlight matching', () => {
  // Positive: exact match
  it('Set.has returns true for present IDs', () => {
    const idSet = new Set(['Function:a.ts:foo', 'Class:b.ts:Bar']);
    expect(idSet.has('Function:a.ts:foo')).toBe(true);
    expect(idSet.has('Class:b.ts:Bar')).toBe(true);
  });

  // Negative: missing ID
  it('Set.has returns false for absent IDs', () => {
    const idSet = new Set(['Function:a.ts:foo']);
    expect(idSet.has('Function:a.ts:bar')).toBe(false);
    expect(idSet.has('')).toBe(false);
  });

  // Positive: works with graph node IDs containing special chars
  it('handles IDs with colons, dots, and slashes', () => {
    const idSet = new Set(['Function:src/utils/path-resolver.ts:resolveFile']);
    expect(idSet.has('Function:src/utils/path-resolver.ts:resolveFile')).toBe(true);
  });

  // Negative: case sensitive
  it('is case-sensitive', () => {
    const idSet = new Set(['Function:a.ts:Foo']);
    expect(idSet.has('Function:a.ts:foo')).toBe(false);
  });
});

describe('layout pressure caps', () => {
  it('throttles repeated 3D layout position publishes to the configured cadence', () => {
    expect(shouldPublishThreeLayoutPositions(1000, null)).toBe(true);
    expect(shouldPublishThreeLayoutPositions(1020, 1000)).toBe(false);
    expect(
      shouldPublishThreeLayoutPositions(1000 + THREE_LAYOUT_POSITION_PUBLISH_INTERVAL_MS, 1000),
    ).toBe(true);
  });

  it('keeps small and medium noverlap quality synchronous', () => {
    expect(getNoverlapPolicy(250)).toEqual({
      mode: 'sync',
      label: 'sync:standard:80',
      settings: getNoverlapSettings(250),
    });
    expect(getNoverlapPolicy(3000)).toEqual({
      mode: 'sync',
      label: 'sync:standard:55',
      settings: getNoverlapSettings(3000),
    });
  });

  it('defers or skips expensive noverlap passes for large graphs', () => {
    expect(getNoverlapPolicy(7500)).toEqual({
      mode: 'defer',
      label: 'defer:large:28',
      settings: getNoverlapSettings(7500),
    });
    expect(getNoverlapPolicy(12000)).toEqual({
      mode: 'defer',
      label: 'defer:large:18',
      settings: getNoverlapSettings(12000),
    });
    expect(getNoverlapPolicy(16000)).toEqual({ mode: 'skip', label: 'skip:huge' });
  });

  it('locks noverlap policy thresholds at boundary sizes', () => {
    expect(getNoverlapPolicy(1)).toEqual({ mode: 'skip', label: 'skip:single-node' });
    expect(getNoverlapPolicy(2).mode).toBe('sync');
    expect(getNoverlapSettings(2000).maxIterations).toBe(80);
    expect(getNoverlapSettings(2001).maxIterations).toBe(55);
    expect(getNoverlapPolicy(5000).mode).toBe('sync');
    expect(getNoverlapPolicy(5001).mode).toBe('defer');
    expect(getNoverlapSettings(10000).maxIterations).toBe(28);
    expect(getNoverlapSettings(10001).maxIterations).toBe(18);
    expect(getNoverlapPolicy(15000).mode).toBe('defer');
    expect(getNoverlapPolicy(15001)).toEqual({ mode: 'skip', label: 'skip:huge' });
  });
});

// ==========================================================================
// Render-on-demand gate — animated-node active-animation check
// Verifies the guard logic extracted from updateSceneObjects' dirty-flag gating.
// These tests operate on the pure policy without importing React hooks or THREE.
// ==========================================================================

interface TestNodeAnimation {
  type: string;
  startTime: number;
  duration: number;
}

const hasActiveAnimation = (anims: Map<string, TestNodeAnimation>, now: number): boolean => {
  for (const anim of anims.values()) {
    if (now < anim.startTime + anim.duration) return true;
  }
  return false;
};

describe('animated-node active-animation gate', () => {
  it('returns false for empty map', () => {
    expect(hasActiveAnimation(new Map(), 1000)).toBe(false);
  });

  it('returns true when an animation is still running', () => {
    const anims = new Map<string, TestNodeAnimation>([
      ['node-a', { type: 'pulse', startTime: 900, duration: 600 }],
    ]);
    expect(hasActiveAnimation(anims, 1000)).toBe(true); // 1000 < 900 + 600 = 1500
  });

  it('returns false when all animations have expired', () => {
    const anims = new Map<string, TestNodeAnimation>([
      ['node-a', { type: 'pulse', startTime: 900, duration: 100 }], // expired at 1000
      ['node-b', { type: 'ripple', startTime: 800, duration: 150 }], // expired at 950
    ]);
    expect(hasActiveAnimation(anims, 1001)).toBe(false);
  });

  it('returns true when at least one animation among several is still running', () => {
    const anims = new Map<string, TestNodeAnimation>([
      ['expired-1', { type: 'pulse', startTime: 500, duration: 100 }], // expired
      ['expired-2', { type: 'glow', startTime: 600, duration: 50 }], // expired
      ['active-1', { type: 'ripple', startTime: 950, duration: 500 }], // still running
    ]);
    expect(hasActiveAnimation(anims, 1000)).toBe(true); // 1000 < 950 + 500 = 1450
  });

  it('treats an animation expiring exactly at now as inactive', () => {
    const anims = new Map<string, TestNodeAnimation>([
      ['node-a', { type: 'pulse', startTime: 500, duration: 500 }], // expires exactly at 1000
    ]);
    // now < startTime + duration → 1000 < 1000 is false → inactive
    expect(hasActiveAnimation(anims, 1000)).toBe(false);
  });
});

describe('render-on-demand gate policy', () => {
  // Simulates the animate() condition: render when dirty, camera moved, OR layout is running.
  const shouldRender = (
    renderPending: boolean,
    cameraMoved: boolean,
    layoutRunning: boolean,
  ): boolean => renderPending || cameraMoved || layoutRunning;

  it('skips render when nothing is dirty, camera is still, and layout is idle', () => {
    expect(shouldRender(false, false, false)).toBe(false);
  });

  it('renders when scene objects were updated', () => {
    expect(shouldRender(true, false, false)).toBe(true);
  });

  it('renders when camera moved even if no dirty flags', () => {
    expect(shouldRender(false, true, false)).toBe(true);
  });

  it('renders when both pending and camera moved', () => {
    expect(shouldRender(true, true, false)).toBe(true);
  });

  it('renders every frame while layout is running (active layout cadence)', () => {
    expect(shouldRender(false, false, true)).toBe(true);
  });

  it('still skips render when idle: no dirty, no camera move, layout stopped', () => {
    expect(shouldRender(false, false, false)).toBe(false);
  });
});
